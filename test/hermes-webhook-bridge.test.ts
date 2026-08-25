import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const MESSAGE_ID = "hermes_bridge_message_01";
const HERMES_BRIDGE =
  process.env.A2A_PACKED_HERMES_BRIDGE ?? join(process.cwd(), "docs", "hermes-webhook-bridge.mjs");
const BODY = JSON.stringify({
  message: `A2A message ${MESSAGE_ID} is ready. Use the A2A MCP tools to retrieve and process it.`,
  name: "A2A Gateway",
  deliver: false,
  wakeMode: "now",
});

test("the Hermes bridge authenticates the gateway and signs the unchanged wake", async (t) => {
  let forwardCount = 0;
  let resolveForwarded:
    | ((forwarded: { headers: IncomingHttpHeaders; body: Buffer }) => void)
    | undefined;
  const forwardedRequest = new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>(
    (resolve) => {
      resolveForwarded = resolve;
    },
  );
  const hermes = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      forwardCount += 1;
      resolveForwarded?.({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"status":"accepted"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    hermes.once("error", reject);
    hermes.listen(8644, "127.0.0.1", () => {
      hermes.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => hermes.close(() => resolve())));

  const child = spawn(process.execPath, [HERMES_BRIDGE], {
    env: { A2A_GATEWAY_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      exit,
      delay(5_000, undefined, { ref: false }).then(() => undefined),
    ]);
    assert.notEqual(outcome, undefined, "Hermes bridge did not stop after SIGTERM");
  };
  t.after(stop);

  await Promise.race([
    new Promise<void>((resolve) => {
      const inspect = (): void => {
        if (stdout.includes("Hermes bridge:")) resolve();
        else setTimeout(inspect, 10).unref();
      };
      inspect();
    }),
    exit.then(() => assert.fail(`Hermes bridge exited before startup\n${stderr}`)),
    delay(5_000, undefined, { ref: false }).then(() =>
      assert.fail(`Hermes bridge did not start\n${stderr}`),
    ),
  ]);

  const unauthenticated = await fetch("http://127.0.0.1:8645/hooks/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: BODY,
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(forwardCount, 0);

  const accepted = await fetch("http://127.0.0.1:8645/hooks/agent", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": MESSAGE_ID,
    },
    body: BODY,
  });
  assert.equal(accepted.status, 202);
  const forwarded = await forwardedRequest;
  assert.equal(forwarded.body.toString("utf8"), BODY);
  assert.equal(forwarded.headers["x-request-id"], MESSAGE_ID);
  const timestamp = String(forwarded.headers["x-webhook-timestamp"]);
  assert.ok(Math.abs(Date.now() / 1_000 - Number(timestamp)) < 10);
  assert.equal(
    forwarded.headers["x-webhook-signature-v2"],
    createHmac("sha256", TOKEN).update(timestamp).update(".").update(BODY).digest("hex"),
  );

  await stop();
  assert.ok(!stdout.includes(TOKEN));
  assert.ok(!stderr.includes(TOKEN));
});
