import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

import {
  assertSameKeyCredentialReplacement,
  type LoadedCentralCredentialV2,
  parseCentralCredentialV2,
} from "./credential-v2.js";

const LEGACY_FILE_VERSION = 1;
const V2_FILE_VERSION = 2;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_JWT_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const SYSTEM_SID = "S-1-5-18";
const WINDOWS_POWERSHELL_TIMEOUT_MS = 30_000;
const WINDOWS_HELPER_ENVIRONMENT_NAMES = [
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
] as const;
const HOOK_TOKEN_PATTERN = /^[0-9a-f]{48}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_KEYS = [
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
] as const;
const AAD_METADATA = {
  kdf: "scrypt",
  n: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  cipher: "aes-256-gcm",
} as const;
const savingPaths = new Set<string>();

interface CredentialEnvelope {
  version: typeof LEGACY_FILE_VERSION | typeof V2_FILE_VERSION;
  kdf: "scrypt";
  n: typeof SCRYPT_N;
  r: typeof SCRYPT_R;
  p: typeof SCRYPT_P;
  salt: string;
  cipher: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface CredentialStore {
  load(): Promise<string | undefined>;
  save(jwt: string): Promise<void>;
}

export type StoredCredential =
  | { readonly version: 1; readonly plaintext: string }
  | { readonly version: 2; readonly plaintext: string };

export interface VersionedCredentialStore {
  loadCredential(): Promise<StoredCredential | undefined>;
  saveCredential(credential: StoredCredential): Promise<void>;
}

export type CredentialArtifactKind = "directory" | "file";

export interface WindowsCredentialAccessControl {
  secure(path: string, kind: CredentialArtifactKind): Promise<void>;
}

export interface WindowsCredentialFileReplacement {
  replace(sourcePath: string, destinationPath: string): Promise<void>;
}

export interface EncryptedFileCredentialStoreOptions {
  platform?: NodeJS.Platform;
  windowsAccessControl?: WindowsCredentialAccessControl;
  windowsFileReplacement?: WindowsCredentialFileReplacement;
}

interface SecuredDirectory {
  stats: BigIntStats;
  handle?: FileHandle;
}

class WindowsCredentialOperationError extends Error {}

function invalidCredential(): Error {
  return new Error("The credential store is invalid or cannot be decrypted");
}

function credentialExists(): Error {
  return new Error("A central identity is already stored");
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function sameArtifact(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) throw invalidCredential();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw invalidCredential();
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) throw invalidCredential();
  return decoded;
}

function parseEnvelope(bytes: Buffer): {
  version: CredentialEnvelope["version"];
  salt: Buffer;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidCredential();
  }
  if (!isRecord(value)) throw invalidCredential();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    !keys.every((key, index) => key === ENVELOPE_KEYS[index])
  ) {
    throw invalidCredential();
  }
  if (
    (value.version !== LEGACY_FILE_VERSION && value.version !== V2_FILE_VERSION) ||
    value.kdf !== "scrypt" ||
    value.n !== SCRYPT_N ||
    value.r !== SCRYPT_R ||
    value.p !== SCRYPT_P ||
    value.cipher !== "aes-256-gcm"
  ) {
    throw invalidCredential();
  }
  const ciphertext = decodeBase64(value.ciphertext);
  const maximumPlaintext = value.version === V2_FILE_VERSION ? 8_192 : MAX_JWT_BYTES;
  if (ciphertext.length === 0 || ciphertext.length > maximumPlaintext) throw invalidCredential();
  return {
    version: value.version,
    salt: decodeBase64(value.salt, SALT_BYTES),
    iv: decodeBase64(value.iv, IV_BYTES),
    tag: decodeBase64(value.tag, TAG_BYTES),
    ciphertext,
  };
}

