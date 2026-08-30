import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  T03_CODE,
  T03_EMAIL,
  T03_USERNAME,
  T03_WEBHOOK_TOKEN,
  useT03FixtureClock,
} from "./support/t03-contract-fixtures.js";
import {
  startT03ScriptedCentralApi,
  T03RawMcpClient,
  type T03ResponsePlan,
  waitForT03Observation,
} from "./support/t03-observation.js";

async function scriptedScenario(t: TestContext, plans: readonly T03ResponsePlan[]) {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const api = await startT03ScriptedCentralApi(t, plans);
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
  return { api, central, client, credentials, gateway };
}

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

function registrationBodyAtSize(size: number, email = T03_EMAIL, username = T03_USERNAME): string {
  const body = JSON.stringify({
    agent_id: "agent_fixture_0001",
    username,
    email,
    message: "Verification code sent.",
  });
  assert.ok(body.length <= size);
  return body.padEnd(size, " ");
}

function registrationBodyWithExtension(extension: unknown): string {
  return JSON.stringify({
    agent_id: "agent_fixture_0001",
    username: T03_USERNAME,
    email: T03_EMAIL,
    message: "Verification code sent.",
    extension,
  });
}

function nestedArrays(containers: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < containers; index += 1) value = [value];
  return value;
}

function memberObject(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`field_${index}`, "v"]));
}

test("T03-B01 registration sends one exact bounded REST projection", async (t) => {
  const result = {
    agent_id: "agent_fixture_0001",
    username: T03_USERNAME,
    email: T03_EMAIL,
    message: "Verification code sent.",
  };
  const { api, central, client } = await scriptedScenario(t, [
    { status: 200, headers: JSON_HEADERS, body: JSON.stringify(result) },
  ]);

  const local = await client.callTool("register_agent", {
    email: T03_EMAIL,
    username: T03_USERNAME,
    display_name: "T03 gateway",
  });
  assert.ok(
    local.agent_id === result.agent_id &&
      local.username === result.username &&
      local.email === result.email &&
      local.message === result.message,
    "registration result did not use the selected REST response",
  );
  assert.equal(api.requests.length, 1);
  const request = api.requests[0];
  assert.ok(request !== undefined);
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/register");
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(request.headers["cache-control"], "no-store");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers.dpop, undefined);
  assert.equal(request.headers.cookie, undefined);
  assert.deepEqual(JSON.parse(request.body.toString("utf8")), {
    email: T03_EMAIL,
    username: T03_USERNAME,
    display_name: "T03 gateway",
  });
  assert.equal(central.calls.length, 0);
});

test("T03-B02 invalid bootstrap inputs stop before central dispatch", async (t) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tool: string;
    readonly args: Record<string, unknown>;
  }> = [
    { name: "short email", tool: "register_agent", args: { email: "a@", username: T03_USERNAME } },
    {
      name: "long email",
      tool: "register_agent",
      args: { email: `${"a".repeat(245)}@x.invalid`, username: T03_USERNAME },
    },
    {
      name: "email whitespace",
      tool: "register_agent",
      args: { email: ` ${T03_EMAIL}`, username: T03_USERNAME },
    },
    { name: "short username", tool: "register_agent", args: { email: T03_EMAIL, username: "ab" } },
    {
      name: "long username",
      tool: "register_agent",
      args: { email: T03_EMAIL, username: "u".repeat(51) },
    },
    {
      name: "empty display name",
      tool: "register_agent",
      args: { email: T03_EMAIL, username: T03_USERNAME, display_name: "" },
    },
    {
      name: "long display name",
      tool: "register_agent",
      args: { email: T03_EMAIL, username: T03_USERNAME, display_name: "d".repeat(129) },
    },
    {
      name: "unknown registration field",
      tool: "register_agent",
      args: { email: T03_EMAIL, username: T03_USERNAME, extra: true },
    },
    { name: "short code", tool: "verify_email", args: { email: T03_EMAIL, code: "12345" } },
    { name: "long code", tool: "verify_email", args: { email: T03_EMAIL, code: "1234567" } },
    { name: "non-ASCII code", tool: "verify_email", args: { email: T03_EMAIL, code: "12345é" } },
    {
      name: "unknown verification field",
      tool: "verify_email",
      args: { email: T03_EMAIL, code: T03_CODE, token: "caller-value" },
    },
    {
      name: "unknown resend field",
      tool: "resend_verification",
      args: { email: T03_EMAIL, extra: true },
    },
  ];
  const { api, central, client } = await scriptedScenario(t, []);
  for (const vector of cases) {
    await t.test(vector.name, async () => {
      const apiCount = api.requests.length;
      const mcpCount = central.calls.length;
      await assert.rejects(client.callTool(vector.tool, vector.args));
      assert.equal(api.requests.length, apiCount);
      assert.equal(central.calls.length, mcpCount);
    });
  }
});

