import assert from "node:assert/strict";
import test from "node:test";

import {
  K02_TOKEN,
  k02Message,
  k02RawHead,
  k02ResponseStatus,
  k02WakeBody,
  k02WakeHeaders,
  ManualK02Clock,
  openK02Socket,
  readK02Response,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

async function exchange(webhookUrl: string, request: string | Buffer): Promise<Buffer> {
  const socket = await openK02Socket(webhookUrl);
  socket.end(request);
  return await readK02Response(socket);
}

function responseParts(response: Buffer): {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
} {
  const separator = response.indexOf("\r\n\r\n");
  assert.ok(separator >= 0, "HTTP response omitted its header terminator");
  const lines = response.subarray(0, separator).toString("ascii").split("\r\n").slice(1);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, "HTTP response contained a malformed header");
    const name = line.slice(0, colon).toLowerCase();
    assert.equal(headers[name], undefined, `HTTP response repeated ${name}`);
    headers[name] = line.slice(colon + 1).trim();
  }
  return { headers, body: response.subarray(separator + 4) };
}

function assertCanonicalJsonResponse(response: Buffer, status: number, body: string): void {
  assert.equal(k02ResponseStatus(response), status);
  const parsed = responseParts(response);
  assert.deepEqual(parsed.headers, {
    "cache-control": "no-store",
    connection: "close",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json",
  });
  assert.deepEqual(parsed.body, Buffer.from(body));
}

function assertTruncatedCanonicalJsonResponse(
  response: Buffer,
  status: number,
  body: string,
): void {
  assert.equal(k02ResponseStatus(response), status);
  const parsed = responseParts(response);
  assert.equal(parsed.headers["cache-control"], "no-store");
  assert.equal(parsed.headers.connection, "close");
  assert.equal(parsed.headers["content-type"], "application/json");
  assert.equal(parsed.headers["content-length"], String(Buffer.byteLength(body)));
  assert.ok(parsed.body.byteLength < Buffer.byteLength(body), "response body was not truncated");
  assert.ok(Buffer.from(body).subarray(0, parsed.body.byteLength).equals(parsed.body));
}

test("K02-W01 enforces exact request-line and header-block byte boundaries", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W01");
  const id = "wire_boundary";
  const body = k02WakeBody(id);
  const headers = k02WakeHeaders(
    scenario.connector.webhookUrl,
    id,
    Math.floor(Date.now() / 1_000),
    body,
  );
  const prefix = "POST /webhook?";
  const suffix = " HTTP/1.1";
  const exactLine = `${prefix}${"q".repeat(2_048 - prefix.length - suffix.length)}${suffix}`;
  assert.equal(Buffer.byteLength(exactLine), 2_048);
  assert.equal(
    k02ResponseStatus(
      await exchange(scenario.connector.webhookUrl, k02RawHead(exactLine, headers)),
    ),
    404,
  );
  assert.equal(
    k02ResponseStatus(
      await exchange(scenario.connector.webhookUrl, k02RawHead(`${exactLine}q`, headers)),
    ),
    414,
  );

  const baseBytes = Buffer.byteLength(
    Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join(""),
  );
  const fill = "x".repeat(16_384 - baseBytes - Buffer.byteLength("X-Fill: \r\n\r\n"));
  const exactHeaders = { ...headers, "X-Fill": fill };
  const exactHeaderBlock = k02RawHead("POST /webhook HTTP/1.1", exactHeaders).split(
    "POST /webhook HTTP/1.1\r\n",
  )[1];
  assert.equal(Buffer.byteLength(exactHeaderBlock ?? ""), 16_384);
  assert.equal(
    k02ResponseStatus(
      await exchange(
        scenario.connector.webhookUrl,
        `${k02RawHead("POST /webhook HTTP/1.1", exactHeaders)}${body}`,
      ),
    ),
    202,
  );
  assert.equal(
    k02ResponseStatus(
      await exchange(
        scenario.connector.webhookUrl,
        k02RawHead("POST /webhook HTTP/1.1", { ...headers, "X-Fill": `${fill}x` }),
      ),
    ),
    431,
  );
});