function deriveKey(hookToken: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(
      hookToken,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => {
        if (error) {
          reject(error);
          return;
        }
        resolveKey(key);
      },
    );
  });
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (
    systemRoot === undefined ||
    !isAbsolute(systemRoot) ||
    systemRoot.includes("\0") ||
    systemRoot.includes("\r") ||
    systemRoot.includes("\n")
  ) {
    throw new Error("Windows credential operation failed");
  }
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsHelperEnvironment(additions: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of WINDOWS_HELPER_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...additions };
}

function runWindowsPowerShell(
  script: string,
  environment: Readonly<Record<string, string>>,
  expectedOutput: string,
): Promise<void> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        env: windowsHelperEnvironment(environment),
        maxBuffer: 32 * 1024,
        timeout: WINDOWS_POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error || stderr.length !== 0 || stdout !== expectedOutput) {
          const status = /^A2A_REPLACE_ERROR_([A-Za-z]+_[0-9]+)$/u.exec(stdout)?.[1];
          reject(
            new WindowsCredentialOperationError(
              status === undefined
                ? "Windows credential operation failed"
                : `Windows credential operation failed (native status ${status})`,
            ),
          );
          return;
        }
        resolveOutput();
      },
    );
  });
}

const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { exit 41 }
$target = [Environment]::GetEnvironmentVariable('A2A_CREDENTIAL_ACL_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('A2A_CREDENTIAL_ACL_KIND', 'Process')
if ([String]::IsNullOrEmpty($target)) { exit 42 }
$attributes = [System.IO.File]::GetAttributes($target)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 43 }
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if (($kind -eq 'directory') -ne $isDirectory) { exit 44 }
if ($kind -ne 'directory' -and $kind -ne 'file') { exit 45 }
$userIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$userSid = $userIdentity.Value
$artifact = if ($kind -eq 'directory') {
  [System.IO.DirectoryInfo]::new($target)
} else {
  [System.IO.FileInfo]::new($target)
}
$security = if ($kind -eq 'directory') {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$security.SetOwner($userIdentity)
$security.SetAccessRuleProtection($true, $false)
$inheritance = if ($kind -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$expected = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
[void]$expected.Add($userSid)
[void]$expected.Add('${SYSTEM_SID}')
foreach ($sid in $expected) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
$artifact.SetAccessControl($security)
$actual = $artifact.GetAccessControl(
  [System.Security.AccessControl.AccessControlSections]'Access,Owner'
)
if (-not $actual.AreAccessRulesProtected) { exit 46 }
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $userSid) {
  exit 47
}
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne $expected.Count) { exit 48 }
foreach ($rule in $rules) {
  if ($expected -notcontains $rule.IdentityReference.Value) { exit 49 }
  if ($rule.IsInherited) { exit 50 }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    exit 51
  }
  if ([int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl) {
    exit 52
  }
  if ($rule.InheritanceFlags -ne $inheritance) { exit 53 }
  if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
    exit 54
  }
}
[Console]::Out.Write('A2A_ACL_OK')
`;

const WINDOWS_REPLACE_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { exit 71 }
$source = [Environment]::GetEnvironmentVariable('A2A_CREDENTIAL_REPLACE_SOURCE', 'Process')
$destination = [Environment]::GetEnvironmentVariable('A2A_CREDENTIAL_REPLACE_DESTINATION', 'Process')
if ([String]::IsNullOrEmpty($source) -or [String]::IsNullOrEmpty($destination)) { exit 72 }
$source = [System.IO.Path]::GetFullPath($source)
$destination = [System.IO.Path]::GetFullPath($destination)
if ($source -eq $destination) { exit 73 }
if (-not [String]::Equals(
  [System.IO.Path]::GetDirectoryName($source),
  [System.IO.Path]::GetDirectoryName($destination),
  [System.StringComparison]::OrdinalIgnoreCase
)) { exit 74 }
$sourceAttributes = [System.IO.File]::GetAttributes($source)
$destinationAttributes = [System.IO.File]::GetAttributes($destination)
if (($sourceAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) { exit 75 }
if (($destinationAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) { exit 75 }
if (($sourceAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 76 }
if (($destinationAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 77 }
try {
  [System.IO.File]::Replace($source, $destination, $null)
} catch {
  $nativeException = $_.Exception.GetBaseException()
  $nativeStatus = $nativeException.HResult -band 65535
  $nativeType = $nativeException.GetType().Name
  [Console]::Out.Write('A2A_REPLACE_ERROR_' + $nativeType + '_' + $nativeStatus)
  exit 81
}
if ([System.IO.File]::Exists($source) -or [System.IO.Directory]::Exists($source)) { exit 78 }
$publishedAttributes = [System.IO.File]::GetAttributes($destination)
if (($publishedAttributes -band [System.IO.FileAttributes]::Directory) -ne 0) { exit 79 }
if (($publishedAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 80 }
[Console]::Out.Write('A2A_REPLACE_OK')
`;

