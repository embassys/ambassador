import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient, CentralEnrollmentError } from "../src/central-enrollment.js";
import { CentralProtectedTransport } from "../src/central-protected-transport.js";
import { CentralRestClient, CentralRestError } from "../src/central-rest.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";
import { startFakeCentral } from "./support/fake-central.js";

// Reviewed against agent2agent 58e554b4 and deployed OpenAPI on 2026-09-14.
function client(response: unknown): CentralRestClient {
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  return new CentralRestClient({
    centralOrigin: "https://central.fixture.test",
    transport: new CentralProtectedTransport({
      credential: () => credential,
      now: () => FIXTURE_NOW_SECONDS,
      fetch: async () => Response.json(response),
    }),
  });
}

const invalid = (error: unknown) =>
  error instanceof CentralRestError && error.code === "central_response_invalid";

test("an accepted call is queued, including recovered receipts, without claiming delivery", async () => {
  const body = {
    target_email: "peer@fixture.test",
    action_type: "get_phone_number",
    payload: { reason: "Test" },
  };
  const receipt = {
    call_id: "00000000-0000-4000-8000-000000000011",
    message_id: "message-1",
    status: "queued",
  };
  assert.deepEqual(await client(receipt).callAction(body), receipt);
  await assert.rejects(client({ ...receipt, status: "delivered" }).callAction(body), invalid);
});

test("current catalog exposes nullable result schemas without weakening input validation", async () => {
  const action = {
    id: "action.get_phone_number",
    name: "get_phone_number",
    description: "Get a phone number",
    input_schema: { type: "object" },
  };
  for (const result_schema of [null, {}, { type: "object", required: ["phone_number"] }]) {
    const row = { ...action, result_schema };
    assert.deepEqual(await client([row]).listActionTypes(), [row]);
  }
  for (const result_schema of [[], "object", true, { token: "must stay private" }]) {
    await assert.rejects(client([{ ...action, result_schema }]).listActionTypes());
  }
  await assert.rejects(client([{ ...action, input_schema: [] }]).listActionTypes(), invalid);
  await assert.rejects(client([{ ...action, unexpected: true }]).listActionTypes(), invalid);
});

const message = {
  id: "7479c67c-b398-46d1-8733-a59c15fd66fa",
  sender_agent_id: "c643a664-5c60-4784-a99f-a83c492729cb",
  action_type_id: "6607d941-8ae9-4c0d-949c-b66668566eb9",
  payload: { type: "action_call", call_id: "7fdcf8f4-eabd-4f95-a7cb-d25a901e5df1" },
  created_at: "2026-09-14T12:00:00Z",
};
const leased = {
  ...message,
  message_type: "action_call",
  delivery_attempts: 1,
  redelivered: false,
  lease_expires_at: "2026-09-14T12:02:00Z",
};

test("lease metadata does not change a message's durable identity on redelivery", async () => {
  const redelivered = {
    ...leased,
    delivery_attempts: 2,
    redelivered: true,
    lease_expires_at: "2026-09-14T12:04:00Z",
  };
  for (const row of [leased, redelivered]) {
    assert.deepEqual(
      await client({ messages: [row], has_more: true, lease_seconds: 120 }).pollRemoteMessages(0),
      { messages: [message] },
    );
  }
  assert.deepEqual(
    await client({ messages: [], has_more: false, lease_seconds: 120 }).pollRemoteMessages(0),
    { messages: [] },
  );
  await assert.rejects(
    client({
      messages: [leased, { ...redelivered, payload: { type: "changed" } }],
      has_more: false,
      lease_seconds: 120,
    }).pollRemoteMessages(0),
    invalid,
  );
});

