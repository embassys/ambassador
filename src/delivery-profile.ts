import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type AgentCapability,
  capabilityForKind,
  type DeliveryMode,
} from "./agent-capabilities.js";
import { secureWindowsArtifact, type WindowsAccessControl } from "./windows-access-control.js";

export type DeliveryProfileErrorCode =
  | "incompatible_profile"
  | "invalid_profile"
  | "profile_conflict"
  | "profile_store_failed";

export class DeliveryProfileError extends Error {
  constructor(readonly code: DeliveryProfileErrorCode) {
    super("Delivery profile operation failed");
    this.name = "DeliveryProfileError";
  }
}

export interface DirectDeliveryInput {
  readonly mode: "direct";
}

export interface WebhookDeliveryInput {
  readonly mode: "webhook";
  readonly url?: string;
}

export type DeliveryInput = DirectDeliveryInput | WebhookDeliveryInput;

export interface DirectDeliveryProfile {
  readonly version: 1;
  readonly mode: "direct";
  readonly agent_kind: string;
  readonly working_directory: string;
}

export interface WebhookDeliveryProfile {
  readonly version: 1;
  readonly mode: "webhook";
  readonly agent_kind: string;
  readonly url: string;
}

export type DeliveryProfile = DirectDeliveryProfile | WebhookDeliveryProfile;

export interface DeliveryProfileStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAccessControl?: WindowsAccessControl;
}

const PROFILE_MAX_BYTES = 8 * 1024;

function failure(code: DeliveryProfileErrorCode): DeliveryProfileError {
  return new DeliveryProfileError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const allowed = new Set(required);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function canonicalWebhookUrl(value: string): string {
  if (
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw failure("invalid_profile");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw failure("invalid_profile");
  }
  const literalLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && literalLoopback)) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw failure("invalid_profile");
  }
  return parsed.href;
}

function parseProfile(value: unknown): DeliveryProfile {
  if (!isRecord(value) || value.version !== 1 || typeof value.agent_kind !== "string") {
    throw failure("invalid_profile");
  }
  if (
    value.mode === "direct" &&
    exactKeys(value, ["version", "mode", "agent_kind", "working_directory"]) &&
    typeof value.working_directory === "string" &&
    value.working_directory.length > 0 &&
    value.working_directory.length <= 4_096
  ) {
    return {
      version: 1,
      mode: "direct",
      agent_kind: value.agent_kind,
      working_directory: value.working_directory,
    };
  }
  if (
    value.mode === "webhook" &&
    exactKeys(value, ["version", "mode", "agent_kind", "url"]) &&
    typeof value.url === "string"
  ) {
    const url = canonicalWebhookUrl(value.url);
    if (url !== value.url) throw failure("invalid_profile");
    return {
      version: 1,
      mode: "webhook",
      agent_kind: value.agent_kind,
      url,
    };
  }
  throw failure("invalid_profile");
}

export async function createDeliveryProfile(
  capability: AgentCapability,
  delivery: DeliveryInput,
  workingDirectory: string,
): Promise<DeliveryProfile> {
  if (!capability.enabled || !capability.modes.includes(delivery.mode)) {
    throw failure("incompatible_profile");
  }
  if (delivery.mode === "direct") {
    if (capability.direct === undefined) throw failure("incompatible_profile");
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(workingDirectory);
    } catch {
      throw failure("invalid_profile");
    }
    return {
      version: 1,
      mode: "direct",
      agent_kind: capability.kind,
      working_directory: canonicalDirectory,
    };
  }
  if (delivery.url === undefined) throw failure("invalid_profile");
  return {
    version: 1,
    mode: "webhook",
    agent_kind: capability.kind,
    url: canonicalWebhookUrl(delivery.url),
  };
}

export async function validateStoredDeliveryProfile(
  profile: DeliveryProfile,
  workingDirectory: string,
): Promise<{ readonly profile: DeliveryProfile; readonly capability: AgentCapability }> {
  const parsed = parseProfile(profile);
  const capability = capabilityForKind(parsed.agent_kind);
  if (capability === undefined || !capability.modes.includes(parsed.mode)) {
    throw failure("incompatible_profile");
  }
  if (parsed.mode === "direct") {
    if (capability.direct === undefined) throw failure("incompatible_profile");
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(workingDirectory);
    } catch {
      throw failure("incompatible_profile");
    }
    if (canonicalDirectory !== parsed.working_directory) throw failure("incompatible_profile");
  }
  return { profile: parsed, capability };
}

export class DeliveryProfileStore {
  readonly #platform: NodeJS.Platform;
  readonly #windowsAccessControl?: WindowsAccessControl;

  constructor(
    readonly path: string,
    options: DeliveryProfileStoreOptions = {},
  ) {
    this.#platform = options.platform ?? process.platform;
    if (this.#platform === "win32") {
      this.#windowsAccessControl = options.windowsAccessControl ?? {
        secure: secureWindowsArtifact,
      };
    }
  }

  async load(): Promise<DeliveryProfile | undefined> {
    if (!(await this.#safeExistingFile(this.path))) return undefined;
    try {
      const bytes = await readFile(this.path);
      if (bytes.byteLength > PROFILE_MAX_BYTES) throw failure("invalid_profile");
      return parseProfile(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      if (error instanceof DeliveryProfileError) throw error;
      throw failure("invalid_profile");
    }
  }

  async save(profile: DeliveryProfile): Promise<void> {
    const parsed = parseProfile(profile);
    const existing = await this.load();
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return;
      throw failure("profile_conflict");
    }

    const directory = dirname(this.path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStatus = await lstat(directory);
      if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
        throw failure("profile_store_failed");
      }
      if (this.#platform === "win32") {
        await this.#windowsAccessControl?.secure(directory, "directory");
      } else {
        await chmod(directory, 0o700);
      }
    } catch (error) {
      if (error instanceof DeliveryProfileError) throw error;
      throw failure("profile_store_failed");
    }

    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const noFollow = this.#platform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      );
      if (this.#platform === "win32") {
        await this.#windowsAccessControl?.secure(temporaryPath, "file");
      } else {
        await handle.chmod(0o600);
      }
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporaryPath, this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await unlink(temporaryPath).catch(() => undefined);
        const committed = await this.load();
        if (committed !== undefined && JSON.stringify(committed) === JSON.stringify(parsed)) return;
        throw failure("profile_conflict");
      }
      await unlink(temporaryPath);
      if (this.#platform !== "win32") await chmod(this.path, 0o600);
      await this.#safeExistingFile(this.path);
      if (this.#platform !== "win32") {
        const directoryHandle = await open(directory, constants.O_RDONLY);
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof DeliveryProfileError) throw error;
      throw failure("profile_store_failed");
    }
  }

  async #safeExistingFile(path: string): Promise<boolean> {
    try {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
        throw failure("profile_store_failed");
      }
      if (this.#platform === "win32") {
        await this.#windowsAccessControl?.secure(path, "file");
      } else if ((status.mode & 0o077) !== 0) {
        throw failure("profile_store_failed");
      }
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.dev !== status.dev ||
        current.ino !== status.ino
      ) {
        throw failure("profile_store_failed");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof DeliveryProfileError) throw error;
      throw failure("profile_store_failed");
    }
  }
}

export function deliveryMode(profile: DeliveryProfile): DeliveryMode {
  return profile.mode;
}
