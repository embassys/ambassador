import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EncryptedFileWebhookSecretStore } from "../src/webhook-secret-store.js";

test("creates one encrypted webhook secret and returns it across restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-webhook-secret-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "webhook-secret.json");
  const keyPath = join(root, "webhook-secret.key");

  const store = new EncryptedFileWebhookSecretStore(path, keyPath);
  const created = await store.createOrLoad();
  assert.match(created, /^[a-f0-9]{48}$/u);
  assert.equal(await store.createOrLoad(), created);
  assert.equal(await new EncryptedFileWebhookSecretStore(path, keyPath).load(), created);

  assert.equal((await readFile(path)).includes(Buffer.from(created)), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o7777, 0o600);
    assert.equal((await stat(keyPath)).mode & 0o7777, 0o600);
  }
});

test("uses a distinct cryptographic scope and rejects malformed plaintext", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-webhook-secret-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "webhook-secret.json");
  const keyPath = join(root, "webhook-secret.key");
  const store = new EncryptedFileWebhookSecretStore(path, keyPath);
  const secret = await store.createOrLoad();

  await assert.rejects(
    new EncryptedFileWebhookSecretStore(path, keyPath, {
      scope: "different-webhook-scope",
    }).load(),
  );
  assert.equal(await store.load(), secret);
});
