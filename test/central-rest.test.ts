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
import { type FakeCentral, startFakeCentral } from "./support/fake-central.js";

const NOW_SECONDS = 1_788_220_800;

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

test("post-enrollment catalog exposes exactly six agent-facing tools", () => {
  assert.deepEqual(
    REST_AUTHENTICATED_TOOLS.map((tool) => tool.name),
    [
      "list_action_types",
      "request_permission",
      "respond_to_permission",
      "call_action",
      "submit_action_result",
      "get_my_permissions",
    ],
  );
  const serialized = JSON.stringify(REST_AUTHENTICATED_TOOLS);
  for (const removed of [
    "poll_messages",
    "ack_message",
    "start_",
    "reply_",
    "complete_",
    "outcome",
    "reissue",
    "activation",
  ]) {
    assert.equal(serialized.includes(removed), false);
  }
});

test("I02-R02 REST client projects the fixed action and permission routes", async (t) => {
  const central = await startFakeCentral(t);
  const requesterCredential = await enroll(central, "rest-requester@fixture.test");
  const targetCredential = await enroll(central, "rest-target@fixture.test");
  const requester = rest(central, requesterCredential);
  const target = rest(central, targetCredential);
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
    action_type: "get_email",
    scope: { use: "current fixture" },
  });
  assert.equal(requested.status, "pending");

  const receivedPermission = await target.pollRemoteMessages(0);
  assert.equal(receivedPermission.messages.length, 1);
  assert.equal(receivedPermission.messages[0]?.payload.type, "permission_request");
  const permissionMessageId = receivedPermission.messages[0]?.id;
  assert.equal(typeof permissionMessageId, "string");

  const decided = await target.respondToPermission({
    permission_id: requested.permission_id,
    decision: "granted",
  });
  assert.equal(decided.status, "granted");
  await target.ackMessage({ message_id: permissionMessageId as string });
  const permissionResponse = await requester.pollRemoteMessages(0);
  const permissionResponseId = permissionResponse.messages[0]?.id;
  assert.equal(permissionResponse.messages[0]?.payload.type, "permission_response");
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
        path: "/api/respond_to_permission",
        authorizationScheme: "Bearer",
        dpopCount: 1,
      },
      { method: "POST", path: "/api/ack_message", authorizationScheme: "Bearer", dpopCount: 1 },
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
    client.respondToPermission({ permission_id: "permission.invalid", decision: "maybe" } as never),
    (error: unknown) => error instanceof CentralRestError && error.code === "invalid_arguments",
  );
  assert.deepEqual(central.requests(), []);

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