test("K02-W02 enforces timestamp syntax and exact past and future windows", async (t) => {
  const now = 1_788_000_000;
  const clock = new ManualK02Clock(now * 1_000);
  const scenario = await startK02Scenario(t, "K02-K03:W02", { clock });
  const vectors = [
    [String(now - 300), 202],
    [String(now + 5), 202],
    [String(now - 301), 400],
    [String(now + 6), 400],
    ["00", 400],
    ["1000000000000", 400],
    ["253402300800", 400],
  ] as const;
  for (const [index, [timestamp, expected]] of vectors.entries()) {
    const id = `timestamp_${index}`;
    const body = k02WakeBody(id);
    const headers = k02WakeHeaders(scenario.connector.webhookUrl, id, Number(timestamp), body);
    headers["X-Webhook-Timestamp"] = timestamp;
    assert.equal(
      k02ResponseStatus(
        await exchange(
          scenario.connector.webhookUrl,
          `${k02RawHead("POST /webhook HTTP/1.1", headers)}${body}`,
        ),
      ),
      expected,
    );
  }
});

test("K02-W03 rejects an exact live signature replay before parsing or dispatch", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W03");
  const timestamp = Math.floor(Date.now() / 1_000);
  assert.equal((await scenario.wake("message_replay", timestamp)).status, 202);
  assert.equal((await scenario.wake("message_replay", timestamp)).status, 409);
  assert.equal(scenario.provider.requests.length, 0);
});

test("K02-W04 retains 4096 replay pairs and admits a new pair only after expiry", async (t) => {
  const now = 1_788_000_000;
  const clock = new ManualK02Clock(now * 1_000);
  const scenario = await startK02Scenario(t, "K02-K03:W04", { clock });
  for (let index = 0; index < 4_096; index += 1) {
    const id = `replay_${index}`;
    const body = `{${index}`;
    const headers = k02WakeHeaders(scenario.connector.webhookUrl, id, now, body);
    assert.equal(
      k02ResponseStatus(
        await exchange(
          scenario.connector.webhookUrl,
          `${k02RawHead("POST /webhook HTTP/1.1", headers)}${body}`,
        ),
      ),
      400,
    );
  }
  const fullBody = "{full";
  const fullHeaders = k02WakeHeaders(scenario.connector.webhookUrl, "replay_full", now, fullBody);
  const full = await exchange(
    scenario.connector.webhookUrl,
    `${k02RawHead("POST /webhook HTTP/1.1", fullHeaders)}${fullBody}`,
  );
  assert.equal(k02ResponseStatus(full), 503);
  assert.ok(full.toString("utf8").includes("connector_replay_capacity"));
  clock.advance(301_000);
  const expiredBody = "{expired";
  const expiredHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    "replay_expired",
    now + 301,
    expiredBody,
  );
  assert.equal(
    k02ResponseStatus(
      await exchange(
        scenario.connector.webhookUrl,
        `${k02RawHead("POST /webhook HTTP/1.1", expiredHeaders)}${expiredBody}`,
      ),
    ),
    400,
  );
});

test("K02-W05 accepts exactly 1 MiB and rejects a declared one-over body before reading", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W05");
  const id = "body_boundary";
  const base = k02WakeBody(id);
  const body = `${base}${" ".repeat(1_048_576 - Buffer.byteLength(base))}`;
  const headers = k02WakeHeaders(
    scenario.connector.webhookUrl,
    id,
    Math.floor(Date.now() / 1_000),
    body,
  );
  assert.equal(
    k02ResponseStatus(
      await exchange(
        scenario.connector.webhookUrl,
        Buffer.concat([
          Buffer.from(k02RawHead("POST /webhook HTTP/1.1", headers), "ascii"),
          Buffer.from(body),
        ]),
      ),
    ),
    202,
  );
  const socket = await openK02Socket(scenario.connector.webhookUrl);
  socket.write(k02RawHead("POST /webhook HTTP/1.1", { ...headers, "Content-Length": "1048577" }));
  assert.equal(k02ResponseStatus(await readK02Response(socket)), 413);
  assert.ok(socket.bytesWritten < 1_048_577);
});

