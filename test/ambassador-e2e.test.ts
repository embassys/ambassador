import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import {
  type GatewayApplicationOptions,
  openGatewayApplication,
} from "../src/gateway-application.js";
import type { DeliveryTarget } from "../src/notification-relay.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";

const WEBHOOK_SECRET = "abcdef0123456789abcdef0123456789";
const NOW_SECONDS = 1_788_220_800;
const OPENCLAW = { name: "openclaw-bundle-mcp", version: "0.0.0" };
const CODEX = { name: "codex-mcp-client", version: "0.0.0" };
const JSON_HEADERS = { "content-type": "application/json" };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-e2e-"));
  const gateways = new Set<Awaited<ReturnType<typeof openGatewayApplication>>>();
  const central = await startFakeCentral();
  const webhook = await startFakeWebhook(undefined, {
    secret: WEBHOOK_SECRET,
    nowSeconds: NOW_SECONDS,
    contract: "openclaw-agent",
  });
  t.after(async () => {
    for (const gateway of gateways) await gateway.close();
    await webhook.close();
    await central.close();
    await rm(root, { recursive: true, force: true });
  });
  const options: GatewayApplicationOptions = {
    journalPath: join(root, "notifications.sqlite3"),
    credentialPath: join(root, "central-credential.enc"),
    credentialKeyPath: join(root, "central-credential.key"),
    webhookSecretPath: join(root, "webhook-secret.json"),
    webhookSecretKeyPath: join(root, "webhook-secret.key"),
    localControlSecretPath: join(root, "local-control-secret.json"),
    localControlSecretKeyPath: join(root, "local-control-secret.key"),
    pendingActionPath: join(root, "pending-actions.sqlite"),
    actionResultPath: join(root, "action-results.sqlite"),
    acpSessionPath: join(root, "acp-sessions.sqlite"),
    profilePath: join(root, "delivery-profile.json"),
    workingDirectory: root,
    environment: {},
    webhookSecretStore: {
      async load() {
        return WEBHOOK_SECRET;
      },
      async createOrLoad() {
        return WEBHOOK_SECRET;
      },
    },
    localControlSecretStore: {
      async load() {
        return "0123456789abcdef".repeat(4);
      },
      async createOrLoad() {
        return "0123456789abcdef".repeat(4);
      },
    },
    centralOrigin: central.apiUrl,
    localMcpPort: 0,
    nowSeconds: () => NOW_SECONDS,
  };
  return {
    root,
    central,
    webhook,
    options,
    trackGateway(gateway: Awaited<ReturnType<typeof openGatewayApplication>>) {
      gateways.add(gateway);
      return gateway;
    },
  };
}

async function enrollWebhook(
  gateway: Awaited<ReturnType<typeof openGatewayApplication>>,
  central: Awaited<ReturnType<typeof startFakeCentral>>,
  webhookUrl: string,
  email: string,
): Promise<TestMcpClient> {
  const client = new TestMcpClient(gateway.endpoint);
  await client.initialize(OPENCLAW);
  assert.equal((await client.callTool("register_agent", { email })).status, "input_required");
  await client.callTool("register_agent", {
    email,
    delivery: {
      mode: "webhook",
      url: webhookUrl,
    },
  });
  await client.callTool("verify_email", { email, code: central.verificationCode(email) });
  return client;
}

async function enrollDirect(
  gateway: Awaited<ReturnType<typeof openGatewayApplication>>,
  central: Awaited<ReturnType<typeof startFakeCentral>>,
  email: string,
): Promise<TestMcpClient> {
  const client = new TestMcpClient(gateway.endpoint);
  await client.initialize(CODEX);
  await client.callTool("register_agent", { email });
  await client.callTool("verify_email", { email, code: central.verificationCode(email) });
  return client;
}