test("T03-B02a exact maximum bootstrap input fields remain accepted", async (t) => {
  const email = `${"a".repeat(244)}@x.invalid`;
  const username = "u".repeat(50);
  const displayName = "d".repeat(128);
  assert.equal(email.length, 254);
  const { api, client } = await scriptedScenario(t, [
    {
      status: 200,
      headers: JSON_HEADERS,
      body: registrationBodyAtSize(512, email, username),
    },
  ]);
  const result = await client.callTool("register_agent", {
    email,
    username,
    display_name: displayName,
  });
  assert.equal(result.email, email);
  assert.equal(result.username, username);
  assert.equal(api.requests.length, 1);
});

test("T03-B03 reviewed bootstrap errors and unsafe outcomes never fall back or retry", async (t) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly plan: T03ResponsePlan;
    readonly localCode: string;
  }> = [
    {
      name: "registration conflict",
      plan: {
        status: 409,
        headers: JSON_HEADERS,
        body: '{"error":{"code":"registration_conflict"}}',
      },
      localCode: "registration_conflict",
    },
    {
      name: "reviewed invalid request",
      plan: {
        status: 422,
        headers: JSON_HEADERS,
        body: '{"error":{"code":"invalid_request"}}',
      },
      localCode: "central_enrollment_contract_failed",
    },
    {
      name: "rate limit",
      plan: {
        status: 429,
        headers: { ...JSON_HEADERS, "retry-after": "2" },
        body: '{"error":{"code":"rate_limited"}}',
      },
      localCode: "central_rate_limited",
    },
    {
      name: "internal error",
      plan: {
        status: 500,
        headers: JSON_HEADERS,
        body: '{"error":{"code":"internal_error"}}',
      },
      localCode: "central_enrollment_outcome_uncertain",
    },
    {
      name: "temporary failure",
      plan: {
        status: 503,
        headers: JSON_HEADERS,
        body: '{"error":{"code":"temporarily_unavailable"}}',
      },
      localCode: "central_enrollment_outcome_uncertain",
    },
    {
      name: "selected route not found",
      plan: { status: 404, headers: JSON_HEADERS, body: '{"error":{"code":"not_found"}}' },
      localCode: "central_enrollment_contract_failed",
    },
    {
      name: "redirect",
      plan: {
        status: 307,
        headers: { location: "/api/register_agent", "content-type": "application/json" },
        body: "{}",
      },
      localCode: "central_enrollment_outcome_uncertain",
    },
    {
      name: "bodyless redirect",
      plan: { status: 302, headers: { location: "/api/register_agent" } },
      localCode: "central_enrollment_outcome_uncertain",
    },
    {
      name: "HTML redirect",
      plan: {
        status: 308,
        headers: { location: "/api/register_agent", "content-type": "text/html" },
        body: "<html>redirect</html>",
      },
      localCode: "central_enrollment_outcome_uncertain",
    },
    {
      name: "connection loss after dispatch",
      plan: { status: 200, drop: true },
      localCode: "central_enrollment_outcome_uncertain",
    },
  ];

  for (const vector of cases) {
    await t.test(vector.name, async (subtest) => {
      const { api, central, gateway } = await scriptedScenario(subtest, [vector.plan]);
      const raw = new T03RawMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
      await raw.initialize();
      const failure = await raw.callToolFailure("register_agent", {
        email: T03_EMAIL,
        username: T03_USERNAME,
      });
      assert.ok(
        failure.data !== null && typeof failure.data === "object" && !Array.isArray(failure.data),
        "local failure omitted its fixed identifier",
      );
      const data = failure.data as Record<string, unknown>;
      assert.deepEqual(Object.keys(data), ["code"]);
      assert.equal(data.code, vector.localCode);
      const serialized = JSON.stringify(failure);
      assert.ok(!serialized.includes(T03_EMAIL) && !serialized.includes(T03_CODE));
      assert.equal(api.requests.length, 1);
      assert.equal(central.calls.length, 0);
    });
  }
});