test("K02-W06 verifies HMAC before strict JSON and correlation validation", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W06");
  const bodies = ["{not-json", '{"name":"a","name":"b"}', '{"unknown":true}'];
  for (const [index, body] of bodies.entries()) {
    const id = `invalid_json_${index}`;
    const headers = k02WakeHeaders(
      scenario.connector.webhookUrl,
      id,
      Math.floor(Date.now() / 1_000),
      body,
    );
    const response = await exchange(
      scenario.connector.webhookUrl,
      `${k02RawHead("POST /webhook HTTP/1.1", headers)}${body}`,
    );
    assert.equal(k02ResponseStatus(response), 400);
    assert.ok(response.toString("utf8").includes("connector_wake_invalid"));
  }
  const mismatchBodyId = "w06_body_id";
  const mismatchBody = k02WakeBody(mismatchBodyId);
  for (const [headerName, headerValue] of [
    ["Idempotency-Key", "w06_wrong_header_id"],
    ["X-Request-ID", "w06_wrong_request_id"],
  ] as const) {
    const headers = k02WakeHeaders(
      scenario.connector.webhookUrl,
      mismatchBodyId,
      Math.floor(Date.now() / 1_000),
      mismatchBody,
    );
    headers[headerName] = headerValue;
    const response = await exchange(
      scenario.connector.webhookUrl,
      `${k02RawHead("POST /webhook HTTP/1.1", headers)}${mismatchBody}`,
    );
    assertCanonicalJsonResponse(response, 400, '{"error":"connector_wake_invalid"}');
  }
  const headerId = "w06_header_id";
  const bodyId = "w06_different_body_id";
  const bodyMismatch = k02WakeBody(bodyId);
  const bodyMismatchHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    headerId,
    Math.floor(Date.now() / 1_000),
    bodyMismatch,
  );
  assertCanonicalJsonResponse(
    await exchange(
      scenario.connector.webhookUrl,
      `${k02RawHead("POST /webhook HTTP/1.1", bodyMismatchHeaders)}${bodyMismatch}`,
    ),
    400,
    '{"error":"connector_wake_invalid"}',
  );
  assert.equal(scenario.provider.requests.length, 0);
  assert.equal(scenario.gateway.calls.length, 0);
});

test("K02-W07 coalesces both queued and active repeats without duplicate turns", async (t) => {
  const waiting = (suffix: string) =>
    [
      { kind: "session", provider_session_id: `session_${suffix}` },
      { kind: "turn", provider_turn_id: `turn_${suffix}` },
      { kind: "wait_for_cancel" },
    ] as const;
  const scenario = await startK02Scenario(t, "K02-K03:W07", {
    scripts: [waiting("one"), waiting("two"), waiting("three")],
  });
  for (const message of [
    k02Message("active_1", "conversation_1"),
    k02Message("active_2", "conversation_2"),
    k02Message("queued_1", "conversation_3"),
  ]) {
    scenario.enqueue(message);
  }
  const now = Math.floor(Date.now() / 1_000);
  assert.equal((await scenario.wake("active_1", now)).status, 202);
  assert.equal((await scenario.wake("active_2", now)).status, 202);
  await waitFor(() => scenario.provider.activeExecutionCount === 2, "two active turns");
  assert.equal((await scenario.wake("active_1", now + 1)).status, 202);
  assert.equal((await scenario.wake("queued_1", now)).status, 202);
  assert.equal((await scenario.wake("queued_1", now + 1)).status, 202);
  const first = scenario.provider.requests[0];
  assert.ok(first !== undefined);
  await scenario.providerPort.cancel({
    kind: "cancel",
    execution_id: first.execution_id,
    provider_session_id: null,
    provider_turn_id: null,
    reason: "shutdown",
  });
  await waitFor(() => scenario.provider.requests.length === 3, "queued turn");
  assert.deepEqual(
    scenario.provider.requests.map((request) => request.message_id),
    ["active_1", "active_2", "queued_1"],
  );
});