test("reports verified enrollment independently of an empty permission list and across restart", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
  const bootstrap = new TestMcpClient(gateway.endpoint);
  await bootstrap.initialize(OPENCLAW);
  assert.match(bootstrap.serverInstructions ?? "", /"status":"not_enrolled"/u);
  await assert.rejects(
    bootstrap.callTool("get_my_permissions", {}),
    (error: unknown) =>
      error instanceof McpCallError && JSON.stringify(error.data).includes("not_enrolled"),
  );
  const email = "registered-no-grants@fixture.test";
  const client = await enrollWebhook(gateway, value.central, value.webhook.url, email);
  const result = await client.callTool("get_my_permissions", {});
  const expected = {
    status: "registered",
    verified: true,
    agent_id: "agent.000001",
    email,
    credential_status: "active",
  };
  assert.deepEqual(result.enrollment, expected);
  assert.deepEqual(result.permissions, []);
  assert.match(String(result.message), /empty.*permission.*registered/iu);
  const catalog = await client.callTool("list_action_types", {});
  assert.deepEqual(catalog.enrollment, expected);
  assert.equal((catalog.workflow_guidance as Record<string, unknown>).requester_email, email);
  assert.match(JSON.stringify(catalog.workflow_guidance), /availability.*even.*specific time/u);
  assert.match(JSON.stringify(catalog.workflow_guidance), /attendee/u);
  const fresh = new TestMcpClient(gateway.endpoint);
  await fresh.initialize(OPENCLAW);
  assert.ok(
    fresh.serverInstructions?.includes(`Local Embassys enrollment: ${JSON.stringify(expected)}`),
  );
  assert.match(fresh.serverInstructions ?? "", /Do not register again/iu);
  await gateway.close();
  const reopened = value.trackGateway(await openGatewayApplication(value.options));
  const restored = new TestMcpClient(reopened.endpoint);
  await restored.initialize(OPENCLAW);
  assert.ok(restored.serverInstructions?.includes(email));
  assert.deepEqual(await restored.callTool("get_my_permissions", {}), result);
  assert.equal(
    value.central.requests().filter((request) => request.path === "/api/register_agent").length,
    1,
  );
});

test("keeps saved results readable after credential expiry and restart without retrying central", {
  timeout: process.platform === "win32" ? 30_000 : 5_000,
}, async (t) => {
  const value = await fixture(t);
  let now = NOW_SECONDS;
  const notices: Error[] = [];
  let paused!: () => void;
  const pause = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const options = {
    ...value.options,
    nowSeconds: () => now,
    onRuntimeNotice: (error: Error) => {
      notices.push(error);
      paused();
    },
  };
  const gateway = value.trackGateway(await openGatewayApplication(options));
  const email = "expiry@fixture.test";
  const client = await enrollWebhook(gateway, value.central, value.webhook.url, email);
  const sender = value.central.seedClient("expiry-sender@fixture.test");
  const callId = "10000000-0000-4000-8000-000000000055";
  value.central.queueMessage(
    email,
    {
      type: "action_response",
      call_id: callId,
      action_type: "get_phone_number",
      status: "success",
      result: { phone_number: "+447700900055" },
    },
    sender.email,
  );
  await value.webhook.waitForWake();
  now += 100 * 24 * 60 * 60;
  await assert.rejects(
    client.callTool("list_action_types", {}),
    (error: unknown) =>
      error instanceof McpCallError && JSON.stringify(error.data).includes("credential_expired"),
  );
  value.central.queueMessage(email, { type: "expiry-wake" }, sender.email);
  await pause;
  const requestCount = value.central.requests().length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(value.central.requests().length, requestCount);
  assert.match(notices[0]?.message ?? "", /expired/iu);
  await gateway.close();
  const reopened = value.trackGateway(await openGatewayApplication(options));
  assert.equal(value.central.requests().length, requestCount);
  const reader = new TestMcpClient(reopened.endpoint);
  await reader.initialize(OPENCLAW);
  assert.match(reader.serverInstructions ?? "", /"status":"registered"/u);
  assert.match(reader.serverInstructions ?? "", /"credential_status":"expired"/u);
  assert.match(reader.serverInstructions ?? "", /expiry@fixture\.test/u);
  const inbox = await reader.callTool("message_box", { type: "inbox" });
  assert.equal(inbox.count, 1);
  assert.equal((inbox.items as Array<Record<string, unknown>>)[0]?.call_id, callId);
  await assert.rejects(
    reader.callTool("get_my_permissions", {}),
    (error: unknown) =>
      error instanceof McpCallError && JSON.stringify(error.data).includes("credential_expired"),
  );
});

