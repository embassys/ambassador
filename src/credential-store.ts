import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { parseCentralCredential } from "./central-credential.js";
import {
  secureWindowsArtifact,
  type WindowsAccessControl,
  type WindowsArtifactKind,
} from "./windows-access-control.js";

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
const STATE_KEY_BYTES = 24;
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

export type CredentialArtifactKind = WindowsArtifactKind;

export type WindowsCredentialAccessControl = WindowsAccessControl;

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

function deriveKey(stateKey: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(
      stateKey,
      salt,
      KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error === null ? resolveKey(key) : reject(error)),
    );
  });
}

class BuiltInWindowsCredentialAccessControl implements WindowsCredentialAccessControl {
  async secure(path: string, kind: CredentialArtifactKind): Promise<void> {
    await secureWindowsArtifact(path, kind);
  }
}

export class EncryptedFileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #keyPath: string;
  readonly #directoryPath: string;
  readonly #credentialScope: string;
  readonly #platform: NodeJS.Platform;
  readonly #windowsAccessControl?: WindowsCredentialAccessControl;

  constructor(
    path: string,
    keyPath: string,
    credentialScope: string,
    options: EncryptedFileCredentialStoreOptions = {},
  ) {
    if (typeof credentialScope !== "string" || credentialScope.length < 1) {
      throw new Error("The credential scope is invalid");
    }
    this.#path = resolve(path);
    this.#keyPath = resolve(keyPath);
    this.#directoryPath = dirname(this.#path);
    if (this.#keyPath === this.#path || dirname(this.#keyPath) !== this.#directoryPath) {
      throw new Error("The credential key path is invalid");
    }
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
      const stateKey = await this.#loadOrCreateStateKey(directory);
      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      let key: Buffer | undefined;
      let ciphertext: Buffer;
      let tag: Buffer;
      try {
        key = await deriveKey(stateKey, salt);
        const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(this.#additionalData());
        ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        tag = cipher.getAuthTag();
      } finally {
        key?.fill(0);
        stateKey.fill(0);
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
      let stateKey: Buffer;
      try {
        stateKey = await this.#readStateKeyPath(this.#keyPath);
      } catch {
        throw invalidCredential();
      }
      let key: Buffer | undefined;
      let decoded: Buffer | undefined;
      try {
        key = await deriveKey(stateKey, envelope.salt);
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
        stateKey.fill(0);
        decoded?.fill(0);
      }
    } finally {
      await file.close();
    }
  }

  async #readStateKeyPath(path: string): Promise<Buffer> {
    const file = await this.#openExistingFile(path, false);
    try {
      const stats = await file.stat({ bigint: true });
      if (stats.size !== BigInt(STATE_KEY_BYTES)) throw invalidCredential();
      const bytes = await file.readFile();
      const currentStats = await file.stat({ bigint: true });
      if (bytes.length !== STATE_KEY_BYTES || !sameArtifact(stats, currentStats)) {
        throw invalidCredential();
      }
      return bytes;
    } finally {
      await file.close();
    }
  }

  async #loadOrCreateStateKey(directory: SecuredDirectory): Promise<Buffer> {
    try {
      return await this.#readStateKeyPath(this.#keyPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const stateKey = randomBytes(STATE_KEY_BYTES);
    const temporaryPath = `${this.#keyPath}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
    let temporaryFile: FileHandle | undefined;
    let temporaryCreated = false;
    let finalCreated = false;
    let committed = false;
    try {
      await this.#verifyDirectory(directory);
      await this.#assertPathAbsent(this.#keyPath);
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
      await temporaryFile.writeFile(stateKey);
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = undefined;
      const verified = await this.#readStateKeyPath(temporaryPath);
      verified.fill(0);
      await this.#verifyDirectory(directory);
      await this.#assertPathAbsent(this.#keyPath);
      if (this.#platform === "win32") {
        await rename(temporaryPath, this.#keyPath);
        temporaryCreated = false;
        finalCreated = true;
      } else {
        await link(temporaryPath, this.#keyPath);
        finalCreated = true;
        await unlink(temporaryPath);
        temporaryCreated = false;
      }
      const finalFile = await this.#openExistingFile(this.#keyPath, true);
      try {
        await finalFile.sync();
      } finally {
        await finalFile.close();
      }
      await this.#verifyDirectory(directory);
      await directory.handle?.sync();
      const result = await this.#readStateKeyPath(this.#keyPath);
      committed = true;
      return result;
    } finally {
      stateKey.fill(0);
      await temporaryFile?.close().catch(() => undefined);
      if (!committed && finalCreated) await unlink(this.#keyPath).catch(() => undefined);
      if (!committed && temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
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
    await this.#assertPathAbsent(this.#path, credentialExists());
  }

  async #assertPathAbsent(path: string, existsError = invalidCredential()): Promise<void> {
    try {
      await lstat(path, { bigint: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    throw existsError;
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
