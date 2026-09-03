import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

type ReceiverModule = typeof import("../integrations/openclaw-ambassador/receiver.mjs");
const {
  buildAmbassadorPrompt,
  classifyOpenClawExecutionError,
  createBoundedOpenClawWorkQueue,
  verifyAmbassadorWebhook,
} = (await import(
  pathToFileURL(join(process.cwd(), "integrations/openclaw-ambassador/receiver.mjs")).href
)) as ReceiverModule;

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = 1_788_364_800;
const MESSAGE = {
  id: "68deea87-9460-4eb9-8bb9-004cd54d516c",
  sender_agent_id: "agent.requester",
  action_type_id: "get_phone_number",
  payload: {
    type: "action_call",
    call_id: "b5ce2f2c-e585-4a89-a23b-4d9e639104b5",
    action_type: "get_phone_number",
    payload: { phone_number: "+447700900123" },
  },
  created_at: "2026-09-03T12:00:00.000Z",
};

function signedRequest(
  message: Record<string, unknown> = MESSAGE,
  timestamp = String(NOW),
): { body: Buffer; headers: Headers } {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const signature = createHmac("sha256", SECRET)
    .update(timestamp, "ascii")
    .update(".", "ascii")
    .update(body)
    .digest("hex");
  return {
    body,
    headers: new Headers({
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      "idempotency-key": String(message.id),
      "x-request-id": String(message.id),
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature-v2": signature,
    }),
  };
}

test("accepts Ambassador's exact bearer and HMAC-v2 request", () => {
  const request = signedRequest();
  assert.deepEqual(
    verifyAmbassadorWebhook({
      method: "POST",
      headers: request.headers,
      body: request.body,
      secret: SECRET,
      nowSeconds: NOW,
    }),
    { ok: true, message: MESSAGE },
  );
});

test("fails closed before model dispatch for altered authentication or bodies", () => {
  const cases: Array<{ request: ReturnType<typeof signedRequest>; status: number }> = [];
  const wrongBearer = signedRequest();
  wrongBearer.headers.set("authorization", `Bearer ${"f".repeat(48)}`);
  cases.push({ request: wrongBearer, status: 401 });

  const wrongSignature = signedRequest();
  wrongSignature.headers.set("x-webhook-signature-v2", "0".repeat(64));
  cases.push({ request: wrongSignature, status: 401 });

  cases.push({ request: signedRequest(MESSAGE, String(NOW - 301)), status: 401 });

  const mismatchedId = signedRequest({ ...MESSAGE, id: "different-id" });
  mismatchedId.headers.set("idempotency-key", String(MESSAGE.id));
  mismatchedId.headers.set("x-request-id", String(MESSAGE.id));
  cases.push({ request: mismatchedId, status: 400 });

  for (const { request, status } of cases) {
    assert.deepEqual(
      verifyAmbassadorWebhook({
        method: "POST",
        headers: request.headers,
        body: request.body,
        secret: SECRET,
        nowSeconds: NOW,
      }),
      { ok: false, status },
    );
  }
});

test("builds a bounded instruction that preserves the complete correlated message", () => {
  const prompt = buildAmbassadorPrompt(MESSAGE);
  assert.match(prompt, /untrusted Ambassador message/u);
  assert.match(prompt, /submit_action_result/u);
  assert.match(prompt, /b5ce2f2c-e585-4a89-a23b-4d9e639104b5/u);
  assert.equal(prompt.includes(JSON.stringify(MESSAGE)), true);
});

test("classifies OpenClaw launch failures without returning error content", () => {
  assert.equal(
    classifyOpenClawExecutionError(new Error("active plugin runtime scope is missing")),
    "plugin_runtime_scope",
  );
  assert.equal(
    classifyOpenClawExecutionError(new Error("session ownership rejected private-content")),
    "session_admission",
  );
  assert.equal(
    classifyOpenClawExecutionError(new Error("provider credential rejected private-content")),
    "model_start",
  );
  assert.equal(classifyOpenClawExecutionError(new Error("private-content")), "unknown");
});

test("bounds and closes the OpenClaw service handoff queue", async () => {
  const queue = createBoundedOpenClawWorkQueue(1);
  const first = { requestId: "first" };
  const second = { requestId: "second" };
  assert.equal(queue.enqueue(first), true);
  assert.equal(queue.enqueue(second), false);
  assert.equal(await queue.next(), first);

  const waiting = queue.next();
  assert.equal(queue.enqueue(second), true);
  assert.equal(await waiting, second);
  queue.close();
  assert.equal(queue.enqueue(first), false);
  assert.equal(await queue.next(), undefined);
});

test("ships an OpenClaw plugin that owns the authenticated route and model turn", async () => {
  const root = join(process.cwd(), "integrations/openclaw-ambassador");
  const manifest = JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8")) as {
    id?: unknown;
    configContracts?: unknown;
  };
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: unknown;
  };
  const entry = await readFile(join(root, "index.mjs"), "utf8");
  assert.equal(manifest.id, "embassys-ambassador");
  assert.equal(packageJson.name, manifest.id);
  assert.match(JSON.stringify(manifest.configContracts), /secretInputs/u);
  assert.match(entry, /registerHttpRoute/u);
  assert.match(entry, /registerService/u);
  assert.match(entry, /runEmbeddedAgent/u);
  assert.match(entry, /sessionId: work\.requestId/u);
  assert.match(entry, /runId: work\.requestId/u);
  assert.match(entry, /resolveAgentTimeoutMs/u);
  assert.doesNotMatch(entry, /sessionKey:/u);
  assert.doesNotMatch(entry, /sessionPersistence:/u);
  assert.doesNotMatch(entry, /dispatchHookAgentTurn/u);
  assert.match(entry, /classifyOpenClawExecutionError/u);
  assert.doesNotMatch(entry, /\$\{error|String\(error|error\.message/iu);
  assert.doesNotMatch(entry, /console\.|authorization.*logger|prompt.*logger/iu);
});
