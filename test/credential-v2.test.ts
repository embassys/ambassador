import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import {
  assertSameKeyCredentialReplacement,
  CredentialV2Error,
  parseCentralCredentialV2,
  serializeCentralCredentialV2,
} from "../src/credential-v2.js";
import { createCentralCredentialV2Record, generateDpopKeyMaterial } from "../src/dpop.js";

const HOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const SCOPE = "central:https://api.example.test|https://mcp.example.test/mcp";

function accessToken(
  thumbprint: string,
  options: {
    readonly issuedAt?: number;
    readonly signatureBytes?: number;
    readonly tokenId?: string;
  } = {},
): string {
  const issuedAt = options.issuedAt ?? 1_788_000_000;
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "urn:a2a:test:issuer",
      aud: ["urn:a2a:test:api", "urn:a2a:test:mcp"],
      sub: "agent_test_0001",
      iat: issuedAt,
      exp: issuedAt + 86_400,
      jti: options.tokenId ?? "00000000-0000-4000-8000-000000000101",
      cnf: { jkt: thumbprint },
    }),
  ).toString("base64url");
  return `${header}.${payload}.${Buffer.alloc(options.signatureBytes ?? 64).toString("base64url")}`;
}

function credential(
  key: ReturnType<typeof generateDpopKeyMaterial>,
  options: { readonly issuedAt?: number; readonly tokenId?: string } = {},
) {
  return createCentralCredentialV2Record(accessToken(key.thumbprint, options), key);
}

test("strictly parses one bound P-256 credential and rejects hidden record changes", () => {
  const key = generateDpopKeyMaterial();
  const serialized = serializeCentralCredentialV2(credential(key));
  const parsed = parseCentralCredentialV2(serialized);
  assert.equal(parsed.keyThumbprint, key.thumbprint);
  assert.equal(parsed.token.subject, "agent_test_0001");
  assert.equal(parsed.token.expiresAt - parsed.token.issuedAt, 86_400);

  const duplicate = serialized.replace(
    '"credential_version":2,',
    '"credential_version":2,"credential_version":2,',
  );
  assert.throws(() => parseCentralCredentialV2(duplicate), CredentialV2Error);
  assert.throws(
    () => parseCentralCredentialV2(JSON.stringify({ ...credential(key), extra: true })),
    CredentialV2Error,
  );
  const otherKey = generateDpopKeyMaterial();
  assert.throws(
    () =>
      parseCentralCredentialV2(
        JSON.stringify({
          ...credential(key),
          dpop_private_key_pkcs8: otherKey.privateKeyPkcs8,
        }),
      ),
    CredentialV2Error,
  );
});

test("same-key replacement accepts only an advancing token for the same identity", () => {
  const key = generateDpopKeyMaterial();
  const current = parseCentralCredentialV2(serializeCentralCredentialV2(credential(key)));
  const replacement = parseCentralCredentialV2(
    serializeCentralCredentialV2(
      credential(key, {
        issuedAt: 1_788_043_201,
        tokenId: "00000000-0000-4000-8000-000000000102",
      }),
    ),
  );
  assert.doesNotThrow(() => assertSameKeyCredentialReplacement(current, replacement));
  assert.throws(() => assertSameKeyCredentialReplacement(current, current), CredentialV2Error);
});

test("requires the ES256 compact JWS signature to contain exactly 64 canonical bytes", () => {
  const key = generateDpopKeyMaterial();
  for (const signatureBytes of [63, 65]) {
    assert.throws(
      () =>
        parseCentralCredentialV2(
          JSON.stringify(
            createCentralCredentialV2Record(accessToken(key.thumbprint, { signatureBytes }), key),
          ),
        ),
      CredentialV2Error,
    );
  }
  assert.doesNotThrow(() =>
    parseCentralCredentialV2(
      JSON.stringify(
        createCentralCredentialV2Record(accessToken(key.thumbprint, { signatureBytes: 64 }), key),
      ),
    ),
  );
});

test("encrypted envelope version 2 supports fresh creation and atomic same-key replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-credential-v2-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "state", "central-credential.json");
  const key = generateDpopKeyMaterial();
  const original = serializeCentralCredentialV2(credential(key));
  const replacement = serializeCentralCredentialV2(
    credential(key, {
      issuedAt: 1_788_043_201,
      tokenId: "00000000-0000-4000-8000-000000000103",
    }),
  );
  const store = new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE);
  await store.saveCredential({ version: 2, plaintext: original });
  assert.deepEqual(await store.loadCredential(), { version: 2, plaintext: original });
  await assert.rejects(store.load());
  const firstEnvelope = await readFile(path);
  assert.equal(JSON.parse(firstEnvelope.toString("utf8")).version, 2);
  assert.ok(!firstEnvelope.includes(Buffer.from(original)));
  assert.ok(!firstEnvelope.includes(Buffer.from(key.privateKeyPkcs8)));
  assert.ok(!firstEnvelope.includes(Buffer.from(HOOK_TOKEN)));
  assert.ok(!firstEnvelope.includes(Buffer.from(SCOPE)));

  await new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE).saveCredential({
    version: 2,
    plaintext: replacement,
  });
  assert.deepEqual(
    await new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE).loadCredential(),
    { version: 2, plaintext: replacement },
  );
  const replacementEnvelope = await readFile(path);
  assert.equal(JSON.parse(replacementEnvelope.toString("utf8")).version, 2);
  assert.ok(!replacementEnvelope.includes(Buffer.from(replacement)));
  assert.deepEqual(await readdir(join(root, "state")), ["central-credential.json"]);
});

test("rejects every outer and inner credential-version mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-credential-mismatch-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const key = generateDpopKeyMaterial();
  const version2 = serializeCentralCredentialV2(credential(key));
  const firstPath = join(root, "first", "central-credential.json");
  const secondPath = join(root, "second", "central-credential.json");
  const first = new EncryptedFileCredentialStore(firstPath, HOOK_TOKEN, SCOPE);
  const second = new EncryptedFileCredentialStore(secondPath, HOOK_TOKEN, SCOPE);

  await assert.rejects(first.saveCredential({ version: 1, plaintext: version2 }));
  await assert.rejects(second.saveCredential({ version: 2, plaintext: "central-jwt" }));
  assert.equal(await first.loadCredential(), undefined);
  assert.equal(await second.loadCredential(), undefined);
});
