import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  T03_CODE,
  T03_EMAIL,
  T03_WEBHOOK_TOKEN,
  useT03FixtureClock,
} from "./support/t03-contract-fixtures.js";
import {
  installT03FetchObserver,
  startT03ScriptedCentralApi,
  type T03McpFailure,
  T03RawMcpClient,
  type T03ResponsePlan,
  type T03ScriptedRequest,
} from "./support/t03-observation.js";

const SAFE_JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;
const VALID_NONCE = "A".repeat(76);
const OTHER_VALID_NONCE = "B".repeat(76);

function challenge(
  options: {
    readonly nonce?: string | readonly string[];
    readonly status?: number;
    readonly body?: string;
    readonly mediaType?: string;
    readonly noStore?: boolean;
  } = {},
): T03ResponsePlan {
  return {
    status: options.status ?? 400,
    headers: {
      ...(options.noStore === false ? {} : { "cache-control": "no-store" }),
      "content-type": options.mediaType ?? "application/json",
      ...(options.nonce === undefined ? {} : { "dpop-nonce": options.nonce }),
    },
    body: options.body ?? '{"error":"use_dpop_nonce"}',
  };
}

function safeProofRejection(noStore = true): T03ResponsePlan {
  return {
    status: 400,
    headers: {
      ...(noStore ? { "cache-control": "no-store" } : {}),
      "content-type": "application/json",
    },
    body: '{"error":"invalid_dpop_proof"}',
  };
}

function headerValue(request: T03ScriptedRequest, name: string): string {
  const value = request.headers[name];
  assert.ok(typeof value === "string", `request omitted ${name}`);
  return value;
}

function proofJkt(request: T03ScriptedRequest): string {
  const proof = headerValue(request, "dpop");
  const encodedHeader = proof.split(".")[0];
  assert.ok(encodedHeader !== undefined, "proof header was missing");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.ok(header.jwk !== null && typeof header.jwk === "object" && !Array.isArray(header.jwk));
  const jwk = header.jwk as Record<string, unknown>;
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
}

interface TokenOverrides {
  readonly header?: Readonly<Record<string, unknown>>;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly malformed?: boolean;
}

function fixtureToken(request: T03ScriptedRequest, overrides: TokenOverrides = {}): string {
  if (overrides.malformed === true) return "not-a-compact-jwt";
  const header = { typ: "JWT", alg: "ES256", ...overrides.header };
  const payload = {
    iss: "urn:a2a:fixture:issuer:v2",
    aud: ["urn:a2a:fixture:resource:api:v2", "urn:a2a:fixture:resource:mcp:v2"],
    sub: "agent_fixture_0001",
    iat: 1_788_000_000,
    exp: 1_788_086_400,
    jti: "00000000-0000-4000-8000-000000000901",
    cnf: { jkt: proofJkt(request) },
    ...overrides.claims,
  };
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
    JSON.stringify(payload),
  ).toString("base64url")}.${Buffer.alloc(64).toString("base64url")}`;
}

function fixtureTokenAtLength(request: T03ScriptedRequest, target: number): string {
  const source = fixtureToken(request);
  const parts = source.split(".");
  const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const signature = parts[2];
  assert.ok(signature !== undefined);
  for (const claim of ["a", "aa", "aaa", "aaaa"]) {
    for (let padding = 0; padding <= 8_192; padding += 1) {
      const token = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
        JSON.stringify({ ...payload, [claim]: "x".repeat(padding) }),
      ).toString("base64url")}.${signature}`;
      if (Buffer.byteLength(token, "ascii") === target) return token;
    }
  }
  assert.fail("could not construct the exact issued-token boundary");
}

function successBody(
  request: T03ScriptedRequest,
  options: {
    readonly token?: TokenOverrides;
    readonly tokenType?: unknown;
    readonly expiresIn?: unknown;
    readonly raw?: (token: string) => string;
  } = {},
): string {
  const token = fixtureToken(request, options.token);
  if (options.raw !== undefined) return options.raw(token);
  return JSON.stringify({
    agent_id: "agent_fixture_0001",
    username: "t03_gateway",
    token,
    token_type: options.tokenType ?? "DPoP",
    expires_in: options.expiresIn ?? 86_400,
    message: "Email verified successfully.",
  });
}

async function runVerificationFailure(
  t: TestContext,
  plans: readonly T03ResponsePlan[],
): Promise<{
  readonly failure: T03McpFailure;
  readonly requests: readonly T03ScriptedRequest[];
  readonly savedCount: number;
  readonly mcpCalls: number;
  readonly responseBodies: readonly string[];
}> {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const api = await startT03ScriptedCentralApi(t, plans);
  const observed = installT03FetchObserver(t, [api.url]);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore();
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: api.url,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
    observeCentralFetch: true,
    targetContract: "v2",
  });
  const client = new T03RawMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  const failure = await client.callToolFailure("verify_email", {
    email: T03_EMAIL,
    code: T03_CODE,
  });
  return {
    failure,
    requests: api.requests,
    savedCount: credentials.saved.length,
    mcpCalls: central.calls.length,
    responseBodies: observed.observations.map((observation) =>
      observation.responseBody.toString("utf8"),
    ),
  };
}

