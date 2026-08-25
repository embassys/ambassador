import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export interface WebhookWake {
  method: string;
  path: string;
  contentType: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface WakeWaiter {
  resolve: (wake: WebhookWake) => void;
  timer: NodeJS.Timeout;
}

export async function startFakeWebhook(
  t: TestContext,
  options: { statuses?: number[] } = {},
): Promise<{ url: string; waitForWake: () => Promise<WebhookWake> }> {
  const wakes: WebhookWake[] = [];
  const waiters: WakeWaiter[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    request.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength <= 1_048_576) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (
        byteLength > 1_048_576 ||
        request.method !== "POST" ||
        request.url !== "/hooks/agent" ||
        request.headers["content-type"] !== "application/json"
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"ok":false}');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"ok":false}');
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"ok":false}');
        return;
      }

      const wake = {
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        headers: request.headers,
        body: parsed as Record<string, unknown>,
      };
      const waiter = waiters.shift();
      if (waiter === undefined) {
        wakes.push(wake);
      } else {
        clearTimeout(waiter.timer);
        waiter.resolve(wake);
      }
      const responseStatus = options.statuses?.shift() ?? 200;
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(responseStatus >= 200 && responseStatus < 300 ? '{"ok":true}' : '{"ok":false}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/agent`,
    waitForWake: async () => {
      const wake = wakes.shift();
      if (wake !== undefined) {
        return wake;
      }
      return await new Promise<WebhookWake>((resolve, reject) => {
        const waiter: WakeWaiter = {
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error("timed out waiting for webhook wake"));
          }, 5_000),
        };
        waiter.timer.unref();
        waiters.push(waiter);
      });
    },
  };
}
