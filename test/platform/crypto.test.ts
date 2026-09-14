import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseCentralCredential,
  serializeCentralCredential,
} from "../../src/central-credential.js";
import { EncryptedFileCredentialStore } from "../../src/credential-store.js";
import { generateDpopKeyMaterial } from "../../src/dpop.js";
import { currentCredentialRecord, FIXTURE_NOW_SECONDS } from "../support/current-credential.js";
import { assertPrivateArtifact } from "../support/private-artifact.js";

test("native P-256 keys survive encrypted storage and PKCS8 reload and verify only matching signatures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ambassador-native-crypto-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = currentCredentialRecord();
  const serialized = serializeCentralCredential(record);
  const key = parseCentralCredential(record, () => FIXTURE_NOW_SECONDS);
  const path = join(directory, "credential.json");
  const keyPath = join(directory, "state.key");
  const store = new EncryptedFileCredentialStore(path, keyPath, "native-crypto-test");
  await store.save(serialized);
  assert.equal((await readFile(path, "utf8")).includes(record.dpop_private_key_pkcs8), false);
  const loaded = await new EncryptedFileCredentialStore(path, keyPath, "native-crypto-test").load();
  assert.equal(loaded, serialized);
  const reloaded = parseCentralCredential(loaded, () => FIXTURE_NOW_SECONDS);
  const restored = createPrivateKey({
    key: Buffer.from(reloaded.record.dpop_private_key_pkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey({ key: { ...key.publicJwk }, format: "jwk" });
  const payload = Buffer.from("native DPoP signature fixture");
  const signature = sign("sha256", payload, { key: restored, dsaEncoding: "ieee-p1363" });
  assert.equal(signature.length, 64);
  assert.equal(
    verify("sha256", payload, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
    true,
  );
  assert.equal(
    verify(
      "sha256",
      Buffer.from("changed"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    ),
    false,
  );
  assert.equal(
    verify(
      "sha256",
      payload,
      { key: createPublicKey(generateDpopKeyMaterial().privateKey), dsaEncoding: "ieee-p1363" },
      signature,
    ),
    false,
  );
  await assertPrivateArtifact(directory, "directory");
  await assertPrivateArtifact(path, "file");
  await assertPrivateArtifact(keyPath, "file");
});
