import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient } from "../src/central-enrollment.js";
import {
  CentralProtectedTransport,
  CentralProtectedTransportError,
} from "../src/central-protected-transport.js";
import { DpopNonceCache } from "../src/dpop.js";
import { startFakeCentral } from "./support/fake-central.js";

const NOW_SECONDS = 1_788_220_800;

test("I02-D04 transport sends Bearer authorization and one separate fresh proof", async (t) => {
  const central = await startFakeCentral(t);
  const email = "transport@fixture.test";
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const credential = parseCentralCredential(verified.credential, () => NOW_SECONDS);
  central.resetRequests();
  let proofSequence = 0;
  const acceptEncodings: Array<string | null> = [];
  const transport = new CentralProtectedTransport({
    credential: () => credential,
    fetch: async (input, init) => {
      acceptEncodings.push(new Headers(init?.headers).get("accept-encoding"));
      return fetch(input, init);
    },
    nonceCache: new DpopNonceCache(),
    now: () => NOW_SECONDS,
    uuid: () =>
      `123e4567-e89b-42d3-a456-${(426_614_174_000 + proofSequence++).toString().padStart(12, "0")}`,
  });

  const first = await transport.fetch(`${central.apiUrl}/api/poll_messages?timeout=0`);
  assert.equal(first.status, 200);
  const second = await transport.fetch(`${central.apiUrl}/api/poll_messages?timeout=0`);
  assert.equal(second.status, 200);
  assert.deepEqual(acceptEncodings, ["identity", "identity"]);
  assert.deepEqual(
    central.requests().map(({ authorizationScheme, dpopCount, path }) => ({
      authorizationScheme,
      dpopCount,
      path,
    })),
    [
      {
        authorizationScheme: "Bearer",
        dpopCount: 1,
        path: "/api/poll_messages?timeout=0",
      },
      {
        authorizationScheme: "Bearer",
        dpopCount: 1,
        path: "/api/poll_messages?timeout=0",
      },
    ],
  );
});

test("I02-D05 one valid nonce challenge retries once with a new proof", async (t) => {
  const central = await startFakeCentral(t);
  const email = "transport-nonce@fixture.test";
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const credential = parseCentralCredential(verified.credential, () => NOW_SECONDS);
  central.setNonce(email, "fixture-initial-nonce");
  central.resetRequests();
  const transport = new CentralProtectedTransport({
    credential: () => credential,
    nonceCache: new DpopNonceCache(),
    now: () => NOW_SECONDS,
  });
  const response = await transport.fetch(`${central.apiUrl}/api/list_action_types`);
  assert.equal(response.status, 200);
  assert.equal(central.requests().length, 2);
});

test("I02-D06 non-nonce authentication failures never retry or fall back", async (t) => {
  const central = await startFakeCentral(t);
  const email = "no-retry@fixture.test";
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const credential = parseCentralCredential(verified.credential, () => NOW_SECONDS);

  let calls = 0;
  const transport = new CentralProtectedTransport({
    credential: () => credential,
    now: () => NOW_SECONDS,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ detail: "rejected" }), { status: 401 });
    },
  });
  await assert.rejects(
    transport.fetch("https://central.invalid/api/list_action_types"),
    (error: unknown) =>
      error instanceof CentralProtectedTransportError &&
      error.code === "central_protected_authentication_failed",
  );
  assert.equal(calls, 1);
});
