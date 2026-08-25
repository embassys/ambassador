import assert from "node:assert/strict";
import test from "node:test";

import { type CredentialStore, GatewayIdentity, IdentityError } from "../src/identity.js";
import { McpContractError } from "../src/mcp-contract.js";

const JWT = "central-jwt-stays-inside-identity";

function memoryStore(initial?: string): CredentialStore & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    async load() {
      return initial;
    },
    async save(token) {
      saved.push(token);
    },
  };
}

function verificationResult(): Record<string, unknown> {
  return {
    agent_id: "agent_fixture",
    username: "fixture-agent",
    token: JWT,
    message: "Email verified successfully.",
  };
}

test("loads an existing credential without returning it as state", async () => {
  const identity = await GatewayIdentity.open(memoryStore(JWT));
  assert.equal(identity.enrolled, true);
  assert.ok(identity.authenticatedToken() === JWT);
});

test("persists verification before enabling the token-free identity", async () => {
  const store = memoryStore();
  const identity = await GatewayIdentity.open(store);
  const local = await identity.verify(async () => verificationResult());

  assert.equal(identity.enrolled, true);
  assert.equal(store.saved.length, 1);
  assert.ok(store.saved[0] === JWT);
  assert.deepEqual(local, {
    verified: true,
    agent_id: "agent_fixture",
    username: "fixture-agent",
    message: "Email verified successfully.",
  });
  assert.ok(!JSON.stringify(local).includes(JWT));
});

test("does not enroll after malformed output or persistence failure", async () => {
  const malformedIdentity = await GatewayIdentity.open(memoryStore());
  await assert.rejects(
    malformedIdentity.verify(async () => ({ token: JWT })),
    McpContractError,
  );
  assert.equal(malformedIdentity.enrolled, false);

  const failingStore: CredentialStore = {
    async load() {
      return undefined;
    },
    async save(token) {
      assert.ok(token === JWT);
      throw new Error("injected persistence failure");
    },
  };
  const failingIdentity = await GatewayIdentity.open(failingStore);
  await assert.rejects(failingIdentity.verify(async () => verificationResult()));
  assert.equal(failingIdentity.enrolled, false);
});

test("rejects concurrent and replacement verification before forwarding", async () => {
  const identity = await GatewayIdentity.open(memoryStore());
  let resolveVerification: ((result: unknown) => void) | undefined;
  const first = identity.verify(
    async () =>
      await new Promise((resolve) => {
        resolveVerification = resolve;
      }),
  );
  let secondForwarded = false;
  await assert.rejects(
    identity.verify(async () => {
      secondForwarded = true;
      return verificationResult();
    }),
    (error: unknown) => error instanceof IdentityError && error.code === "verification_busy",
  );
  assert.equal(secondForwarded, false);

  resolveVerification?.(verificationResult());
  await first;
  await assert.rejects(
    identity.verify(async () => {
      secondForwarded = true;
      return verificationResult();
    }),
    (error: unknown) => error instanceof IdentityError && error.code === "already_enrolled",
  );
  assert.equal(secondForwarded, false);
});

test("keeps the credential but disables authenticated work after central rejection", async () => {
  const identity = await GatewayIdentity.open(memoryStore(JWT));
  identity.markAuthenticationFailed();
  assert.equal(identity.enrolled, true);
  assert.equal(identity.authenticationFailed, true);
  assert.throws(
    () => identity.authenticatedToken(),
    (error: unknown) =>
      error instanceof IdentityError && error.code === "central_authentication_failed",
  );
});