class BuiltInWindowsCredentialAccessControl implements WindowsCredentialAccessControl {
  async secure(path: string, kind: CredentialArtifactKind): Promise<void> {
    await runWindowsPowerShell(
      WINDOWS_ACL_SCRIPT,
      {
        A2A_CREDENTIAL_ACL_PATH: path,
        A2A_CREDENTIAL_ACL_KIND: kind,
      },
      "A2A_ACL_OK",
    );
  }
}

class BuiltInWindowsCredentialFileReplacement implements WindowsCredentialFileReplacement {
  async replace(sourcePath: string, destinationPath: string): Promise<void> {
    await runWindowsPowerShell(
      WINDOWS_REPLACE_SCRIPT,
      {
        A2A_CREDENTIAL_REPLACE_SOURCE: sourcePath,
        A2A_CREDENTIAL_REPLACE_DESTINATION: destinationPath,
      },
      "A2A_REPLACE_OK",
    );
  }
}

export class EncryptedFileCredentialStore implements CredentialStore, VersionedCredentialStore {
  private readonly path: string;
  private readonly directoryPath: string;
  private readonly hookToken: Buffer;
  private readonly credentialScope: string;
  private readonly platform: NodeJS.Platform;
  private readonly windowsAccessControl?: WindowsCredentialAccessControl;
  private readonly windowsFileReplacement?: WindowsCredentialFileReplacement;

  constructor(
    path: string,
    hookToken: string,
    credentialScope: string,
    options: EncryptedFileCredentialStoreOptions = {},
  ) {
    if (!HOOK_TOKEN_PATTERN.test(hookToken)) {
      throw new Error("The webhook token format is invalid");
    }
    if (typeof credentialScope !== "string" || credentialScope.length === 0) {
      throw new Error("The credential scope is invalid");
    }
    this.path = resolve(path);
    this.directoryPath = dirname(this.path);
    this.hookToken = Buffer.from(hookToken, "hex");
    this.credentialScope = credentialScope;
    this.platform = options.platform ?? process.platform;
    if (this.platform === "win32") {
      this.windowsAccessControl =
        options.windowsAccessControl ?? new BuiltInWindowsCredentialAccessControl();
      this.windowsFileReplacement =
        options.windowsFileReplacement ?? new BuiltInWindowsCredentialFileReplacement();
    }
  }

  async load(): Promise<string | undefined> {
    const credential = await this.loadCredential();
    if (credential === undefined) return undefined;
    if (credential.version !== LEGACY_FILE_VERSION) throw invalidCredential();
    return credential.plaintext;
  }