test("registers by client capability, delivers the full webhook, then acknowledges centrally", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
  const client = await enrollWebhook(
    gateway,
    value.central,
    value.webhook.url,
    "ambassador-webhook@fixture.test",
  );
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    [
      "register_agent",
      "verify_email",
      "resend_verification",
      "list_action_types",
      "get_my_permissions",
      "message_box",
    ],
  );

  const marker = "complete-message-marker-memory-only";
  const messageId = value.central.queueMessage("ambassador-webhook@fixture.test", {
    type: "fixture",
    value: marker,
  });
  const request = await value.webhook.waitForWake();
  assert.equal(request.ambassadorMessage.id, messageId);
  assert.equal(JSON.stringify(request.body).includes(marker), true);
  assert.equal(request.headers.authorization, `Bearer ${WEBHOOK_SECRET}`);
  assert.equal(request.headers["idempotency-key"], messageId);
  assert.equal(request.headers["x-webhook-signature-v2"], undefined);
  for (
    let attempt = 0;
    attempt < 100 && value.central.messageState(messageId) !== "acked";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(value.central.messageState(messageId), "acked");
  assert.equal(
    (await readFile(join(value.root, "notification-custody.sqlite"))).includes(Buffer.from(marker)),
    false,
  );
  assert.equal((await readFile(value.options.profilePath, "utf8")).includes(WEBHOOK_SECRET), false);
  await assert.rejects(client.callTool("poll_messages", { timeout: 0 }));
  await assert.rejects(client.callTool("ack_message", { message_id: messageId }));
});

