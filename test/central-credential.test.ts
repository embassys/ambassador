import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CentralCredentialError,
  createCentralCredentialRecord,
  parseCentralCredential,
  serializeCentralCredential,
} from "../src/central-credential.js";
import { generateDpopKeyMaterial } from "../src/dpop.js";

const NOW_SECONDS = 1_788_220_800;

function token(
  keyThumbprint: string,
  overrides: Partial<Record<"sub" | "email" | "iat" | "exp", unknown>> = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: "agent.current",
      email: "credential@fixture.test",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 30 * 24 * 60 * 60,
      cnf: { jkt: keyThumbprint },
      ...overrides,
    }),
    "utf8",
  ).toString("base64url");
  return `${header}.${payload}.fixture-signature`;
}

test("I02-C01 one current credential stores only token and P-256 private key", () => {
  const key = generateDpopKeyMaterial();
  const record = createCentralCredentialRecord(token(key.thumbprint), key);
  assert.deepEqual(Object.keys(record).sort(), [
    "access_token",
    "credential_format",
    "dpop_private_key_pkcs8",
  ]);
  const serialized = serializeCentralCredential(record);
  const loaded = parseCentralCredential(serialized, () => NOW_SECONDS);
  assert.equal(loaded.keyThumbprint, key.thumbprint);
  assert.equal(loaded.token.subject, "agent.current");
  assert.equal(loaded.token.email, "credential@fixture.test");
});

test("I02-C02 current token validation does not invent issuer, audience, ID, type, or 24-hour lifetime", () => {
  const key = generateDpopKeyMaterial();
  const loaded = parseCentralCredential(
    createCentralCredentialRecord(token(key.thumbprint), key),
    () => NOW_SECONDS,
  );
  assert.equal(loaded.token.expiresAt - loaded.token.issuedAt, 30 * 24 * 60 * 60);
});

test("I02-C03 malformed, expired, and key-mismatched records fail closed", () => {
  const key = generateDpopKeyMaterial();
  const other = generateDpopKeyMaterial();
  const valid = createCentralCredentialRecord(token(key.thumbprint), key);
  const cases: unknown[] = [
    "fixture-jwt-only-record",
    { access_token: token(key.thumbprint) },
    { ...valid, credential_format: 2 },
    { ...valid, access_token: token(other.thumbprint) },
    { ...valid, access_token: token(key.thumbprint, { exp: NOW_SECONDS }) },
  ];
  for (const value of cases) {
    assert.throws(() => parseCentralCredential(value, () => NOW_SECONDS), CentralCredentialError);
  }
});