test("T03-B04a an exact 64 KiB valid bootstrap body remains accepted", async (t) => {
  const { api, client } = await scriptedScenario(t, [
    { status: 200, headers: JSON_HEADERS, body: registrationBodyAtSize(65_536) },
  ]);
  const result = await client.callTool("register_agent", {
    email: T03_EMAIL,
    username: T03_USERNAME,
  });
  assert.equal(result.email, T03_EMAIL);
  assert.equal(api.requests.length, 1);
});

test("T03-B04b exact parser depth, member, and element limits remain accepted", async (t) => {
  const vectors: ReadonlyArray<{ readonly name: string; readonly extension: unknown }> = [
    { name: "16 container levels", extension: nestedArrays(15) },
    { name: "128 total object members", extension: memberObject(123) },
    { name: "128 total array elements", extension: Array.from({ length: 128 }, () => 0) },
  ];
  for (const vector of vectors) {
    await t.test(vector.name, async (subtest) => {
      const { api, client } = await scriptedScenario(subtest, [
        {
          status: 200,
          headers: JSON_HEADERS,
          body: registrationBodyWithExtension(vector.extension),
        },
      ]);
      const result = await client.callTool("register_agent", {
        email: T03_EMAIL,
        username: T03_USERNAME,
      });
      assert.equal(result.email, T03_EMAIL);
      assert.equal(api.requests.length, 1);
    });
  }
});

test("T03-B04 malformed and over-limit bootstrap responses fail closed", async (t) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly plan: T03ResponsePlan;
  }> = [
    {
      name: "unexpected success status",
      plan: { status: 201, headers: JSON_HEADERS, body: "{}" },
    },
    {
      name: "wrong media type",
      plan: { status: 200, headers: { "content-type": "text/plain" }, body: "{}" },
    },
    {
      name: "content encoding",
      plan: {
        status: 200,
        headers: { ...JSON_HEADERS, "content-encoding": "gzip" },
        body: "{}",
      },
    },
    {
      name: "duplicate JSON key",
      plan: {
        status: 200,
        headers: JSON_HEADERS,
        body: `{"agent_id":"a","agent_id":"b","username":"${T03_USERNAME}","email":"${T03_EMAIL}"}`,
      },
    },
    {
      name: "invalid UTF-8",
      plan: { status: 200, headers: JSON_HEADERS, body: Uint8Array.from([0xc3, 0x28]) },
    },
    { name: "invalid JSON", plan: { status: 200, headers: JSON_HEADERS, body: "{" } },
    {
      name: "17 container levels",
      plan: {
        status: 200,
        headers: JSON_HEADERS,
        body: registrationBodyWithExtension(nestedArrays(16)),
      },
    },
    {
      name: "129 total object members",
      plan: {
        status: 200,
        headers: JSON_HEADERS,
        body: registrationBodyWithExtension(memberObject(124)),
      },
    },
    {
      name: "129 total array elements",
      plan: {
        status: 200,
        headers: JSON_HEADERS,
        body: registrationBodyWithExtension(Array.from({ length: 129 }, () => 0)),
      },
    },
    {
      name: "body over limit",
      plan: { status: 200, headers: JSON_HEADERS, body: registrationBodyAtSize(65_537) },
    },
    {
      name: "header over limit",
      plan: {
        status: 200,
        headers: { ...JSON_HEADERS, "x-oversized": "x".repeat(16_384) },
        body: "{}",
      },
    },
    {
      name: "malformed error pair",
      plan: {
        status: 409,
        headers: JSON_HEADERS,
        body: '{"error":{"code":"invalid_request"}}',
      },
    },
    {
      name: "credential field in registration",
      plan: {
        status: 200,
        headers: JSON_HEADERS,
        body: `{"agent_id":"agent_fixture_0001","username":"${T03_USERNAME}","email":"${T03_EMAIL}","nested":{"token":"forbidden-marker"}}`,
      },
    },
    {
      name: "registration set-cookie headers",
      plan: {
        status: 200,
        headers: { ...JSON_HEADERS, "set-cookie": ["first=forbidden", "second=forbidden"] },
        body: registrationBodyAtSize(512),
      },
    },
  ];

  for (const vector of cases) {
    await t.test(vector.name, async (subtest) => {
      const { api, central, gateway } = await scriptedScenario(subtest, [vector.plan]);
      const raw = new T03RawMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
      await raw.initialize();
      const failure = await raw.callToolFailure("register_agent", {
        email: T03_EMAIL,
        username: T03_USERNAME,
      });
      assert.ok(
        failure.data !== null && typeof failure.data === "object" && !Array.isArray(failure.data),
        "local failure omitted its fixed identifier",
      );
      assert.equal(
        (failure.data as Record<string, unknown>).code,
        "central_enrollment_contract_failed",
      );
      assert.deepEqual(Object.keys(failure.data as Record<string, unknown>), ["code"]);
      const serialized = JSON.stringify(failure);
      assert.ok(
        !serialized.includes(T03_EMAIL) &&
          !serialized.includes(T03_CODE) &&
          !serialized.includes("forbidden-marker"),
      );
      assert.equal(api.requests.length, 1);
      assert.equal(central.calls.length, 0);
    });
  }
});