test("polling rejects malformed lease fields and never invents a sender for system messages", async () => {
  for (const mutation of [
    { delivery_attempts: 0 },
    { delivery_attempts: 1.5 },
    { delivery_attempts: "2" },
    { redelivered: "false" },
    { lease_expires_at: "not a date" },
    { message_type: [] },
    { sender_agent_id: null },
    { unexpected: true },
  ]) {
    await assert.rejects(
      client({
        messages: [{ ...leased, ...mutation }],
        has_more: false,
        lease_seconds: 120,
      }).pollRemoteMessages(0),
      invalid,
    );
  }
  for (const mutation of [
    { has_more: "false" },
    { lease_seconds: -1 },
    { lease_seconds: 1.5 },
    { lease_seconds: Number.MAX_SAFE_INTEGER + 1 },
    { unexpected: true },
  ]) {
    await assert.rejects(
      client({ messages: [], has_more: false, lease_seconds: 120, ...mutation }).pollRemoteMessages(
        0,
      ),
      invalid,
    );
  }
});

test("single-message acknowledgements validate the requested ID in the new receipt lists", async () => {
  const response = {
    message_id: message.id,
    status: "acked",
    acknowledged: [message.id],
    already_acked: [],
    unknown: [],
  };
  for (const already_acked of [[], [message.id]]) {
    assert.deepEqual(
      await client({ ...response, already_acked }).ackMessage({ message_id: message.id }),
      { message_id: message.id, status: "acked" },
    );
  }
  for (const mutation of [
    { acknowledged: [] },
    { acknowledged: ["other"] },
    { acknowledged: [message.id, "other"] },
    { unknown: [message.id] },
    { already_acked: ["other"] },
    { already_acked: [message.id, message.id] },
    { message_id: "other" },
    { status: "unknown" },
    { acknowledged: "not an array" },
  ]) {
    await assert.rejects(
      client({ ...response, ...mutation }).ackMessage({ message_id: message.id }),
      invalid,
    );
  }
});

test("verification accepts only a boolean replay indicator and keeps it out of agent results", async (t) => {
  const central = await startFakeCentral(t);
  for (const [index, replayed] of [false, true, "false"].entries()) {
    const email = `replay-${index}@fixture.test`;
    const enrollment = new CentralEnrollmentClient({
      centralOrigin: central.apiUrl,
      nowSeconds: () => FIXTURE_NOW_SECONDS,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).endsWith("/verify_email")) return response;
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, replayed }, { headers: response.headers });
      },
    });
    await enrollment.register({ email });
    const verify = enrollment.verify({ email, code: central.verificationCode(email) });
    if (typeof replayed === "boolean") {
      const result = await verify;
      assert.equal(result.localResult.verified, true);
      assert.deepEqual(Object.keys(result.localResult).sort(), [
        "agent_id",
        "email",
        "message",
        "verified",
      ]);
    } else {
      await assert.rejects(
        verify,
        (error: unknown) =>
          error instanceof CentralEnrollmentError &&
          error.code === "central_verification_credential_invalid",
      );
    }
  }
});

test("execution fences are explicit and cannot be mistaken for missing permission", async () => {
  const { CentralRestClient } = await import("../src/central-rest.js");
  const { CentralProtectedTransport } = await import("../src/central-protected-transport.js");
  const { parseCentralCredential } = await import("../src/central-credential.js");
  const { currentCredential, FIXTURE_NOW_SECONDS } = await import(
    "./support/current-credential.js"
  );
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  for (const reason of ["executor_revoked", "executor_transferred", "execution_token_required"]) {
    const transport = new CentralProtectedTransport({
      credential: () => credential,
      now: () => FIXTURE_NOW_SECONDS,
      fetch: async () =>
        Response.json(
          {
            detail: {
              error: "Not the execution device for this agent",
              reason,
              message: "Stop executing",
            },
          },
          { status: 403 },
        ),
    });
    const client = new CentralRestClient({
      centralOrigin: "https://central.fixture.test",
      transport,
    });
    await assert.rejects(
      client.pollRemoteMessages(30),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "executor_inactive",
    );
  }
});
