import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { AcpSessionRecord } from "./acp-session-store.js";
import {
  EncryptedFileCredentialStore,
  type EncryptedFileCredentialStoreOptions,
} from "./credential-store.js";

export const LOCAL_CONTROL_PATH = "/_ambassador/control";
const SECRET = /^[a-f0-9]{64}$/u;
const SESSION_ID = /^[\x20-\x7e]{1,512}$/u;
const AGENT_KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const CORRELATION_ID = /^[\x20-\x7e]{1,256}$/u;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_LINES = 4_096;
const MAX_HISTORY_LINE_BYTES = 512 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_SCOPE = '{"kind":"ambassador-local-control-secret","version":1}';
const creations = new Map<string, Promise<string>>();

export interface LocalControlSecretStore {
  load(): Promise<string | undefined>;
  createOrLoad(): Promise<string>;
}

export interface EncryptedFileLocalControlSecretStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAccessControl?: EncryptedFileCredentialStoreOptions["windowsAccessControl"];
  readonly scope?: string;
}

function validateSecret(value: string): void {
  if (!SECRET.test(value)) throw new Error("The local control secret store is invalid");
}

export class EncryptedFileLocalControlSecretStore implements LocalControlSecretStore {
  readonly #path: string;
  readonly #store: EncryptedFileCredentialStore;

  constructor(
    path: string,
    keyPath: string,
    options: EncryptedFileLocalControlSecretStoreOptions = {},
  ) {
    this.#path = resolve(path);
    this.#store = new EncryptedFileCredentialStore(path, keyPath, options.scope ?? DEFAULT_SCOPE, {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.windowsAccessControl === undefined
        ? {}
        : { windowsAccessControl: options.windowsAccessControl }),
      validatePlaintext: validateSecret,
    });
  }

  async load(): Promise<string | undefined> {
    return await this.#store.load();
  }

  async createOrLoad(): Promise<string> {
    const existing = creations.get(this.#path);
    if (existing !== undefined) return await existing;
    const creation = this.#createOrLoad();
    creations.set(this.#path, creation);
    try {
      return await creation;
    } finally {
      creations.delete(this.#path);
    }
  }

  async #createOrLoad(): Promise<string> {
    const stored = await this.#store.load();
    if (stored !== undefined) return stored;
    const created = randomBytes(32).toString("hex");
    await this.#store.save(created);
    return created;
  }
}

export type LocalSessionControlErrorCode =
  | "session_not_found"
  | "agent_unsupported"
  | "operation_failed";

export class LocalSessionControlError extends Error {
  constructor(readonly code: LocalSessionControlErrorCode) {
    super("Local session control failed");
    this.name = "LocalSessionControlError";
  }
}

export interface LocalSessionControl {
  list(): readonly AcpSessionRecord[] | Promise<readonly AcpSessionRecord[]>;
  show(
    sessionId: string,
    verbose: boolean,
    signal: AbortSignal,
  ): readonly string[] | Promise<readonly string[]>;
}

export type LocalControlClientErrorCode =
  | LocalSessionControlErrorCode
  | "unauthorized"
  | "unavailable"
  | "invalid_response";

export class LocalControlClientError extends Error {
  constructor(readonly code: LocalControlClientErrorCode) {
    super("Local control request failed");
    this.name = "LocalControlClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function sessionRecord(value: unknown): AcpSessionRecord {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        "session_id",
        "agent_kind",
        "working_directory",
        "status",
        "created_at_ms",
        "last_used_at_ms",
      ],
      ["central_message_id", "call_id", "retired_at_ms"],
    ) ||
    typeof value.session_id !== "string" ||
    !SESSION_ID.test(value.session_id) ||
    typeof value.agent_kind !== "string" ||
    !AGENT_KIND.test(value.agent_kind) ||
    typeof value.working_directory !== "string" ||
    !isAbsolute(value.working_directory) ||
    value.working_directory.length > 4_096 ||
    (value.status !== "active" && value.status !== "retired") ||
    !Number.isSafeInteger(value.created_at_ms) ||
    Number(value.created_at_ms) < 0 ||
    !Number.isSafeInteger(value.last_used_at_ms) ||
    Number(value.last_used_at_ms) < 0 ||
    Number(value.last_used_at_ms) < Number(value.created_at_ms) ||
    (value.central_message_id !== undefined &&
      (typeof value.central_message_id !== "string" ||
        !CORRELATION_ID.test(value.central_message_id))) ||
    (value.call_id !== undefined &&
      (typeof value.call_id !== "string" || !CORRELATION_ID.test(value.call_id))) ||
    (value.status === "active" && value.retired_at_ms !== undefined) ||
    (value.status === "retired" &&
      (value.retired_at_ms === undefined ||
        !Number.isSafeInteger(value.retired_at_ms) ||
        Number(value.retired_at_ms) < Number(value.created_at_ms)))
  ) {
    throw new LocalControlClientError("invalid_response");
  }
  return value as unknown as AcpSessionRecord;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalControlClientError("invalid_response");
  }
  if (response.body === null) throw new LocalControlClientError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new LocalControlClientError("invalid_response");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new LocalControlClientError("invalid_response");
  }
}

function controlUrl(mcpEndpoint: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(mcpEndpoint);
  } catch {
    throw new LocalControlClientError("unavailable");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/mcp" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new LocalControlClientError("unavailable");
  }
  endpoint.pathname = LOCAL_CONTROL_PATH;
  return endpoint;
}

export class LocalControlClient {
  readonly #url: URL;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(mcpEndpoint: string, secret: string, fetchImplementation: typeof fetch = fetch) {
    validateSecret(secret);
    this.#url = controlUrl(mcpEndpoint);
    this.#secret = secret;
    this.#fetch = fetchImplementation;
  }

  async listSessions(signal?: AbortSignal): Promise<readonly AcpSessionRecord[]> {
    const result = await this.#request({ operation: "sessions.list" }, signal);
    if (!isRecord(result) || !exactKeys(result, ["sessions"]) || !Array.isArray(result.sessions)) {
      throw new LocalControlClientError("invalid_response");
    }
    return result.sessions.map(sessionRecord);
  }

  async showSession(
    sessionId: string,
    verbose: boolean,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    if (!SESSION_ID.test(sessionId)) throw new LocalControlClientError("operation_failed");
    const result = await this.#request(
      { operation: "sessions.show", session_id: sessionId, verbose },
      signal,
    );
    if (
      !isRecord(result) ||
      !exactKeys(result, ["lines"]) ||
      !Array.isArray(result.lines) ||
      result.lines.length > MAX_HISTORY_LINES ||
      !result.lines.every(
        (line) =>
          typeof line === "string" && Buffer.byteLength(line, "utf8") <= MAX_HISTORY_LINE_BYTES,
      )
    ) {
      throw new LocalControlClientError("invalid_response");
    }
    return result.lines as string[];
  }

  async #request(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const requestSignal = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(DEFAULT_DEADLINE_MS),
    ]);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: requestSignal,
      });
    } catch {
      throw new LocalControlClientError("unavailable");
    }
    const result = await readBoundedJson(response);
    if (!response.ok) {
      if (
        isRecord(result) &&
        exactKeys(result, ["error"]) &&
        typeof result.error === "string" &&
        ["session_not_found", "agent_unsupported", "operation_failed", "unauthorized"].includes(
          result.error,
        )
      ) {
        throw new LocalControlClientError(result.error as LocalControlClientErrorCode);
      }
      throw new LocalControlClientError("invalid_response");
    }
    return result;
  }
}
