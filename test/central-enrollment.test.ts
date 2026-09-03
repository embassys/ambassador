import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import {
  CentralEnrollmentClient,
  CentralEnrollmentError,
  REST_BOOTSTRAP_TOOLS,
} from "../src/central-enrollment.js";
import { startFakeCentral } from "./support/fake-central.js";

const NOW_SECONDS = 1_788_220_800;

test("I02-E01 bootstrap catalog contains only current enrollment tools", () => {
  assert.deepEqual(
    REST_BOOTSTRAP_TOOLS.map((tool) => tool.name),
    ["register_agent", "verify_email", "resend_verification"],
  );
  for (const tool of REST_BOOTSTRAP_TOOLS) {
    assert.equal(JSON.stringify(tool).includes("username"), false);
    assert.equal(JSON.stringify(tool).includes("token"), false);
  }
  const registration = REST_BOOTSTRAP_TOOLS[0];
  assert.ok(registration);
  assert.match(registration.description ?? "", /Embassys Ambassador/iu);
  assert.match(registration.description ?? "", /register me/iu);
  assert.deepEqual((registration.inputSchema.properties as Record<string, unknown>).delivery, {
    oneOf: [
      {
        type: "object",
        properties: { mode: { const: "direct" } },
        required: ["mode"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          mode: { const: "webhook" },
          url: { type: "string", minLength: 1, maxLength: 2_048 },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    ],
  });
});

test("I02-E02 enrollment sends exact REST bodies and returns token-free results", async (t) => {
  const central = await startFakeCentral(t);
  const acceptEncodings: Array<string | null> = [];
  const client = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    fetch: async (input, init) => {
      acceptEncodings.push(new Headers(init?.headers).get("accept-encoding"));
      return fetch(input, init);
    },
    nowSeconds: () => NOW_SECONDS,
  });
  const email = "gateway-enrollment@fixture.test";

  const registered = await client.register({ email, display_name: "Ambassador fixture" });
  assert.equal(registered.email, email);
  assert.deepEqual(Object.keys(registered).sort(), ["agent_id", "email", "message"]);
  const resent = await client.resend({ email });
  assert.deepEqual(Object.keys(resent), ["message"]);

  const verified = await client.verify({ email, code: central.verificationCode(email) });
  assert.deepEqual(verified.localResult, {
    verified: true,
    agent_id: registered.agent_id,
    email,
    message: "Email verified successfully.",
  });
  assert.equal(JSON.stringify(verified.localResult).includes("token"), false);
  assert.equal(JSON.stringify(verified.localResult).includes("jkt"), false);
  const loaded = parseCentralCredential(verified.credential, () => NOW_SECONDS);
  assert.equal(loaded.token.email, email);
  assert.equal(loaded.token.subject, registered.agent_id);
  assert.equal(loaded.token.expiresAt - loaded.token.issuedAt, 30 * 24 * 60 * 60);
  assert.deepEqual(acceptEncodings, ["identity", "identity", "identity"]);

  assert.deepEqual(
    central.requests().map(({ method, path, authorizationScheme, dpopCount, bodyKeys }) => ({
      method,
      path,
      authorizationScheme,
      dpopCount,
      bodyKeys,
    })),
    [
      {
        method: "POST",
        path: "/api/register_agent",
        authorizationScheme: null,
        dpopCount: 0,
        bodyKeys: ["display_name", "email"],
      },
      {
        method: "POST",
        path: "/api/resend_verification",
        authorizationScheme: null,
        dpopCount: 0,
        bodyKeys: ["email"],
      },
      {
        method: "POST",
        path: "/api/verify_email",
        authorizationScheme: null,
        dpopCount: 0,
        bodyKeys: ["code", "email", "jwk"],
      },
    ],
  );
});

test("I02-E03 invalid bootstrap arguments stop before dispatch", async (t) => {
  const central = await startFakeCentral(t);
  const client = new CentralEnrollmentClient({ centralOrigin: central.apiUrl });
  await assert.rejects(
    client.register({ email: "invalid", username: "removed" } as never),
    (error: unknown) =>
      error instanceof CentralEnrollmentError &&
      error.code === "central_enrollment_contract_failed",
  );
  await assert.rejects(
    client.verify({ email: "valid@fixture.test", code: "12345" }),
    (error: unknown) =>
      error instanceof CentralEnrollmentError &&
      error.code === "central_enrollment_contract_failed",
  );
  assert.deepEqual(central.requests(), []);
});

test("I02-E04 redirects and uncertain verification outcomes are never retried", async () => {
  let calls = 0;
  const client = new CentralEnrollmentClient({
    centralOrigin: "https://central.invalid",
    fetch: async () => {
      calls += 1;
      throw new TypeError("synthetic transport failure");
    },
  });
  await assert.rejects(
    client.verify({ email: "uncertain@fixture.test", code: "123456" }),
    (error: unknown) =>
      error instanceof CentralEnrollmentError &&
      error.code === "central_enrollment_outcome_uncertain",
  );
  assert.equal(calls, 1);

  const redirectClient = new CentralEnrollmentClient({
    centralOrigin: "https://central.invalid",
    fetch: async () =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.invalid" } }),
  });
  await assert.rejects(
    redirectClient.register({ email: "redirect@fixture.test" }),
    (error: unknown) =>
      error instanceof CentralEnrollmentError &&
      error.code === "central_enrollment_contract_failed",
  );
});
