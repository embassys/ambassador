import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EncryptedFileCredentialStore } from "../../src/credential-store.js";
import { currentCredential } from "../support/current-credential.js";
import { assertNativeWindowsAcl } from "../support/windows-acl.js";

const CENTRAL_JWT = currentCredential("first@fixture.test", "agent.first");
const CREDENTIAL_SCOPE = '{"centralOrigin":"https://mcp.embassys.ai"}';
async function fixture(t: TestContext, prefix = "a2a-native-credential-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  return {
    root,
    directory,
    path: join(directory, "central-credential.json"),
    keyPath: join(directory, "central-credential.key"),
  };
}
function credentialStore(path: string, keyPath: string) {
  return new EncryptedFileCredentialStore(path, keyPath, CREDENTIAL_SCOPE);
}
async function expectSafeRejection(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(CENTRAL_JWT));
    assert.ok(!error.message.includes(CREDENTIAL_SCOPE));
    return true;
  });
}
test("enforces owner-only POSIX directory and file modes on save and load", {
  skip: process.platform === "win32",
}, async (t) => {
  const item = await fixture(t);
  await mkdir(item.directory, { mode: 0o777 });
  await chmod(item.directory, 0o777);
  const store = credentialStore(item.path, item.keyPath);
  await store.save(CENTRAL_JWT);

  assert.equal((await stat(item.directory)).mode & 0o7777, 0o700);
  assert.equal((await stat(item.path)).mode & 0o7777, 0o600);
  assert.equal((await stat(item.keyPath)).mode & 0o7777, 0o600);

  await chmod(item.directory, 0o755);
  await chmod(item.path, 0o644);
  assert.ok((await store.load()) === CENTRAL_JWT);
  assert.equal((await stat(item.directory)).mode & 0o7777, 0o700);
  assert.equal((await stat(item.path)).mode & 0o7777, 0o600);
});

test("rejects POSIX credential and directory symlinks without touching their targets", {
  skip: process.platform === "win32",
}, async (t) => {
  await t.test("credential symlink", async (subtest) => {
    const item = await fixture(subtest, "a2a-credential-symlink-test-");
    await mkdir(item.directory, { mode: 0o700 });
    const target = join(item.root, "target");
    await writeFile(target, "target-data", { mode: 0o644 });
    await symlink(target, item.path);
    const store = credentialStore(item.path, item.keyPath);

    await expectSafeRejection(() => store.load());
    await expectSafeRejection(() => store.save(CENTRAL_JWT));
    assert.equal(await readFile(target, "utf8"), "target-data");
    assert.equal((await stat(target)).mode & 0o7777, 0o644);
  });

  await t.test("directory symlink", async (subtest) => {
    const item = await fixture(subtest, "a2a-credential-directory-symlink-test-");
    const targetDirectory = join(item.root, "target-state");
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(targetDirectory, item.directory);
    const store = credentialStore(item.path, item.keyPath);

    await expectSafeRejection(() => store.load());
    await expectSafeRejection(() => store.save(CENTRAL_JWT));
    assert.deepEqual(await readdir(targetDirectory), []);
  });
});

test("rejects a POSIX hard-linked credential without changing its target", {
  skip: process.platform === "win32",
}, async (t) => {
  const item = await fixture(t, "a2a-credential-hardlink-test-");
  await mkdir(item.directory, { mode: 0o700 });
  const target = join(item.root, "target");
  await writeFile(target, "target-data", { mode: 0o644 });
  await link(target, item.path);
  const store = credentialStore(item.path, item.keyPath);

  await expectSafeRejection(() => store.load());
  await expectSafeRejection(() => store.save(CENTRAL_JWT));
  assert.equal((await lstat(target)).nlink, 2);
  assert.equal(await readFile(target, "utf8"), "target-data");
  assert.equal((await stat(target)).mode & 0o7777, 0o644);
});

test("rejects POSIX state-key links without changing their targets", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const kind of ["symbolic", "hard"] as const) {
    await t.test(kind, async (subtest) => {
      const item = await fixture(subtest, `a2a-credential-key-${kind}-link-test-`);
      await mkdir(item.directory, { mode: 0o700 });
      const target = join(item.root, "target-key");
      const targetValue = "ab".repeat(24);
      await writeFile(target, targetValue, { mode: 0o644 });
      if (kind === "symbolic") await symlink(target, item.keyPath);
      else await link(target, item.keyPath);

      await expectSafeRejection(() => credentialStore(item.path, item.keyPath).save(CENTRAL_JWT));
      assert.equal(await readFile(target, "utf8"), targetValue);
      assert.equal((await stat(target)).mode & 0o7777, 0o644);
    });
  }
});

test("enforces native Windows DACLs on the state directory and credential pair", {
  skip: process.platform !== "win32",
}, async (t) => {
  const item = await fixture(t, "ambassador-credential-native-windows-;[]$()-");
  const store = new EncryptedFileCredentialStore(item.path, item.keyPath, CREDENTIAL_SCOPE);

  await store.save(CENTRAL_JWT);
  assert.equal(await store.load(), CENTRAL_JWT);
  await assertNativeWindowsAcl(item.directory, "directory");
  await assertNativeWindowsAcl(item.path, "file");
  await assertNativeWindowsAcl(item.keyPath, "file");
  assert.deepEqual((await readdir(item.directory)).sort(), [
    "central-credential.json",
    "central-credential.key",
  ]);
});