test("K02-W08 applies non-resetting header and request deadlines to stalls", async (t) => {
  const clock = new ManualK02Clock(1_788_700_000_000);
  const scenario = await startK02Scenario(t, "K02-K03:W08", { clock });
  const empty = await openK02Socket(scenario.connector.webhookUrl);
  const emptyResponse = readK02Response(empty);
  clock.advance(2_000);
  assert.equal((await emptyResponse).byteLength, 0);
  const headerId = "header_timeout_auth_independent";
  const headerBody = k02WakeBody(headerId);
  const validHeaderBlock = k02RawHead(
    "POST /webhook HTTP/1.1",
    k02WakeHeaders(
      scenario.connector.webhookUrl,
      headerId,
      Math.floor(clock.nowMs() / 1_000),
      headerBody,
    ),
  ).slice(0, -2);
  const invalidHeaderBlock = validHeaderBlock.replace(
    `Bearer ${K02_TOKEN}`,
    `Bearer ${"f".repeat(48)}`,
  );
  const invalidSignatureHeaderBlock = validHeaderBlock.replace(
    /X-Webhook-Signature-V2: [0-9a-f]{64}/u,
    `X-Webhook-Signature-V2: ${"f".repeat(64)}`,
  );
  const headerVariants = [validHeaderBlock, invalidHeaderBlock, invalidSignatureHeaderBlock];
  const requestLineSockets = await Promise.all(
    headerVariants.map(async () => {
      const socket = await openK02Socket(scenario.connector.webhookUrl);
      socket.write("P");
      return socket;
    }),
  );
  clock.advance(1_999);
  for (const [index, socket] of requestLineSockets.entries()) {
    socket.write(headerVariants[index]?.slice(1) ?? "");
  }
  const requestLineResponses = requestLineSockets.map(
    async (socket) => await readK02Response(socket),
  );
  clock.advance(1);
  for (const response of requestLineResponses) assert.equal((await response).byteLength, 0);
  const headerSockets = await Promise.all(
    headerVariants.map(async (block) => {
      const socket = await openK02Socket(scenario.connector.webhookUrl);
      socket.write(block);
      return socket;
    }),
  );
  clock.advance(1_999);
  for (const socket of headerSockets) socket.write("X");
  const headerResponses = headerSockets.map(async (socket) => await readK02Response(socket));
  clock.advance(1);
  for (const response of headerResponses) assert.equal((await response).byteLength, 0);
  const held = await openK02Socket(scenario.connector.webhookUrl);
  assert.equal(clock.pendingTimerCountForTest(), 2);
  const id = "held_body";
  const body = k02WakeBody(id);
  held.write(
    k02RawHead(
      "POST /webhook HTTP/1.1",
      k02WakeHeaders(scenario.connector.webhookUrl, id, Math.floor(clock.nowMs() / 1_000), body),
    ),
  );
  await waitFor(() => clock.pendingTimerCountForTest() === 1, "held body request parsed");
  clock.advance(4_999);
  held.write("{");
  const heldResponse = readK02Response(held);
  clock.advance(1);
  assert.equal((await heldResponse).byteLength, 0);
  await waitFor(() => clock.pendingTimerCountForTest() === 0, "held body request closed");
  const invalidBearer = await openK02Socket(scenario.connector.webhookUrl);
  invalidBearer.write(
    k02RawHead("POST /webhook HTTP/1.1", {
      ...k02WakeHeaders(
        scenario.connector.webhookUrl,
        "held_invalid_bearer",
        Math.floor(clock.nowMs() / 1_000),
      ),
      Authorization: `Bearer ${"f".repeat(48)}`,
    }),
  );
  assert.equal(k02ResponseStatus(await readK02Response(invalidBearer)), 401);
  await waitFor(() => clock.pendingTimerCountForTest() === 0, "invalid-bearer request closed");
  const invalidSignatureId = "held_invalid_signature";
  const invalidSignatureBody = k02WakeBody(invalidSignatureId);
  const invalidSignature = await openK02Socket(scenario.connector.webhookUrl);
  assert.equal(clock.pendingTimerCountForTest(), 2);
  invalidSignature.write(
    k02RawHead("POST /webhook HTTP/1.1", {
      ...k02WakeHeaders(
        scenario.connector.webhookUrl,
        invalidSignatureId,
        Math.floor(clock.nowMs() / 1_000),
        invalidSignatureBody,
      ),
      "X-Webhook-Signature-V2": "f".repeat(64),
    }),
  );
  await waitFor(() => clock.pendingTimerCountForTest() === 1, "invalid-signature request parsed");
  clock.advance(4_999);
  invalidSignature.write(invalidSignatureBody.slice(0, -1));
  const invalidSignatureResponse = readK02Response(invalidSignature);
  clock.advance(1);
  assert.equal((await invalidSignatureResponse).byteLength, 0);
  await waitFor(() => clock.pendingTimerCountForTest() === 0, "invalid-signature request closed");
  assert.equal(scenario.provider.requests.length, 0);
  assert.equal(scenario.gateway.calls.length, 0);
  assert.deepEqual(scenario.connector.inspectAdmissionStateForTest(), {
    queuedIds: [],
    activeIds: [],
    replayEntries: 0,
  });

  const committedClock = new ManualK02Clock(1_788_800_000_000);
  const committed = await startK02Scenario(t, "K02-K03:W08", {
    clock: committedClock,
    stallWebhookResponseAfterCommit: true,
  });
  const committedId = "committed_response_stall";
  const committedBody = k02WakeBody(committedId);
  const committedSocket = await openK02Socket(committed.connector.webhookUrl);
  committedSocket.end(
    `${k02RawHead(
      "POST /webhook HTTP/1.1",
      k02WakeHeaders(
        committed.connector.webhookUrl,
        committedId,
        Math.floor(committedClock.nowMs() / 1_000),
        committedBody,
      ),
    )}${committedBody}`,
  );
  const truncated = readK02Response(committedSocket);
  await waitFor(() => committedSocket.bytesRead > 0, "committed response prefix");
  committedClock.advance(5_000);
  const truncatedBytes = await truncated;
  assertTruncatedCanonicalJsonResponse(truncatedBytes, 202, '{"status":"accepted"}');
  await committed.connector.waitForIdle();
  assert.equal(committed.gateway.calls.filter((call) => call.name === "poll_messages").length, 1);
  assert.deepEqual(committed.connector.inspectAdmissionStateForTest(), {
    queuedIds: [],
    activeIds: [],
    replayEntries: 1,
  });

  const rejectedClock = new ManualK02Clock(1_788_900_000_000);
  const rejected = await startK02Scenario(t, "K02-K03:W08", {
    clock: rejectedClock,
    stallWebhookResponseAfterCommit: true,
  });
  const rejectedId = "rejected_response_stall";
  const rejectedBody = k02WakeBody(rejectedId);
  const rejectedSocket = await openK02Socket(rejected.connector.webhookUrl);
  rejectedSocket.write(
    k02RawHead("POST /webhook HTTP/1.1", {
      ...k02WakeHeaders(
        rejected.connector.webhookUrl,
        rejectedId,
        Math.floor(rejectedClock.nowMs() / 1_000),
        rejectedBody,
      ),
      Authorization: `Bearer ${"f".repeat(48)}`,
    }),
  );
  const rejectedResponse = readK02Response(rejectedSocket);
  await waitFor(() => rejectedSocket.bytesRead > 0, "rejected response prefix");
  rejectedClock.advance(5_000);
  assertTruncatedCanonicalJsonResponse(
    await rejectedResponse,
    401,
    '{"error":"connector_auth_failed"}',
  );
  assert.equal(rejected.gateway.calls.length, 0);
  assert.deepEqual(rejected.connector.inspectAdmissionStateForTest(), {
    queuedIds: [],
    activeIds: [],
    replayEntries: 0,
  });

  const rejectedSignatureClock = new ManualK02Clock(1_789_000_000_000);
  const rejectedSignature = await startK02Scenario(t, "K02-K03:W08", {
    clock: rejectedSignatureClock,
    stallWebhookResponseAfterCommit: true,
  });
  const rejectedSignatureId = "rejected_signature_response_stall";
  const rejectedSignatureBody = k02WakeBody(rejectedSignatureId);
  const rejectedSignatureSocket = await openK02Socket(rejectedSignature.connector.webhookUrl);
  rejectedSignatureSocket.end(
    `${k02RawHead("POST /webhook HTTP/1.1", {
      ...k02WakeHeaders(
        rejectedSignature.connector.webhookUrl,
        rejectedSignatureId,
        Math.floor(rejectedSignatureClock.nowMs() / 1_000),
        rejectedSignatureBody,
      ),
      "X-Webhook-Signature-V2": "f".repeat(64),
    })}${rejectedSignatureBody}`,
  );
  const rejectedSignatureResponse = readK02Response(rejectedSignatureSocket);
  await waitFor(() => rejectedSignatureSocket.bytesRead > 0, "rejected signature response prefix");
  rejectedSignatureClock.advance(5_000);
  assertTruncatedCanonicalJsonResponse(
    await rejectedSignatureResponse,
    401,
    '{"error":"connector_auth_failed"}',
  );
  assert.equal(rejectedSignature.gateway.calls.length, 0);
  assert.deepEqual(rejectedSignature.connector.inspectAdmissionStateForTest(), {
    queuedIds: [],
    activeIds: [],
    replayEntries: 0,
  });
});

