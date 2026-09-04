import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createFixtureKeyPair, startFakeCentral } from "./support/fake-central.js";

const jsonHeaders = { "content-type": "application/json" };

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split(".")[1];
  assert.ok(segment !== undefined);
  const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("I02-F01 fixture exposes email enrollment and issues the current bound token", async (t) => {
  const central = await startFakeCentral(t);
  const email = "enrollment@fixture.test";
  const registered = await fetch(`${central.apiUrl}/api/register_agent`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, display_name: "Fixture enrollment" }),
  });
  assert.equal(registered.status, 200);
  assert.deepEqual(Object.keys((await registered.json()) as Record<string, unknown>).sort(), [
    "agent_id",
    "email",
    "message",
  ]);

  const key = createFixtureKeyPair();
  const verified = await fetch(`${central.apiUrl}/api/verify_email`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      email,
      code: central.verificationCode(email),
      jwk: key.publicJwk,
    }),
  });
  assert.equal(verified.status, 200);
  assert.match(verified.headers.get("cache-control") ?? "", /(?:^|,)\s*no-store\s*(?:,|$)/u);
  const result = (await verified.json()) as Record<string, unknown>;
  assert.equal(result.email, email);
  assert.equal(typeof result.token, "string");
  assert.equal(typeof result.jkt, "string");
  const claims = decodeJwtPayload(result.token as string);
  assert.deepEqual(Object.keys(claims).sort(), ["cnf", "email", "exp", "iat", "sub"]);
  assert.equal(claims.email, email);
  assert.equal((claims.exp as number) - (claims.iat as number), 30 * 24 * 60 * 60);
  assert.deepEqual(claims.cnf, { jkt: result.jkt });

  assert.deepEqual(central.requests(), [
    {
      method: "POST",
      path: "/api/register_agent",
      authorizationScheme: null,
      dpopCount: 0,
      bodyKeys: ["display_name", "email"],
    },
    {
      method: "POST",
      path: "/api/verify_email",
      authorizationScheme: null,
      dpopCount: 0,
      bodyKeys: ["code", "email", "jwk"],
    },
  ]);
});

test("I02-F02 protected fixture routes require Bearer plus an exact fresh proof", async (t) => {
  const central = await startFakeCentral(t);
  const client = central.seedClient("proofs@fixture.test");
  const path = "/api/poll_messages?timeout=0";
  const target = `${central.apiUrl}${path}`;

  const valid = await client.protectedFetch(path);
  assert.equal(valid.status, 200);

  const missing = await client.protectedFetch(path, { proof: false });
  assert.equal(missing.status, 401);

  const wrongScheme = await client.protectedFetch(path, { authorizationScheme: "DPoP" });
  assert.equal(wrongScheme.status, 401);

  const other = createFixtureKeyPair();
  const wrongKey = await client.protectedFetch(path, {
    proof: { privateKey: other.privateKey, publicJwk: other.publicJwk },
  });
  assert.equal(wrongKey.status, 401);

  const wrongHash = await client.protectedFetch(path, { proof: { ath: "wrong-token-hash" } });
  assert.equal(wrongHash.status, 401);

  const wrongMethod = await client.protectedFetch(path, { proof: { method: "POST" } });
  assert.equal(wrongMethod.status, 401);

  const wrongUrl = await client.protectedFetch(path, {
    proof: { target: `${central.apiUrl}/api/poll_messages?timeout=1` },
  });
  assert.equal(wrongUrl.status, 401);

  const stale = await client.protectedFetch(path, {
    proof: { nowSeconds: 1_788_220_739 },
  });
  assert.equal(stale.status, 401);

  const future = await client.protectedFetch(path, {
    proof: { nowSeconds: 1_788_220_806 },
  });
  assert.equal(future.status, 401);

  const replayJti = randomUUID();
  const proof = client.createProof("GET", target, { jti: replayJti });
  const firstReplay = await fetch(target, {
    headers: {
      authorization: `Bearer ${client.accessTokenForTest()}`,
      dpop: proof,
    },
  });
  assert.equal(firstReplay.status, 200);
  const secondReplay = await fetch(target, {
    headers: {
      authorization: `Bearer ${client.accessTokenForTest()}`,
      dpop: proof,
    },
  });
  assert.equal(secondReplay.status, 401);
});

test("I02-F03 fixture challenges once with a server-provided nonce", async (t) => {
  const central = await startFakeCentral(t);
  const client = central.seedClient("nonce@fixture.test");
  central.setNonce(client.email, "fixture-initial-nonce");

  const challenged = await client.protectedFetch("/api/list_action_types");
  assert.equal(challenged.status, 401);
  const supplied = challenged.headers.get("dpop-nonce");
  assert.ok(supplied !== null);

  const accepted = await client.protectedFetch("/api/list_action_types", {
    proof: { nonce: supplied },
  });
  assert.equal(accepted.status, 200);
});