function localIdentifier(failure: T03McpFailure): string | undefined {
  if (failure.data === null || typeof failure.data !== "object" || Array.isArray(failure.data)) {
    return undefined;
  }
  return (failure.data as Record<string, unknown>).code as string | undefined;
}

test("T03-N01 verification nonce and proof failures use fixed precedence and retry bounds", async (t) => {
  const vectors: ReadonlyArray<{
    readonly name: string;
    readonly plans: readonly T03ResponsePlan[];
    readonly code: string;
    readonly requests: number;
  }> = [
    {
      name: "verification code rejected",
      plans: [
        {
          status: 400,
          headers: SAFE_JSON_HEADERS,
          body: '{"error":{"code":"verification_failed"}}',
        },
      ],
      code: "verification_failed",
      requests: 1,
    },
    {
      name: "well-formed second challenge",
      plans: [challenge({ nonce: VALID_NONCE }), challenge({ nonce: OTHER_VALID_NONCE })],
      code: "central_dpop_nonce_retry_exhausted",
      requests: 2,
    },
    {
      name: "missing nonce",
      plans: [challenge()],
      code: "central_dpop_challenge_failed",
      requests: 1,
    },
    {
      name: "malformed nonce",
      plans: [challenge({ nonce: "short-nonce" })],
      code: "central_dpop_challenge_failed",
      requests: 1,
    },
    {
      name: "duplicate nonce",
      plans: [challenge({ nonce: [VALID_NONCE, OTHER_VALID_NONCE] })],
      code: "central_dpop_challenge_failed",
      requests: 1,
    },
    {
      name: "challenge wrong status",
      plans: [challenge({ nonce: VALID_NONCE, status: 401 })],
      code: "central_enrollment_contract_failed",
      requests: 1,
    },
    {
      name: "challenge wrong body",
      plans: [challenge({ nonce: VALID_NONCE, body: '{"error":"invalid_dpop_proof"}' })],
      code: "central_dpop_proof_rejected",
      requests: 1,
    },
    {
      name: "challenge wrong media type",
      plans: [challenge({ nonce: VALID_NONCE, mediaType: "text/plain" })],
      code: "central_enrollment_contract_failed",
      requests: 1,
    },
    {
      name: "challenge missing no-store",
      plans: [challenge({ nonce: VALID_NONCE, noStore: false })],
      code: "central_verification_response_unsafe",
      requests: 1,
    },
    {
      name: "invalid proof",
      plans: [safeProofRejection()],
      code: "central_dpop_proof_rejected",
      requests: 1,
    },
    {
      name: "invalid proof missing no-store",
      plans: [safeProofRejection(false)],
      code: "central_verification_response_unsafe",
      requests: 1,
    },
  ];

  for (const vector of vectors) {
    await t.test(vector.name, async (subtest) => {
      const result = await runVerificationFailure(subtest, vector.plans);
      assert.equal(localIdentifier(result.failure), vector.code);
      assert.deepEqual(Object.keys(result.failure.data as Record<string, unknown>), ["code"]);
      const serialized = JSON.stringify(result.failure);
      assert.ok(!serialized.includes(T03_EMAIL) && !serialized.includes(T03_CODE));
      assert.equal(
        result.requests.length,
        vector.requests,
        "verification used an unsafe retry count",
      );
      assert.equal(result.savedCount, 0, "failed verification persisted a credential");
      assert.equal(result.mcpCalls, 0, "failed verification fell back to central MCP");
      if (result.requests.length === 2) {
        const first = result.requests[0];
        const second = result.requests[1];
        assert.ok(first !== undefined && second !== undefined);
        assert.ok(
          headerValue(first, "dpop") !== headerValue(second, "dpop"),
          "verification nonce retry replayed its proof",
        );
      }
    });
  }
});

