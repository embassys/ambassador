import assert from "node:assert/strict";
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
  T03_CODE,
  T03_EMAIL,
  T03_USERNAME,
  T03_WEBHOOK_TOKEN,
  type T03CredentialRecord,
} from "./support/t03-contract-fixtures.js";
import {
  installT03FetchObserver,
  runT03ArtifactScan,
  waitForT03Observation,
} from "./support/t03-observation.js";

test("T03-A01 verbose enrollment and reissue redact actual proof, nonce, token, key, code, and idempotency markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_788_000_000_000 });
  const artifactRoot = await mkdtemp(join(tmpdir(), "a2a-t03-verbose-reissue-"));
  t.after(() => rm(artifactRoot, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const webhook = await startFakeWebhook(t);
  const observed = installT03FetchObserver(t, [central.apiUrl]);
  const first = await startGateway(t, {
    artifactRoot,
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    verbose: true,
  });
  const client = new TestMcpClient(first.endpoint, T03_WEBHOOK_TOKEN);
  await client.initialize();
  await client.callTool("register_agent", {
    email: T03_EMAIL,
    username: T03_USERNAME,
  });
  await client.callTool("verify_email", { email: T03_EMAIL, code: T03_CODE });
  await first.stop();
  const enrollmentCount = observed.observations.length;

  const scope = JSON.stringify({
    centralApiUrl: new URL(central.apiUrl).href,
    centralMcpUrl: new URL(central.mcpUrl).href,
  });
  const credentialPath = join(first.stateRoot, "central-credential.json");
  const originalStored = await new EncryptedFileCredentialStore(
    credentialPath,
    T03_WEBHOOK_TOKEN,
    scope,
  ).loadCredential();
  assert.equal(originalStored?.version, 2);
  const originalText = originalStored?.plaintext;
  assert.ok(originalText !== undefined);
  const original = JSON.parse(originalText) as T03CredentialRecord;

  central.advanceClock(43_201);
  t.mock.timers.setTime(central.clock() * 1_000);
  const second = await startGateway(t, {
    artifactRoot,
    webhookUrl: webhook.url,
    webhookToken: T03_WEBHOOK_TOKEN,
    centralApiUrl: central.apiUrl,
    centralMcpUrl: central.mcpUrl,
    verbose: true,
  });
  const reissue = () =>
    observed.observations
      .slice(enrollmentCount)
      .filter((observation) => new URL(observation.url).pathname === "/api/v2/token/reissue");
  await waitForT03Observation(() => reissue().length >= 2);
  const replacementStore = new EncryptedFileCredentialStore(
    credentialPath,
    T03_WEBHOOK_TOKEN,
    scope,
  );
  let replacementText: string | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stored = await replacementStore.loadCredential();
    const candidate = stored?.version === 2 ? stored.plaintext : undefined;
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
  const replacement = JSON.parse(replacementText) as T03CredentialRecord;
  const observations = observed.observations;
  const proofs = observations.flatMap((observation) =>
    observation.requestHeaders.dpop === undefined ? [] : [observation.requestHeaders.dpop],
  );
  const nonces = observations.flatMap((observation) =>
    observation.responseHeaders["dpop-nonce"] === undefined
      ? []
      : [observation.responseHeaders["dpop-nonce"]],
  );
  const idempotencyKeys = reissue().flatMap((observation) =>
    observation.requestHeaders["idempotency-key"] === undefined
      ? []
      : [observation.requestHeaders["idempotency-key"]],
  );
  assert.ok(proofs.length >= 4 && nonces.length >= 2 && idempotencyKeys.length === 2);
  assert.ok(idempotencyKeys[0] === idempotencyKeys[1]);

  await runT03ArtifactScan({
    artifactRoot,
    captures: [
      { name: "stdout", value: `${first.stdout()}${second.stdout()}` },
      { name: "stderr", value: `${first.stderr()}${second.stderr()}` },
    ],
    markers: [
      { name: "verification-code", value: T03_CODE },
      { name: "original-token", value: original.access_token },
      { name: "replacement-token", value: replacement.access_token },
      { name: "private-key", value: replacement.dpop_private_key_pkcs8 },
      { name: "reissue-idempotency", value: idempotencyKeys[0] ?? "missing-marker" },
      ...proofs.map((value, index) => ({ name: `proof-${index + 1}`, value })),
      ...nonces.map((value, index) => ({ name: `nonce-${index + 1}`, value })),
    ],
  });
});
