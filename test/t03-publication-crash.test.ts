import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { defaultGatewayPaths } from "../src/gateway-paths.js";
import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import {
  seededCredentialV2,
  T03_WEBHOOK_TOKEN,
  type T03CredentialRecord,
} from "./support/t03-contract-fixtures.js";
import {
  runT03ArtifactScan,
  startT03ScriptedCentralApi,
  type T03ResponsePlan,
} from "./support/t03-observation.js";
import { V2_PROCESS_BARRIER_NAMES } from "./support/v2-process-barriers.js";
import { startV2ManagedProcess, v2NodeProcessEnvironment } from "./support/v2-process-runtime.js";

interface PublicationFixture {
  readonly api: Awaited<ReturnType<typeof startT03ScriptedCentralApi>>;
  readonly artifactRoot: string;
  readonly centralMcpUrl: string;
  readonly credentialPath: string;
  readonly original: T03CredentialRecord;
  readonly originalDigest: string;
  readonly replacement: T03CredentialRecord;
  readonly releaseFirstResponse: () => void;
  readonly scope: string;
  readonly webhookUrl: string;
}

function rewriteToken(source: string, claims: Readonly<Record<string, unknown>>): string {
  const segments = source.split(".");
  assert.equal(segments.length, 3);
  const header = JSON.parse(Buffer.from(segments[0] ?? "", "base64url").toString("utf8"));
  const payload = JSON.parse(
    Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(
    JSON.stringify({ ...payload, ...claims }),
  ).toString("base64url")}.${Buffer.alloc(64).toString("base64url")}`;
}

async function publicationFixture(t: TestContext): Promise<PublicationFixture> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "a2a-t03-publication-crash-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const seeded = seededCredentialV2(central, "fixture_sender");
  const now = Math.floor(Date.now() / 1_000);
  const original: T03CredentialRecord = {
    ...seeded,
    access_token: rewriteToken(seeded.access_token, {
      iat: now - 43_201,
      exp: now + 43_199,
      jti: "00000000-0000-4000-8000-000000000a01",
    }),
  };
  const replacement: T03CredentialRecord = {
    ...original,
    access_token: rewriteToken(original.access_token, {
      iat: now,
      exp: now + 86_400,
      jti: "00000000-0000-4000-8000-000000000a02",
    }),
  };
  let releaseFirstResponse: (() => void) | undefined;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  const challenge: T03ResponsePlan = {
    method: "POST",
    path: "/api/v2/token/reissue",
    status: 401,
    headers: {
      "cache-control": "no-store",
      "dpop-nonce": "G".repeat(76),
      "www-authenticate": 'DPoP error="use_dpop_nonce"',
    },
  };
  const success: T03ResponsePlan = {
    method: "POST",
    path: "/api/v2/token/reissue",
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
    body: JSON.stringify({
      token: replacement.access_token,
      token_type: "DPoP",
      expires_in: 86_400,
    }),
  };
  const api = await startT03ScriptedCentralApi(t, [
    challenge,
    { ...success, waitFor: firstResponseGate },
    challenge,
    success,
  ]);
  const scope = JSON.stringify({
    centralApiUrl: new URL(api.url).href,
    centralMcpUrl: new URL(central.mcpUrl).href,
  });
  const credentialPath = defaultGatewayPaths(
    process.platform,
    { XDG_STATE_HOME: join(artifactRoot, "state") },
    artifactRoot,
  ).credentialPath;
  const store = new EncryptedFileCredentialStore(credentialPath, T03_WEBHOOK_TOKEN, scope);
  await store.saveCredential({ version: 2, plaintext: JSON.stringify(original) });
  const originalDigest = createHash("sha256")
    .update(await readFile(credentialPath))
    .digest("hex");
  assert.ok(releaseFirstResponse !== undefined);
  return {
    api,
    artifactRoot,
    centralMcpUrl: central.mcpUrl,
    credentialPath,
    original,
    originalDigest,
    replacement,
    releaseFirstResponse,
    scope,
    webhookUrl: webhook.url,
  };
}

function startWorker(t: TestContext, fixture: PublicationFixture, expectPublication: boolean) {
  return startV2ManagedProcess(t, {
    command: process.execPath,
    args: [join(process.cwd(), ".test-dist", "test", "support", "t03-crash-worker.js")],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      T03_ARTIFACT_ROOT: fixture.artifactRoot,
      T03_CENTRAL_API_URL: fixture.api.url,
      T03_CENTRAL_MCP_URL: fixture.centralMcpUrl,
      T03_WEBHOOK_URL: fixture.webhookUrl,
      T03_WEBHOOK_TOKEN,
      T03_CREDENTIAL_DIGEST: fixture.originalDigest,
      T03_CREDENTIAL_PATH: fixture.credentialPath,
      ...(expectPublication ? { T03_EXPECT_PUBLICATION: "1" } : {}),
    }),
    gracefulStopMs: 500,
    forcedStopMs: 2_000,
  });
}

async function reachOperation(worker: ReturnType<typeof startWorker>): Promise<void> {
  for (const name of ["startup", "readiness", "operation"] as const) {
    await worker.barriers.waitFor(name, 10_000);
    if (name !== "operation") worker.barriers.release(name);
  }
}

async function finishWorker(worker: ReturnType<typeof startWorker>): Promise<void> {
  for (const name of ["operation", "commit", "response", "teardown"] as const) {
    if (name !== "operation") await worker.barriers.waitFor(name, 10_000);
    worker.barriers.release(name);
  }
  assert.deepEqual(await worker.waitForExit(), { code: 0, signal: null });
  assert.deepEqual(worker.barriers.arrivalOrder, V2_PROCESS_BARRIER_NAMES);
  assert.equal(worker.stderr(), "");
}

function reissueCount(fixture: PublicationFixture): number {
  return fixture.api.requests.filter((request) => request.path === "/api/v2/token/reissue").length;
}

async function waitForReissueCount(fixture: PublicationFixture, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (reissueCount(fixture) !== expected && Date.now() < deadline) {
    await delay(10);
  }
  assert.equal(reissueCount(fixture), expected, "reissue request count missed its bound");
}

async function scanPublicationArtifacts(
  fixture: PublicationFixture,
  captures: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): Promise<void> {
  const requests = fixture.api.requests.filter(
    (request) => request.path === "/api/v2/token/reissue",
  );
  const transportMarkers = requests.flatMap((request, index) => {
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
    artifactRoot: fixture.artifactRoot,
    captures,
    markers: [
      { name: "original-token", value: fixture.original.access_token },
      { name: "replacement-token", value: fixture.replacement.access_token },
      { name: "private-key", value: fixture.original.dpop_private_key_pkcs8 },
      { name: "nonce", value: "G".repeat(76) },
      ...transportMarkers,
    ],
  });
}

test("T03-C01 a full-process crash during pre-response uncertainty retains the old credential", async (t) => {
  const fixture = await publicationFixture(t);
  const crashed = startWorker(t, fixture, true);
  await reachOperation(crashed);
  await waitForReissueCount(fixture, 2);
  assert.equal(
    createHash("sha256")
      .update(await readFile(fixture.credentialPath))
      .digest("hex"),
    fixture.originalDigest,
  );
  await crashed.stop();
  fixture.releaseFirstResponse();

  const beforeRecoveryStored = await new EncryptedFileCredentialStore(
    fixture.credentialPath,
    T03_WEBHOOK_TOKEN,
    fixture.scope,
  ).loadCredential();
  assert.equal(beforeRecoveryStored?.version, 2);
  const beforeRecovery = beforeRecoveryStored?.plaintext;
  assert.equal(beforeRecovery, JSON.stringify(fixture.original));

  const recovery = startWorker(t, fixture, true);
  await reachOperation(recovery);
  await waitForReissueCount(fixture, 4);
  await finishWorker(recovery);
  const afterRecoveryStored = await new EncryptedFileCredentialStore(
    fixture.credentialPath,
    T03_WEBHOOK_TOKEN,
    fixture.scope,
  ).loadCredential();
  assert.equal(afterRecoveryStored?.version, 2);
  const afterRecovery = afterRecoveryStored?.plaintext;
  assert.equal(afterRecovery, JSON.stringify(fixture.replacement));
  await scanPublicationArtifacts(fixture, [
    { name: "crash-stdout", value: crashed.stdout() },
    { name: "crash-stderr", value: crashed.stderr() },
    { name: "recovery-stdout", value: recovery.stdout() },
    { name: "recovery-stderr", value: recovery.stderr() },
  ]);
});

test("T03-C02 a full-process crash after publication reloads one complete replacement", async (t) => {
  const fixture = await publicationFixture(t);
  const crashed = startWorker(t, fixture, true);
  await reachOperation(crashed);
  await waitForReissueCount(fixture, 2);
  fixture.releaseFirstResponse();
  crashed.barriers.release("operation");
  await crashed.barriers.waitFor("commit", 10_000);
  const publishedDigest = createHash("sha256")
    .update(await readFile(fixture.credentialPath))
    .digest("hex");
  assert.notEqual(publishedDigest, fixture.originalDigest);
  await crashed.stop();

  const storedCredential = await new EncryptedFileCredentialStore(
    fixture.credentialPath,
    T03_WEBHOOK_TOKEN,
    fixture.scope,
  ).loadCredential();
  assert.equal(storedCredential?.version, 2);
  const stored = storedCredential?.plaintext;
  assert.equal(stored, JSON.stringify(fixture.replacement));
  const envelope = JSON.parse(await readFile(fixture.credentialPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(envelope.version, 2);

  const recovery = startWorker(t, { ...fixture, originalDigest: publishedDigest }, false);
  await reachOperation(recovery);
  await finishWorker(recovery);
  await scanPublicationArtifacts(fixture, [
    { name: "crash-stdout", value: crashed.stdout() },
    { name: "crash-stderr", value: crashed.stderr() },
    { name: "recovery-stdout", value: recovery.stdout() },
    { name: "recovery-stderr", value: recovery.stderr() },
  ]);
});
