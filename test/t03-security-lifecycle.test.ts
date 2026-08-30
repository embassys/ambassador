import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  verify,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { TestMcpClient } from "./support/mcp-client.js";
import { startGateway } from "./support/start-gateway.js";
import {
  capturingCredentialStore,
  registerPendingIdentity,
  seededCredentialV2,
  T03_CODE,
  T03_EMAIL,
  T03_WEBHOOK_TOKEN,
  type T03CredentialRecord,
  useT03FixtureClock,
} from "./support/t03-contract-fixtures.js";
import {
  installT03FetchObserver,
  runT03ArtifactScan,
  type T03HttpObservation,
  waitForT03Observation,
} from "./support/t03-observation.js";

function jsonObject(bytes: Buffer): Record<string, unknown> {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function jwtPart(jwt: string, index: number): Record<string, unknown> {
  const segments = jwt.split(".");
  assert.equal(segments.length, 3, "JOSE value did not have three segments");
  const segment = segments[index];
  assert.ok(segment !== undefined, "JOSE segment was missing");
  return jsonObject(Buffer.from(segment, "base64url"));
}

function publicThumbprint(jwk: Record<string, unknown>): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}

function assertProofSignature(proof: string): void {
  const segments = proof.split(".");
  const encodedHeader = segments[0];
  const encodedPayload = segments[1];
  const encodedSignature = segments[2];
  assert.ok(
    encodedHeader !== undefined && encodedPayload !== undefined && encodedSignature !== undefined,
    "proof was not compact JOSE",
  );
  const header = jwtPart(proof, 0);
  assert.ok(header.jwk !== null && typeof header.jwk === "object" && !Array.isArray(header.jwk));
  const key = createPublicKey({ key: header.jwk as JsonWebKey, format: "jwk" });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    ),
    "proof signature was not a valid P-256 ES256 signature",
  );
}

function verifyRequests(observations: readonly T03HttpObservation[]): T03HttpObservation[] {
  return observations.filter(
    (observation) => new URL(observation.url).pathname === "/api/verify_email",
  );
}

function tokenWithClaims(token: string, claims: Readonly<Record<string, unknown>>): string {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const payload = jwtPart(token, 1);
  return `${parts[0]}.${Buffer.from(JSON.stringify({ ...payload, ...claims })).toString(
    "base64url",
  )}.${parts[2]}`;
}