test("stores received action results before acknowledgement and consumes them from one inbox", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
  const email = "ambassador-result-inbox@fixture.test";
  await enrollWebhook(gateway, value.central, value.webhook.url, email);
  const callId = "10000000-0000-4000-8000-000000000001";
  const messageId = value.central.queueMessage(email, {
    type: "action_response",
    call_id: callId,
    action_type: "get_phone_number",
    status: "success",
    result: { phone_number: "+447700900001" },
  });

  const wake = await value.webhook.waitForWake();
  for (
    let attempt = 0;
    attempt < 100 && value.central.messageState(messageId) !== "acked";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(value.central.messageState(messageId), "acked");
  const bytes = await readFile(value.options.actionResultPath);
  assert.equal(bytes.includes(Buffer.from("+447700900001", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from(callId, "utf8")), false);
  await gateway.close();

  const restarted = value.trackGateway(await openGatewayApplication(value.options));
  const restartedClient = new TestMcpClient(restarted.endpoint);
  await restartedClient.initialize(OPENCLAW);
  assert.deepEqual(await restartedClient.callTool("message_box", { type: "inbox" }), {
    count: 1,
    items: [
      {
        kind: "action_result",
        call_id: callId,
        sender_agent_id: wake.ambassadorMessage.sender_agent_id,
        action_type: "get_phone_number",
        status: "success",
        result: { phone_number: "+447700900001" },
        created_at: wake.ambassadorMessage.created_at,
        receipt: {
          tool: "message_box",
          arguments: { type: "acknowledge_results", call_ids: [callId] },
        },
      },
    ],
  });
  await restartedClient.callTool("message_box", {
    type: "acknowledge_results",
    call_ids: [callId],
  });
  assert.deepEqual(await restartedClient.callTool("message_box", { type: "inbox" }), {
    count: 0,
    items: [],
  });
  await assert.rejects(restartedClient.callTool("message_box", { type: "inbox", limit: 0 }));
});

test("holds an ACP permission request for its owner's emailed answer", async (t) => {
  const value = await fixture(t);
  const recipientEmail = "ambassador-acp-permission@fixture.test";
  const approver = value.central.seedClient("approver@fixture.test");
  const deliveredTypes: unknown[] = [];
  let approvalResult: string | undefined;
  let finishApproval!: () => void;
  const approvalFinished = new Promise<void>((resolve) => {
    finishApproval = resolve;
  });
  const gateway = value.trackGateway(
    await openGatewayApplication({
      ...value.options,
      deliveryTargetFactory: (context) => ({
        async deliver(message, signal) {
          deliveredTypes.push(message.payload.type);
          if (message.payload.type === "request_agent_tool") {
            approvalResult = await context.approvePermission(
              {
                agentKind: context.capability.kind,
                message,
                sessionId: "fixture-session",
                options: [
                  { optionId: "provider:once", name: "Run this once", kind: "allow_once" },
                  {
                    optionId: "provider:remember",
                    name: "Always run this tool",
                    kind: "allow_always",
                  },
                  { optionId: "provider:deny", name: "Skip this tool", kind: "reject_once" },
                ],
                toolCall: {
                  toolCallId: "fixture-tool-call",
                  title: "Run a shell command",
                  kind: "execute",
                  status: "pending",
                },
              },
              signal,
            );
            finishApproval();
          }
          return { status: "completed" };
        },
        async close() {},
      }),
    }),
  );
  await enrollDirect(gateway, value.central, recipientEmail);
  const triggeringMessageId = value.central.queueMessage(
    recipientEmail,
    { type: "request_agent_tool" },
    approver.email,
  );

  let humanInput: { readonly requestId: string; readonly messageId: string } | undefined;
  for (let attempt = 0; attempt < 100 && humanInput === undefined; attempt += 1) {
    humanInput = value.central.pendingHumanInputRequest(recipientEmail);
    if (humanInput === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(humanInput?.messageId, triggeringMessageId);
  assert.equal(approvalResult, undefined);

  const unrelatedMessageId = value.central.queueMessage(
    recipientEmail,
    { type: "unrelated" },
    approver.email,
  );
  const decided = await fetch(`${value.central.apiUrl}/api/human_input_response`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      token: value.central.humanInputResponseToken(humanInput?.requestId as string),
      value: "provider:remember",
    }),
  });
  assert.equal(decided.status, 200);
  await approvalFinished;
  assert.equal(approvalResult, "provider:remember");

  const outcomeMessageId = value.central.humanInputResponseMessageId(
    humanInput?.requestId as string,
  );
  assert.equal(typeof outcomeMessageId, "string");
  for (
    let attempt = 0;
    attempt < 100 &&
    (value.central.messageState(triggeringMessageId) !== "acked" ||
      value.central.messageState(unrelatedMessageId) !== "acked" ||
      value.central.messageState(outcomeMessageId as string) !== "acked");
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(deliveredTypes, ["request_agent_tool", "unrelated"]);
  assert.equal(value.central.messageState(triggeringMessageId), "acked");
  assert.equal(value.central.messageState(unrelatedMessageId), "acked");
  assert.equal(value.central.messageState(outcomeMessageId as string), "acked");
});

test("returns a correlated action result from the target MCP tool to the requester", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
  const targetEmail = "ambassador-result-target@fixture.test";
  const target = await enrollWebhook(gateway, value.central, value.webhook.url, targetEmail);
  const requester = value.central.seedClient("ambassador-result-requester@fixture.test");

  const permissionResponse = await requester.protectedFetch("/api/request_permission", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      target_email: targetEmail,
      action_type: "get_phone_number",
      decision_options: "once_always",
      reason: "deterministic result round trip",
    }),
  });
  assert.equal(permissionResponse.status, 200);
  const permission = (await permissionResponse.json()) as Record<string, unknown>;
  assert.equal(typeof permission.permission_id, "string");

  assert.deepEqual(await target.callTool("message_box", { type: "inbox" }), {
    count: 0,
    items: [],
  });

  const decided = await fetch(`${value.central.apiUrl}/api/permission_decision`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      token: value.central.permissionDecisionToken(String(permission.permission_id)),
      decision: "allow_once",
    }),
  });
  assert.equal(decided.status, 200);
  assert.deepEqual(await target.callTool("message_box", { type: "inbox" }), {
    count: 0,
    items: [],
  });
  const requesterPermissionPoll = await requester.protectedFetch("/api/poll_messages?timeout=0");
  const requesterPermissionMessages = (
    (await requesterPermissionPoll.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(requesterPermissionMessages.length, 1);

  const actionResponse = await requester.protectedFetch("/api/call_action", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      target_email: targetEmail,
      action_type: "get_phone_number",
      payload: { reason: "deterministic result round trip" },
    }),
  });
  assert.equal(actionResponse.status, 200);
  const action = (await actionResponse.json()) as Record<string, unknown>;
  assert.equal(typeof action.call_id, "string");
  const actionWake = await value.webhook.waitForWake();
  assert.equal(
    (actionWake.ambassadorMessage.payload as Record<string, unknown>).call_id,
    action.call_id,
  );

  for (
    let attempt = 0;
    attempt < 100 && value.central.messageState(String(action.message_id)) !== "acked";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(value.central.messageState(String(action.message_id)), "acked");
  await gateway.close();

  const restartedGateway = value.trackGateway(await openGatewayApplication(value.options));
  const restartedTarget = new TestMcpClient(restartedGateway.endpoint);
  await restartedTarget.initialize(OPENCLAW);

  await assert.rejects(restartedTarget.callTool("message_box", { type: "inbox", limit: 0 }));
  const pendingActions = await restartedTarget.callTool("message_box", { type: "inbox" });
  assert.equal(pendingActions.count, 1);
  assert.deepEqual(pendingActions.items, [
    {
      kind: "action_call",
      call_id: action.call_id,
      source_message_id: action.message_id,
      action_type_id: actionWake.ambassadorMessage.action_type_id,
      sender_agent_id: actionWake.ambassadorMessage.sender_agent_id,
      action_type: "get_phone_number",
      payload: { reason: "deterministic result round trip" },
      created_at: actionWake.ambassadorMessage.created_at,
      response: {
        tool: "message_box",
        required: {
          type: "submit_action_result",
          request_id: { type: "string", format: "uuid" },
          call_id: action.call_id,
          status: ["success", "error"],
          result: { type: "object" },
        },
      },
    },
  ]);
  assert.deepEqual(
    (await restartedTarget.callTool("message_box", { type: "inbox" })).items,
    pendingActions.items,
  );

  const submitted = await restartedTarget.callTool("message_box", {
    type: "submit_action_result",
    request_id: randomUUID(),
    call_id: action.call_id,
    result: { phone_number: "+447700900001" },
    status: "success",
  });
  assert.equal(submitted.call_id, action.call_id);
  assert.equal(submitted.status, "completed");
  assert.deepEqual(await restartedTarget.callTool("message_box", { type: "inbox" }), {
    count: 0,
    items: [],
  });

  const requesterResultPoll = await requester.protectedFetch("/api/poll_messages?timeout=0");
  const requesterResultMessages = (
    (await requesterResultPoll.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(requesterResultMessages.length, 1);
  assert.deepEqual(requesterResultMessages[0]?.payload, {
    type: "action_response",
    call_id: action.call_id,
    action_type: "get_phone_number",
    status: "success",
    result: { phone_number: "+447700900001" },
  });
});

test("resumes mixed-case request IDs after restart and exposes their correlated result", async (t) => {
  const value = await fixture(t);
  const gateway = value.trackGateway(await openGatewayApplication(value.options));
  const requesterEmail = "saved-intent-requester@fixture.test";
  const targetEmail = "saved-intent-target@fixture.test";
  const requester = await enrollWebhook(gateway, value.central, value.webhook.url, requesterEmail);
  const target = value.central.seedClient(targetEmail);
  const requestId = randomUUID();
  const permission = await requester.callTool("message_box", {
    type: "request_action",
    request_id: requestId.toUpperCase(),
    wait_seconds: 0,
    target_email: targetEmail,
    action_type: "get_phone_number",
    decision_options: "once_always",
    payload: { reason: "exact saved request" },
  });
  assert.equal(permission.status, "pending");
  assert.equal(permission.request_id, requestId);
  await gateway.close();
  const restarted = value.trackGateway(await openGatewayApplication(value.options));
  const client = new TestMcpClient(restarted.endpoint);
  await client.initialize(OPENCLAW);
  const decision = await fetch(`${value.central.apiUrl}/api/permission_decision`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      token: value.central.permissionDecisionToken(String(permission.permission_id)),
      decision: "allow_once",
    }),
  });
  assert.equal(decision.status, 200);
  const update = await client.callTool("message_box", {
    type: "check",
    request_id: requestId.toUpperCase(),
  });
  const poll = await target.protectedFetch("/api/poll_messages?timeout=0");
  const messages = (
    (await poll.json()) as { messages: Array<{ payload: Record<string, unknown> }> }
  ).messages;
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]?.payload.payload, { reason: "exact saved request" });
  const callId = messages[0]?.payload.call_id;
  const submission = await target.protectedFetch("/api/submit_action_result", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      call_id: callId,
      status: "success",
      result: { phone_number: "+447700900002" },
    }),
  });
  assert.equal(submission.status, 200);
  const result = await client.callTool("message_box", {
    type: "check",
    request_id: permission.request_id,
    cursor: update.cursor,
  });
  assert.match(JSON.stringify(result), /447700900002/u);
  const inbox = await client.callTool("message_box", { type: "inbox" });
  assert.equal(inbox.count, 1);
  assert.equal((inbox.items as Record<string, unknown>[])[0]?.kind, "action_result");
  assert.equal((inbox.items as Record<string, unknown>[])[0]?.call_id, callId);
  await client.callTool("message_box", {
    type: "acknowledge_results",
    call_ids: [String(callId).toUpperCase()],
  });
  assert.deepEqual(await client.callTool("message_box", { type: "inbox" }), {
    count: 0,
    items: [],
  });
});

