import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  seededCredentialV2,
  T03_CODE,
  T03_EMAIL,
  T03_USERNAME,
  T03_WEBHOOK_TOKEN,
  type T03CredentialRecord,
} from "./support/t03-contract-fixtures.js";
import {
  installT03FetchObserver,
  runT03ArtifactScan,
  startT03ScriptedCentralApi,
  type T03HttpObservation,
  type T03ResponsePlan,
  waitForT03Observation,
} from "./support/t03-observation.js";

function reissueRequests(observations: readonly T03HttpObservation[]): T03HttpObservation[] {
  return observations.filter(
    (observation) => new URL(observation.url).pathname === "/api/v2/token/reissue",
  );
}

function setReissueClock(
  t: TestContext,
  central: Awaited<ReturnType<typeof startFakeCentral>>,
): void {
  central.advanceClock(43_201);
  t.mock.timers.enable({ apis: ["Date"], now: central.clock() * 1_000 });
}

function reissueToken(
  source: string,
  changes: {
    readonly header?: Readonly<Record<string, unknown>>;
    readonly claims?: Readonly<Record<string, unknown>>;
  } = {},
): string {
  const segments = source.split(".");
  assert.equal(segments.length, 3);
  const header = JSON.parse(Buffer.from(segments[0] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const previous = JSON.parse(
    Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const claims = {
    ...previous,
    iat: 1_788_043_201,
    exp: 1_788_129_601,
    jti: "00000000-0000-4000-8000-000000000902",
    ...changes.claims,
  };
  return `${Buffer.from(JSON.stringify({ ...header, ...changes.header })).toString(
    "base64url",
  )}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${Buffer.alloc(64).toString(
    "base64url",
  )}`;
}

function reissuePlans(token: string): readonly T03ResponsePlan[] {
  return [
    {
      method: "POST",
      path: "/api/v2/token/reissue",
      status: 401,
      headers: {
        "cache-control": "no-store",
        "dpop-nonce": "E".repeat(76),
        "www-authenticate": 'DPoP error="use_dpop_nonce"',
      },
    },
    {
      method: "POST",
      path: "/api/v2/token/reissue",
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      body: JSON.stringify({ token, token_type: "DPoP", expires_in: 86_400 }),
    },
  ];
}

test("T03-U01 lost reissue response retries with one idempotency key and fresh proofs", async (t) => {
  const central = await startFakeCentral(t);
  const original = seededCredentialV2(central, "fixture_sender");
  setReissueClock(t, central);
  central.failNextV2("reissue", "drop_after_commit");
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore(JSON.stringify(original));
  await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
  });

  await waitForT03Observation(() => reissueRequests(observed.observations).length >= 3);
  await waitForT03Observation(() => credentials.saved.length === 1);
  const requests = reissueRequests(observed.observations);
  assert.equal(requests.length, 3, "lost reissue response used an unexpected retry count");
  const keys = requests.map((request) => request.requestHeaders["idempotency-key"]);
  assert.ok(keys[0] !== undefined && keys.every((key) => key === keys[0]));
  const proofs = requests.map((request) => request.requestHeaders.dpop);
  assert.equal(new Set(proofs).size, requests.length, "reissue retry replayed a proof");
  assert.equal(requests.filter((request) => request.responseStatus === 0).length, 1);
  assert.equal(credentials.saved.length, 1, "recovered reissue was not published once");
  const replacement = JSON.parse(credentials.saved[0] ?? "") as T03CredentialRecord;
  assert.ok(replacement.access_token !== original.access_token, "reissue kept the old token");
  assert.ok(replacement.dpop_private_key_pkcs8 === original.dpop_private_key_pkcs8);
});

test("T03-U02 reissue persistence failure retains and continues with the old credential", async (t) => {
  const central = await startFakeCentral(t);
  const original = seededCredentialV2(central, "fixture_sender");
  setReissueClock(t, central);
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  let saveAttempts = 0;
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: {
      async load() {
        return JSON.stringify(original);
      },
      async save() {
        saveAttempts += 1;
        throw new Error("injected replacement publication failure");
      },
    },
  });
  await waitForT03Observation(() => saveAttempts === 1);

  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await client.listTools();
  assert.deepEqual(await client.callTool("list_action_types", {}), {
    action_types: ["fixture.echo"],
  });
  const afterFailure = observed.observations.filter(
    (observation) => new URL(observation.url).pathname === "/mcp",
  );
  assert.ok(afterFailure.length > 0, "old credential was not retained for authenticated work");
  assert.ok(
    afterFailure.every(
      (request) => request.requestHeaders.authorization === `DPoP ${original.access_token}`,
    ),
    "replacement failure activated an unpersisted token",
  );
  assert.equal(saveAttempts, 1);
});

