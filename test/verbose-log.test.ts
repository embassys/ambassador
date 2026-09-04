import assert from "node:assert/strict";
import { test } from "node:test";

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
      nested: { verification_code: "123456", message: `token ${token}` },
      ordinary: "visible",
    }),
    {
      authorization: "[redacted]",
      DPoP: "[redacted]",
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

  assert.deepEqual(await response.json(), { token: "server-secret", result: "visible" });
  const combined = output.join("");
  assert.match(combined, /central\.request/u);
  assert.match(combined, /central\.response/u);
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