for (const answerSource of ["email", "foreground"] as const) {
  test(`${answerSource} owner answers resume the same peer and preserve provider approval correlation`, {
    timeout: process.platform === "win32" ? 60_000 : 10_000,
  }, async (t) => {
    const f = await fixture(t);
    const recipient = "owner-question@fixture.test";
    const peer = f.central.seedClient("question-peer@fixture.test");
    const callId = randomUUID();
    const questionId = randomUUID();
    let approvalRequestId: string | undefined;
    let approvalSourceId: string | undefined;
    let firstPeer: string | undefined;
    let resumed!: () => void;
    const finished = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const gateway = f.trackGateway(
      await openGatewayApplication({
        ...f.options,
        centralFetch: async (input, init) => {
          const response = await fetch(input, init);
          if (String(input).endsWith("/api/get_human_input")) {
            const body = JSON.parse(String(init?.body)) as {
              input_type?: string;
              message_id?: string;
            };
            if (body.input_type === "buttons") {
              approvalSourceId = body.message_id;
              const result = (await response.clone().json()) as { request_id?: string };
              approvalRequestId = result.request_id;
            }
          }
          return response;
        },
        deliveryTargetFactory: (context) => ({
          async deliver(message, signal) {
            if (message.payload.type === "action_call") {
              firstPeer = message.sender_agent_id;
              const client = new TestMcpClient(context.endpoint);
              await client.initialize(CODEX);
              const response = await client.callTool("message_box", {
                type: "ask_owner",
                request_id: questionId,
                call_id: callId,
                question: "Which synthetic number should I return?",
                input_type: "text",
              });
              assert.equal(response.status, "waiting_for_owner");
            } else if (message.payload.type === "owner_input") {
              assert.equal(message.sender_agent_id, firstPeer);
              assert.equal(message.payload.call_id, callId);
              assert.equal(message.payload.text, "synthetic-owner-answer");
              if (answerSource === "foreground") {
                assert.equal(
                  await context.approvePermission(
                    {
                      agentKind: "codex",
                      message,
                      sessionId: randomUUID(),
                      options: [
                        { optionId: "permit-once", name: "Allow once", kind: "allow_once" },
                      ],
                      toolCall: { toolCallId: "resume-tool", title: "Read synthetic contact" },
                    },
                    signal,
                  ),
                  "permit-once",
                );
              }
              resumed();
            }
            return { status: "completed" };
          },
          async close() {},
        }),
      }),
    );
    const owner = await enrollDirect(gateway, f.central, recipient);
    const sourceId = f.central.queueMessage(
      recipient,
      {
        type: "action_call",
        call_id: callId,
        action_type: "get_phone_number",
        payload: { reason: "test owner input" },
      },
      peer.email,
    );
    let question: { requestId: string; messageId: string } | undefined;
    for (let attempt = 0; attempt < 200 && question === undefined; attempt++) {
      question = f.central.pendingHumanInputRequest(recipient);
      if (question === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(question?.messageId, sourceId);
    assert.ok(question);
    if (answerSource === "foreground") {
      const answer = await owner.callTool("message_box", {
        type: "answer_owner",
        request_id: randomUUID(),
        question_id: questionId,
        call_id: callId,
        text: "synthetic-owner-answer",
      });
      assert.equal(answer.status, "answered");
      for (let attempt = 0; attempt < 200 && approvalSourceId === undefined; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(approvalSourceId, sourceId);
      for (let attempt = 0; attempt < 200 && approvalRequestId === undefined; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(approvalRequestId);
      const approval = await fetch(`${f.central.apiUrl}/api/human_input_response`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          token: f.central.humanInputResponseToken(approvalRequestId),
          value: "permit-once",
        }),
      });
      assert.equal(approval.status, 200);
    } else {
      const answer = await fetch(`${f.central.apiUrl}/api/human_input_response`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          token: f.central.humanInputResponseToken(question.requestId),
          text: "synthetic-owner-answer",
        }),
      });
      assert.equal(answer.status, 200);
    }
    await finished;
    const status = await owner.callTool("message_box", {
      type: "check_owner",
      request_id: questionId,
    });
    assert.equal(status.status, "answered");
    assert.equal((await owner.callTool("message_box", { type: "inbox" })).count, 1);
  });
}