  async loadCredential(): Promise<StoredCredential | undefined> {
    const directory = await this.openDirectory(false);
    if (directory === undefined) return undefined;
    try {
      try {
        const stored = await this.readCredentialPath(this.path);
        await this.verifyDirectory(directory);
        if (
          stored.version === LEGACY_FILE_VERSION &&
          stored.plaintext.trimStart().startsWith("{")
        ) {
          throw invalidCredential();
        }
        return { version: stored.version, plaintext: stored.plaintext };
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          await this.verifyDirectory(directory);
          return undefined;
        }
        throw error;
      }
    } finally {
      await directory.handle?.close();
    }
  }

  async save(plaintext: string): Promise<void> {
    if (typeof plaintext !== "string") throw new Error("The central credential is invalid");
    if (plaintext.trimStart().startsWith("{")) throw new Error("The central credential is invalid");
    await this.saveCredential({ version: LEGACY_FILE_VERSION, plaintext });
  }

  async saveCredential(credential: StoredCredential): Promise<void> {
    const { plaintext, version } = credential;
    if (version !== LEGACY_FILE_VERSION && version !== V2_FILE_VERSION) {
      throw new Error("The central credential is invalid");
    }
    if (
      typeof plaintext !== "string" ||
      plaintext.length === 0 ||
      Buffer.byteLength(plaintext) > MAX_JWT_BYTES
    ) {
      throw new Error("The central credential is invalid");
    }
    if (version === LEGACY_FILE_VERSION && plaintext.trimStart().startsWith("{")) {
      throw new Error("The central credential is invalid");
    }
    const replacement =
      version === V2_FILE_VERSION ? parseCentralCredentialV2(plaintext) : undefined;
    if (savingPaths.has(this.path)) throw credentialExists();
    savingPaths.add(this.path);
    let directory: SecuredDirectory | undefined;
    let temporaryPath: string | undefined;
    let temporaryFile: FileHandle | undefined;
    let temporaryCreated = false;
    let published = false;
    let current:
      | {
          readonly bytes: Buffer;
        }
      | undefined;

    try {
      directory = await this.openDirectory(true);
      if (directory === undefined) throw new Error("The credential directory is unavailable");
      try {
        const stored = await this.readCredentialPath(this.path);
        if (stored.version !== V2_FILE_VERSION || replacement === undefined) {
          throw credentialExists();
        }
        const credential = parseCentralCredentialV2(stored.plaintext);
        assertSameKeyCredentialReplacement(credential, replacement);
        current = { bytes: stored.bytes };
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }

      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      let key: Buffer | undefined;
      let ciphertext: Buffer;
      let tag: Buffer;
      try {
        key = await deriveKey(this.hookToken, salt);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(this.additionalData(version));
        ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        tag = cipher.getAuthTag();
      } finally {
        key?.fill(0);
      }
      const envelope: CredentialEnvelope = {
        version,
        kdf: "scrypt",
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        salt: salt.toString("base64"),
        cipher: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      const serialized = Buffer.from(JSON.stringify(envelope), "ascii");

      await this.verifyDirectory(directory);
      if (current === undefined) await this.assertCredentialAbsent();
      temporaryPath = `${this.path}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
      const noFollow = this.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      temporaryFile = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      );
      temporaryCreated = true;
      await this.verifyOpenFile(temporaryPath, temporaryFile, undefined, false);
      if (this.platform === "win32") {
        await this.windowsAccessControl?.secure(temporaryPath, "file");
      } else {
        await temporaryFile.chmod(0o600);
      }
      await this.verifyOpenFile(temporaryPath, temporaryFile);
      await temporaryFile.writeFile(serialized);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;

      const staged = await this.readCredentialPath(temporaryPath);
      if (staged.version !== version || staged.plaintext !== plaintext) throw invalidCredential();

      await this.verifyDirectory(directory);
      if (current !== undefined) {
        const latest = await this.readCredentialPath(this.path);
        const expectedDigest = createHash("sha256").update(current.bytes).digest();
        const latestDigest = createHash("sha256").update(latest.bytes).digest();
        if (!expectedDigest.equals(latestDigest)) throw invalidCredential();
        const latestCredential = parseCentralCredentialV2(latest.plaintext);
        assertSameKeyCredentialReplacement(
          latestCredential,
          replacement as LoadedCentralCredentialV2,
        );
        if (this.platform === "win32") {
          const windowsFileReplacement = this.windowsFileReplacement;
          if (windowsFileReplacement === undefined) throw invalidCredential();
          try {
            await windowsFileReplacement.replace(temporaryPath, this.path);
            temporaryCreated = false;
          } catch (error) {
            const recovered = await this.loadCredential().catch(() => undefined);
            if (recovered?.version !== version || recovered.plaintext !== plaintext) {
              if (error instanceof WindowsCredentialOperationError) throw error;
              throw invalidCredential();
            }
            try {
              await unlink(temporaryPath);
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw invalidCredential();
            }
            temporaryCreated = false;
          }
        } else {
          await rename(temporaryPath, this.path);
          temporaryCreated = false;
        }
      } else if (this.platform === "win32") {
        await this.assertCredentialAbsent();
        await rename(temporaryPath, this.path);
        temporaryCreated = false;
      } else {
        await this.assertCredentialAbsent();
        await link(temporaryPath, this.path);
        published = true;
        try {
          await unlink(temporaryPath);
          temporaryCreated = false;
        } catch (error) {
          const temporaryStats = await lstat(temporaryPath, { bigint: true });
          const finalStats = await lstat(this.path, { bigint: true });
          if (sameArtifact(temporaryStats, finalStats)) await unlink(this.path);
          published = false;
          throw error;
        }
      }
      published = true;

      try {
        const finalFile = await this.openExistingFile(this.path, true);
        try {
          await finalFile.sync();
        } finally {
          await finalFile.close();
        }
        await this.verifyDirectory(directory);
        if (directory.handle !== undefined) await directory.handle.sync();
        const stored = await this.readCredentialPath(this.path);
        if (stored.version !== version || stored.plaintext !== plaintext) throw invalidCredential();
      } catch {
        const recovered = await this.loadCredential().catch(() => undefined);
        if (recovered?.version !== version || recovered.plaintext !== plaintext) {
          throw invalidCredential();
        }
      }
    } finally {
      savingPaths.delete(this.path);
      if (temporaryFile !== undefined) await temporaryFile.close().catch(() => undefined);
      if (!published && temporaryCreated && temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      await directory?.handle?.close().catch(() => undefined);
    }
  }

  private additionalData(version: CredentialEnvelope["version"]): Buffer {
    return Buffer.from(
      JSON.stringify({ version, ...AAD_METADATA, credentialScope: this.credentialScope }),
      "utf8",
    );
  }

  private async readCredentialPath(path: string): Promise<{
    readonly bytes: Buffer;
    readonly plaintext: string;
    readonly version: CredentialEnvelope["version"];
  }> {
    const file = await this.openExistingFile(path, false);
    try {
      const stats = await file.stat({ bigint: true });
      if (stats.size <= 0n || stats.size > BigInt(MAX_FILE_BYTES)) throw invalidCredential();
      const bytes = await file.readFile();
      const currentStats = await file.stat({ bigint: true });
      if (bytes.length !== Number(stats.size) || !sameArtifact(stats, currentStats)) {
        throw invalidCredential();
      }
      const envelope = parseEnvelope(bytes);
      let key: Buffer | undefined;
      let decoded: Buffer | undefined;
      try {
        key = await deriveKey(this.hookToken, envelope.salt);
        const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(this.additionalData(envelope.version));
        decipher.setAuthTag(envelope.tag);
        decoded = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
        const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        if (plaintext.length === 0) throw invalidCredential();
        if (envelope.version === V2_FILE_VERSION) parseCentralCredentialV2(plaintext);
        return { bytes, plaintext, version: envelope.version };
      } catch {
        throw invalidCredential();
      } finally {
        key?.fill(0);
        decoded?.fill(0);
      }
    } finally {
      await file.close();
    }
  }

  private async openDirectory(create: boolean): Promise<SecuredDirectory | undefined> {
    if (create) {
      await mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
    }
    let initialStats: BigIntStats;
    try {
      initialStats = await lstat(this.directoryPath, { bigint: true });
    } catch (error) {
      if (!create && errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!initialStats.isDirectory()) throw invalidCredential();

    if (this.platform === "win32") {
      await this.windowsAccessControl?.secure(this.directoryPath, "directory");
      const currentStats = await lstat(this.directoryPath, { bigint: true });
      if (!currentStats.isDirectory() || !sameArtifact(initialStats, currentStats)) {
        throw invalidCredential();
      }
      return { stats: currentStats };
    }

    const handle = await open(
      this.directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const descriptorStats = await handle.stat({ bigint: true });
      const pathStats = await lstat(this.directoryPath, { bigint: true });
      if (
        !descriptorStats.isDirectory() ||
        !pathStats.isDirectory() ||
        !sameArtifact(initialStats, descriptorStats) ||
        !sameArtifact(descriptorStats, pathStats) ||
        (typeof process.getuid === "function" && descriptorStats.uid !== BigInt(process.getuid()))
      ) {
        throw invalidCredential();
      }
      await handle.chmod(0o700);
      const securedStats = await handle.stat({ bigint: true });
      if ((securedStats.mode & 0o7777n) !== 0o700n) throw invalidCredential();
      return { stats: securedStats, handle };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async verifyDirectory(directory: SecuredDirectory): Promise<void> {
    const pathStats = await lstat(this.directoryPath, { bigint: true });
    const descriptorStats =
      directory.handle === undefined
        ? directory.stats
        : await directory.handle.stat({ bigint: true });
    if (
      !pathStats.isDirectory() ||
      !descriptorStats.isDirectory() ||
      !sameArtifact(directory.stats, descriptorStats) ||
      !sameArtifact(descriptorStats, pathStats)
    ) {
      throw invalidCredential();
    }
    if (this.platform === "win32") {
      await this.windowsAccessControl?.secure(this.directoryPath, "directory");
      const securedStats = await lstat(this.directoryPath, { bigint: true });
      if (!securedStats.isDirectory() || !sameArtifact(descriptorStats, securedStats)) {
        throw invalidCredential();
      }
    } else if (
      (descriptorStats.mode & 0o7777n) !== 0o700n ||
      (typeof process.getuid === "function" && descriptorStats.uid !== BigInt(process.getuid()))
    ) {
      throw invalidCredential();
    }
  }

  private async assertCredentialAbsent(): Promise<void> {
    try {
      await lstat(this.path, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    throw credentialExists();
  }

  private async openExistingFile(path: string, writable: boolean): Promise<FileHandle> {
    const initialStats = await lstat(path, { bigint: true });
    if (!initialStats.isFile() || initialStats.nlink !== 1n) throw invalidCredential();
    const noFollow = this.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const access = writable ? constants.O_RDWR : constants.O_RDONLY;
    const file = await open(path, access | noFollow);
    try {
      await this.verifyOpenFile(path, file, initialStats, false);
      if (this.platform === "win32") {
        await this.windowsAccessControl?.secure(path, "file");
      } else {
        if (typeof process.getuid === "function" && initialStats.uid !== BigInt(process.getuid())) {
          throw invalidCredential();
        }
        await file.chmod(0o600);
      }
      await this.verifyOpenFile(path, file, initialStats);
      return file;
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  private async verifyOpenFile(
    path: string,
    file: FileHandle,
    initialStats?: BigIntStats,
    requireMode = true,
  ): Promise<void> {
    const descriptorStats = await file.stat({ bigint: true });
    const pathStats = await lstat(path, { bigint: true });
    if (
      !descriptorStats.isFile() ||
      !pathStats.isFile() ||
      descriptorStats.nlink !== 1n ||
      pathStats.nlink !== 1n ||
      (initialStats !== undefined && !sameArtifact(initialStats, descriptorStats)) ||
      !sameArtifact(descriptorStats, pathStats)
    ) {
      throw invalidCredential();
    }
    if (
      requireMode &&
      this.platform !== "win32" &&
      ((descriptorStats.mode & 0o7777n) !== 0o600n ||
        (typeof process.getuid === "function" && descriptorStats.uid !== BigInt(process.getuid())))
    ) {
      throw invalidCredential();
    }
  }
}
