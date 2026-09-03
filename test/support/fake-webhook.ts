import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export interface WebhookWake {
  method: string;
  path: string;
  contentType: string | undefined;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  body: Record<string, unknown>;
  ambassadorMessage: Record<string, unknown>;
}

interface WakeWaiter {
  resolve: (wake: WebhookWake) => void;
  timer: NodeJS.Timeout;
}

export async function startFakeWebhook(
  t: TestContext | undefined,
  options: {
    statuses?: number[];
    secret?: string;
    nowSeconds?: number;
    contract?: "ambassador-hmac-v2" | "openclaw-agent";
  } = {},
): Promise<{
  url: string;
  waitForWake: () => Promise<WebhookWake>;
  close: () => Promise<void>;
}> {
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
      const rawBody = Buffer.concat(chunks);
      try {
        parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
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

      const body = parsed as Record<string, unknown>;
      let ambassadorMessage = body;
      if (options.contract === "openclaw-agent") {
        const prompt = body.message;
        const marker = "\nEmbassys message JSON:\n";
        const markerIndex = typeof prompt === "string" ? prompt.lastIndexOf(marker) : -1;
        try {
          ambassadorMessage =
            markerIndex >= 0
              ? (JSON.parse((prompt as string).slice(markerIndex + marker.length)) as Record<
                  string,
                  unknown
                >)
              : {};
        } catch {
          ambassadorMessage = {};
        }
        if (
          Object.keys(body).sort().join(",") !== "agentId,deliver,message,name,sessionMode" ||
          body.name !== "Embassys Ambassador" ||
          body.agentId !== "main" ||
          body.sessionMode !== "isolated" ||
          body.deliver !== false ||
          request.headers.authorization !== `Bearer ${options.secret}` ||
          typeof ambassadorMessage.id !== "string" ||
          request.headers["idempotency-key"] !== ambassadorMessage.id ||
          request.headers["x-request-id"] !== undefined ||
          request.headers["x-webhook-timestamp"] !== undefined ||
          request.headers["x-webhook-signature-v2"] !== undefined
        ) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"ok":false}');
          return;
        }
      } else if (options.secret !== undefined) {
        const timestamp = request.headers["x-webhook-timestamp"];
        const signature = request.headers["x-webhook-signature-v2"];
        const messageId = ambassadorMessage.id;
        const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
        const expectedSignature =
          typeof timestamp === "string"
            ? createHmac("sha256", options.secret)
                .update(timestamp, "ascii")
                .update(".", "ascii")
                .update(rawBody)
                .digest("hex")
            : "";
        const signatureValid =
          typeof signature === "string" &&
          signature.length === expectedSignature.length &&
          timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
        if (
          request.headers.authorization !== `Bearer ${options.secret}` ||
          typeof timestamp !== "string" ||
          !/^\d{1,12}$/u.test(timestamp) ||
          Math.abs(Number(timestamp) - nowSeconds) > 300 ||
          !signatureValid ||
          typeof messageId !== "string" ||
          request.headers["idempotency-key"] !== messageId ||
          request.headers["x-request-id"] !== messageId
        ) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"ok":false}');
          return;
        }
      }

      const wake = {
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        headers: request.headers,
        rawBody,
        body,
        ambassadorMessage,
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
      response.end(
        responseStatus >= 200 && responseStatus < 300
          ? options.contract === "openclaw-agent"
            ? '{"ok":true,"runId":"fixture-run"}'
            : '{"ok":true}'
          : '{"ok":false}',
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = async (): Promise<void> => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  };
  t?.after(close);

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/agent`,
    close,
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
