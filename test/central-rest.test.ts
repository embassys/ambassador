import assert from "node:assert/strict";
import { test } from "node:test";

import { type LoadedCentralCredential, parseCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient } from "../src/central-enrollment.js";
import { CentralProtectedTransport } from "../src/central-protected-transport.js";
import {
  CentralRestClient,
  CentralRestError,
  REST_AUTHENTICATED_TOOLS,
} from "../src/central-rest.js";
import { DpopNonceCache } from "../src/dpop.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";
import { type FakeCentral, startFakeCentral } from "./support/fake-central.js";

const NOW_SECONDS = 1_788_220_800;

test("recognizes exact central permission errors without returning arbitrary detail", async () => {
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  for (const [detail, expected] of [
    ["No permission exists for this action", "permission_missing"],
    ["Permission is pending, not granted", "permission_pending"],
    ["Permission is denied, not granted", "permission_denied"],
    ["Permission has expired", "permission_expired"],
    [
      "This permission was granted for a single use, which has already been spent. Request permission again.",
      "permission_spent",
    ],
    ["private unexpected server detail", "central_request_rejected"],
  ]) {
    const client = new CentralRestClient({
      centralOrigin: "https://central.fixture.test",
      transport: new CentralProtectedTransport({
        credential: () => credential,
        now: () => FIXTURE_NOW_SECONDS,
        fetch: async () =>
          new Response(JSON.stringify({ detail }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      }),
    });
    await assert.rejects(
      client.callAction({
        target_email: "peer@example.test",
        action_type: "read_calendar_event_by_title",
        payload: { title: "a" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CentralRestError);
        assert.equal(error.code, expected);
        assert.equal(error.response?.notAccepted, true);
        assert.doesNotMatch(JSON.stringify(error), /private unexpected/u);
        return true;
      },
    );
  }
});

test("classifies reviewed pre-acceptance errors without trusting the response body", async () => {
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  for (const status of [400, 403, 404, 409, 422, 429, 500, 502]) {
    const client = new CentralRestClient({
      centralOrigin: "https://central.fixture.test",
      transport: new CentralProtectedTransport({
        credential: () => credential,
        now: () => FIXTURE_NOW_SECONDS,
        fetch: async () =>
          new Response("private server rejection details", {
            status,
            headers: { "retry-after": "12" },
          }),
      }),
    });
    for (const [index, operation] of [
      () => client.requestPermission({ target_email: "peer@fixture.test", action_type: "lookup" }),
      () =>
        client.callAction({
          target_email: "peer@fixture.test",
          action_type: "lookup",
          payload: {},
        }),
    ].entries())
      await assert.rejects(operation(), (error: unknown) => {
        assert.ok(error instanceof CentralRestError);
        assert.equal(error.response?.httpStatus, status);
        assert.equal(error.response?.notAccepted, status < 500 && !(index === 1 && status === 409));
        assert.equal(error.response?.retryAfterMs, status === 429 ? 12_000 : undefined);
        assert.doesNotMatch(JSON.stringify(error), /private server/u);
        return true;
      });
  }
});

test("reports credential expiry without a network request or a retryable transport error", async () => {
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let calls = 0;
  const client = new CentralRestClient({
    centralOrigin: "https://central.fixture.test",
    transport: new CentralProtectedTransport({
      credential: () => credential,
      now: () => credential.token.expiresAt,
      fetch: async () => {
        calls += 1;
        throw new Error("unexpected network");
      },
    }),
  });
  await assert.rejects(
    client.pollRemoteMessages(0),
    (error: unknown) => error instanceof CentralRestError && error.code === "credential_expired",
  );
  assert.equal(calls, 0);
});

async function enroll(central: FakeCentral, email: string): Promise<LoadedCentralCredential> {
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  return parseCentralCredential(verified.credential, () => NOW_SECONDS);
}

function rest(central: FakeCentral, credential: LoadedCentralCredential): CentralRestClient {
  return new CentralRestClient({
    centralOrigin: central.apiUrl,
    transport: new CentralProtectedTransport({
      credential: () => credential,
      nonceCache: new DpopNonceCache(),
      now: () => NOW_SECONDS,
    }),
  });
}

test("post-enrollment catalog exposes the current agent-facing tools with discoverable descriptions", () => {
  assert.deepEqual(
    REST_AUTHENTICATED_TOOLS.map((tool) => tool.name),
    ["list_action_types", "get_my_permissions"],
  );
  const serialized = JSON.stringify(REST_AUTHENTICATED_TOOLS);
  assert.match(serialized, /Embassys Ambassador/iu);
  for (const removed of [
    "poll_messages",
    "ack_message",
    "start_",
    "reply_",
    "complete_",
    "outcome",
    "reissue",
    "activation",
    "list_pending_permission_requests",
    "list_pending_action_calls",
    "list_action_results",
    "respond_to_permission",
  ]) {
    assert.equal(serialized.includes(removed), false);
  }
});

test("central message polls reserve ten seconds beyond the requested server hold", async (t) => {
  const central = await startFakeCentral(t);
  const credential = await enroll(central, "poll-deadline@fixture.test");
  const deadlines: number[] = [];
  const client = new CentralRestClient({
    centralOrigin: central.apiUrl,
    transport: new CentralProtectedTransport({
      credential: () => credential,
      nonceCache: new DpopNonceCache(),
      now: () => NOW_SECONDS,
      deadlineSignal: (milliseconds) => {
        deadlines.push(milliseconds);
        return new AbortController().signal;
      },
    }),
  });

  await client.pollRemoteMessages(30);
  assert.deepEqual(deadlines, [40_000]);
});

test("hides Ambassador's temporary ACP permission types from the action catalog", async (t) => {
  const central = await startFakeCentral(t);
  const credential = await enroll(central, "internal-action-type@fixture.test");
  const client = new CentralRestClient({
    centralOrigin: central.apiUrl,
    transport: new CentralProtectedTransport({
      credential: () => credential,
      nonceCache: new DpopNonceCache(),
      now: () => NOW_SECONDS,
      fetch: async () =>
        Response.json([
          {
            id: "internal-id",
            name: "acp_tool_execution_0123456789abcdef0123456789abcdef",
            description: "Unverified action type",
            input_schema: {},
          },
          {
            id: "public-id",
            name: "get_phone_number",
            description: "Get a phone number",
            input_schema: { type: "object" },
          },
        ]),
    }),
  });

  assert.deepEqual(await client.listActionTypes(), [
    {
      id: "public-id",
      name: "get_phone_number",
      description: "Get a phone number",
      input_schema: { type: "object" },
    },
  ]);
});

test("owner questions reuse known action types without changing the catalog", async (t) => {
  const central = await startFakeCentral(t);
  const credential = await enroll(central, "calendar-owner@fixture.test");
  const sender = central.seedClient("calendar-caller@fixture.test");
  const client = rest(central, credential);
  const before = await client.listActionTypes();
  for (const action of ["get_phone_number", "create_calendar_event", "get_free_busy_permission"]) {
    const messageId = central.queueMessage(
      "calendar-owner@fixture.test",
      { type: "action_call", action_type: action },
      sender.email,
      action,
    );
    for (let repeat = 0; repeat < 2; repeat++) {
      const requested = await client.requestHumanInput({
        permission_type: action,
        request: "May I complete this requested action?",
        input_type: "buttons",
        options: [
          { label: "Approve", value: "approve" },
          { label: "Decline", value: "deny" },
        ],
        message_id: messageId,
      });
      assert.equal(requested.status, "pending");
      assert.deepEqual(await client.listActionTypes(), before);
    }
  }
});

test("asks the enrolled agent's own human and receives the correlated answer", async (t) => {
  const central = await startFakeCentral(t);
  const credential = await enroll(central, "human-input@fixture.test");
  const sender = central.seedClient("human-input-sender@fixture.test");
  const messageId = central.queueMessage(
    "human-input@fixture.test",
    { type: "action_call" },
    sender.email,
  );
  const client = rest(central, credential);

  const requested = await client.requestHumanInput({
    permission_type: "ambassador_acp_tool_execution",
    request: "Codex wants to run a local tool. Allow this once?",
    input_type: "buttons",
    options: [
      { label: "Allow once", value: "allow_once" },
      { label: "Deny", value: "deny" },
    ],
    message_id: messageId,
  });
  assert.equal(requested.status, "pending");
  assert.deepEqual(requested.options, [
    { label: "Allow once", value: "allow_once" },
    { label: "Deny", value: "deny" },
  ]);
  assert.deepEqual(await client.listActionTypes(), central.actions);

  const answered = await fetch(`${central.apiUrl}/api/human_input_response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: central.humanInputResponseToken(requested.request_id),
      value: "allow_once",
    }),
  });
  assert.equal(answered.status, 200);

  const messages = (await client.pollRemoteMessages(0)).messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1]?.payload, {
    type: "human_input_response",
    request_id: requested.request_id,
    action_type: "ambassador_acp_tool_execution",
    input_type: "buttons",
    value: "allow_once",
    text: null,
    prompt: "Codex wants to run a local tool. Allow this once?",
    message_id: messageId,
  });
});

test("asks for text tied to the triggering message without creating a permission", async (t) => {
  const central = await startFakeCentral(t);
  const credential = await enroll(central, "owner-text@fixture.test");
  const messageId = central.queueMessage("owner-text@fixture.test", { type: "action_call" });
  const client = rest(central, credential);
  const requested = await client.requestHumanInput({
    permission_type: "get_phone_number",
    request: "What number should I return?",
    input_type: "text",
    message_id: messageId,
  });
  assert.equal(requested.input_type, "text");
  assert.equal(requested.options, null);
  const answered = await fetch(`${central.apiUrl}/api/human_input_response`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: central.humanInputResponseToken(requested.request_id),
      text: "test phone answer",
    }),
  });
  assert.equal(answered.status, 200);
  const messages = (await client.pollRemoteMessages(0)).messages;
  assert.deepEqual(messages.at(-1)?.payload, {
    type: "human_input_response",
    request_id: requested.request_id,
    action_type: "get_phone_number",
    input_type: "text",
    value: null,
    text: "test phone answer",
    prompt: "What number should I return?",
    message_id: messageId,
  });
  assert.deepEqual(await client.getMyPermissions(), []);
});

test("I02-R02 REST client projects the fixed action and permission routes", async (t) => {
  const central = await startFakeCentral(t);
  const requesterCredential = await enroll(central, "rest-requester@fixture.test");
  const targetCredential = await enroll(central, "rest-target@fixture.test");
  const requester = rest(central, requesterCredential);
  const target = rest(central, targetCredential);
  const correlationMessageId = central.queueMessage(
    "rest-requester@fixture.test",
    { type: "permission_context" },
    "rest-target@fixture.test",
  );
  const correlationPoll = await requester.pollRemoteMessages(0);
  assert.equal(correlationPoll.messages[0]?.id, correlationMessageId);
  await requester.ackMessage({ message_id: correlationMessageId });
  central.resetRequests();

  const catalog = await requester.listActionTypes();
  assert.equal(catalog.length, 6);
  for (const name of ["get_email", "get_phone_number"]) {
    assert.deepEqual(catalog.find((action) => action.name === name)?.input_schema, {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            name === "get_email"
              ? "Reason for requesting email address"
              : "Reason for requesting phone number",
        },
      },
      required: ["reason"],
    });
  }

  const requested = await requester.requestPermission({
    target_email: "rest-target@fixture.test",
    message_id: correlationMessageId,
    permission_type: "get_email",
    decision_options: "once_always",
    reason: "Needed for the current fixture",
    scope: { use: "current fixture" },
  });
  assert.equal(requested.status, "pending");
  assert.equal(requested.already_granted, false);
  assert.equal(requested.decision, null);

  const receivedPermission = await target.pollRemoteMessages(0);
  assert.deepEqual(receivedPermission.messages, []);

  const decided = await fetch(`${central.apiUrl}/api/permission_decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: central.permissionDecisionToken(String(requested.permission_id)),
      decision: "allow_once",
    }),
  });
  assert.equal(decided.status, 200);
  const permissionResponse = await requester.pollRemoteMessages(0);
  const permissionResponseId = permissionResponse.messages[0]?.id;
  assert.deepEqual(permissionResponse.messages[0]?.payload, {
    type: "permission_outcome",
    permission_id: requested.permission_id,
    action_type: "get_email",
    decision: "allow_once",
    status: "granted",
    granted: true,
    single_use: true,
    grantor_email: "rest-target@fixture.test",
  });
  assert.equal(typeof permissionResponseId, "string");
  await requester.ackMessage({ message_id: permissionResponseId as string });

  const called = await requester.callAction({
    target_email: "rest-target@fixture.test",
    action_type: "get_email",
    payload: { reason: "current fixture" },
  });
  assert.equal(called.status, "delivered");
  const actionPoll = await target.pollRemoteMessages(0);
  assert.equal(actionPoll.messages[0]?.id, called.message_id);
  assert.equal(actionPoll.messages[0]?.payload.type, "action_call");
  await target.ackMessage({ message_id: called.message_id });

  const submitted = await target.submitActionResult({
    call_id: called.call_id,
    result: { email: "rest-target@fixture.test" },
    status: "success",
  });
  assert.equal(submitted.call_id, called.call_id);
  assert.equal(submitted.status, "completed");
  assert.equal(typeof submitted.message_id, "string");

  const responsePoll = await requester.pollRemoteMessages(0);
  assert.equal(responsePoll.messages[0]?.id, submitted.message_id);
  assert.deepEqual(responsePoll.messages[0]?.payload, {
    type: "action_response",
    call_id: called.call_id,
    action_type: "get_email",
    status: "success",
    result: { email: "rest-target@fixture.test" },
  });
  await requester.ackMessage({ message_id: submitted.message_id });

  const permissions = await requester.getMyPermissions();
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0]?.grantor_email, "rest-target@fixture.test");
  assert.equal(permissions[0]?.grantee_email, "rest-requester@fixture.test");

  assert.deepEqual(
    central.requests().map(({ method, path, authorizationScheme, dpopCount }) => ({
      method,
      path,
      authorizationScheme,
      dpopCount,
    })),
    [
      {
        method: "GET",
        path: "/api/list_action_types",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      {
        method: "POST",
        path: "/api/request_permission",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      {
        method: "GET",
        path: "/api/poll_messages?timeout=0",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      {
        method: "POST",
        path: "/api/permission_decision",
        authorizationScheme: null,
        dpopCount: 0,
      },
      {
        method: "GET",
        path: "/api/poll_messages?timeout=0",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      { method: "POST", path: "/api/ack_message", authorizationScheme: "Bearer", dpopCount: 1 },
      { method: "POST", path: "/api/call_action", authorizationScheme: "Bearer", dpopCount: 1 },
      {
        method: "GET",
        path: "/api/poll_messages?timeout=0",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      { method: "POST", path: "/api/ack_message", authorizationScheme: "Bearer", dpopCount: 1 },
      {
        method: "POST",
        path: "/api/submit_action_result",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      {
        method: "GET",
        path: "/api/poll_messages?timeout=0",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      { method: "POST", path: "/api/ack_message", authorizationScheme: "Bearer", dpopCount: 1 },
      {
        method: "GET",
        path: "/api/get_my_permissions",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
    ],
  );
});

test("I02-R03 invalid arguments and remote detail errors remain bounded and private", async (t) => {
  const central = await startFakeCentral(t);
  const credential = await enroll(central, "rest-errors@fixture.test");
  const client = rest(central, credential);
  central.resetRequests();
  await assert.rejects(
    client.requestPermission({
      action_type: "get_email",
    }),
    (error: unknown) => error instanceof CentralRestError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    client.requestPermission({ target_email: "target@fixture.test" }),
    (error: unknown) => error instanceof CentralRestError && error.code === "invalid_arguments",
  );
  assert.deepEqual(central.requests(), []);

  central.seedClient("selector-target@fixture.test");
  const other = central.seedClient("selector-other@fixture.test");
  const messageId = central.queueMessage(
    "rest-errors@fixture.test",
    { type: "permission_context" },
    other.email,
  );
  await assert.rejects(
    client.requestPermission({
      target_email: "selector-target@fixture.test",
      message_id: messageId,
      action_type: "get_email",
    }),
    (error: unknown) =>
      error instanceof CentralRestError && error.code === "central_request_rejected",
  );

  await assert.rejects(
    client.callAction({
      target_email: "absent@fixture.test",
      action_type: "get_email",
      payload: { reason: "must not be reflected" },
    }),
    (error: unknown) =>
      error instanceof CentralRestError &&
      error.code === "central_request_rejected" &&
      !error.message.includes("must not be reflected"),
  );
});