test("T03-B05 gateway shutdown cancels one in-flight bootstrap request without retry", async (t) => {
  const { api, central, client, gateway } = await scriptedScenario(t, [
    { status: 200, hold: true },
  ]);
  const pending = client.callTool("register_agent", {
    email: T03_EMAIL,
    username: T03_USERNAME,
  });
  await waitForT03Observation(() => api.requests.length === 1);
  const stopping = gateway.stop();
  await assert.rejects(pending);
  assert.equal(await stopping, 0);
  assert.equal(api.requests.length, 1, "cancelled bootstrap request was retried");
  assert.ok(api.requests[0]?.connectionClosed(), "shutdown left the REST request open");
  assert.equal(central.calls.length, 0, "cancelled bootstrap request fell back to MCP");
});

test("T03-B06 a lost verification response is uncertain and is never repeated", async (t) => {
  const { api, central, credentials, gateway } = await scriptedScenario(t, [
    { status: 200, drop: true },
  ]);
  const raw = new T03RawMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await raw.initialize();
  const failure = await raw.callToolFailure("verify_email", {
    email: T03_EMAIL,
    code: T03_CODE,
  });
  assert.deepEqual(failure.data, { code: "central_enrollment_outcome_uncertain" });
  assert.equal(api.requests.length, 1, "uncertain verification was repeated");
  assert.equal(credentials.saved.length, 0, "uncertain verification persisted a credential");
  assert.equal(central.calls.length, 0, "uncertain verification fell back to MCP");
});

test("T03-B07 resend preserves the reviewed rate-limit projection without retry", async (t) => {
  const { api, central, gateway } = await scriptedScenario(t, [
    {
      status: 429,
      headers: { ...JSON_HEADERS, "retry-after": "2" },
      body: '{"error":{"code":"rate_limited"}}',
    },
  ]);
  const raw = new T03RawMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await raw.initialize();
  const failure = await raw.callToolFailure("resend_verification", { email: T03_EMAIL });
  assert.deepEqual(failure.data, { code: "central_rate_limited" });
  assert.equal(api.requests.length, 1, "rate-limited resend was retried");
  assert.equal(central.calls.length, 0, "rate-limited resend fell back to MCP");
});

test("T03-B08 a lost resend response is uncertain and is never repeated", async (t) => {
  const { api, central, gateway } = await scriptedScenario(t, [{ status: 200, drop: true }]);
  const raw = new T03RawMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await raw.initialize();
  const failure = await raw.callToolFailure("resend_verification", { email: T03_EMAIL });
  assert.deepEqual(failure.data, { code: "central_enrollment_outcome_uncertain" });
  assert.equal(api.requests.length, 1, "uncertain resend was repeated");
  assert.equal(central.calls.length, 0, "uncertain resend fell back to MCP");
});
