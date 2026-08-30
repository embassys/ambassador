import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialStore, VersionedCredentialStore } from "../src/credential-store.js";
import { serializeCentralCredentialV2 } from "../src/credential-v2.js";
import { createCentralCredentialV2Record, generateDpopKeyMaterial } from "../src/dpop.js";
import { GatewayIdentity } from "../src/identity.js";

function token(thumbprint: string, issuedAt: number, tokenId: string): string {
  return `${Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString(
    "base64url",
  )}.${Buffer.from(
    JSON.stringify({
      iss: "urn:a2a:test:issuer",
      aud: ["urn:a2a:test:api", "urn:a2a:test:mcp"],
      sub: "agent_test_0001",
      iat: issuedAt,
      exp: issuedAt + 86_400,
      jti: tokenId,
      cnf: { jkt: thumbprint },
    }),
  ).toString("base64url")}.${Buffer.alloc(64).toString("base64url")}`;
}

function memoryStore(
  initial?: string,
): CredentialStore & VersionedCredentialStore & { readonly saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    async load() {
      return undefined;
    },
    async save() {
      throw new Error("version 2 used the legacy store API");
    },
    async loadCredential() {
      return initial === undefined ? undefined : { version: 2, plaintext: initial };
    },
    async saveCredential(credential) {
      assert.equal(credential.version, 2);
      saved.push(credential.plaintext);
    },
  };
}

test("loads version 2 only through its discriminated store and runtime accessor", async () => {
  const key = generateDpopKeyMaterial();
  const record = createCentralCredentialV2Record(
    token(key.thumbprint, 1_788_000_000, "00000000-0000-4000-8000-000000000201"),
    key,
  );
  const identity = await GatewayIdentity.open(memoryStore(serializeCentralCredentialV2(record)));
  assert.throws(() => identity.authenticatedToken());
  assert.equal(identity.authenticatedCredentialV2().keyThumbprint, key.thumbprint);

  const legacyStore: CredentialStore = {
    async load() {
      return serializeCentralCredentialV2(record);
    },
    async save() {},
  };
  await assert.rejects(GatewayIdentity.open(legacyStore));

  const mismatched = memoryStore();
  mismatched.loadCredential = async () => ({
    version: 1,
    plaintext: serializeCentralCredentialV2(record),
  });
  await assert.rejects(GatewayIdentity.open(mismatched));
});

test("publishes a same-key replacement before switching the in-memory credential", async () => {
  const key = generateDpopKeyMaterial();
  const original = createCentralCredentialV2Record(
    token(key.thumbprint, 1_788_000_000, "00000000-0000-4000-8000-000000000202"),
    key,
  );
  const replacement = createCentralCredentialV2Record(
    token(key.thumbprint, 1_788_043_201, "00000000-0000-4000-8000-000000000203"),
    key,
  );
  const store = memoryStore(serializeCentralCredentialV2(original));
  const identity = await GatewayIdentity.open(store);
  await identity.replaceCredentialV2(replacement);
  assert.equal(store.saved.length, 1);
  assert.equal(identity.authenticatedCredentialV2().record.access_token, replacement.access_token);

  const failedStore: CredentialStore & VersionedCredentialStore = {
    async load() {
      return undefined;
    },
    async save() {},
    async loadCredential() {
      return { version: 2, plaintext: serializeCentralCredentialV2(original) };
    },
    async saveCredential() {
      throw new Error("injected replacement failure");
    },
  };
  const retained = await GatewayIdentity.open(failedStore);
  await assert.rejects(retained.replaceCredentialV2(replacement));
  assert.equal(retained.authenticatedCredentialV2().record.access_token, original.access_token);
});

test("rejects malformed version 2 state during open", async () => {
  await assert.rejects(GatewayIdentity.open(memoryStore('{"credential_version":2}')));
});

test("authentication failure blocks replacement before and during persistence", async () => {
  const key = generateDpopKeyMaterial();
  const original = createCentralCredentialV2Record(
    token(key.thumbprint, 1_788_000_000, "00000000-0000-4000-8000-000000000204"),
    key,
  );
  const replacement = createCentralCredentialV2Record(
    token(key.thumbprint, 1_788_043_201, "00000000-0000-4000-8000-000000000205"),
    key,
  );

  const failedBefore = memoryStore(serializeCentralCredentialV2(original));
  const beforeIdentity = await GatewayIdentity.open(failedBefore);
  beforeIdentity.markAuthenticationFailed();
  await assert.rejects(beforeIdentity.replaceCredentialV2(replacement));
  assert.equal(failedBefore.saved.length, 0);

  let releaseSave: (() => void) | undefined;
  let reportSaveStarted: (() => void) | undefined;
  const saveStarted = new Promise<void>((resolve) => {
    reportSaveStarted = resolve;
  });
  const saveReleased = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const racing = memoryStore(serializeCentralCredentialV2(original));
  racing.saveCredential = async (credential) => {
    assert.equal(credential.version, 2);
    reportSaveStarted?.();
    await saveReleased;
    racing.saved.push(credential.plaintext);
  };
  const racingIdentity = await GatewayIdentity.open(racing);
  const replacing = racingIdentity.replaceCredentialV2(replacement);
  await saveStarted;
  racingIdentity.markAuthenticationFailed();
  releaseSave?.();
  await assert.rejects(replacing);
  assert.equal(racing.saved.length, 1);
  assert.throws(() => racingIdentity.authenticatedCredentialV2());
});