test("T03-U03 an expired credential disables protected work without network refresh", async (t) => {
  const central = await startFakeCentral(t);
  const original = seededCredentialV2(central, "fixture_sender");
  central.advanceClock(86_401);
  t.mock.timers.enable({ apis: ["Date"], now: central.clock() * 1_000 });
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: capturingCredentialStore(JSON.stringify(original)).adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  const tools = await client.listTools();
  assert.ok(!tools.some((tool) => tool.name === "list_action_types"));
  assert.equal(observed.observations.length, 0, "expired credential reached central");
});

test("T03-U04 invalid-token responses never trigger reissue, replacement, or bearer fallback", async (t) => {
  const central = await startFakeCentral(t);
  const original = seededCredentialV2(central, "fixture_sender");
  const fixtureClient = central.seedClient("fixture_sender");
  const revoked = await fixtureClient.request(
    new URL("/api/v2/token/revoke", central.apiUrl).href,
    {
      method: "POST",
    },
  );
  assert.equal(revoked.status, 204);
  await revoked.body?.cancel();
  t.mock.timers.enable({ apis: ["Date"], now: central.clock() * 1_000 });
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore(JSON.stringify(original));
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await assert.rejects(client.listTools());
  await waitForT03Observation(() =>
    observed.observations.some((item) => item.responseStatus === 401),
  );

  assert.ok(
    observed.observations.every(
      (request) =>
        request.requestHeaders.authorization === undefined ||
        request.requestHeaders.authorization.startsWith("DPoP "),
    ),
    "invalid-token handling used bearer fallback",
  );
  assert.ok(
    !observed.observations.some((request) =>
      ["/api/v2/token/reissue", "/api/verify_email"].includes(new URL(request.url).pathname),
    ),
    "invalid-token handling started credential replacement",
  );
  assert.equal(credentials.saved.length, 0);
});

