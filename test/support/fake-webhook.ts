import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

export interface WebhookWake {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export async function startFakeWebhook(
  t: TestContext,
): Promise<{ url: string; waitForWake: () => Promise<WebhookWake> }> {
  const wakes: WebhookWake[] = [];
  const waiters: Array<(wake: WebhookWake) => void> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
      const wake = { headers: request.headers, body: parsed as Record<string, unknown> };
      const waiter = waiters.shift();
      if (waiter === undefined) {
        wakes.push(wake);
      } else {
        waiter(wake);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
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
      return await Promise.race([
        new Promise<WebhookWake>((resolve) => waiters.push(resolve)),
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error("timed out waiting for webhook wake");
        }),
      ]);
    },
  };
}
