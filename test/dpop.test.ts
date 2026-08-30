import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import test from "node:test";

import {
  createDpopProof,
  DpopError,
  DpopNonceCache,
  generateDpopKeyMaterial,
  normalizeDpopTargetUri,
  parseDpopNonce,
} from "../src/dpop.js";

function jwtPart(proof: string, index: number): Record<string, unknown> {
  const segment = proof.split(".")[index];
  assert.ok(segment !== undefined);
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("creates an exact ES256 issuance proof from a fresh P-256 key", () => {
  const key = generateDpopKeyMaterial();
  const proof = createDpopProof({
    method: "POST",
    targetUri: "HTTPS://Central.Example:443/api/./verify_email?ignored=true#fragment",
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    nonce: "A".repeat(76),
    now: () => 1_788_000_000,
    uuid: () => "00000000-0000-4000-8000-000000000001",
  });
  const parts = proof.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(jwtPart(proof, 0), {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: key.publicJwk,
  });
  assert.deepEqual(jwtPart(proof, 1), {
    jti: "00000000-0000-4000-8000-000000000001",
    htm: "POST",
    htu: "https://central.example/api/verify_email",
    iat: 1_788_000_000,
    nonce: "A".repeat(76),
  });
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  assert.ok(
    encodedHeader !== undefined && encodedPayload !== undefined && encodedSignature !== undefined,
  );
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      { key: createPublicKey(key.privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    ),
  );
});

test("rejects caller JWK extensions and emits only the derived public key", () => {
  const key = generateDpopKeyMaterial();
  const extensions: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { d: "A".repeat(43) },
    { kid: "caller-selected" },
    { jku: "https://attacker.invalid/jwks" },
    { x5u: "https://attacker.invalid/key" },
  ];
  for (const extension of extensions) {
    assert.throws(
      () =>
        createDpopProof({
          method: "POST",
          targetUri: "https://central.example/api/verify_email",
          privateKey: key.privateKey,
          publicJwk: { ...key.publicJwk, ...extension } as typeof key.publicJwk,
          now: () => 1_788_000_000,
          uuid: () => "00000000-0000-4000-8000-000000000011",
        }),
      DpopError,
    );
  }
});

test("protected proofs bind the token hash and never reuse an injected proof identifier", () => {
  const key = generateDpopKeyMaterial();
  const token = "header.payload.signature";
  const first = createDpopProof({
    method: "GET",
    targetUri: "https://central.example/api/v2/messages/receive?timeout=30&limit=100",
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    accessToken: token,
    now: () => 1_788_000_000,
    uuid: () => "00000000-0000-4000-8000-000000000002",
  });
  const second = createDpopProof({
    method: "GET",
    targetUri: "https://central.example/api/v2/messages/receive?timeout=30&limit=100",
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    accessToken: token,
    now: () => 1_788_000_000,
    uuid: () => "00000000-0000-4000-8000-000000000003",
  });
  assert.notEqual(first, second);
  assert.equal(
    jwtPart(first, 1).ath,
    createHash("sha256").update(token, "ascii").digest("base64url"),
  );
  assert.equal(jwtPart(first, 1).htu, "https://central.example/api/v2/messages/receive");
});

test("normalizes the fixed RFC 3986 URI features used by DPoP", () => {
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ["https://EXAMPLE.com:443", "https://example.com/"],
    ["http://EXAMPLE.com:80/a/./b/../c", "http://example.com/a/c"],
    ["https://example.com/%7euser/%2fkeep", "https://example.com/~user/%2Fkeep"],
    ["https://example.com/a//b/", "https://example.com/a//b/"],
    ["https://example.com/Case?x=1#part", "https://example.com/Case"],
  ];
  for (const [input, expected] of vectors) assert.equal(normalizeDpopTargetUri(input), expected);
  assert.throws(() => normalizeDpopTargetUri("ftp://example.com/resource"), DpopError);
  assert.throws(() => normalizeDpopTargetUri("https://user@example.com/path"), DpopError);
});

test("keeps at most one validated nonce in each fixed security domain", () => {
  const cache = new DpopNonceCache();
  assert.equal(cache.updateFromHeader("issuance", null), false);
  cache.set("issuance", "A".repeat(76));
  cache.set("api", "B".repeat(76));
  cache.set("mcp", "C".repeat(76));
  cache.set("api", "D".repeat(76));
  assert.equal(cache.get("issuance"), "A".repeat(76));
  assert.equal(cache.get("api"), "D".repeat(76));
  assert.equal(cache.get("mcp"), "C".repeat(76));
  assert.throws(() => parseDpopNonce("short"), DpopError);
  cache.clear();
  assert.equal(cache.get("issuance"), undefined);
});
