import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedFileCredentialStore,
  type EncryptedFileCredentialStoreOptions,
  type WindowsCredentialFileReplacement,
} from "../src/credential-store.js";
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

const TEST_WINDOWS_ACCESS_CONTROL = {
  async secure() {},
};

function simulatedWindowsOptions(
  replacement: WindowsCredentialFileReplacement,
): EncryptedFileCredentialStoreOptions {
  return {
    platform: "win32",
    windowsAccessControl: TEST_WINDOWS_ACCESS_CONTROL,
    windowsFileReplacement: replacement,
  };
}

async function assertOnlyPublishedCredential(directory: string): Promise<void> {
  assert.deepEqual(await readdir(directory), ["central-credential.json"]);
}

function executeWindowsPowerShell(script: string, environment: NodeJS.ProcessEnv): Promise<string> {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot !== undefined && systemRoot.length > 0);
  const inheritedEnvironment: NodeJS.ProcessEnv = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
  ]) {
    const value = process.env[name];
    if (value !== undefined) inheritedEnvironment[name] = value;
  }
  return new Promise((resolve, reject) => {
    execFile(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        env: { ...inheritedEnvironment, ...environment },
        maxBuffer: 32 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null || stderr.length !== 0) {
          reject(new Error("Native Windows ACL observation failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

interface WindowsAclObservation {
  readonly currentSid: string;
  readonly ownerSid: string;
  readonly protected: boolean;
  readonly rules: ReadonlyArray<{
    readonly sid: string;
    readonly rights: number;
    readonly inheritance: number;
    readonly propagation: number;
    readonly type: number;
    readonly inherited: boolean;
  }>;
}

const WINDOWS_ACL_OBSERVATION_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { exit 61 }
$target = [Environment]::GetEnvironmentVariable('A2A_W01A_ACL_TARGET', 'Process')
if ([String]::IsNullOrEmpty($target)) { exit 62 }
$attributes = [System.IO.File]::GetAttributes($target)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 63 }
$artifact = if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
  [System.IO.DirectoryInfo]::new($target)
} else {
  [System.IO.FileInfo]::new($target)
}
$acl = $artifact.GetAccessControl(
  [System.Security.AccessControl.AccessControlSections]'Access,Owner'
)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = $acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
)
$lines = [System.Collections.Generic.List[string]]::new()
[void]$lines.Add($currentSid)
[void]$lines.Add($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)
[void]$lines.Add($(if ($acl.AreAccessRulesProtected) { '1' } else { '0' }))
foreach ($rule in $rules) {
  [void]$lines.Add([String]::Join('|', @(
    $rule.IdentityReference.Value,
    [int]$rule.FileSystemRights,
    [int]$rule.InheritanceFlags,
    [int]$rule.PropagationFlags,
    [int]$rule.AccessControlType,
    $(if ($rule.IsInherited) { '1' } else { '0' })
  )))
}
[Console]::Out.Write([String]::Join("\`n", $lines))
`;

async function observeWindowsAcl(path: string): Promise<WindowsAclObservation> {
  const output = await executeWindowsPowerShell(WINDOWS_ACL_OBSERVATION_SCRIPT, {
    A2A_W01A_ACL_TARGET: path,
  });
  const lines = output.split("\n");
  assert.ok(lines.length >= 4);
  const currentSid = lines[0];
  const ownerSid = lines[1];
  assert.ok(currentSid !== undefined && /^S-[0-9-]+$/u.test(currentSid));
  assert.ok(ownerSid !== undefined && /^S-[0-9-]+$/u.test(ownerSid));
  assert.ok(lines[2] === "0" || lines[2] === "1");
  return {
    currentSid,
    ownerSid,
    protected: lines[2] === "1",
    rules: lines.slice(3).map((line) => {
      const fields = line.split("|");
      assert.equal(fields.length, 6);
      const [sid, rights, inheritance, propagation, type, inherited] = fields;
      assert.ok(sid !== undefined && /^S-[0-9-]+$/u.test(sid));
      assert.ok(rights !== undefined && /^[0-9]+$/u.test(rights));
      assert.ok(inheritance !== undefined && /^[0-9]+$/u.test(inheritance));
      assert.ok(propagation !== undefined && /^[0-9]+$/u.test(propagation));
      assert.ok(type !== undefined && /^[0-9]+$/u.test(type));
      assert.ok(inherited === "0" || inherited === "1");
      return {
        sid,
        rights: Number(rights),
        inheritance: Number(inheritance),
        propagation: Number(propagation),
        type: Number(type),
        inherited: inherited === "1",
      };
    }),
  };
}

function assertWindowsAcl(observation: WindowsAclObservation, kind: "directory" | "file"): void {
  assert.equal(observation.protected, true);
  assert.equal(observation.ownerSid, observation.currentSid);
  assert.deepEqual(
    observation.rules.map((rule) => rule.sid).sort(),
    [observation.currentSid, "S-1-5-18"].sort(),
  );
  for (const rule of observation.rules) {
    assert.equal(rule.rights, 2_032_127);
    assert.equal(rule.inheritance, kind === "directory" ? 3 : 0);
    assert.equal(rule.propagation, 0);
    assert.equal(rule.type, 0);
    assert.equal(rule.inherited, false);
  }
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

test("encrypted envelope version 2 creates fresh state and handles same-key replacement safely", async (t) => {
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
  const options: EncryptedFileCredentialStoreOptions =
    process.platform === "win32"
      ? {
          windowsAccessControl: {
            async secure() {},
          },
          windowsFileReplacement: {
            async replace(sourcePath, destinationPath) {
              await rename(sourcePath, destinationPath);
            },
          },
        }
      : {};
  const createStore = () => new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE, options);
  const store = createStore();
  await store.saveCredential({ version: 2, plaintext: original });
  assert.deepEqual(await store.loadCredential(), { version: 2, plaintext: original });
  await assert.rejects(store.load());
  const firstEnvelope = await readFile(path);
  assert.equal(JSON.parse(firstEnvelope.toString("utf8")).version, 2);
  assert.ok(!firstEnvelope.includes(Buffer.from(original)));
  assert.ok(!firstEnvelope.includes(Buffer.from(key.privateKeyPkcs8)));
  assert.ok(!firstEnvelope.includes(Buffer.from(HOOK_TOKEN)));
  assert.ok(!firstEnvelope.includes(Buffer.from(SCOPE)));

  await createStore().saveCredential({ version: 2, plaintext: replacement });
  assert.deepEqual(await createStore().loadCredential(), { version: 2, plaintext: replacement });
  const replacementEnvelope = await readFile(path);
  assert.equal(JSON.parse(replacementEnvelope.toString("utf8")).version, 2);
  assert.ok(!replacementEnvelope.includes(Buffer.from(replacement)));
  assert.deepEqual(await readdir(join(root, "state")), ["central-credential.json"]);
});

test("Windows replacement publishes one validated sibling and survives restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-w01a-simulated-success-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  const path = join(directory, "central-credential.json");
  const key = generateDpopKeyMaterial();
  const original = serializeCentralCredentialV2(credential(key));
  const replacement = serializeCentralCredentialV2(
    credential(key, {
      issuedAt: 1_788_043_201,
      tokenId: "00000000-0000-4000-8000-000000000104",
    }),
  );
  const calls: Array<{ sourcePath: string; destinationPath: string }> = [];
  const fileReplacement: WindowsCredentialFileReplacement = {
    async replace(sourcePath, destinationPath) {
      calls.push({ sourcePath, destinationPath });
      await rename(sourcePath, destinationPath);
    },
  };
  const options = simulatedWindowsOptions(fileReplacement);
  const createStore = () => new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE, options);

  await createStore().saveCredential({ version: 2, plaintext: original });
  await createStore().saveCredential({ version: 2, plaintext: replacement });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.destinationPath, path);
  assert.match(calls[0]?.sourcePath ?? "", /central-credential\.json\.tmp-[0-9]+-[0-9a-f]{32}$/u);
  assert.deepEqual(await createStore().loadCredential(), { version: 2, plaintext: replacement });
  await assertOnlyPublishedCredential(directory);
});

test("Windows pre-publication replacement failure preserves the old record and removes the sibling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-w01a-simulated-before-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  const path = join(directory, "central-credential.json");
  const key = generateDpopKeyMaterial();
  const original = serializeCentralCredentialV2(credential(key));
  const replacement = serializeCentralCredentialV2(
    credential(key, {
      issuedAt: 1_788_043_201,
      tokenId: "00000000-0000-4000-8000-000000000105",
    }),
  );
  const fileReplacement: WindowsCredentialFileReplacement = {
    async replace() {
      throw new Error("injected pre-publication replacement failure");
    },
  };
  const options = simulatedWindowsOptions(fileReplacement);
  const createStore = () => new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE, options);
  await createStore().saveCredential({ version: 2, plaintext: original });
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

  await assert.rejects(
    createStore().saveCredential({ version: 2, plaintext: replacement }),
    /credential/u,
  );

  assert.equal(
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    digest,
  );
  assert.deepEqual(await createStore().loadCredential(), { version: 2, plaintext: original });
  await assertOnlyPublishedCredential(directory);
});

test("Windows uncertain post-publication result reloads the complete replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-w01a-simulated-after-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  const path = join(directory, "central-credential.json");
  const key = generateDpopKeyMaterial();
  const original = serializeCentralCredentialV2(credential(key));
  const replacement = serializeCentralCredentialV2(
    credential(key, {
      issuedAt: 1_788_043_201,
      tokenId: "00000000-0000-4000-8000-000000000106",
    }),
  );
  const fileReplacement: WindowsCredentialFileReplacement = {
    async replace(sourcePath, destinationPath) {
      await rename(sourcePath, destinationPath);
      throw new Error("injected uncertain post-publication result");
    },
  };
  const options = simulatedWindowsOptions(fileReplacement);
  const createStore = () => new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE, options);
  await createStore().saveCredential({ version: 2, plaintext: original });

  await createStore().saveCredential({ version: 2, plaintext: replacement });

  assert.deepEqual(await createStore().loadCredential(), { version: 2, plaintext: replacement });
  await assertOnlyPublishedCredential(directory);
});

test("Windows corrupt post-publication result fails closed and leaves no sibling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-w01a-simulated-corrupt-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  const path = join(directory, "central-credential.json");
  const key = generateDpopKeyMaterial();
  const original = serializeCentralCredentialV2(credential(key));
  const replacement = serializeCentralCredentialV2(
    credential(key, {
      issuedAt: 1_788_043_201,
      tokenId: "00000000-0000-4000-8000-000000000107",
    }),
  );
  const fileReplacement: WindowsCredentialFileReplacement = {
    async replace(sourcePath, destinationPath) {
      await rename(sourcePath, destinationPath);
      await writeFile(destinationPath, "{corrupt");
      throw new Error("injected corrupt post-publication result");
    },
  };
  const options = simulatedWindowsOptions(fileReplacement);
  const createStore = () => new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE, options);
  await createStore().saveCredential({ version: 2, plaintext: original });

  await assert.rejects(createStore().saveCredential({ version: 2, plaintext: replacement }));
  await assert.rejects(createStore().loadCredential());
  await assertOnlyPublishedCredential(directory);
});

test("W01a enforces native owner and SYSTEM DACLs, replaces atomically, and rejects restart corruption", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-w01a-;[]$()-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const directory = join(root, "state");
  const path = join(directory, "central-credential.json");
  const key = generateDpopKeyMaterial();
  const original = serializeCentralCredentialV2(credential(key));
  const replacement = serializeCentralCredentialV2(
    credential(key, {
      issuedAt: 1_788_043_201,
      tokenId: "00000000-0000-4000-8000-000000000108",
    }),
  );
  const createStore = () => new EncryptedFileCredentialStore(path, HOOK_TOKEN, SCOPE);

  await createStore().saveCredential({ version: 2, plaintext: original });
  assertWindowsAcl(await observeWindowsAcl(directory), "directory");
  assertWindowsAcl(await observeWindowsAcl(path), "file");

  await createStore().saveCredential({ version: 2, plaintext: replacement });
  assert.deepEqual(await createStore().loadCredential(), { version: 2, plaintext: replacement });
  assertWindowsAcl(await observeWindowsAcl(directory), "directory");
  assertWindowsAcl(await observeWindowsAcl(path), "file");
  await assertOnlyPublishedCredential(directory);

  await writeFile(path, "{corrupt");
  await assert.rejects(createStore().loadCredential());
  assert.equal(await readFile(path, "utf8"), "{corrupt");
  await assertOnlyPublishedCredential(directory);
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
