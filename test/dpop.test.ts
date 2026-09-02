import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";

import {
  createDpopProof,
  dpopAccessTokenHash,
  dpopJwkThumbprint,
  generateDpopKeyMaterial,
} from "../src/dpop.js";

function segment(proof: string, index: number): Record<string, unknown> {
  const value = proof.split(".")[index];
  assert.ok(value !== undefined);
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("I02-D01 proof binds exact full URL, method, token hash, and current key", () => {
  const key = generateDpopKeyMaterial();
  const accessToken = "header.payload.signature";
  const proof = createDpopProof({
    method: "GET",
    targetUri: "https://mcp.embassys.ai/api/poll_messages?timeout=30",
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    accessToken,
    now: () => 1_788_220_800,
    uuid: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  const header = segment(proof, 0);
  const payload = segment(proof, 1);
  assert.deepEqual(header, { typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk });
  assert.deepEqual(payload, {
    jti: "123e4567-e89b-42d3-a456-426614174000",
    htm: "GET",
    htu: "https://mcp.embassys.ai/api/poll_messages?timeout=30",
    iat: 1_788_220_800,
    ath: dpopAccessTokenHash(accessToken),
  });
  const [headerSegment, payloadSegment, signatureSegment] = proof.split(".") as [
    string,
    string,
    string,
  ];
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
      { key: createPublicKey(key.privateKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureSegment, "base64url"),
    ),
    true,
  );
});

test("I02-D02 each proof has a fresh identifier and query order is not normalized", () => {
  const key = generateDpopKeyMaterial();
  const first = createDpopProof({
    method: "GET",
    targetUri: "https://mcp.embassys.ai/api/poll_messages?timeout=30&marker=one",
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    accessToken: "header.payload.signature",
  });
  const second = createDpopProof({
    method: "GET",
    targetUri: "https://mcp.embassys.ai/api/poll_messages?marker=one&timeout=30",
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    accessToken: "header.payload.signature",
  });
  assert.notEqual(segment(first, 1).jti, segment(second, 1).jti);
  assert.equal(
    segment(first, 1).htu,
    "https://mcp.embassys.ai/api/poll_messages?timeout=30&marker=one",
  );
  assert.equal(
    segment(second, 1).htu,
    "https://mcp.embassys.ai/api/poll_messages?marker=one&timeout=30",
  );
});

test("I02-D03 generated key thumbprint matches RFC 7638 canonical members", () => {
  const key = generateDpopKeyMaterial();
  assert.equal(dpopJwkThumbprint(key.publicJwk), key.thumbprint);
  assert.deepEqual(Object.keys(key.publicJwk).sort(), ["crv", "kty", "x", "y"]);
});
