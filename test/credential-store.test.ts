import assert from "node:assert/strict";
import {
  access,
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

import {
  EncryptedFileCredentialStore,
  type EncryptedFileCredentialStoreOptions,
  type WindowsCredentialAccessControl,
} from "../src/credential-store.js";

const HOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_HOOK_TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789";
const CENTRAL_JWT = "header.payload.central-signature-value";
const OTHER_CENTRAL_JWT = "other-header.other-payload.other-signature";
const CREDENTIAL_SCOPE = "central:https://api.example.test|https://mcp.example.test/mcp";
const OTHER_CREDENTIAL_SCOPE =
  "central:https://other-api.example.test|https://other-mcp.example.test/mcp";
const SUCCESSFUL_WINDOWS_ACCESS_CONTROL: WindowsCredentialAccessControl = {
  async secure() {},
};
const SECRET_MARKERS = [
  HOOK_TOKEN,
  OTHER_HOOK_TOKEN,
  CENTRAL_JWT,
  OTHER_CENTRAL_JWT,
  CREDENTIAL_SCOPE,
  OTHER_CREDENTIAL_SCOPE,
];

interface StoreFixture {
  root: string;
  directory: string;
  path: string;
}

async function fixture(t: TestContext, prefix = "a2a-credential-test-"): Promise<StoreFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  return { root, directory, path: join(directory, "central-credential.json") };
}

async function expectSafeRejection(action: () => Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error !== undefined);
  const diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const marker of SECRET_MARKERS) assert.ok(!diagnostic.includes(marker));
}

async function assertNoSecretFiles(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const bytes = await readFile(join(entry.parentPath, entry.name));
    for (const marker of SECRET_MARKERS) assert.ok(!bytes.includes(Buffer.from(marker)));
  }
}

function credentialStore(
  path: string,
  token = HOOK_TOKEN,
  scope = CREDENTIAL_SCOPE,
  options: EncryptedFileCredentialStoreOptions = process.platform === "win32"
    ? { windowsAccessControl: SUCCESSFUL_WINDOWS_ACCESS_CONTROL }
    : {},
): EncryptedFileCredentialStore {
  return new EncryptedFileCredentialStore(path, token, scope, options);
}

test("round trips one central credential across store instances", async (t) => {
  const item = await fixture(t);
  const store = credentialStore(item.path);
  await store.save(CENTRAL_JWT);

  const restarted = credentialStore(item.path);
  assert.ok((await restarted.load()) === CENTRAL_JWT);
});

test("writes only the strict cryptographic envelope and no plaintext", async (t) => {
  const item = await fixture(t);
  await credentialStore(item.path).save(CENTRAL_JWT);

  await assertNoSecretFiles(item.root);
  const envelope = JSON.parse(await readFile(item.path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(envelope).sort(), [
    "cipher",
    "ciphertext",
    "iv",
    "kdf",
    "n",
    "p",
    "r",
    "salt",
    "tag",
    "version",
  ]);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.kdf, "scrypt");
  assert.equal(envelope.n, 131_072);
  assert.equal(envelope.r, 8);
  assert.equal(envelope.p, 1);
  assert.equal(envelope.cipher, "aes-256-gcm");
  assert.equal(Buffer.from(String(envelope.salt), "base64").length, 16);
  assert.equal(Buffer.from(String(envelope.iv), "base64").length, 12);
  assert.equal(Buffer.from(String(envelope.tag), "base64").length, 16);
  assert.deepEqual(await readdir(item.directory), ["central-credential.json"]);
});

test("a different valid webhook token cannot decrypt the credential", async (t) => {
  const item = await fixture(t);
  await credentialStore(item.path).save(CENTRAL_JWT);

  const wrongStore = credentialStore(item.path, OTHER_HOOK_TOKEN);
  await expectSafeRejection(() => wrongStore.load());
  assert.ok((await credentialStore(item.path).load()) === CENTRAL_JWT);
});

test("a different central endpoint scope cannot decrypt the credential", async (t) => {
  const item = await fixture(t);
  await credentialStore(item.path).save(CENTRAL_JWT);

  await expectSafeRejection(() =>
    credentialStore(item.path, HOOK_TOKEN, OTHER_CREDENTIAL_SCOPE).load(),
  );
  assert.equal(await credentialStore(item.path).load(), CENTRAL_JWT);
});

test("rejects authenticated-ciphertext tampering", async (t) => {
  const item = await fixture(t);
  await credentialStore(item.path).save(CENTRAL_JWT);
  const envelope = JSON.parse(await readFile(item.path, "utf8")) as Record<string, unknown>;
  const tag = Buffer.from(String(envelope.tag), "base64");
  tag[0] = (tag[0] as number) ^ 1;
  envelope.tag = tag.toString("base64");
  await writeFile(item.path, JSON.stringify(envelope));

  await expectSafeRejection(() => credentialStore(item.path).load());
});