test("T03-U05 real encrypted credential reissue replaces envelope v2 and survives restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_788_000_000_000 });
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const first = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });
  const firstClient = new TestMcpClient(first.endpoint, T03_WEBHOOK_TOKEN);
  await firstClient.initialize();
  await firstClient.callTool("register_agent", {
    email: T03_EMAIL,
    username: T03_USERNAME,
  });
  await firstClient.callTool("verify_email", { email: T03_EMAIL, code: T03_CODE });
  await first.stop();

  const scope = JSON.stringify({
    centralApiUrl: new URL(central.apiUrl).href,
    centralMcpUrl: new URL(central.mcpUrl).href,
  });
  const originalText = await new EncryptedFileCredentialStore(
    `${first.stateRoot}/central-credential.json`,
    T03_WEBHOOK_TOKEN,
    scope,
  ).load();
  assert.ok(originalText !== undefined);
  const original = JSON.parse(originalText) as T03CredentialRecord;
  central.advanceClock(43_201);
  t.mock.timers.setTime(central.clock() * 1_000);
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const second = await startGateway(t, {
    artifactRoot: first.artifactRoot,
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });
  await waitForT03Observation(() => reissueRequests(observed.observations).length >= 2);
  const replacementStore = new EncryptedFileCredentialStore(
    `${first.stateRoot}/central-credential.json`,
    T03_WEBHOOK_TOKEN,
    scope,
  );
  let replacementText: string | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = await replacementStore.load();
    if (
      candidate !== undefined &&
      (JSON.parse(candidate) as T03CredentialRecord).access_token !== original.access_token
    ) {
      replacementText = candidate;
      break;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(replacementText !== undefined);
  await second.stop();

  const envelope = JSON.parse(
    await readFile(`${first.stateRoot}/central-credential.json`, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(envelope.version, 2, "replacement did not publish envelope version 2");
  const replacement = JSON.parse(replacementText) as T03CredentialRecord;
  assert.ok(replacement.access_token !== original.access_token);
  assert.ok(replacement.dpop_private_key_pkcs8 === original.dpop_private_key_pkcs8);

  const third = await startGateway(t, {
    artifactRoot: first.artifactRoot,
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
  });
  const restarted = new TestMcpClient(third.endpoint, T03_WEBHOOK_TOKEN);
  await restarted.initialize();
  await restarted.listTools();
  assert.deepEqual(await restarted.callTool("list_action_types", {}), {
    action_types: ["fixture.echo"],
  });
  await third.stop();

  const replacementCentral = await startFakeCentral(t);
  await assert.rejects(
    startGateway(t, {
      artifactRoot: first.artifactRoot,
      webhookUrl: webhook.url,
      webhookToken: T03_WEBHOOK_TOKEN,
      centralApiUrl: replacementCentral.apiUrl,
      centralMcpUrl: replacementCentral.mcpUrl,
    }),
  );
  assert.equal(replacementCentral.calls.length, 0, "endpoint mismatch reached replacement central");
});

test("T03-U06 reissue rejects every identity, key, algorithm, and lifetime change", async (t) => {
  const vectors: ReadonlyArray<{
    readonly name: string;
    readonly token: (original: T03CredentialRecord) => string;
  }> = [
    {
      name: "issuer changed",
      token: (original) =>
        reissueToken(original.access_token, {
          claims: { iss: "urn:a2a:fixture:issuer:other" },
        }),
    },
    {
      name: "subject changed",
      token: (original) =>
        reissueToken(original.access_token, { claims: { sub: "agent_fixture_other" } }),
    },
    {
      name: "ordered audience changed",
      token: (original) =>
        reissueToken(original.access_token, {
          claims: {
            aud: ["urn:a2a:fixture:resource:mcp:v2", "urn:a2a:fixture:resource:api:v2"],
          },
        }),
    },
    {
      name: "key thumbprint changed",
      token: (original) =>
        reissueToken(original.access_token, {
          claims: { cnf: { jkt: "F".repeat(43) } },
        }),
    },
    {
      name: "token signing algorithm changed",
      token: (original) => reissueToken(original.access_token, { header: { alg: "ES384" } }),
    },
    {
      name: "lifetime changed",
      token: (original) => reissueToken(original.access_token, { claims: { exp: 1_788_129_600 } }),
    },
    {
      name: "token identifier reused",
      token: (original) => {
        const payload = JSON.parse(
          Buffer.from(original.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        return reissueToken(original.access_token, { claims: { jti: payload.jti } });
      },
    },
    {
      name: "expiry did not advance",
      token: (original) => {
        const payload = JSON.parse(
          Buffer.from(original.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        return reissueToken(original.access_token, { claims: { exp: payload.exp } });
      },
    },
  ];

  for (const vector of vectors) {
    await t.test(vector.name, async (subtest) => {
      const central = await startFakeCentral(subtest);
      const original = seededCredentialV2(central, "fixture_sender");
      setReissueClock(subtest, central);
      const api = await startT03ScriptedCentralApi(subtest, reissuePlans(vector.token(original)));
      const webhook = await startFakeWebhook(subtest);
      const credentials = capturingCredentialStore(JSON.stringify(original));
      const gateway = await startGateway(subtest, {
        webhookUrl: webhook.url,
        webhookToken: T03_WEBHOOK_TOKEN,
        centralApiUrl: api.url,
        centralMcpUrl: central.mcpUrl,
        credentialStore: credentials.adapter,
      });
      const requests = () =>
        api.requests.filter((request) => request.path === "/api/v2/token/reissue");
      await waitForT03Observation(() => requests().length === 2);
      await waitForT03Observation(() => requests()[1]?.responseFinished() === true);
      const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
      await client.initialize();
      await client.listTools();
      assert.deepEqual(await client.callTool("list_action_types", {}), {
        action_types: ["fixture.echo"],
      });
      await gateway.stop();
      assert.equal(credentials.saved.length, 0, "invalid reissue response was persisted");
    });
  }
});

test("T03-U07 reissue applies strict interception and response-shape rules", async (t) => {
  const vectors: ReadonlyArray<{
    readonly name: string;
    readonly response: (token: string) => T03ResponsePlan;
  }> = [
    {
      name: "missing no-store",
      response: (token) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, token_type: "DPoP", expires_in: 86_400 }),
      }),
    },
    {
      name: "wrong token type",
      response: (token) => ({
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        body: JSON.stringify({ token, token_type: "Bearer", expires_in: 86_400 }),
      }),
    },
    {
      name: "wrong declared lifetime",
      response: (token) => ({
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        body: JSON.stringify({ token, token_type: "DPoP", expires_in: 86_399 }),
      }),
    },
    {
      name: "duplicate token member",
      response: (token) => ({
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        body: `{"token":${JSON.stringify(token)},"token":${JSON.stringify(
          token,
        )},"token_type":"DPoP","expires_in":86400}`,
      }),
    },
    {
      name: "extra top-level member",
      response: (token) => ({
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        body: JSON.stringify({ token, token_type: "DPoP", expires_in: 86_400, status: "ok" }),
      }),
    },
    {
      name: "token bytes outside selected field",
      response: (token) => ({
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
        body: JSON.stringify({
          token,
          token_type: "DPoP",
          expires_in: 86_400,
          diagnostic: { echoed: token },
        }),
      }),
    },
    {
      name: "wrong media type",
      response: (token) => ({
        status: 200,
        headers: { "cache-control": "no-store", "content-type": "text/plain" },
        body: JSON.stringify({ token, token_type: "DPoP", expires_in: 86_400 }),
      }),
    },
  ];

  for (const vector of vectors) {
    await t.test(vector.name, async (subtest) => {
      const central = await startFakeCentral(subtest);
      const original = seededCredentialV2(central, "fixture_sender");
      setReissueClock(subtest, central);
      const replacement = reissueToken(original.access_token);
      const challenge = reissuePlans(replacement)[0];
      assert.ok(challenge !== undefined);
      const api = await startT03ScriptedCentralApi(subtest, [
        challenge,
        { ...vector.response(replacement), method: "POST", path: "/api/v2/token/reissue" },
      ]);
      const webhook = await startFakeWebhook(subtest);
      const credentials = capturingCredentialStore(JSON.stringify(original));
      const gateway = await startGateway(subtest, {
        webhookUrl: webhook.url,
        webhookToken: T03_WEBHOOK_TOKEN,
        centralApiUrl: api.url,
        centralMcpUrl: central.mcpUrl,
        credentialStore: credentials.adapter,
      });
      const requests = () =>
        api.requests.filter((request) => request.path === "/api/v2/token/reissue");
      await waitForT03Observation(() => requests()[1]?.responseFinished() === true);
      const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
      await client.initialize();
      await client.listTools();
      assert.deepEqual(await client.callTool("list_action_types", {}), {
        action_types: ["fixture.echo"],
      });
      await gateway.stop();
      assert.equal(credentials.saved.length, 0, "unsafe reissue response was persisted");
      const transportMarkers = requests().flatMap((request, index) => {
        const proof = request.headers.dpop;
        const idempotency = request.headers["idempotency-key"];
        return [
          ...(typeof proof === "string" ? [{ name: `proof-${index + 1}`, value: proof }] : []),
          ...(typeof idempotency === "string"
            ? [{ name: `idempotency-${index + 1}`, value: idempotency }]
            : []),
        ];
      });
      await runT03ArtifactScan({
        artifactRoot: gateway.artifactRoot,
        captures: [
          { name: "stdout", value: gateway.stdout() },
          { name: "stderr", value: gateway.stderr() },
        ],
        markers: [
          { name: "rejected-token", value: replacement },
          { name: "private-key", value: original.dpop_private_key_pkcs8 },
          { name: "nonce", value: "E".repeat(76) },
          ...transportMarkers,
        ],
      });
    });
  }
});