test("I02-F04 fixture models permission, action, result, consuming poll, and ack", async (t) => {
  const central = await startFakeCentral(t);
  const requester = central.seedClient("requester@fixture.test");
  const target = central.seedClient("target@fixture.test");

  const catalog = await requester.protectedFetch("/api/list_action_types");
  assert.equal(catalog.status, 200);
  const actions = (await catalog.json()) as Array<Record<string, unknown>>;
  for (const name of ["get_email", "get_phone_number"]) {
    const action = actions.find((candidate) => candidate.name === name);
    assert.deepEqual(action?.input_schema, {
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

  const requested = await requester.protectedFetch("/api/request_permission", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      target_email: target.email,
      action_type: "get_email",
      scope: { use: "fixture" },
    }),
  });
  assert.equal(requested.status, 200);
  const requestedBody = (await requested.json()) as Record<string, unknown>;
  const permissionId = requestedBody.permission_id;
  assert.equal(typeof permissionId, "string");
  assert.equal(requestedBody.already_granted, false);
  assert.equal(requestedBody.decision, null);

  const targetPoll = await target.protectedFetch("/api/poll_messages?timeout=0");
  assert.deepEqual(await targetPoll.json(), { messages: [] });

  const decided = await target.protectedFetch("/api/respond_to_permission", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ permission_id: permissionId, decision: "granted" }),
  });
  assert.equal(decided.status, 200);
  const permissionResponse = await requester.protectedFetch("/api/poll_messages?timeout=0");
  const permissionResponseMessages = (
    (await permissionResponse.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(permissionResponseMessages.length, 1);
  const permissionResponsePayload = permissionResponseMessages[0]?.payload as
    | Record<string, unknown>
    | undefined;
  assert.equal(permissionResponsePayload?.type, "permission_response");
  const permissionResponseId = permissionResponseMessages[0]?.id;
  assert.equal(typeof permissionResponseId, "string");
  const acknowledgedResponse = await requester.protectedFetch("/api/ack_message", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ message_id: permissionResponseId }),
  });
  assert.equal(acknowledgedResponse.status, 200);

  const action = await requester.protectedFetch("/api/call_action", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      target_email: target.email,
      action_type: "get_email",
      payload: { reason: "fixture qualification" },
    }),
  });
  assert.equal(action.status, 200);
  const actionResult = (await action.json()) as Record<string, unknown>;
  const callId = actionResult.call_id;
  const actionMessageId = actionResult.message_id;
  assert.equal(typeof callId, "string");
  assert.equal(typeof actionMessageId, "string");
  assert.equal(central.messageState(actionMessageId as string), "queued");

  const actionPoll = await target.protectedFetch("/api/poll_messages?timeout=0");
  const actionMessages = ((await actionPoll.json()) as { messages: Array<Record<string, unknown>> })
    .messages;
  assert.equal(actionMessages.length, 1);
  const actionPayload = actionMessages[0]?.payload as Record<string, unknown> | undefined;
  assert.equal(actionPayload?.call_id, callId);
  assert.equal(central.messageState(actionMessageId as string), "delivered");

  const unauthorized = await requester.protectedFetch("/api/submit_action_result", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      call_id: callId,
      result: { phone_number: "+447700900001" },
      status: "success",
    }),
  });
  assert.equal(unauthorized.status, 404);

  const submitted = await target.protectedFetch("/api/submit_action_result", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      call_id: callId,
      result: { phone_number: "+447700900001" },
      status: "success",
    }),
  });
  assert.equal(submitted.status, 200);
  const submittedResult = (await submitted.json()) as Record<string, unknown>;
  assert.equal(submittedResult.call_id, callId);
  assert.equal(submittedResult.status, "completed");
  assert.equal(typeof submittedResult.message_id, "string");

  const repeatedResult = await target.protectedFetch("/api/submit_action_result", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      call_id: callId,
      result: { phone_number: "+447700900001" },
      status: "success",
    }),
  });
  assert.equal(repeatedResult.status, 409);

  const requesterPoll = await requester.protectedFetch("/api/poll_messages?timeout=0");
  const requesterMessages = (
    (await requesterPoll.json()) as { messages: Array<Record<string, unknown>> }
  ).messages;
  assert.equal(requesterMessages.length, 1);
  assert.deepEqual(requesterMessages[0]?.payload, {
    type: "action_response",
    call_id: callId,
    action_type: "get_email",
    status: "success",
    result: { phone_number: "+447700900001" },
  });
});

test("I02-F05 fixture rejects routes outside the fixed REST catalog", async (t) => {
  const central = await startFakeCentral(t);
  const client = central.seedClient("surface@fixture.test");
  assert.equal((await client.protectedFetch("/api/unknown_gateway_route")).status, 404);
});