test("T03-N02 invalid verification credentials are rejected before persistence", async (t) => {
  const vectors: ReadonlyArray<{
    readonly name: string;
    readonly response: T03ResponsePlan;
    readonly code: string;
  }> = [
    {
      name: "wrong token type",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) => successBody(request, { tokenType: "Bearer" }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "wrong expires-in",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) => successBody(request, { expiresIn: 86_399 }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "wrong subject",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, { token: { claims: { sub: "agent_fixture_other" } } }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "wrong issuer",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, { token: { claims: { iss: "urn:a2a:fixture:other" } } }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "reordered audience",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, {
            token: {
              claims: {
                aud: ["urn:a2a:fixture:resource:mcp:v2", "urn:a2a:fixture:resource:api:v2"],
              },
            },
          }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "missing confirmation",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) => successBody(request, { token: { claims: { cnf: null } } }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "wrong thumbprint",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, { token: { claims: { cnf: { jkt: "A".repeat(43) } } } }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "wrong token lifetime",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) => successBody(request, { token: { claims: { exp: 1_788_086_399 } } }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "malformed JWT",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) => successBody(request, { token: { malformed: true } }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "duplicate token member",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, {
            raw: (token) =>
              `{"agent_id":"agent_fixture_0001","username":"t03_gateway","token":"${token}","token":"${token}","token_type":"DPoP","expires_in":86400}`,
          }),
      },
      code: "central_enrollment_contract_failed",
    },
    {
      name: "nested credential-shaped data",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, {
            raw: (token) =>
              JSON.stringify({
                agent_id: "agent_fixture_0001",
                username: "t03_gateway",
                token,
                token_type: "DPoP",
                expires_in: 86_400,
                message: "Email verified successfully.",
                credential: { token },
              }),
          }),
      },
      code: "central_enrollment_contract_failed",
    },
    {
      name: "token bytes reflected outside token field",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, {
            raw: (token) =>
              JSON.stringify({
                agent_id: "agent_fixture_0001",
                username: "t03_gateway",
                token,
                token_type: "DPoP",
                expires_in: 86_400,
                message: `Email verified ${token}`,
              }),
          }),
      },
      code: "central_enrollment_contract_failed",
    },
    {
      name: "raw token 4097",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, {
            raw: () =>
              JSON.stringify({
                agent_id: "agent_fixture_0001",
                username: "t03_gateway",
                token: "x".repeat(4_097),
                token_type: "DPoP",
                expires_in: 86_400,
                message: "Email verified successfully.",
              }),
          }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "smallest canonical token over limit",
      response: {
        status: 200,
        headers: SAFE_JSON_HEADERS,
        body: (request) =>
          successBody(request, {
            raw: () =>
              JSON.stringify({
                agent_id: "agent_fixture_0001",
                username: "t03_gateway",
                token: fixtureTokenAtLength(request, 4_098),
                token_type: "DPoP",
                expires_in: 86_400,
                message: "Email verified successfully.",
              }),
          }),
      },
      code: "central_verification_credential_invalid",
    },
    {
      name: "success missing no-store",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: (request) => successBody(request),
      },
      code: "central_verification_response_unsafe",
    },
  ];

  for (const vector of vectors) {
    await t.test(vector.name, async (subtest) => {
      const result = await runVerificationFailure(subtest, [
        challenge({ nonce: VALID_NONCE }),
        vector.response,
      ]);
      assert.equal(localIdentifier(result.failure), vector.code);
      assert.deepEqual(Object.keys(result.failure.data as Record<string, unknown>), ["code"]);
      const serialized = JSON.stringify(result.failure);
      assert.ok(!serialized.includes(T03_EMAIL) && !serialized.includes(T03_CODE));
      for (const body of result.responseBodies) {
        for (const match of body.matchAll(/"token"\s*:\s*"([^"]+)"/gu)) {
          const token = match[1];
          assert.ok(token !== undefined && !serialized.includes(token));
        }
      }
      assert.equal(result.requests.length, 2, "credential failure used an unsafe retry count");
      assert.equal(result.savedCount, 0, "invalid credential response was persisted");
      assert.equal(result.mcpCalls, 0, "invalid credential response fell back to MCP");
    });
  }
});

test("T03-N03 verification accepts an exact 4096-byte bound token without exposing it", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const api = await startT03ScriptedCentralApi(t, [
    challenge({ nonce: VALID_NONCE }),
    {
      status: 200,
      headers: SAFE_JSON_HEADERS,
      body: (request) =>
        successBody(request, {
          raw: () =>
            JSON.stringify({
              agent_id: "agent_fixture_0001",
              username: "t03_gateway",
              token: fixtureTokenAtLength(request, 4_096),
              token_type: "DPoP",
              expires_in: 86_400,
              message: "Email verified successfully.",
            }),
        }),
    },
  ]);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore();
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: api.url,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
    targetContract: "v2",
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  const result = await client.callTool("verify_email", { email: T03_EMAIL, code: T03_CODE });
  assert.ok(result.verified === true && !Object.hasOwn(result, "token"));
  assert.equal(credentials.saved.length, 1);
  const saved = JSON.parse(credentials.saved[0] ?? "") as Record<string, unknown>;
  assert.equal(Buffer.byteLength(String(saved.access_token), "ascii"), 4_096);
});