test("rejects malformed, incomplete, and unknown credential fields", async (t) => {
  const item = await fixture(t);
  await credentialStore(item.path).save(CENTRAL_JWT);
  const original = JSON.parse(await readFile(item.path, "utf8")) as Record<string, unknown>;
  const cases: Array<[string, string]> = [
    ["malformed JSON", "{"],
    ["unknown field", JSON.stringify({ ...original, identity: "not-allowed" })],
    ["unknown version", JSON.stringify({ ...original, version: 2 })],
    [
      "missing field",
      JSON.stringify(Object.fromEntries(Object.entries(original).filter(([key]) => key !== "tag"))),
    ],
  ];

  for (const [name, contents] of cases) {
    await t.test(name, async () => {
      await writeFile(item.path, contents);
      await expectSafeRejection(() => credentialStore(item.path).load());
    });
  }
});

test("never overwrites the first stored identity", async (t) => {
  const item = await fixture(t);
  const store = credentialStore(item.path);
  await store.save(CENTRAL_JWT);
  const before = await readFile(item.path);

  await expectSafeRejection(() => store.save(OTHER_CENTRAL_JWT));
  await expectSafeRejection(() => credentialStore(item.path).save(OTHER_CENTRAL_JWT));
  const after = await readFile(item.path);
  assert.ok(before.equals(after));
  assert.ok((await credentialStore(item.path).load()) === CENTRAL_JWT);
});

test("serializes concurrent saves for the same identity path", async (t) => {
  const item = await fixture(t);
  const first = credentialStore(item.path);
  const second = credentialStore(item.path);

  const firstSave = first.save(CENTRAL_JWT);
  await expectSafeRejection(() => second.save(OTHER_CENTRAL_JWT));
  await firstSave;
  assert.ok((await second.load()) === CENTRAL_JWT);
});

test("enforces owner-only POSIX directory and file modes on save and load", {
  skip: process.platform === "win32",
}, async (t) => {
  const item = await fixture(t);
  await mkdir(item.directory, { mode: 0o777 });
  await chmod(item.directory, 0o777);
  const store = credentialStore(item.path);
  await store.save(CENTRAL_JWT);

  assert.equal((await stat(item.directory)).mode & 0o7777, 0o700);
  assert.equal((await stat(item.path)).mode & 0o7777, 0o600);

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
    const store = credentialStore(item.path);

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
    const store = credentialStore(item.path);

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
  const store = credentialStore(item.path);

  await expectSafeRejection(() => store.load());
  await expectSafeRejection(() => store.save(CENTRAL_JWT));
  assert.equal((await lstat(target)).nlink, 2);
  assert.equal(await readFile(target, "utf8"), "target-data");
  assert.equal((await stat(target)).mode & 0o7777, 0o644);
});

test("reports persistence failure without writing plaintext or a final file", async (t) => {
  const item = await fixture(t, "a2a-credential-failure-test-");
  await writeFile(item.directory, "directory-blocker");
  const store = credentialStore(item.path);

  await expectSafeRejection(() => store.save(CENTRAL_JWT));
  await expectSafeRejection(() => access(item.path));
  await assertNoSecretFiles(item.root);
});

if (process.platform === "win32") {
  test("W01 qualifies native Windows DACL and atomic replacement", {
    skip: "W01: native credential DACL and replacement are not qualified on Windows",
  }, () => {});
}

test("fails closed when injected Windows DACL enforcement fails", async (t) => {
  const item = await fixture(t, "a2a-credential-windows-acl-test-");
  let calls = 0;
  const accessControl: WindowsCredentialAccessControl = {
    async secure() {
      calls += 1;
      throw new Error("injected access-control failure");
    },
  };
  const store = credentialStore(item.path, HOOK_TOKEN, CREDENTIAL_SCOPE, {
    platform: "win32",
    windowsAccessControl: accessControl,
  });

  await expectSafeRejection(() => store.save(CENTRAL_JWT));
  assert.equal(calls, 1);
  await expectSafeRejection(() => access(item.path));
  await assertNoSecretFiles(item.root);
});

test("rejects invalid webhook-token formats before touching state", async (t) => {
  const item = await fixture(t, "a2a-credential-token-format-test-");
  const invalidTokens = [
    "",
    "0".repeat(47),
    "0".repeat(49),
    "A".repeat(48),
    "g".repeat(48),
    `${"0".repeat(47)}\n`,
  ];

  for (const token of invalidTokens) {
    assert.throws(() => credentialStore(item.path, token));
  }
  await expectSafeRejection(() => access(item.directory));
});
