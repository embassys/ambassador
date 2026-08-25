import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";

const FILE_VERSION = 1;
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
  version: FILE_VERSION,
  kdf: "scrypt",
  n: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  cipher: "aes-256-gcm",
} as const;
const savingPaths = new Set<string>();

interface CredentialEnvelope {
  version: typeof FILE_VERSION;
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

export type CredentialArtifactKind = "directory" | "file";

export interface WindowsCredentialAccessControl {
  secure(path: string, kind: CredentialArtifactKind): Promise<void>;
}

export interface EncryptedFileCredentialStoreOptions {
  platform?: NodeJS.Platform;
  windowsAccessControl?: WindowsCredentialAccessControl;
}

interface SecuredDirectory {
  stats: BigIntStats;
  handle?: FileHandle;
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
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) throw invalidCredential();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw invalidCredential();
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) throw invalidCredential();
  return decoded;
}

function parseEnvelope(bytes: Buffer): {
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
    value.version !== FILE_VERSION ||
    value.kdf !== "scrypt" ||
    value.n !== SCRYPT_N ||
    value.r !== SCRYPT_R ||
    value.p !== SCRYPT_P ||
    value.cipher !== "aes-256-gcm"
  ) {
    throw invalidCredential();
  }
  const ciphertext = decodeBase64(value.ciphertext);
  if (ciphertext.length === 0 || ciphertext.length > MAX_JWT_BYTES) throw invalidCredential();
  return {
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

function assertSid(value: string): string {
  if (!/^S-1-(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*)){1,15}$/.test(value)) {
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
        if (error || stderr.length !== 0) {
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
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne $expected.Count) { exit 45 }
foreach ($rule in $rules) {
  if ($expected -notcontains $rule.IdentityReference.Value) { exit 46 }
  if ($rule.IsInherited) { exit 47 }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    exit 48
  }
  if ([int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl) {
    exit 49
  }
  if ($rule.InheritanceFlags -ne $inheritance) { exit 50 }
  if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
    exit 51
  }
}
[Console]::Out.Write('A2A_ACL_OK')
`;

class BuiltInWindowsCredentialAccessControl implements WindowsCredentialAccessControl {
  private userSid?: Promise<string>;

  async secure(path: string, kind: CredentialArtifactKind): Promise<void> {
    this.userSid ??= this.readUserSid();
    const sid = await this.userSid;
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

  private async readUserSid(): Promise<string> {
    const output = await runExecutable("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const match = /^(?:"(?:[^"]|"")*"),"([^"]+)"\r?\n?$/.exec(output);
    if (match?.[1] === undefined) throw new Error("Current Windows identity is unavailable");
    return assertSid(match[1]);
  }
}

export class EncryptedFileCredentialStore implements CredentialStore {
  private readonly path: string;
  private readonly directoryPath: string;
  private readonly hookToken: Buffer;
  private readonly additionalData: Buffer;
  private readonly platform: NodeJS.Platform;
  private readonly windowsAccessControl?: WindowsCredentialAccessControl;
  private saved = false;

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
    this.additionalData = Buffer.from(JSON.stringify({ ...AAD_METADATA, credentialScope }), "utf8");
    this.platform = options.platform ?? process.platform;
    if (this.platform === "win32") {
      this.windowsAccessControl =
        options.windowsAccessControl ?? new BuiltInWindowsCredentialAccessControl();
    }
  }

  async load(): Promise<string | undefined> {
    const directory = await this.openDirectory(false);
    if (directory === undefined) return undefined;
    try {
      let file: FileHandle | undefined;
      try {
        file = await this.openExistingFile(this.path, false);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          await this.verifyDirectory(directory);
          return undefined;
        }
        throw error;
      }

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
        let plaintext: Buffer | undefined;
        try {
          key = await deriveKey(this.hookToken, envelope.salt);
          const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv, {
            authTagLength: TAG_BYTES,
          });
          decipher.setAAD(this.additionalData);
          decipher.setAuthTag(envelope.tag);
          plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
          const jwt = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
          if (jwt.length === 0) throw invalidCredential();
          return jwt;
        } catch {
          throw invalidCredential();
        } finally {
          key?.fill(0);
          plaintext?.fill(0);
        }
      } finally {
        await file.close();
      }
    } finally {
      await directory.handle?.close();
    }
  }

  async save(jwt: string): Promise<void> {
    if (typeof jwt !== "string" || jwt.length === 0 || Buffer.byteLength(jwt) > MAX_JWT_BYTES) {
      throw new Error("The central credential is invalid");
    }
    if (this.saved || savingPaths.has(this.path)) throw credentialExists();
    savingPaths.add(this.path);
    let directory: SecuredDirectory | undefined;
    let temporaryPath: string | undefined;
    let temporaryFile: FileHandle | undefined;
    let temporaryCreated = false;
    let published = false;

    try {
      directory = await this.openDirectory(true);
      if (directory === undefined) throw new Error("The credential directory is unavailable");
      await this.assertCredentialAbsent();

      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      let key: Buffer | undefined;
      let ciphertext: Buffer;
      let tag: Buffer;
      try {
        key = await deriveKey(this.hookToken, salt);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(this.additionalData);
        ciphertext = Buffer.concat([cipher.update(jwt, "utf8"), cipher.final()]);
        tag = cipher.getAuthTag();
      } finally {
        key?.fill(0);
      }
      const envelope: CredentialEnvelope = {
        version: FILE_VERSION,
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
      await this.assertCredentialAbsent();
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

      await this.verifyDirectory(directory);
      await this.assertCredentialAbsent();
      if (this.platform === "win32") {
        await rename(temporaryPath, this.path);
      } else {
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

      const finalFile = await this.openExistingFile(this.path, true);
      try {
        await finalFile.sync();
      } finally {
        await finalFile.close();
      }
      await this.verifyDirectory(directory);
      if (directory.handle !== undefined) await directory.handle.sync();
      this.saved = true;
    } finally {
      savingPaths.delete(this.path);
      if (temporaryFile !== undefined) await temporaryFile.close().catch(() => undefined);
      if (!published && temporaryCreated && temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      await directory?.handle?.close().catch(() => undefined);
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
