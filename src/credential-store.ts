import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { parseCentralCredential } from "./central-credential.js";

const FILE_FORMAT = 1;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 8_192;
const MAX_FILE_BYTES = 16_384;
const SYSTEM_SID = "S-1-5-18";
const LOCAL_TOKEN = /^[0-9a-f]{48}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
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
  readonly version: typeof FILE_FORMAT;
  readonly kdf: "scrypt";
  readonly n: typeof SCRYPT_N;
  readonly r: typeof SCRYPT_R;
  readonly p: typeof SCRYPT_P;
  readonly salt: string;
  readonly cipher: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface CredentialStore {
  load(): Promise<string | undefined>;
  save(credential: string): Promise<void>;
}

export type CredentialArtifactKind = "directory" | "file";

export interface WindowsCredentialAccessControl {
  secure(path: string, kind: CredentialArtifactKind): Promise<void>;
}

export interface EncryptedFileCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAccessControl?: WindowsCredentialAccessControl;
}

interface SecuredDirectory {
  readonly stats: BigIntStats;
  readonly handle?: FileHandle;
}

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
  if (typeof value !== "string" || !BASE64.test(value)) throw invalidCredential();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw invalidCredential();
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) throw invalidCredential();
  return decoded;
}

function parseEnvelope(bytes: Buffer): {
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
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
    !ENVELOPE_KEYS.every((key, index) => keys[index] === key) ||
    value.version !== FILE_FORMAT ||
    value.kdf !== "scrypt" ||
    value.n !== SCRYPT_N ||
    value.r !== SCRYPT_R ||
    value.p !== SCRYPT_P ||
    value.cipher !== "aes-256-gcm"
  ) {
    throw invalidCredential();
  }
  const ciphertext = decodeBase64(value.ciphertext);
  if (ciphertext.length < 1 || ciphertext.length > MAX_PLAINTEXT_BYTES) {
    throw invalidCredential();
  }
  return {
    salt: decodeBase64(value.salt, SALT_BYTES),
    iv: decodeBase64(value.iv, IV_BYTES),
    tag: decodeBase64(value.tag, TAG_BYTES),
    ciphertext,
  };
}

function deriveKey(localToken: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(
      localToken,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error === null ? resolveKey(key) : reject(error)),
    );
  });
}

function assertSid(value: string): string {
  if (!/^S-1-(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*)){1,15}$/u.test(value)) {
    throw new Error("Current Windows identity is unavailable");
  }
  const components = value.split("-").slice(2);
  const authority = components.shift();
  if (authority === undefined || BigInt(authority) > 281_474_976_710_655n) {
    throw new Error("Current Windows identity is unavailable");
  }
  if (components.some((component) => BigInt(component) > 4_294_967_295n)) {
    throw new Error("Current Windows identity is unavailable");
  }
  return value;
}