test("K02-W09 enforces 32 socket and 16 parsed-request capacity limits", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W09");
  const sockets = await Promise.all(
    Array.from({ length: 32 }, async () => await openK02Socket(scenario.connector.webhookUrl)),
  );
  const socket33 = await openK02Socket(scenario.connector.webhookUrl);
  assert.equal((await readK02Response(socket33, 1_000)).byteLength, 0);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 25));

  const parsed = [];
  for (let index = 0; index < 16; index += 1) {
    const socket = await openK02Socket(scenario.connector.webhookUrl);
    const id = `parsed_${index}`;
    const body = k02WakeBody(id);
    socket.write(
      k02RawHead(
        "POST /webhook HTTP/1.1",
        k02WakeHeaders(scenario.connector.webhookUrl, id, Math.floor(Date.now() / 1_000), body),
      ),
    );
    parsed.push(socket);
  }
  const seventeenth = await openK02Socket(scenario.connector.webhookUrl);
  const id = "parsed_17";
  const body = k02WakeBody(id);
  seventeenth.end(
    k02RawHead(
      "POST /webhook HTTP/1.1",
      k02WakeHeaders(scenario.connector.webhookUrl, id, Math.floor(Date.now() / 1_000), body),
    ),
  );
  assert.equal(k02ResponseStatus(await readK02Response(seventeenth)), 503);
  for (const socket of parsed) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const releasedId = "parsed_capacity_released";
  const releasedBody = k02WakeBody(releasedId);
  assertCanonicalJsonResponse(
    await exchange(
      scenario.connector.webhookUrl,
      `${k02RawHead(
        "POST /webhook HTTP/1.1",
        k02WakeHeaders(
          scenario.connector.webhookUrl,
          releasedId,
          Math.floor(Date.now() / 1_000),
          releasedBody,
        ),
      )}${releasedBody}`,
    ),
    202,
    '{"status":"accepted"}',
  );
});