function tokenWithoutClaim(token: string, claim: string): string {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const payload = jwtPart(token, 1);
  assert.ok(Object.hasOwn(payload, claim));
  delete payload[claim];
  assert.ok(!Object.hasOwn(payload, claim));
  return `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
}

function withoutField(
  record: T03CredentialRecord,
  field: keyof T03CredentialRecord,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== field));
}

test("T03-S01 enrollment uses fresh bound P-256 proofs and persists one JSON credential", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  await registerPendingIdentity(central);
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  const credentials = capturingCredentialStore();
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: credentials.adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();

  const result = await client.callTool("verify_email", { email: T03_EMAIL, code: T03_CODE });
  assert.ok(result.verified === true, "verification did not return the safe success projection");
  assert.ok(!Object.hasOwn(result, "token"), "verification exposed a token to local MCP");

  const requests = verifyRequests(observed.observations);
  assert.equal(requests.length, 2, "verification did not perform exactly one safe nonce retry");
  const first = requests[0];
  const second = requests[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.responseStatus, 400);
  assert.equal(second.responseStatus, 200);
  assert.ok(first.requestHeaders.authorization === undefined, "issuance sent authorization");
  assert.ok(second.requestHeaders.authorization === undefined, "issuance retry sent authorization");
  assert.ok(typeof first.requestHeaders.dpop === "string", "issuance proof was absent");
  assert.ok(typeof second.requestHeaders.dpop === "string", "issuance retry proof was absent");
  assert.ok(
    first.requestHeaders.dpop !== second.requestHeaders.dpop,
    "issuance proof was replayed",
  );

  const nonce = first.responseHeaders["dpop-nonce"];
  assert.ok(typeof nonce === "string" && /^[A-Za-z0-9_-]{76}$/u.test(nonce));
  for (const [index, request] of requests.entries()) {
    const proof = request.requestHeaders.dpop;
    assert.ok(typeof proof === "string");
    assert.ok(Buffer.byteLength(proof, "ascii") <= 4_096, "proof exceeded its bound");
    assertProofSignature(proof);
    const header = jwtPart(proof, 0);
    const payload = jwtPart(proof, 1);
    assert.deepEqual(Object.keys(header).sort(), ["alg", "jwk", "typ"]);
    assert.ok(header.alg === "ES256" && header.typ === "dpop+jwt");
    assert.deepEqual(Object.keys(header.jwk as Record<string, unknown>).sort(), [
      "crv",
      "kty",
      "x",
      "y",
    ]);
    assert.ok(payload.htm === "POST" && payload.htu === request.url);
    assert.ok(payload.iat === central.clock(), "proof timestamp did not use the fixture clock");
    assert.ok(
      typeof payload.jti === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(payload.jti),
      "proof identifier was not a lowercase UUID v4",
    );
    assert.ok(payload.ath === undefined, "issuance proof contained an access-token hash");
    assert.ok(
      index === 0 ? payload.nonce === undefined : payload.nonce === nonce,
      "issuance nonce placement was invalid",
    );
    const body = jsonObject(request.requestBody);
    assert.ok(body.email === T03_EMAIL && body.code === T03_CODE, "verification body changed");
    assert.deepEqual(Object.keys(body).sort(), ["code", "email"]);
  }

  assert.equal(credentials.saved.length, 1);
  const savedText = credentials.saved[0];
  assert.ok(savedText !== undefined);
  const saved = JSON.parse(savedText) as T03CredentialRecord;
  assert.deepEqual(Object.keys(saved).sort(), [
    "access_token",
    "credential_version",
    "dpop_alg",
    "dpop_private_key_pkcs8",
    "token_type",
  ]);
  assert.ok(Buffer.byteLength(savedText, "utf8") <= 8_192, "credential record exceeded its bound");
  const privateKey = createPrivateKey({
    key: Buffer.from(saved.dpop_private_key_pkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const storedJwk = createPublicKey(privateKey).export({ format: "jwk" }) as Record<
    string,
    unknown
  >;
  const tokenPayload = jwtPart(saved.access_token, 1);
  const confirmation = tokenPayload.cnf as Record<string, unknown>;
  assert.ok(
    confirmation?.jkt === publicThumbprint(storedJwk),
    "persisted token and private key were not bound",
  );
});

test("T03-S02 malformed fresh-install version 2 records fail before central dispatch", async (t) => {
  const nonP256Key = generateKeyPairSync("ed25519").privateKey.export({
    format: "der",
    type: "pkcs8",
  });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly record: (central: Awaited<ReturnType<typeof startFakeCentral>>) => string;
  }> = [
    { name: "invalid JSON", record: () => "{" },
    {
      name: "duplicate credential field",
      record: (central) => {
        const value = JSON.stringify(seededCredentialV2(central, "fixture_sender"));
        return value.replace(
          '{"credential_version":2,',
          '{"credential_version":2,"credential_version":2,',
        );
      },
    },
    {
      name: "missing credential version",
      record: (central) =>
        JSON.stringify(
          withoutField(seededCredentialV2(central, "fixture_sender"), "credential_version"),
        ),
    },
    {
      name: "wrong credential version",
      record: (central) =>
        JSON.stringify({ ...seededCredentialV2(central, "fixture_sender"), credential_version: 3 }),
    },
    {
      name: "wrong credential token type",
      record: (central) =>
        JSON.stringify({ ...seededCredentialV2(central, "fixture_sender"), token_type: "Bearer" }),
    },
    {
      name: "unknown field",
      record: (central) =>
        JSON.stringify({ ...seededCredentialV2(central, "fixture_sender"), unexpected: true }),
    },
    {
      name: "unsupported DPoP algorithm",
      record: (central) =>
        JSON.stringify({ ...seededCredentialV2(central, "fixture_sender"), dpop_alg: "ES384" }),
    },
    {
      name: "token and key mismatch",
      record: (central) =>
        JSON.stringify({
          ...seededCredentialV2(central, "fixture_sender"),
          dpop_private_key_pkcs8: seededCredentialV2(central, "fixture_recipient")
            .dpop_private_key_pkcs8,
        }),
    },
    {
      name: "malformed token",
      record: (central) =>
        JSON.stringify({
          ...seededCredentialV2(central, "fixture_sender"),
          access_token: " bad token ",
        }),
    },
    {
      name: "invalid private-key base64url",
      record: (central) =>
        JSON.stringify({
          ...seededCredentialV2(central, "fixture_sender"),
          dpop_private_key_pkcs8: "not+base64url",
        }),
    },
    {
      name: "malformed private-key DER",
      record: (central) =>
        JSON.stringify({
          ...seededCredentialV2(central, "fixture_sender"),
          dpop_private_key_pkcs8: "AA",
        }),
    },
    {
      name: "non-P-256 private key",
      record: (central) =>
        JSON.stringify({
          ...seededCredentialV2(central, "fixture_sender"),
          dpop_private_key_pkcs8: nonP256Key.toString("base64url"),
        }),
    },
    {
      name: "missing token confirmation",
      record: (central) => {
        const credential = seededCredentialV2(central, "fixture_sender");
        return JSON.stringify({
          ...credential,
          access_token: tokenWithoutClaim(credential.access_token, "cnf"),
        });
      },
    },
    {
      name: "malformed token thumbprint",
      record: (central) => {
        const credential = seededCredentialV2(central, "fixture_sender");
        return JSON.stringify({
          ...credential,
          access_token: tokenWithClaims(credential.access_token, { cnf: { jkt: "short" } }),
        });
      },
    },
  ];

  for (const vector of cases) {
    await t.test(vector.name, async (subtest) => {
      useT03FixtureClock(subtest);
      const central = await startFakeCentral(subtest);
      const observed = installT03FetchObserver(subtest, [central.apiUrl]);
      const webhook = await startFakeWebhook(subtest);
      await assert.rejects(
        startGateway(subtest, {
          webhookUrl: webhook.url,
          webhookToken: T03_WEBHOOK_TOKEN,
          centralApiUrl: central.apiUrl,
          centralMcpUrl: central.mcpUrl,
          credentialStore: capturingCredentialStore(vector.record(central)).adapter,
        }),
      );
      assert.equal(observed.observations.length, 0, "invalid credential reached central");
    });
  }
});

test("T03-S03 protected REST and MCP use fresh token-free DPoP transport requests", async (t) => {
  useT03FixtureClock(t);
  const central = await startFakeCentral(t);
  const credential = seededCredentialV2(central, "fixture_sender");
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  const gateway = await startGateway(t, {
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: capturingCredentialStore(JSON.stringify(credential)).adapter,
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await client.listTools();
  assert.deepEqual(await client.callTool("list_action_types", {}), {
    action_types: ["fixture.echo"],
  });
  assert.deepEqual(await client.callTool("list_action_types", {}), {
    action_types: ["fixture.echo"],
  });
  await waitForT03Observation(() => observed.observations.length > 0);

  const protectedRequests = observed.observations.filter((observation) => {
    const path = new URL(observation.url).pathname;
    return path === "/mcp" || path.startsWith("/api/");
  });
  assert.ok(protectedRequests.some((request) => new URL(request.url).pathname === "/mcp"));
  assert.ok(
    protectedRequests.some((request) => new URL(request.url).pathname.startsWith("/api/")),
    "protected REST was not started",
  );
  const proofs = new Set<string>();
  for (const request of protectedRequests) {
    assert.ok(
      request.requestHeaders.authorization === `DPoP ${credential.access_token}`,
      "protected request did not use the DPoP authorization scheme",
    );
    const proof = request.requestHeaders.dpop;
    assert.ok(typeof proof === "string", "protected request omitted its proof");
    assertProofSignature(proof);
    assert.ok(!proofs.has(proof), "protected request replayed a proof");
    proofs.add(proof);
    const payload = jwtPart(proof, 1);
    const target = new URL(request.url);
    target.search = "";
    target.hash = "";
    assert.ok(
      payload.htm === request.method && payload.htu === target.href,
      "proof target changed",
    );
    assert.ok(
      payload.ath === createHash("sha256").update(credential.access_token).digest("base64url"),
      "proof access-token hash was invalid",
    );
    const body = request.requestBody.toString("utf8");
    assert.ok(!body.includes(credential.access_token), "central request body contained the token");
    assert.ok(!body.includes('"token"'), "central MCP request contained a token argument");
  }
});

test("T03-S04 scheduled same-key reissue keeps one idempotency key and atomically replaces JSON", async (t) => {
  const central = await startFakeCentral(t);
  const original = seededCredentialV2(central, "fixture_sender");
  central.advanceClock(43_201);
  t.mock.timers.enable({ apis: ["Date"], now: central.clock() * 1_000 });
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

  const reissue = () =>
    observed.observations.filter(
      (observation) => new URL(observation.url).pathname === "/api/v2/token/reissue",
    );
  await waitForT03Observation(() => reissue().length >= 2);
  await waitForT03Observation(() => credentials.saved.length === 1);
  const requests = reissue();
  assert.equal(requests.length, 2, "reissue did not use one nonce retry");
  const firstKey = requests[0]?.requestHeaders["idempotency-key"];
  assert.ok(
    typeof firstKey === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(firstKey),
    "reissue idempotency key was not a lowercase UUID v4",
  );
  assert.ok(requests[1]?.requestHeaders["idempotency-key"] === firstKey);
  assert.ok(requests[0]?.requestHeaders.dpop !== requests[1]?.requestHeaders.dpop);
  assert.equal(credentials.saved.length, 1, "reissue did not publish exactly one replacement");
  const replacementText = credentials.saved[0];
  assert.ok(replacementText !== undefined);
  const replacement = JSON.parse(replacementText) as T03CredentialRecord;
  assert.ok(replacement.access_token !== original.access_token, "reissue kept the old token");
  assert.ok(
    replacement.dpop_private_key_pkcs8 === original.dpop_private_key_pkcs8,
    "reissue changed the private key",
  );
});

test("T03-S05 normal artifacts and captures exclude actual enrollment and DPoP markers", async (t) => {
  useT03FixtureClock(t);
  const artifactRoot = await mkdtemp(join(tmpdir(), "a2a-t03-artifacts-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  await registerPendingIdentity(central);
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const webhook = await startFakeWebhook(t);
  const credentialPath = join(artifactRoot, "state", "a2a-gateway", "central-credential.json");
  const delegate = new EncryptedFileCredentialStore(
    credentialPath,
    T03_WEBHOOK_TOKEN,
    JSON.stringify({
      centralApiUrl: new URL(central.apiUrl).href,
      centralMcpUrl: new URL(central.mcpUrl).href,
    }),
  );
  const saved: string[] = [];
  const gateway = await startGateway(t, {
    artifactRoot,
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    credentialStore: {
      async load() {
        return undefined;
      },
      async save() {
        throw new Error("T03 version 2 state reached the legacy credential store API");
      },
      async loadCredential() {
        return await delegate.loadCredential();
      },
      async saveCredential(credential) {
        assert.equal(credential.version, 2);
        saved.push(credential.plaintext);
        await delegate.saveCredential(credential);
      },
    },
  });
  const client = new TestMcpClient(gateway.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await client.callTool("verify_email", { email: T03_EMAIL, code: T03_CODE });
  assert.equal(saved.length, 1);
  const credential = JSON.parse(saved[0] ?? "") as T03CredentialRecord;
  await gateway.stop();

  const requests = verifyRequests(observed.observations);
  const proofs = requests.flatMap((request) =>
    request.requestHeaders.dpop === undefined ? [] : [request.requestHeaders.dpop],
  );
  const nonces = requests.flatMap((request) =>
    request.responseHeaders["dpop-nonce"] === undefined
      ? []
      : [request.responseHeaders["dpop-nonce"]],
  );
  assert.ok(proofs.length >= 2 && nonces.length >= 1, "runtime DPoP markers were not captured");
  await runT03ArtifactScan({
    artifactRoot,
    captures: [
      { name: "stdout", value: gateway.stdout() },
      { name: "stderr", value: gateway.stderr() },
    ],
    markers: [
      { name: "email", value: T03_EMAIL },
      { name: "verification-code", value: T03_CODE },
      { name: "access-token", value: credential.access_token },
      { name: "private-key", value: credential.dpop_private_key_pkcs8 },
      ...proofs.map((value, index) => ({ name: `proof-${index + 1}`, value })),
      ...nonces.map((value, index) => ({ name: `nonce-${index + 1}`, value })),
      ...requests.map((request, index) => ({
        name: `request-body-${index + 1}`,
        value: request.requestBody.toString("utf8"),
      })),
      ...requests.map((request, index) => ({
        name: `response-body-${index + 1}`,
        value: request.responseBody.toString("utf8"),
      })),
    ],
  });
});
