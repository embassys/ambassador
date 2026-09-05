import assert from "node:assert/strict";
import { test } from "node:test";
import { readCentralJson } from "../src/central-json.js";

import {
  createVerboseLogger,
  describeVerboseError,
  redactVerboseValue,
  traceFetch,
} from "../src/verbose-log.js";

test("redacts credentials recursively while preserving useful verbose data", () => {
  const token = "eyJheader.payload.signature";
  assert.deepEqual(
    redactVerboseValue({
      authorization: `Bearer ${token}`,
      DPoP: token,
      jwk: { kty: "EC", x: "public-coordinate", y: "other-coordinate" },
      dpop_private_key_pkcs8: "encoded-private-material",
      nested: { verification_code: "123456", message: `token ${token}` },
      ordinary: "visible",
    }),
    {
      authorization: "[redacted]",
      DPoP: "[redacted]",
      jwk: "[redacted]",
      dpop_private_key_pkcs8: "[redacted]",
      nested: { verification_code: "[redacted]", message: "token [redacted]" },
      ordinary: "visible",
    },
  );
});

test("describes the complete bounded error chain with codes and sources", () => {
  const cause = Object.assign(new Error("The email address format is unsupported"), {
    name: "CentralEnrollmentError",
    code: "unsupported_email_format",
  });
  const error = Object.assign(new Error("Guided registration failed", { cause }), {
    name: "GuidedRegistrationError",
    code: "registration_failed",
    stage: "central_registration",
  });

  assert.deepEqual(describeVerboseError(error), {
    name: "GuidedRegistrationError",
    message: "Guided registration failed",
    error_code: "registration_failed",
    stage: "central_registration",
    cause: {
      name: "CentralEnrollmentError",
      message: "The email address format is unsupported",
      error_code: "unsupported_email_format",
    },
  });
});

test("traces central requests and responses without consuming or exposing credentials", async () => {
  const output: string[] = [];
  const log = createVerboseLogger(
    (value) => output.push(value),
    () => new Date(0),
  );
  const traced = traceFetch(async (_input, init) => {
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ token: "server-secret", result: "visible" }), {
      status: 200,
      headers: { "DPoP-Nonce": "nonce-secret", "Content-Type": "application/json" },
    });
  }, log);
  const response = await traced("https://example.test/api", {
    method: "POST",
    headers: {
      Authorization: "Bearer eyJheader.payload.signature",
      DPoP: "eyJproof.payload.signature",
    },
    body: JSON.stringify({ code: "123456", email: "person@example.test" }),
  });

  assert.deepEqual(await readCentralJson(response), { token: "server-secret", result: "visible" });
  const combined = output.join("");
  assert.match(combined, /central\.request/u);
  assert.match(combined, /central\.response/u);
  assert.match(combined, /visible/u);
  assert.match(combined, /person@example\.test/u);
  for (const secret of [
    "eyJheader.payload.signature",
    "eyJproof.payload.signature",
    "server-secret",
    "nonce-secret",
    "123456",
  ]) {
    assert.equal(combined.includes(secret), false);
  }
});

test("verbose tracing leaves oversized response consumption to the bounded parser", async () => {
  let readBytes = 0;
  let cancelled = false;
  const output: string[] = [];
  const traced = traceFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (readBytes === 8 * 1024 * 1024) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(64 * 1024).fill(120);
            readBytes += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    createVerboseLogger((line) => output.push(line)),
  );
  const response = await traced("https://example.test/api");
  assert.ok(readBytes <= 64 * 1024, `diagnostics consumed ${readBytes} bytes`);
  await assert.rejects(readCentralJson(response));
  assert.equal(cancelled, true);
  assert.ok(readBytes <= 4 * 1024 * 1024 + 128 * 1024);
  assert.ok(output.join("").length < 2_048);
});

test("verbose tracing never logs raw invalid or truncated JSON containing secrets", async () => {
  for (const body of [
    '{"verification_code":"private-code","value":',
    JSON.stringify({ data: "x".repeat(70 * 1024), token: "private-token" }),
  ]) {
    const output: string[] = [];
    const traced = traceFetch(
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
      createVerboseLogger((line) => output.push(line)),
    );
    const response = await traced("https://example.test/api");
    await readCentralJson(response).catch(() => undefined);
    assert.doesNotMatch(output.join(""), /private-code|private-token/u);
    assert.ok(output.join("").length < 2_048);
  }
});
