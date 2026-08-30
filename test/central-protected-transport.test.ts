import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import {
  CentralProtectedTransport,
  CentralProtectedTransportError,
} from "../src/central-protected-transport.js";
import { type LoadedCentralCredentialV2, parseCentralCredentialV2 } from "../src/credential-v2.js";
import {
  createCentralCredentialV2Record,
  DpopNonceCache,
  generateDpopKeyMaterial,
} from "../src/dpop.js";

const NOW_SECONDS = 1_788_000_000;
const FIRST_NONCE = "A".repeat(76);
const REPLACEMENT_NONCE = "B".repeat(76);

function credential(expiresAt = NOW_SECONDS + 86_400): LoadedCentralCredentialV2 {
  const key = generateDpopKeyMaterial();
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "urn:a2a:test:issuer",
      aud: ["urn:a2a:test:api", "urn:a2a:test:mcp"],
      sub: "test_subject",
      iat: expiresAt - 86_400,
      exp: expiresAt,
      jti: randomUUID(),
      cnf: { jkt: key.thumbprint },
    }),
  ).toString("base64url");
  const signature = Buffer.alloc(64).toString("base64url");
  const record = createCentralCredentialV2Record(`${header}.${payload}.${signature}`, key);
  return parseCentralCredentialV2(JSON.stringify(record));
}

function payload(proof: string | null): Record<string, unknown> {
  assert.ok(proof !== null);
  const encoded = proof.split(".")[1];
  assert.ok(encoded !== undefined);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

function useClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_SECONDS * 1_000 });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof CentralProtectedTransportError ? error.code : undefined;
}

test("protected transport retries one exact nonce challenge with a fresh proof", async (t) => {
  useClock(t);
  const loaded = credential();
  const cache = new DpopNonceCache();
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  let challengeCancelled = false;
  const injectedFetch = (async (url: string | URL, init?: RequestInit) => {
    assert.ok(init !== undefined);
    requests.push({ url: String(url), init });
    if (requests.length === 1) {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          challengeCancelled = true;
        },
      });
      return new Response(body, {
        status: 401,
        headers: {
          "cache-control": "private, no-store",
          "dpop-nonce": FIRST_NONCE,
          "www-authenticate": 'DPoP error="use_dpop_nonce"',
        },
      });
    }
    return new Response("accepted", {
      status: 200,
      headers: { "cache-control": "no-store", "dpop-nonce": REPLACEMENT_NONCE },
    });
  }) as typeof fetch;
  const transport = new CentralProtectedTransport({
    domain: "mcp",
    credential: () => loaded,
    nonceCache: cache,
    fetch: injectedFetch,
  });

  const response = await transport.fetch("https://central.example/mcp?request=1", {
    method: "post",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(await response.text(), "accepted");
  assert.equal(requests.length, 2);
  assert.equal(challengeCancelled, true);
  assert.equal(cache.get("mcp"), REPLACEMENT_NONCE);
  const firstHeaders = new Headers(requests[0]?.init.headers);
  const secondHeaders = new Headers(requests[1]?.init.headers);
  assert.equal(firstHeaders.get("authorization"), `DPoP ${loaded.record.access_token}`);
  assert.equal(secondHeaders.get("authorization"), `DPoP ${loaded.record.access_token}`);
  assert.equal(requests[0]?.init.method, "POST");
  assert.equal(requests[1]?.init.method, "POST");
  assert.equal(requests[0]?.init.redirect, "manual");
  const firstPayload = payload(firstHeaders.get("dpop"));
  const secondPayload = payload(secondHeaders.get("dpop"));
  assert.equal(firstPayload.htm, "POST");
  assert.equal(firstPayload.htu, "https://central.example/mcp");
  assert.equal(firstPayload.nonce, undefined);
  assert.equal(secondPayload.nonce, FIRST_NONCE);
  assert.equal(firstPayload.iat, NOW_SECONDS);
  assert.notEqual(firstPayload.jti, secondPayload.jti);
  assert.notEqual(firstHeaders.get("dpop"), secondHeaders.get("dpop"));
  assert.equal(typeof firstPayload.ath, "string");
});