test("retains custody but never replays a dispatched action after restart", async (t) => {
  const value = await fixture(t);
  let firstDeliveries = 0;
  const blocking: DeliveryTarget = {
    async deliver(_message, signal) {
      firstDeliveries += 1;
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
      });
    },
    async close() {},
  };
  const first = value.trackGateway(
    await openGatewayApplication({
      ...value.options,
      deliveryTargetFactory: () => blocking,
    }),
  );
  await enrollWebhook(first, value.central, value.webhook.url, "ambassador-restart@fixture.test");
  const lostId = value.central.queueMessage("ambassador-restart@fixture.test", {
    value: "restart-loss-marker",
  });
  for (let attempt = 0; attempt < 100 && firstDeliveries === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(firstDeliveries, 1);
  for (let attempt = 0; attempt < 100 && value.central.messageState(lostId) !== "acked"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(value.central.messageState(lostId), "acked");
  await first.close();

  let secondDeliveries = 0;
  value.trackGateway(
    await openGatewayApplication({
      ...value.options,
      deliveryTargetFactory: () => ({
        async deliver() {
          secondDeliveries += 1;
          return { status: "accepted" };
        },
        async close() {},
      }),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondDeliveries, 0);
  assert.equal(value.central.messageState(lostId), "acked");
});
