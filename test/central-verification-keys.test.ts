import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CentralVerificationKeys } from "../src/central-verification-keys.js";
import { EncryptedFileCredentialStore } from "../src/credential-store.js";

test("verification saves its key before sending, reuses it after restart, and clears after custody", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "verification.enc");
  const store = new EncryptedFileCredentialStore(path, join(root, "key"), "verification", {
    validatePlaintext: CentralVerificationKeys.validate,
  });
  const first = await new CentralVerificationKeys(store).forEmail("owner@example.test");
  const resumed = await new CentralVerificationKeys(store).forEmail("owner@example.test");
  assert.equal(first.thumbprint, resumed.thumbprint);
  assert.equal((await readFile(path)).includes(first.privateKeyPkcs8), false);
  const keys = new CentralVerificationKeys(store);
  await keys.clear();
  assert.notEqual((await keys.forEmail("owner@example.test")).thumbprint, first.thumbprint);
});
test("a failed verification-key save prevents an unsaved key from being used", async () => {
  const keys = new CentralVerificationKeys({
    load: async () => undefined,
    save: async () => {
      throw new Error("full");
    },
  });
  await assert.rejects(keys.forEmail("owner@example.test"));
});