test("K02-W10 rejects ambiguous framing, buffered surplus, and pipelining", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W10");
  const id = "framing";
  const body = k02WakeBody(id);
  const headers = k02WakeHeaders(
    scenario.connector.webhookUrl,
    id,
    Math.floor(Date.now() / 1_000),
    body,
  );
  const duplicateLength = k02RawHead("POST /webhook HTTP/1.1", {
    ...headers,
    "Content-Length": `${headers["Content-Length"]}\r\ncontent-length: ${headers["Content-Length"]}`,
  });
  const conflictingLength = k02RawHead("POST /webhook HTTP/1.1", {
    ...headers,
    "Content-Length": `${headers["Content-Length"]}\r\nCoNtEnT-LeNgTh: ${Number(headers["Content-Length"]) + 1}`,
  });
  const transfers = ["chunked", "identity", "gzip", "chunked, gzip"].map((value) =>
    k02RawHead("POST /webhook HTTP/1.1", { ...headers, "Transfer-Encoding": value }),
  );
  const forbiddenHeaders = [
    { Trailer: "X-Late" },
    { Expect: "100-continue" },
    { Upgrade: "websocket" },
    { TE: "trailers" },
    { "Proxy-Connection": "keep-alive" },
  ].map((extra) => k02RawHead("POST /webhook HTTP/1.1", { ...headers, ...extra }));
  const folded = k02RawHead("POST /webhook HTTP/1.1", {
    ...headers,
    "X-Fold": "first\r\n second",
  });
  const bareCr = k02RawHead("POST /webhook\rHTTP/1.1", headers);
  const bareLf = k02RawHead("POST /webhook\nHTTP/1.1", headers);
  const surplus = `${k02RawHead("POST /webhook HTTP/1.1", headers)}${body}x`;
  const pipeline = `${k02RawHead("POST /webhook HTTP/1.1", headers)}${body}${k02RawHead(
    "POST /webhook HTTP/1.1",
    headers,
  )}${body}`;
  const noLength = k02RawHead("POST /webhook HTTP/1.1", {
    ...headers,
    "Content-Length": "",
  });
  for (const request of [
    duplicateLength,
    conflictingLength,
    ...transfers,
    ...forbiddenHeaders,
    folded,
    bareCr,
    bareLf,
    noLength,
    surplus,
    pipeline,
  ]) {
    assert.equal(k02ResponseStatus(await exchange(scenario.connector.webhookUrl, request)), 400);
  }

  const early = await openK02Socket(scenario.connector.webhookUrl);
  early.end(
    `${k02RawHead("POST /webhook HTTP/1.1", {
      ...headers,
      "Content-Length": String(Number(headers["Content-Length"]) + 1),
    })}${body}`,
  );
  assertCanonicalJsonResponse(
    await readK02Response(early),
    400,
    '{"error":"connector_framing_invalid"}',
  );

  const lateId = "framing_late_surplus";
  const lateBody = k02WakeBody(lateId);
  const lateHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    lateId,
    Math.floor(Date.now() / 1_000),
    lateBody,
  );
  const late = await openK02Socket(scenario.connector.webhookUrl);
  late.write(`${k02RawHead("POST /webhook HTTP/1.1", lateHeaders)}${lateBody}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  late.end("late-surplus");
  const lateResponse = await readK02Response(late);
  assert.equal(k02ResponseStatus(lateResponse), 202);
  assert.equal(lateResponse.toString("ascii").match(/HTTP\/1\.1/gu)?.length, 1);

  const keepAliveId = "framing_keep_alive";
  const keepAliveBody = k02WakeBody(keepAliveId);
  const keepAliveHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    keepAliveId,
    Math.floor(Date.now() / 1_000),
    keepAliveBody,
  );
  const keepAlive = await openK02Socket(scenario.connector.webhookUrl);
  const secondKeepAliveId = "framing_keep_alive_second";
  const secondKeepAliveBody = k02WakeBody(secondKeepAliveId);
  const secondKeepAliveHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    secondKeepAliveId,
    Math.floor(Date.now() / 1_000),
    secondKeepAliveBody,
  );
  let secondRequestWritten = false;
  keepAlive.once("data", () => {
    secondRequestWritten = true;
    keepAlive.write(
      `${k02RawHead("POST /webhook HTTP/1.1", secondKeepAliveHeaders)}${secondKeepAliveBody}`,
    );
  });
  const keepAliveResponsePromise = readK02Response(keepAlive);
  keepAlive.write(
    `${k02RawHead("POST /webhook HTTP/1.1", {
      ...keepAliveHeaders,
      Connection: "keep-alive",
    })}${keepAliveBody}`,
  );
  const keepAliveResponse = await keepAliveResponsePromise;
  assert.equal(secondRequestWritten, true);
  assert.equal(k02ResponseStatus(keepAliveResponse), 202);
  assert.equal(keepAliveResponse.toString("ascii").match(/HTTP\/1\.1/gu)?.length, 1);
  assert.equal(scenario.provider.requests.length, 0);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.gateway.calls.filter((call) => call.name === "poll_messages").length, 2);
  assert.deepEqual(scenario.connector.inspectAdmissionStateForTest(), {
    queuedIds: [],
    activeIds: [],
    replayEntries: 2,
  });
});

test("K02-W11 validates method, Host, Origin, media, bearer, and HMAC before body", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:W11");
  const id = "admission";
  const body = k02WakeBody(id);
  const base = k02WakeHeaders(
    scenario.connector.webhookUrl,
    id,
    Math.floor(Date.now() / 1_000),
    body,
  );
  const stale = k02WakeHeaders(
    scenario.connector.webhookUrl,
    id,
    Math.floor(Date.now() / 1_000) - 301,
    body,
  );
  const vectors = [
    ["GET /webhook HTTP/1.1", base, 405],
    ["POST /webhook HTTP/1.1", { ...base, Host: "localhost:9999" }, 421],
    ["POST /webhook HTTP/1.1", { ...base, Origin: "http://localhost:9999" }, 403],
    ["POST /webhook HTTP/1.1", { ...base, "Content-Type": "application/json; charset=utf-8" }, 400],
    ["POST /webhook HTTP/1.1", stale, 400],
    ["POST /webhook HTTP/1.1", { ...base, "Transfer-Encoding": "chunked" }, 400],
    [
      "POST /webhook HTTP/1.1",
      { ...base, "Content-Length": `${base["Content-Length"]}\r\ncontent-length: 1` },
      400,
    ],
    ["POST /webhook HTTP/1.1", { ...base, "Content-Length": "1048577" }, 413],
    ["POST /webhook HTTP/1.1", { ...base, Authorization: `Bearer ${"f".repeat(48)}` }, 401],
    ["POST /webhook HTTP/1.1", { ...base, Authorization: `Bearer  ${K02_TOKEN}` }, 401],
  ] as const;
  for (const [line, headers, expected] of vectors) {
    const held = await openK02Socket(scenario.connector.webhookUrl);
    held.write(k02RawHead(line, headers));
    assert.equal(k02ResponseStatus(await readK02Response(held, 1_000)), expected);
  }

  for (const [name, value] of [
    ["Host", base.Host],
    ["Origin", new URL(scenario.connector.webhookUrl).origin],
    ["Content-Type", base["Content-Type"]],
    ["Content-Length", base["Content-Length"]],
    ["Authorization", `Bearer ${K02_TOKEN}`],
    ["X-Webhook-Timestamp", base["X-Webhook-Timestamp"]],
    ["X-Webhook-Signature-V2", base["X-Webhook-Signature-V2"]],
    ["Idempotency-Key", id],
    ["X-Request-ID", id],
  ] as const) {
    const duplicate = await exchange(
      scenario.connector.webhookUrl,
      k02RawHead("POST /webhook HTTP/1.1", {
        ...base,
        [name]: `${value}\r\n${name.toLowerCase()}: ${value}`,
      }),
    );
    assert.equal(k02ResponseStatus(duplicate), 400);
  }

  const edgeId = "admission_ows";
  const edgeBody = k02WakeBody(edgeId);
  const edgeHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    edgeId,
    Math.floor(Date.now() / 1_000),
    edgeBody,
  );
  edgeHeaders.Host = ` ${edgeHeaders.Host}\t`;
  edgeHeaders.Origin = `\t${new URL(scenario.connector.webhookUrl).origin} `;
  edgeHeaders.Authorization = ` \tBearer ${K02_TOKEN}\t `;
  edgeHeaders["Content-Type"] = "\tapplication/json ";
  edgeHeaders["Content-Length"] = ` ${edgeHeaders["Content-Length"]}\t`;
  edgeHeaders["Idempotency-Key"] = ` ${edgeId}\t`;
  edgeHeaders["X-Request-ID"] = `\t${edgeId} `;
  edgeHeaders["X-Webhook-Timestamp"] = ` ${edgeHeaders["X-Webhook-Timestamp"]}\t`;
  edgeHeaders["X-Webhook-Signature-V2"] = ` ${edgeHeaders["X-Webhook-Signature-V2"]}\t`;
  assert.equal(
    k02ResponseStatus(
      await exchange(
        scenario.connector.webhookUrl,
        `${k02RawHead("POST /webhook HTTP/1.1", edgeHeaders)}${edgeBody}`,
      ),
    ),
    202,
  );
  const badBearerToken = "f".repeat(48);
  const badBearerId = "admission_bad_bearer_id_sentinel";
  const badBearerBody = k02WakeBody(badBearerId);
  const badBearerHeaders = k02WakeHeaders(
    scenario.connector.webhookUrl,
    badBearerId,
    Math.floor(Date.now() / 1_000),
    badBearerBody,
  );
  badBearerHeaders.Authorization = `Bearer ${badBearerToken}`;
  const badBearerSocket = await openK02Socket(scenario.connector.webhookUrl);
  badBearerSocket.write(k02RawHead("POST /webhook HTTP/1.1", badBearerHeaders));
  const badBearer = await readK02Response(badBearerSocket);

  const badHmacId = "admission_bad_hmac_id_sentinel";
  const badHmacBody = k02WakeBody(badHmacId);
  const badHmacSignature = "e".repeat(64);
  const badHmac = await exchange(
    scenario.connector.webhookUrl,
    `${k02RawHead("POST /webhook HTTP/1.1", {
      ...k02WakeHeaders(
        scenario.connector.webhookUrl,
        badHmacId,
        Math.floor(Date.now() / 1_000),
        badHmacBody,
      ),
      "X-Webhook-Signature-V2": badHmacSignature,
    })}${badHmacBody}`,
  );
  const authBody = '{"error":"connector_auth_failed"}';
  assertCanonicalJsonResponse(badBearer, 401, authBody);
  assertCanonicalJsonResponse(badHmac, 401, authBody);
  assert.deepEqual(badBearer, badHmac);
  for (const sentinel of [
    K02_TOKEN,
    badBearerToken,
    badBearerId,
    badBearerHeaders["X-Webhook-Signature-V2"],
    badBearerBody,
    badHmacId,
    badHmacSignature,
    badHmacBody,
  ]) {
    assert.ok(sentinel !== undefined);
    assert.equal(badBearer.includes(Buffer.from(sentinel)), false);
    assert.equal(badHmac.includes(Buffer.from(sentinel)), false);
  }
  for (const [name, value, expected] of [
    ["Host", (base.Host ?? "").replace(":", " :"), 421],
    ["Origin", "http://127.0.0.1 :1", 403],
    ["Content-Type", "application /json", 400],
    ["Content-Length", `${base["Content-Length"]} 0`, 400],
    ["Authorization", `Bearer  ${K02_TOKEN}`, 401],
    ["Idempotency-Key", "ad mission", 400],
    ["X-Request-ID", "ad mission", 400],
    ["X-Webhook-Timestamp", `${base["X-Webhook-Timestamp"]} 0`, 400],
    ["X-Webhook-Signature-V2", `${base["X-Webhook-Signature-V2"]} 0`, 401],
  ] as const) {
    const response = await exchange(
      scenario.connector.webhookUrl,
      k02RawHead("POST /webhook HTTP/1.1", { ...base, [name]: value }),
    );
    assert.equal(k02ResponseStatus(response), expected);
  }
  assert.equal(scenario.provider.requests.length, 0);
  await scenario.connector.waitForIdle();
  assert.equal(scenario.gateway.calls.filter((call) => call.name === "poll_messages").length, 1);
  assert.deepEqual(scenario.connector.inspectAdmissionStateForTest(), {
    queuedIds: [],
    activeIds: [],
    replayEntries: 1,
  });
});
