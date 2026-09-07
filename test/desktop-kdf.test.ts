import assert from "node:assert/strict";
import { randomBytes, scrypt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { deriveCredentialKeyIsolated } from "../src/desktop/credential-kdf.js";
import { currentCredential } from "./support/current-credential.js";

test("isolated derivation matches the existing credential format and never mutates the input", async () => {
  const key = randomBytes(24);
  const salt = randomBytes(16);
  const before = Buffer.from(key);
  const expected = await new Promise<Buffer>((resolve, reject) =>
    scrypt(key, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  const actual = await deriveCredentialKeyIsolated(key, salt);
  assert.deepEqual(actual, expected);
  assert.deepEqual(key, before);
  actual.fill(0);
  expected.fill(0);
  key.fill(0);
  before.fill(0);
  await assert.rejects(deriveCredentialKeyIsolated(Buffer.alloc(1), salt));
});

test("desktop credentials remain readable through the normal CLI credential store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-isolated-kdf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "credential.json");
  const key = join(root, "credential.key");
  const desktop = new EncryptedFileCredentialStore(path, key, "test", {
    deriveKey: deriveCredentialKeyIsolated,
  });
  const plaintext = currentCredential();
  await desktop.save(plaintext);
  assert.equal(await desktop.load(), plaintext);
  assert.equal(await new EncryptedFileCredentialStore(path, key, "test").load(), plaintext);
});