function runExecutable(file: string, arguments_: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      file,
      arguments_,
      { encoding: "utf8", maxBuffer: 32 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null || stderr.length !== 0) {
          reject(new Error("Windows credential access control failed"));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 3) { exit 41 }
$target = $args[0]
$userSid = $args[1]
$kind = $args[2]
$item = Get-Item -LiteralPath $target -Force
if (($kind -eq 'directory') -ne $item.PSIsContainer) { exit 42 }
if ($kind -ne 'directory' -and $kind -ne 'file') { exit 43 }
$security = if ($kind -eq 'directory') {
  New-Object System.Security.AccessControl.DirectorySecurity
} else {
  New-Object System.Security.AccessControl.FileSecurity
}
$security.SetAccessRuleProtection($true, $false)
$inheritance = if ($kind -eq 'directory') {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$expected = @($userSid, '${SYSTEM_SID}') | Select-Object -Unique
foreach ($sid in $expected) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $security
$actual = Get-Acl -LiteralPath $target
if (-not $actual.AreAccessRulesProtected) { exit 44 }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $expected.Count) { exit 45 }
foreach ($rule in $rules) {
  if ($expected -notcontains $rule.IdentityReference.Value) { exit 46 }
  if ($rule.IsInherited) { exit 47 }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 48 }
  if ([int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl) { exit 49 }
  if ($rule.InheritanceFlags -ne $inheritance) { exit 50 }
  if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { exit 51 }
}
[Console]::Out.Write('A2A_ACL_OK')
`;

class BuiltInWindowsCredentialAccessControl implements WindowsCredentialAccessControl {
  #userSid?: Promise<string>;

  async secure(path: string, kind: CredentialArtifactKind): Promise<void> {
    this.#userSid ??= this.#readUserSid();
    const sid = await this.#userSid;
    const output = await runExecutable("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_ACL_SCRIPT,
      path,
      sid,
      kind,
    ]);
    if (output !== "A2A_ACL_OK") throw new Error("Windows credential access control failed");
  }

  async #readUserSid(): Promise<string> {
    const output = await runExecutable("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const match = /^(?:"(?:[^"]|"")*"),"([^"]+)"\r?\n?$/u.exec(output);
    if (match?.[1] === undefined) throw new Error("Current Windows identity is unavailable");
    return assertSid(match[1]);
  }
}

export class EncryptedFileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #directoryPath: string;
  readonly #localToken: Buffer;
  readonly #credentialScope: string;
  readonly #platform: NodeJS.Platform;
  readonly #windowsAccessControl?: WindowsCredentialAccessControl;

  constructor(
    path: string,
    localToken: string,
    credentialScope: string,
    options: EncryptedFileCredentialStoreOptions = {},
  ) {
    if (!LOCAL_TOKEN.test(localToken)) throw new Error("The local token format is invalid");
    if (typeof credentialScope !== "string" || credentialScope.length < 1) {
      throw new Error("The credential scope is invalid");
    }
    this.#path = resolve(path);
    this.#directoryPath = dirname(this.#path);
    this.#localToken = Buffer.from(localToken, "hex");
    this.#credentialScope = credentialScope;
    this.#platform = options.platform ?? process.platform;
    if (this.#platform === "win32") {
      this.#windowsAccessControl =
        options.windowsAccessControl ?? new BuiltInWindowsCredentialAccessControl();
    }
  }

  async load(): Promise<string | undefined> {
    const directory = await this.#openDirectory(false);
    if (directory === undefined) return undefined;
    try {
      try {
        const plaintext = await this.#readCredentialPath(this.#path);
        await this.#verifyDirectory(directory);
        return plaintext;
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          await this.#verifyDirectory(directory);
          return undefined;
        }
        throw error;
      }
    } finally {
      await directory.handle?.close();
    }
  }

  async save(plaintext: string): Promise<void> {
    if (
      typeof plaintext !== "string" ||
      plaintext.length < 1 ||
      Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES
    ) {
      throw new Error("The central credential is invalid");
    }
    parseCentralCredential(plaintext);
    if (savingPaths.has(this.#path)) throw credentialExists();
    savingPaths.add(this.#path);
    let directory: SecuredDirectory | undefined;
    let temporaryPath: string | undefined;
    let temporaryFile: FileHandle | undefined;
    let temporaryCreated = false;
    let finalCreated = false;
    let committed = false;
    try {
      directory = await this.#openDirectory(true);
      if (directory === undefined) throw invalidCredential();
      await this.#assertCredentialAbsent();
      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      let key: Buffer | undefined;
      let ciphertext: Buffer;
      let tag: Buffer;
      try {
        key = await deriveKey(this.#localToken, salt);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(this.#additionalData());
        ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        tag = cipher.getAuthTag();
      } finally {
        key?.fill(0);
      }
      const envelope: CredentialEnvelope = {
        version: FILE_FORMAT,
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
      await this.#verifyDirectory(directory);
      temporaryPath = `${this.#path}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
      const noFollow = this.#platform === "win32" ? 0 : constants.O_NOFOLLOW;
      temporaryFile = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      );
      temporaryCreated = true;
      await this.#verifyOpenFile(temporaryPath, temporaryFile, undefined, false);
      if (this.#platform === "win32") {
        await this.#windowsAccessControl?.secure(temporaryPath, "file");
      } else {
        await temporaryFile.chmod(0o600);
      }
      await this.#verifyOpenFile(temporaryPath, temporaryFile);
      await temporaryFile.writeFile(serialized);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      if ((await this.#readCredentialPath(temporaryPath)) !== plaintext) throw invalidCredential();
      await this.#verifyDirectory(directory);
      await this.#assertCredentialAbsent();
      if (this.#platform === "win32") {
        await rename(temporaryPath, this.#path);
        temporaryCreated = false;
        finalCreated = true;
      } else {
        await link(temporaryPath, this.#path);
        finalCreated = true;
        await unlink(temporaryPath);
        temporaryCreated = false;
      }
      const finalFile = await this.#openExistingFile(this.#path, true);
      try {
        await finalFile.sync();
      } finally {
        await finalFile.close();
      }
      await this.#verifyDirectory(directory);
      await directory.handle?.sync();
      if ((await this.#readCredentialPath(this.#path)) !== plaintext) throw invalidCredential();
      committed = true;
    } finally {
      savingPaths.delete(this.#path);
      await temporaryFile?.close().catch(() => undefined);
      if (!committed && finalCreated) await unlink(this.#path).catch(() => undefined);
      if (!committed && temporaryCreated && temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      await directory?.handle?.close().catch(() => undefined);
    }
  }

  #additionalData(): Buffer {
    return Buffer.from(
      JSON.stringify({
        version: FILE_FORMAT,
        ...AAD_METADATA,
        credentialScope: this.#credentialScope,
      }),
      "utf8",
    );
  }

  async #readCredentialPath(path: string): Promise<string> {
    const file = await this.#openExistingFile(path, false);
    try {
      const stats = await file.stat({ bigint: true });
      if (stats.size < 1n || stats.size > BigInt(MAX_FILE_BYTES)) throw invalidCredential();
      const bytes = await file.readFile();
      const currentStats = await file.stat({ bigint: true });
      if (bytes.length !== Number(stats.size) || !sameArtifact(stats, currentStats)) {
        throw invalidCredential();
      }
      const envelope = parseEnvelope(bytes);
      let key: Buffer | undefined;
      let decoded: Buffer | undefined;
      try {
        key = await deriveKey(this.#localToken, envelope.salt);
        const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(this.#additionalData());
        decipher.setAuthTag(envelope.tag);
        decoded = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
        const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
        parseCentralCredential(plaintext);
        return plaintext;
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

  async #openDirectory(create: boolean): Promise<SecuredDirectory | undefined> {
    if (create) await mkdir(this.#directoryPath, { recursive: true, mode: 0o700 });
    let initialStats: BigIntStats;
    try {
      initialStats = await lstat(this.#directoryPath, { bigint: true });
    } catch (error) {
      if (!create && errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!initialStats.isDirectory()) throw invalidCredential();
    if (this.#platform === "win32") {
      await this.#windowsAccessControl?.secure(this.#directoryPath, "directory");
      const currentStats = await lstat(this.#directoryPath, { bigint: true });
      if (!currentStats.isDirectory() || !sameArtifact(initialStats, currentStats)) {
        throw invalidCredential();
      }
      return { stats: currentStats };
    }
    const handle = await open(
      this.#directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const descriptorStats = await handle.stat({ bigint: true });
      const pathStats = await lstat(this.#directoryPath, { bigint: true });
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

  async #verifyDirectory(directory: SecuredDirectory): Promise<void> {
    const pathStats = await lstat(this.#directoryPath, { bigint: true });
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
    if (this.#platform === "win32") {
      await this.#windowsAccessControl?.secure(this.#directoryPath, "directory");
    } else if (
      (descriptorStats.mode & 0o7777n) !== 0o700n ||
      (typeof process.getuid === "function" && descriptorStats.uid !== BigInt(process.getuid()))
    ) {
      throw invalidCredential();
    }
  }

  async #assertCredentialAbsent(): Promise<void> {
    try {
      await lstat(this.#path, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    throw credentialExists();
  }

  async #openExistingFile(path: string, writable: boolean): Promise<FileHandle> {
    const initialStats = await lstat(path, { bigint: true });
    if (!initialStats.isFile() || initialStats.nlink !== 1n) throw invalidCredential();
    const noFollow = this.#platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const file = await open(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow);
    try {
      await this.#verifyOpenFile(path, file, initialStats, false);
      if (this.#platform === "win32") {
        await this.#windowsAccessControl?.secure(path, "file");
      } else {
        if (typeof process.getuid === "function" && initialStats.uid !== BigInt(process.getuid())) {
          throw invalidCredential();
        }
        await file.chmod(0o600);
      }
      await this.#verifyOpenFile(path, file, initialStats);
      return file;
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  async #verifyOpenFile(
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
      this.#platform !== "win32" &&
      ((descriptorStats.mode & 0o7777n) !== 0o600n ||
        (typeof process.getuid === "function" && descriptorStats.uid !== BigInt(process.getuid())))
    ) {
      throw invalidCredential();
    }
  }
}
