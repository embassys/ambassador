import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { type FixtureDpopClient, startFakeCentral } from "./support/fake-central.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";

const SENDER_START_REQUEST = "54d67b8a-b298-4e3b-923c-6f9f8ced71a5";

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function jsonInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(body),
  };
}

async function receive(
  centralUrl: string,
  client: FixtureDpopClient,
): Promise<Record<string, unknown>> {
  const response = await client.request(
    `${centralUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(response.status, 200);
  return await jsonBody(response);
}

async function rawRequest(
  target: string,
  method: "GET" | "POST",
  headers: Record<string, string | string[]>,
): Promise<{ status: number; authenticate: string | undefined }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(target, { method, headers }, (response) => {
      response.resume();
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          authenticate: response.headers["www-authenticate"],
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function callV2Tool(
  client: FixtureDpopClient,
  mcpUrl: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.request(
    mcpUrl,
    jsonInit({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  assert.equal(response.status, 200);
  return await jsonBody(response);
}

test("the Node central fixture consumes full messages and acknowledges delivered IDs", async (t) => {
  const central = await startFakeCentral(t);
  const messageId = "message_contract_01";
  const content = "content returned by the consuming REST poll";
  central.injectMessage(messageId, content);

  const client = new TestMcpClient(central.mcpUrl, "unused-local-transport-token");
  await client.initialize();
  await client.callTool("register_agent", {
    username: "fixture-agent",
    email: "fixture-agent@example.test",
  });
  const verification = await client.callTool("verify_email", {
    email: "fixture-agent@example.test",
    code: "246810",
  });
  assert.ok(verification.token === central.jwt);

  const poll = async (): Promise<Response> =>
    await fetch(`${central.apiUrl}/api/poll_messages?timeout=30`, {
      headers: { authorization: `Bearer ${central.jwt}` },
    });
  const first = await poll();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { messages: [{ id: messageId, content }] });
  assert.deepEqual(await (await poll()).json(), { messages: [] });

  const contentPoll = await client.callTool("poll_messages", {
    token: central.jwt,
    timeout: 0,
  });
  assert.deepEqual(contentPoll, { messages: [] });
  await assert.rejects(
    client.callTool("poll_messages", {
      token: central.jwt,
      timeout: 0,
      agent_id: "other-agent",
    }),
    (error: unknown) => error instanceof McpCallError,
  );

  const contentAcknowledgement = await client.callTool("ack_message", {
    token: central.jwt,
    message_id: messageId,
  });
  assert.deepEqual(contentAcknowledgement, { message_id: messageId, status: "acked" });
  await assert.rejects(
    client.callTool("ack_message", { token: central.jwt, message_id: messageId }),
    (error: unknown) => error instanceof McpCallError,
  );
});

test("the Node central fixture issues a DPoP-bound credential through REST bootstrap", async (t) => {
  const central = await startFakeCentral(t);
  const email = "rest-agent@fixture.invalid";
  const username = "rest_agent";

  const registration = await fetch(`${central.apiUrl}/api/register`, jsonInit({ email, username }));
  assert.equal(registration.status, 200);
  assert.equal(registration.headers.get("cache-control"), "no-store");
  assert.deepEqual(await registration.json(), {
    agent_id: "agent_fixture_0001",
    username,
    email,
    message: "Verification code sent.",
  });

  const client = central.createDpopClient();
  const verificationUrl = `${central.apiUrl}/api/verify_email`;
  const firstProof = client.proof("POST", verificationUrl, { accessToken: null });
  const challenge = await fetch(verificationUrl, {
    ...jsonInit({ email, code: "123456" }),
    headers: {
      "content-type": "application/json; charset=utf-8",
      dpop: firstProof,
    },
  });
  assert.equal(challenge.status, 400);
  assert.deepEqual(await challenge.json(), { error: "use_dpop_nonce" });
  const nonce = challenge.headers.get("dpop-nonce");
  assert.match(nonce ?? "", /^[A-Za-z0-9_-]{76}$/u);

  const verification = await fetch(verificationUrl, {
    ...jsonInit({ email, code: "123456" }),
    headers: {
      "content-type": "application/json; charset=utf-8",
      dpop: client.proof("POST", verificationUrl, {
        accessToken: null,
        nonce: nonce ?? "",
      }),
    },
  });
  assert.equal(verification.status, 200);
  assert.equal(verification.headers.get("cache-control"), "no-store");
  const credential = await jsonBody(verification);
  assert.equal(credential.token_type, "DPoP");
  assert.equal(credential.expires_in, 86_400);
  assert.equal(typeof credential.token, "string");
  const token = String(credential.token);
  const tokenPayload = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(tokenPayload.iss, central.v2Issuer);
  assert.deepEqual(tokenPayload.aud, central.v2Audiences);
  assert.deepEqual(tokenPayload.cnf, { jkt: client.jkt });
  assert.equal((tokenPayload.exp as number) - (tokenPayload.iat as number), 86_400);
  client.setAccessToken(token);

  const bearerDowngrade = await fetch(`${central.apiUrl}/api/poll_messages?timeout=30`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(bearerDowngrade.status, 401);

  const activation = await client.request(`${central.apiUrl}/api/v2/delivery/activate`, {
    method: "POST",
  });
  assert.equal(activation.status, 200);
  assert.deepEqual(await activation.json(), { delivery_version: "v2", status: "active" });
});

test("the Node central fixture rejects bearer, wrong-key, and replayed DPoP requests", async (t) => {
  const central = await startFakeCentral(t);
  const sender = central.seedClient("fixture_sender");
  const token = sender.accessToken;
  assert.ok(token !== undefined);
  const receiveUrl = `${central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`;

  const bearer = await fetch(receiveUrl, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(bearer.status, 401);
  assert.equal(bearer.headers.get("www-authenticate"), 'DPoP error="invalid_token"');

  const missingRestProof = await fetch(receiveUrl, {
    headers: { authorization: `DPoP ${token}` },
  });
  assert.equal(missingRestProof.status, 401);
  assert.equal(missingRestProof.headers.get("www-authenticate"), 'DPoP error="invalid_dpop_proof"');

  const duplicateProof = sender.proof("GET", receiveUrl);
  const duplicateRestProof = await rawRequest(receiveUrl, "GET", {
    Authorization: `DPoP ${token}`,
    DPoP: [duplicateProof, duplicateProof],
  });
  assert.deepEqual(duplicateRestProof, {
    status: 401,
    authenticate: 'DPoP error="invalid_dpop_proof"',
  });

  const duplicateRestAuthorization = await rawRequest(receiveUrl, "GET", {
    Authorization: [`DPoP ${token}`, `DPoP ${token}`],
    DPoP: sender.proof("GET", receiveUrl),
  });
  assert.deepEqual(duplicateRestAuthorization, {
    status: 401,
    authenticate: 'DPoP error="invalid_token"',
  });

  const missingMcpProof = await fetch(central.mcpUrl, {
    ...jsonInit({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `DPoP ${token}`,
    },
  });
  assert.equal(missingMcpProof.status, 401);
  assert.equal(missingMcpProof.headers.get("www-authenticate"), 'DPoP error="invalid_dpop_proof"');
  const duplicateMcpProofValue = sender.proof("POST", central.mcpUrl);
  const duplicateMcpProof = await rawRequest(central.mcpUrl, "POST", {
    Authorization: `DPoP ${token}`,
    DPoP: [duplicateMcpProofValue, duplicateMcpProofValue],
  });
  assert.deepEqual(duplicateMcpProof, {
    status: 401,
    authenticate: 'DPoP error="invalid_dpop_proof"',
  });
  const malformedMcpAuthorization = await fetch(central.mcpUrl, {
    ...jsonInit({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: "DPoP",
    },
  });
  assert.equal(malformedMcpAuthorization.status, 401);
  assert.equal(
    malformedMcpAuthorization.headers.get("www-authenticate"),
    'DPoP error="invalid_token"',
  );
  const duplicateMcpAuthorization = await rawRequest(central.mcpUrl, "POST", {
    Authorization: [`DPoP ${token}`, `DPoP ${token}`],
    DPoP: sender.proof("POST", central.mcpUrl),
  });
  assert.deepEqual(duplicateMcpAuthorization, {
    status: 401,
    authenticate: 'DPoP error="invalid_token"',
  });

  const otherKey = central.createDpopClient();
  const wrongKey = await fetch(receiveUrl, {
    headers: {
      authorization: `DPoP ${token}`,
      dpop: otherKey.proof("GET", receiveUrl, { accessToken: token }),
    },
  });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.headers.get("www-authenticate"), 'DPoP error="invalid_dpop_proof"');

  const oversizedHeaders = sender.headers("GET", receiveUrl);
  oversizedHeaders["x-fixture-padding"] = "x".repeat(17_000);
  const oversized = await fetch(receiveUrl, { headers: oversizedHeaders });
  assert.equal(oversized.status, 401);
  assert.equal(oversized.headers.get("www-authenticate"), 'DPoP error="invalid_token"');
  assert.equal(oversized.headers.get("dpop-nonce"), null);

  const challenge = await fetch(receiveUrl, { headers: sender.headers("GET", receiveUrl) });
  assert.equal(challenge.status, 401);
  const nonce = challenge.headers.get("dpop-nonce");
  assert.match(nonce ?? "", /^[A-Za-z0-9_-]{76}$/u);
  assert.equal(sender.jkt, "AhqHzaYXA5MzmDCrsseUsVBGKyfhDhvekx0THjH_xIE");
  assert.equal(
    nonce,
    "AQAAAABqkrcAIGl-hELy5tYmiz1PkY346IXMuY-K52pkwb2oTrzhFNuTZXj5OfxmlQW7Frx92nQJ",
  );
  const malformedTarget = `${central.apiUrl}/api/v2/messages/%ZZ/outcome`;
  const malformedEncoding = await fetch(malformedTarget, {
    headers: {
      authorization: `DPoP ${token}`,
      dpop: sender.proof("GET", malformedTarget, {
        nonce: nonce ?? "",
        htu: malformedTarget,
      }),
    },
  });
  assert.equal(malformedEncoding.status, 401);
  assert.equal(
    malformedEncoding.headers.get("www-authenticate"),
    'DPoP error="invalid_dpop_proof"',
  );
  const queryBoundProof = sender.proof("GET", receiveUrl, {
    nonce: nonce ?? "",
    htu: receiveUrl,
  });
  const queryBound = await fetch(receiveUrl, {
    headers: { authorization: `DPoP ${token}`, dpop: queryBoundProof },
  });
  assert.equal(queryBound.status, 401);
  assert.equal(queryBound.headers.get("www-authenticate"), 'DPoP error="invalid_dpop_proof"');
  const proof = sender.proof("GET", receiveUrl, { nonce: nonce ?? "" });
  const headers = { authorization: `DPoP ${token}`, dpop: proof };
  const accepted = await fetch(receiveUrl, { headers });
  assert.equal(accepted.status, 200);
  const replay = await fetch(receiveUrl, { headers });
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get("www-authenticate"), 'DPoP error="invalid_dpop_proof"');
});

test("the Node central fixture redelivers leased turns and makes terminal operations idempotent", async (t) => {
  const central = await startFakeCentral(t);
  const sender = central.seedClient("fixture_sender");
  const recipient = central.seedClient("fixture_recipient");
  const startUrl = `${central.apiUrl}/api/v2/conversations`;
  const startBody = {
    recipient_username: "fixture_recipient",
    payload: { text: "Please review the change." },
  };
  const start = await sender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": SENDER_START_REQUEST }),
  );
  assert.equal(start.status, 201);
  const accepted = await jsonBody(start);
  assert.equal(accepted.status, "accepted");
  const messageId = String(accepted.message_id);
  const conversationId = String(accepted.conversation_id);

  const repeatedStart = await sender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": SENDER_START_REQUEST }),
  );
  assert.equal(repeatedStart.status, 200);
  assert.deepEqual(await repeatedStart.json(), accepted);
  const conflictingStart = await sender.request(
    startUrl,
    jsonInit(
      { ...startBody, payload: { text: "Different text." } },
      { "idempotency-key": SENDER_START_REQUEST },
    ),
  );
  assert.equal(conflictingStart.status, 409);

  central.setConversationGrant("fixture_recipient", "fixture_sender", false);
  const cachedAfterGrantRevocation = await sender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": SENDER_START_REQUEST }),
  );
  assert.equal(cachedAfterGrantRevocation.status, 200);
  assert.deepEqual(await cachedAfterGrantRevocation.json(), accepted);
  const rejectedAfterGrantRevocation = await sender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": "54d67b8a-b298-4e3b-923c-6f9f8ced71ae" }),
  );
  assert.equal(rejectedAfterGrantRevocation.status, 404);

  const firstReceive = await receive(central.apiUrl, recipient);
  assert.deepEqual(firstReceive, {
    messages: [
      {
        id: messageId,
        conversation_id: conversationId,
        sender_agent_id: "agent_fixture_sender",
        message_type: "conversation_turn",
        in_reply_to_message_id: null,
        payload: { text: "Please review the change." },
        created_at: "2026-08-29T10:40:00.000Z",
      },
    ],
  });
  assert.deepEqual(await receive(central.apiUrl, recipient), { messages: [] });
  central.advanceClock(60);
  assert.deepEqual(await receive(central.apiUrl, recipient), firstReceive);

  const replyUrl = `${central.apiUrl}/api/v2/messages/${messageId}/reply`;
  const replyKey = `reply.v1.${createHash("sha256").update(messageId).digest("base64url")}`;
  const reply = await recipient.request(
    replyUrl,
    jsonInit({ payload: { text: "The change is ready." } }, { "idempotency-key": replyKey }),
  );
  assert.equal(reply.status, 200);
  const replyResult = await jsonBody(reply);
  assert.equal(replyResult.conversation_id, conversationId);
  const repeatedReply = await recipient.request(
    replyUrl,
    jsonInit({ payload: { text: "The change is ready." } }, { "idempotency-key": replyKey }),
  );
  assert.deepEqual(await repeatedReply.json(), replyResult);
  const conflictingReply = await recipient.request(
    replyUrl,
    jsonInit({ payload: { text: "Changed reply." } }, { "idempotency-key": replyKey }),
  );
  assert.equal(conflictingReply.status, 409);

  const outcome = await sender.request(`${central.apiUrl}/api/v2/messages/${messageId}/outcome`);
  assert.deepEqual(await outcome.json(), {
    message_id: messageId,
    conversation_id: conversationId,
    status: "terminal",
    outcome: "replied",
    reply_message_id: replyResult.message_id,
  });
  const acknowledgementUrl = `${central.apiUrl}/api/v2/messages/${messageId}/ack`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const acknowledgement = await recipient.request(acknowledgementUrl, { method: "POST" });
    assert.deepEqual(await acknowledgement.json(), { message_id: messageId, status: "acked" });
  }
  assert.equal(central.v2MessageState(messageId).acknowledged, true);

  const replyDelivery = await receive(central.apiUrl, sender);
  const deliveredReply = (replyDelivery.messages as Array<Record<string, unknown>>)[0];
  assert.equal(deliveredReply?.conversation_id, conversationId);
  assert.equal(deliveredReply?.in_reply_to_message_id, messageId);
});

test("the Node central fixture records no-reply outcomes and recovers lost start responses", async (t) => {
  const central = await startFakeCentral(t);
  const sender = central.seedClient("fixture_sender");
  const recipient = central.seedClient("fixture_recipient");
  const requestId = "54d67b8a-b298-4e3b-923c-6f9f8ced71a6";
  central.failNextV2("start", "drop_after_commit");
  await assert.rejects(
    sender.request(
      `${central.apiUrl}/api/v2/conversations`,
      jsonInit(
        {
          recipient_username: "fixture_recipient",
          payload: { text: "This response will be dropped." },
        },
        { "idempotency-key": requestId },
      ),
    ),
  );

  const lookup = await sender.request(`${central.apiUrl}/api/v2/conversation-starts/${requestId}`);
  const start = await jsonBody(lookup);
  assert.equal(start.status, "accepted");
  const messageId = String(start.message_id);
  const inbox = await receive(central.apiUrl, recipient);
  assert.equal((inbox.messages as unknown[]).length, 1);

  const completionUrl = `${central.apiUrl}/api/v2/messages/${messageId}/complete`;
  const completionBody = { outcome: "unsupported", reason_code: "unsupported_payload" };
  const completion = await recipient.request(completionUrl, jsonInit(completionBody));
  assert.deepEqual(await completion.json(), {
    message_id: messageId,
    outcome: "unsupported",
    status: "recorded",
  });
  const repeated = await recipient.request(completionUrl, jsonInit(completionBody));
  assert.equal(repeated.status, 200);
  const conflict = await recipient.request(
    completionUrl,
    jsonInit({ outcome: "failed", reason_code: "provider_execution_failed" }),
  );
  assert.equal(conflict.status, 409);

  const acknowledgement = await recipient.request(
    `${central.apiUrl}/api/v2/messages/${messageId}/ack`,
    { method: "POST" },
  );
  assert.equal(acknowledgement.status, 200);
  central.failNextV2("receive", "temporarily_unavailable");
  const unavailable = await recipient.request(
    `${central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(unavailable.status, 503);
});

test("the Node central fixture scopes start IDs and isolates reissue idempotency", async (t) => {
  const central = await startFakeCentral(t);
  const sender = central.seedClient("fixture_sender");
  const secondSender = central.seedClient("fixture_denied");
  const recipient = central.seedClient("fixture_recipient");
  central.setConversationGrant("fixture_recipient", "fixture_denied", true);
  const startUrl = `${central.apiUrl}/api/v2/conversations`;
  const sharedStartId = "54d67b8a-b298-4e3b-923c-6f9f8ced71a8";
  const startBody = {
    recipient_username: "fixture_recipient",
    payload: { text: "Subject-scoped start key." },
  };
  const firstSubjectStart = await sender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": sharedStartId }),
  );
  const secondSubjectStart = await secondSender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": sharedStartId }),
  );
  assert.equal(firstSubjectStart.status, 201);
  assert.equal(secondSubjectStart.status, 201);
  assert.notEqual(
    (await jsonBody(firstSubjectStart)).message_id,
    (await jsonBody(secondSubjectStart)).message_id,
  );

  const reissueUrl = `${central.apiUrl}/api/v2/token/reissue`;
  const startToReissueCollision = await sender.request(
    reissueUrl,
    jsonInit({}, { "idempotency-key": sharedStartId }),
  );
  assert.equal(startToReissueCollision.status, 409);

  const sharedReissueId = "54d67b8a-b298-4e3b-923c-6f9f8ced71a9";
  const firstReissue = await sender.request(
    reissueUrl,
    jsonInit({}, { "idempotency-key": sharedReissueId }),
  );
  assert.equal(firstReissue.status, 200);
  const crossSubjectReissue = await recipient.request(
    reissueUrl,
    jsonInit({}, { "idempotency-key": sharedReissueId }),
  );
  assert.equal(crossSubjectReissue.status, 409);
  const reissueToStartCollision = await sender.request(
    startUrl,
    jsonInit(startBody, { "idempotency-key": sharedReissueId }),
  );
  assert.equal(reissueToStartCollision.status, 409);
});