test("protected transport rejects caller authentication and oversized headers before fetch", async (t) => {
  useClock(t);
  const loaded = credential();
  let calls = 0;
  const injectedFetch = (async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const transport = new CentralProtectedTransport({
    domain: "api",
    credential: () => loaded,
    nonceCache: new DpopNonceCache(),
    fetch: injectedFetch,
  });

  for (const headers of [
    { authorization: "Bearer forbidden" },
    { dpop: "caller-proof" },
    { cookie: "session=forbidden" },
    { "x-padding": "x".repeat(16_384) },
  ]) {
    await assert.rejects(
      transport.fetch("https://central.example/api/v2/token/reissue", { headers }),
      (error: unknown) => errorCode(error) === "central_protected_request_invalid",
    );
  }
  assert.equal(calls, 0);
});

test("protected transport never sends an expired credential", async (t) => {
  useClock(t);
  let calls = 0;
  const transport = new CentralProtectedTransport({
    domain: "api",
    credential: () => credential(NOW_SECONDS),
    nonceCache: new DpopNonceCache(),
    fetch: (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  await assert.rejects(
    transport.fetch("https://central.example/api/v2/token/reissue"),
    (error: unknown) => errorCode(error) === "central_protected_credential_expired",
  );
  assert.equal(calls, 0);
});

test("protected transport classifies terminal DPoP authentication heads without reading bodies", async (t) => {
  useClock(t);
  for (const vector of [
    {
      authenticate: 'DPoP error="invalid_token"',
      code: "central_protected_authentication_failed",
    },
    {
      authenticate: 'DPoP error="invalid_dpop_proof"',
      code: "central_dpop_proof_rejected",
    },
  ] as const) {
    let cancelled = false;
    const transport = new CentralProtectedTransport({
      domain: "mcp",
      credential: () => credential(),
      nonceCache: new DpopNonceCache(),
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 401,
            headers: {
              "cache-control": "no-store",
              "www-authenticate": vector.authenticate,
            },
          },
        )) as typeof fetch,
    });
    await assert.rejects(
      transport.fetch("https://central.example/mcp"),
      (error: unknown) => errorCode(error) === vector.code,
    );
    assert.equal(cancelled, true);
  }
});

test("protected transport rejects malformed and repeated nonce challenges", async (t) => {
  useClock(t);
  const vectors: ReadonlyArray<{
    readonly responses: readonly Response[];
    readonly code: string;
  }> = [
    {
      responses: [
        new Response(null, {
          status: 401,
          headers: {
            "cache-control": "no-store",
            "dpop-nonce": "short",
            "www-authenticate": 'DPoP error="use_dpop_nonce"',
          },
        }),
      ],
      code: "central_dpop_challenge_failed",
    },
    {
      responses: [
        new Response(null, {
          status: 401,
          headers: { "cache-control": "no-store", "dpop-nonce": FIRST_NONCE },
        }),
      ],
      code: "central_dpop_challenge_failed",
    },
    {
      responses: [
        new Response(null, {
          status: 401,
          headers: {
            "dpop-nonce": FIRST_NONCE,
            "www-authenticate": 'DPoP error="use_dpop_nonce"',
          },
        }),
      ],
      code: "central_dpop_challenge_failed",
    },
    {
      responses: [
        new Response(null, {
          status: 401,
          headers: {
            "cache-control": "no-store",
            "dpop-nonce": FIRST_NONCE,
            "www-authenticate": 'DPoP error="use_dpop_nonce"',
          },
        }),
        new Response(null, {
          status: 401,
          headers: {
            "cache-control": "no-store",
            "dpop-nonce": REPLACEMENT_NONCE,
            "www-authenticate": 'DPoP error="use_dpop_nonce"',
          },
        }),
      ],
      code: "central_dpop_nonce_retry_exhausted",
    },
  ];
  for (const vector of vectors) {
    let index = 0;
    const transport = new CentralProtectedTransport({
      domain: "api",
      credential: () => credential(),
      nonceCache: new DpopNonceCache(),
      fetch: (async () => vector.responses[index++] as Response) as typeof fetch,
    });
    await assert.rejects(
      transport.fetch("https://central.example/api/v2/token/reissue", { method: "POST" }),
      (error: unknown) => errorCode(error) === vector.code,
    );
    assert.equal(index, vector.responses.length);
  }
});

test("protected transport separates redirect, unsafe response, and network failure", async (t) => {
  useClock(t);
  const vectors: ReadonlyArray<{ readonly response?: Response; readonly code: string }> = [
    {
      response: new Response(null, { status: 302, headers: { location: "/legacy" } }),
      code: "central_protected_redirect_rejected",
    },
    {
      response: new Response(null, { status: 200, headers: { "dpop-nonce": FIRST_NONCE } }),
      code: "central_protected_response_unsafe",
    },
    {
      response: new Response(null, { status: 200, headers: { "set-cookie": "session=forbidden" } }),
      code: "central_protected_response_unsafe",
    },
    {
      response: new Response(null, { status: 200, headers: { "content-encoding": "gzip" } }),
      code: "central_protected_response_unsafe",
    },
    { code: "central_protected_request_failed" },
  ];
  for (const vector of vectors) {
    const transport = new CentralProtectedTransport({
      domain: "api",
      credential: () => credential(),
      nonceCache: new DpopNonceCache(),
      fetch: (async () => {
        if (vector.response === undefined) throw new Error("secret network failure");
        return vector.response;
      }) as typeof fetch,
    });
    await assert.rejects(
      transport.fetch("https://central.example/api/v2/token/reissue"),
      (error: unknown) =>
        errorCode(error) === vector.code &&
        error instanceof Error &&
        !error.message.includes("secret"),
    );
  }
});
