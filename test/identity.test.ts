import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeCentralCredential } from "../src/central-credential.js";
import { type CredentialStore, GatewayIdentity, IdentityError } from "../src/identity.js";
import {
  currentCredential,
  currentCredentialRecord,
  FIXTURE_NOW_SECONDS,
} from "./support/current-credential.js";

function memoryStore(initial?: string): CredentialStore & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    async load() {
      return initial;
    },
    async save(credential) {
      saved.push(credential);
    },
  };
}

test("loads one current bound credential without exposing mutable state", async () => {
  const serialized = currentCredential();
  const identity = await GatewayIdentity.open(memoryStore(serialized), () => FIXTURE_NOW_SECONDS);
  assert.equal(identity.enrolled, true);
  assert.equal(identity.credential().serialized, serialized);
});

test("keeps the identity and local key readable after expiry while refusing protected use", async () => {
  let now = FIXTURE_NOW_SECONDS;
  const store = memoryStore(currentCredential());
  const identity = await GatewayIdentity.open(store, () => now);
  const original = identity.credential();
  now = original.token.expiresAt;
  assert.equal(identity.enrolled, true);
  assert.equal(identity.expired, true);
  assert.equal(identity.localCredential().keyThumbprint, original.keyThumbprint);
  assert.throws(
    () => identity.credential(),
    (error: unknown) => error instanceof IdentityError && error.code === "credential_expired",
  );
  const reopened = await GatewayIdentity.open(store, () => now);
  assert.equal(reopened.expired, true);
  assert.equal(reopened.localCredential().serialized, original.serialized);
  assert.deepEqual(store.saved, []);
});

test("persists the atomic credential before enabling the identity", async () => {
  const store = memoryStore();
  const identity = await GatewayIdentity.open(store, () => FIXTURE_NOW_SECONDS);
  const credential = currentCredentialRecord("enrolled@fixture.test", "agent.enrolled");
  let savedBeforeReturn = false;
  const originalSave = store.save;
  store.save = async (value) => {
    await originalSave(value);
    savedBeforeReturn = true;
  };
  const local = await identity.enroll(async () => ({
    credential,
    localResult: { verified: true, email: "enrolled@fixture.test" },
  }));
  assert.equal(savedBeforeReturn, true);
  assert.deepEqual(local, { verified: true, email: "enrolled@fixture.test" });
  assert.equal(store.saved[0], serializeCentralCredential(credential));
  assert.equal(identity.enrolled, true);
});

test("does not enable an identity when atomic persistence fails", async () => {
  const store: CredentialStore = {
    async load() {
      return undefined;
    },
    async save() {
      throw new Error("injected persistence failure");
    },
  };
  const identity = await GatewayIdentity.open(store, () => FIXTURE_NOW_SECONDS);
  await assert.rejects(() =>
    identity.enroll(async () => ({
      credential: currentCredentialRecord(),
      localResult: { verified: true },
    })),
  );
  assert.equal(identity.enrolled, false);
});

test("rejects concurrent and repeated enrollment", async () => {
  const store = memoryStore();
  const identity = await GatewayIdentity.open(store, () => FIXTURE_NOW_SECONDS);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = identity.enroll(async () => {
    await barrier;
    return { credential: currentCredentialRecord(), localResult: true };
  });
  await assert.rejects(
    identity.enroll(async () => ({ credential: currentCredentialRecord(), localResult: false })),
    (error: unknown) => error instanceof IdentityError && error.code === "verification_busy",
  );
  release();
  await first;
  await assert.rejects(
    identity.enroll(async () => ({ credential: currentCredentialRecord(), localResult: false })),
    (error: unknown) => error instanceof IdentityError && error.code === "already_enrolled",
  );
});