test("the Node central fixture reissues on the same key and rotates only through email control", async (t) => {
  const central = await startFakeCentral(t);
  const recipient = central.seedClient("fixture_recipient");
  const originalToken = recipient.accessToken;
  assert.ok(originalToken !== undefined);
  central.advanceClock(1);
  const reissueId = "54d67b8a-b298-4e3b-923c-6f9f8ced71a7";
  const reissueUrl = `${central.apiUrl}/api/v2/token/reissue`;
  const reissueInit = jsonInit({}, { "idempotency-key": reissueId });
  const firstReissue = await recipient.request(reissueUrl, reissueInit);
  assert.equal(firstReissue.status, 200);
  const replacement = await jsonBody(firstReissue);
  assert.equal(replacement.token_type, "DPoP");
  const replacementToken = String(replacement.token);
  const replacementPayload = JSON.parse(
    Buffer.from(replacementToken.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(replacementPayload.cnf, { jkt: recipient.jkt });

  const repeatedReissue = await recipient.request(reissueUrl, reissueInit);
  assert.deepEqual(await repeatedReissue.json(), replacement);

  const recoveryEmail = "fixture_recipient@fixture.invalid";
  const resend = await fetch(
    `${central.apiUrl}/api/resend_verification`,
    jsonInit({ email: recoveryEmail }),
  );
  assert.equal(resend.status, 200);
  const recoveryClient = central.createDpopClient();
  const recovery = await recoveryClient.request(
    `${central.apiUrl}/api/verify_email`,
    jsonInit({ email: recoveryEmail, code: "123456" }),
    { accessToken: null },
  );
  assert.equal(recovery.status, 200);
  const recoveredCredential = await jsonBody(recovery);
  const recoveredToken = String(recoveredCredential.token);
  const recoveredPayload = JSON.parse(
    Buffer.from(recoveredToken.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(recoveredPayload.cnf, { jkt: recoveryClient.jkt });
  assert.notEqual(recoveryClient.jkt, recipient.jkt);

  const invalidatedOldCredential = await recipient.request(
    `${central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(invalidatedOldCredential.status, 401);
  assert.equal(
    invalidatedOldCredential.headers.get("www-authenticate"),
    'DPoP error="invalid_token"',
  );

  recoveryClient.setAccessToken(recoveredToken);
  const recoveredReceive = await recoveryClient.request(
    `${central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(recoveredReceive.status, 200);

  const revocation = await recoveryClient.request(
    `${central.apiUrl}/api/v2/token/revoke`,
    jsonInit({ scope: "identity" }),
  );
  assert.equal(revocation.status, 204);
  const revokedCredential = await recoveryClient.request(
    `${central.apiUrl}/api/v2/messages/receive?timeout=0&limit=100`,
  );
  assert.equal(revokedCredential.status, 401);
});

test("the Node central fixture revokes the seeded v1 migration bearer on recovery", async (t) => {
  const central = await startFakeCentral(t);
  const legacyBearer = central.seededLegacyBearer("fixture_legacy");
  const payload = JSON.parse(
    Buffer.from(legacyBearer.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(payload.iss, central.v2Issuer);
  assert.equal(payload.sub, "agent_fixture_legacy");
  assert.deepEqual(payload.aud, central.v2Audiences);
  assert.equal(Object.hasOwn(payload, "cnf"), false);

  const pollUrl = `${central.apiUrl}/api/poll_messages?timeout=30`;
  const acceptedBeforeRecovery = await fetch(pollUrl, {
    headers: { authorization: `Bearer ${legacyBearer}` },
  });
  assert.equal(acceptedBeforeRecovery.status, 200);

  const bearerOnV2 = await fetch(`${central.apiUrl}/api/v2/delivery/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${legacyBearer}` },
  });
  assert.equal(bearerOnV2.status, 401);
  assert.equal(bearerOnV2.headers.get("www-authenticate"), 'DPoP error="invalid_token"');

  const email = "fixture_legacy@fixture.invalid";
  const resend = await fetch(`${central.apiUrl}/api/resend_verification`, jsonInit({ email }));
  assert.equal(resend.status, 200);
  const recoveryClient = central.createDpopClient();
  const recovery = await recoveryClient.request(
    `${central.apiUrl}/api/verify_email`,
    jsonInit({ email, code: "123456" }),
    { accessToken: null },
  );
  assert.equal(recovery.status, 200);

  const rejectedAfterRecovery = await fetch(pollUrl, {
    headers: { authorization: `Bearer ${legacyBearer}` },
  });
  assert.equal(rejectedAfterRecovery.status, 401);
});

test("the Node central fixture authenticates v2 MCP transport and exposes token-free tools", async (t) => {
  const central = await startFakeCentral(t);
  const sender = central.seedClient("fixture_sender");
  const recipient = central.seedClient("fixture_recipient");
  const initialize = await sender.request(
    central.mcpUrl,
    jsonInit({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  );
  assert.equal(initialize.status, 200);
  const initialized = await jsonBody(initialize);
  assert.equal(
    ((initialized.result as Record<string, unknown>).serverInfo as Record<string, unknown>).version,
    "2",
  );

  const listed = await sender.request(
    central.mcpUrl,
    jsonInit({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  );
  const listedBody = await jsonBody(listed);
  const toolList = ((listedBody.result as Record<string, unknown>).tools ?? []) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    toolList.map((definition) => definition.name),
    [
      "list_action_types",
      "request_permission",
      "respond_to_permission",
      "call_action",
      "get_my_permissions",
      "start_conversation",
      "get_conversation_start",
      "receive_messages",
      "reply_message",
      "complete_message",
      "get_message_outcome",
      "ack_message",
    ],
  );
  for (const definition of toolList) {
    const schema = definition.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    assert.equal("token" in properties, false);
  }

  const actionTypes = await callV2Tool(sender, central.mcpUrl, 3, "list_action_types", {});
  assert.deepEqual(
    ((actionTypes.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
      .action_types,
    ["fixture.echo"],
  );
  const rejectedTokenArgument = await callV2Tool(sender, central.mcpUrl, 30, "list_action_types", {
    token: "forbidden-fixture-argument",
  });
  assert.ok(rejectedTokenArgument.error !== undefined);
  const requested = await callV2Tool(sender, central.mcpUrl, 4, "request_permission", {
    target_username: "fixture_recipient",
    action_type: "fixture.echo",
    scope: { resource: "fixture" },
  });
  const requestedContent = (requested.result as Record<string, unknown>)
    .structuredContent as Record<string, unknown>;
  const permissionId = String(requestedContent.permission_id);
  assert.equal(requestedContent.status, "pending");

  const wrongResponder = await callV2Tool(sender, central.mcpUrl, 5, "respond_to_permission", {
    permission_id: permissionId,
    decision: "granted",
  });
  assert.ok(wrongResponder.error !== undefined);
  const granted = await callV2Tool(recipient, central.mcpUrl, 6, "respond_to_permission", {
    permission_id: permissionId,
    decision: "granted",
  });
  assert.equal(
    ((granted.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
      .status,
    "granted",
  );
  const permissions = await callV2Tool(sender, central.mcpUrl, 7, "get_my_permissions", {
    status: "granted",
  });
  const permissionList = (
    (permissions.result as Record<string, unknown>).structuredContent as Record<string, unknown>
  ).permissions as Array<Record<string, unknown>>;
  assert.equal(permissionList[0]?.permission_id, permissionId);

  const actionArguments = {
    target_username: "fixture_recipient",
    action_type: "fixture.echo",
    payload: { value: "fixture" },
  };
  const wrongCaller = await callV2Tool(
    recipient,
    central.mcpUrl,
    8,
    "call_action",
    actionArguments,
  );
  assert.ok(wrongCaller.error !== undefined);
  const called = await callV2Tool(sender, central.mcpUrl, 9, "call_action", actionArguments);
  const calledContent = (called.result as Record<string, unknown>).structuredContent as Record<
    string,
    unknown
  >;
  assert.equal(calledContent.status, "queued");
  assert.equal(calledContent.action_id, "action_fixture_000001");

  const token = sender.accessToken;
  assert.ok(token !== undefined);
  const oversizedMcpHeaders = sender.headers("POST", central.mcpUrl);
  oversizedMcpHeaders["x-fixture-padding"] = "x".repeat(17_000);
  const oversizedMcp = await fetch(central.mcpUrl, {
    ...jsonInit({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...oversizedMcpHeaders,
    },
  });
  assert.equal(oversizedMcp.status, 401);
  assert.equal(oversizedMcp.headers.get("www-authenticate"), 'DPoP error="invalid_token"');
  assert.equal(oversizedMcp.headers.get("dpop-nonce"), null);

  const bearer = await fetch(central.mcpUrl, {
    ...jsonInit({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(bearer.status, 401);
});
