import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

interface CommitObservation {
  readonly method: string;
  readonly pathname: string;
  readonly status: number;
}

export interface T04ResponseObserver {
  readonly environment: Readonly<Record<string, string>>;
  readonly waitForCommit: (timeoutMs?: number) => Promise<CommitObservation>;
  readonly release: () => void;
}

const MAX_EVENT_BYTES = 1_024;

function installGatewayPreload(): void {
  if (process.env.T04_OBSERVER_PRELOAD !== "1") return;
  const controlUrl = process.env.T04_OBSERVER_CONTROL_URL;
  const targetOrigin = process.env.T04_OBSERVER_TARGET_ORIGIN;
  const targetPath = process.env.T04_OBSERVER_TARGET_PATH;
  const targetMethod = process.env.T04_OBSERVER_TARGET_METHOD;
  if (
    controlUrl === undefined ||
    targetOrigin === undefined ||
    targetPath === undefined ||
    targetMethod === undefined
  ) {
    throw new Error("invalid T04 response observer preload configuration");
  }
  const originalFetch = globalThis.fetch;
  let observed = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await originalFetch(request);
    const url = new URL(request.url);
    if (
      !observed &&
      url.origin === targetOrigin &&
      url.pathname === targetPath &&
      request.method === targetMethod
    ) {
      observed = true;
      await originalFetch(controlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: request.method,
          pathname: url.pathname,
          status: response.status,
        }),
      });
    }
    return response;
  };
}

installGatewayPreload();

export async function startT04ResponseObserver(
  t: TestContext,
  options: {
    readonly targetOrigin: string;
    readonly targetPath: string;
    readonly targetMethod: string;
  },
): Promise<T04ResponseObserver> {
  const targetOrigin = new URL(options.targetOrigin);
  if (
    targetOrigin.protocol !== "http:" ||
    targetOrigin.hostname !== "127.0.0.1" ||
    targetOrigin.pathname !== "/"
  ) {
    throw new Error("T04 response observer requires a literal-loopback fixture origin");
  }
  let pendingResponse: ServerResponse | undefined;
  let observation: CommitObservation | undefined;
  let resolveCommit: ((value: CommitObservation) => void) | undefined;
  const committed = new Promise<CommitObservation>((resolve) => {
    resolveCommit = resolve;
  });
  const server = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/committed" ||
      pendingResponse !== undefined
    ) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= MAX_EVENT_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > MAX_EVENT_BYTES) {
        response.writeHead(413).end();
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CommitObservation;
        if (
          parsed.method !== options.targetMethod ||
          parsed.pathname !== options.targetPath ||
          !Number.isInteger(parsed.status)
        ) {
          throw new Error("invalid event");
        }
        observation = parsed;
        pendingResponse = response;
        resolveCommit?.(parsed);
        resolveCommit = undefined;
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const release = (): void => {
    if (pendingResponse === undefined) return;
    pendingResponse.writeHead(204).end();
    pendingResponse = undefined;
  };
  t.after(async () => {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    environment: {
      T04_OBSERVER_PRELOAD: "1",
      T04_OBSERVER_CONTROL_URL: `http://127.0.0.1:${port}/committed`,
      T04_OBSERVER_TARGET_ORIGIN: targetOrigin.origin,
      T04_OBSERVER_TARGET_PATH: options.targetPath,
      T04_OBSERVER_TARGET_METHOD: options.targetMethod,
    },
    waitForCommit: async (timeoutMs = 10_000) => {
      if (observation !== undefined) return observation;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          committed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("timed out waiting for upstream commit observation")),
              timeoutMs,
            );
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    release,
  };
}
