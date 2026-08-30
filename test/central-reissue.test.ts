import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import {
  CentralProtectedTransport,
  CentralProtectedTransportError,
} from "../src/central-protected-transport.js";
import { CentralReissueController } from "../src/central-reissue.js";
import type {
  CredentialStore,
  StoredCredential,
  VersionedCredentialStore,
} from "../src/credential-store.js";
import {
  createCentralCredentialV2Record,
  DpopNonceCache,
  generateDpopKeyMaterial,
} from "../src/dpop.js";
import { GatewayIdentity } from "../src/identity.js";

const NOW_SECONDS = 1_788_043_201;
const ISSUED_AT_SECONDS = 1_788_000_000;
const EXPIRES_AT_SECONDS = 1_788_086_400;

interface CapturingStore {
  readonly adapter: CredentialStore & VersionedCredentialStore;
  readonly saved: StoredCredential[];
}

interface StalledAttempt {
  readonly headers: Headers;
  readonly signal: AbortSignal;
}

function credentialRecord() {
  const key = generateDpopKeyMaterial();
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "urn:a2a:test:issuer",
      aud: ["urn:a2a:test:api", "urn:a2a:test:mcp"],
      sub: "test_subject",
      iat: ISSUED_AT_SECONDS,
      exp: EXPIRES_AT_SECONDS,
      jti: randomUUID(),
      cnf: { jkt: key.thumbprint },
    }),
  ).toString("base64url");
  const signature = Buffer.alloc(64).toString("base64url");
  return createCentralCredentialV2Record(`${header}.${payload}.${signature}`, key);
}

function capturingStore(): CapturingStore {
  const stored = JSON.stringify(credentialRecord());
  const saved: StoredCredential[] = [];
  return {
    saved,
    adapter: {
      async load() {
        return undefined;
      },
      async save() {
        throw new Error("version 2 used the legacy credential store API");
      },
      async loadCredential() {
        return { version: 2, plaintext: stored };
      },
      async saveCredential(credential) {
        saved.push(credential);
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not reached");
}

async function waitForTurns(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

async function stalledReissue(t: TestContext, mockRetryTimer = false) {
  t.mock.timers.enable({
    apis: mockRetryTimer ? ["Date", "setTimeout"] : ["Date"],
    now: NOW_SECONDS * 1_000,
  });
  const store = capturingStore();
  const identity = await GatewayIdentity.open(store.adapter);
  const deadlines: number[] = [];
  const deadlineControllers: AbortController[] = [];
  const attempts: StalledAttempt[] = [];
  let cancellations = 0;
  const transport = new CentralProtectedTransport({
    domain: "api",
    credential: () => identity.authenticatedCredentialV2(),
    nonceCache: new DpopNonceCache(),
    deadlineSignal: (deadlineMs) => {
      deadlines.push(deadlineMs);
      const controller = new AbortController();
      deadlineControllers.push(controller);
      return controller.signal;
    },
    fetch: (async (_url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      const attempt = { headers: new Headers(init.headers), signal: init.signal };
      attempts.push(attempt);
      return await new Promise<Response>((_resolve, reject) => {
        const cancelled = () => {
          cancellations += 1;
          reject(new Error("stalled request cancelled"));
        };
        if (attempt.signal.aborted) cancelled();
        else attempt.signal.addEventListener("abort", cancelled, { once: true });
      });
    }) as typeof fetch,
  });
  const reissue = new CentralReissueController({
    centralApiUrl: "https://central.example",
    identity,
    transport,
  });
  t.after(async () => await reissue.close());
  return {
    attempts,
    cancellations: () => cancellations,
    deadlineControllers,
    deadlines,
    reissue,
    saved: store.saved,
  };
}

test("stalled scheduled reissue times out at 30 seconds and repeats only one uncertain attempt", async (t) => {
  const fixture = await stalledReissue(t);
  fixture.reissue.start();
  await waitFor(() => fixture.attempts.length === 1);
  fixture.deadlineControllers[0]?.abort();
  await waitFor(() => fixture.attempts.length === 2);
  fixture.deadlineControllers[1]?.abort();
  await waitFor(() => fixture.cancellations() === 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(fixture.deadlines, [30_000, 30_000]);
  assert.equal(fixture.attempts.length, 2);
  const idempotencyKeys = fixture.attempts.map((attempt) => attempt.headers.get("idempotency-key"));
  assert.ok(idempotencyKeys[0] !== null && idempotencyKeys[0] === idempotencyKeys[1]);
  const proofs = fixture.attempts.map((attempt) => attempt.headers.get("dpop"));
  assert.ok(proofs.every((proof) => proof !== null));
  assert.notEqual(proofs[0], proofs[1]);
  assert.equal(fixture.saved.length, 0);
});

test("closing a stalled scheduled reissue cancels it without an uncertain repeat", async (t) => {
  const fixture = await stalledReissue(t);
  fixture.reissue.start();
  await waitFor(() => fixture.attempts.length === 1);
  await fixture.reissue.close();

  assert.deepEqual(fixture.deadlines, [30_000]);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.cancellations(), 1);
  assert.equal(fixture.saved.length, 0);
});

test("closing during the uncertain retry delay cannot start another request", async (t) => {
  const fixture = await stalledReissue(t, true);
  fixture.reissue.start();
  await waitForTurns(() => fixture.attempts.length === 1);
  fixture.deadlineControllers[0]?.abort();
  await waitForTurns(() => fixture.cancellations() === 1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const closing = fixture.reissue.close();
  t.mock.timers.tick(10);
  await closing;
  fixture.reissue.start();
  t.mock.timers.tick(10);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.deadlines, [30_000]);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.cancellations(), 1);
  assert.ok(fixture.attempts[0]?.headers.get("dpop") !== null);
  assert.equal(fixture.attempts[0]?.signal.aborted, true);
  assert.equal(fixture.saved.length, 0);
});

test("protected transport rejects unsupported operation deadlines", () => {
  assert.throws(
    () =>
      new CentralProtectedTransport({
        domain: "api",
        credential: () => {
          throw new Error("unused");
        },
        nonceCache: new DpopNonceCache(),
        deadlineMs: 40_001,
      }),
    (error: unknown) =>
      error instanceof CentralProtectedTransportError &&
      error.code === "central_protected_request_invalid",
  );
});
