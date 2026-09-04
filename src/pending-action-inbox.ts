import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

import Database from "better-sqlite3";

import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields, isCentralRecord } from "./central-json.js";
import type { CentralMessage } from "./central-rest.js";
import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_PENDING_ACTIONS = 256;
const MAX_TOTAL_CIPHERTEXT_BYTES = 480 * 1024;
const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTION_NAME = /^[A-Za-z0-9._~-]{1,128}$/u;
const RECORD_KEY = /^[A-Za-z0-9_-]{43}$/u;
const TABLE_SQL = `
  CREATE TABLE pending_action_calls (
    record_key TEXT PRIMARY KEY CHECK (
      length(record_key) = 43
      AND record_key NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    iv BLOB NOT NULL CHECK (length(iv) = 12),
    tag BLOB NOT NULL CHECK (length(tag) = 16),
    ciphertext BLOB NOT NULL CHECK (
      length(ciphertext) BETWEEN 1 AND ${MAX_TOTAL_CIPHERTEXT_BYTES}
    )
  ) STRICT
`;
const ENCRYPTION_KEY_INFO = Buffer.from(
  JSON.stringify({ kind: "ambassador-pending-action-encryption", version: SCHEMA_VERSION }),
  "utf8",
);
const LOOKUP_KEY_INFO = Buffer.from(
  JSON.stringify({ kind: "ambassador-pending-action-lookup", version: SCHEMA_VERSION }),
  "utf8",
);

export interface PendingActionCall {
  readonly call_id: string;
  readonly sender_agent_id: string;
  readonly action_type: string;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

interface PendingActionRow {
  readonly record_key: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

interface InboxResources {
  readonly database: Database.Database;
  readonly encryptionKey: Buffer;
  readonly lookupKey: Buffer;
}

const inboxResources = new WeakMap<object, InboxResources>();

export class PendingActionInboxError extends Error {
  constructor() {
    super("The pending action inbox is invalid");
    this.name = "PendingActionInboxError";
  }
}

function invalidInbox(): PendingActionInboxError {
  return new PendingActionInboxError();
}

function safeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidInbox();
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInbox();
  }
  return value;
}

function normalizedSql(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function initialize(database: Database.Database): void {
  database
    .transaction(() => {
      const version = safeInteger(database.pragma("user_version", { simple: true }));
      if (version > SCHEMA_VERSION) throw invalidInbox();
      if (version === 0) {
        const row = database
          .prepare<[], { count: bigint }>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .get();
        if (row === undefined || safeInteger(row.count) !== 0) throw invalidInbox();
        database.exec(`${TABLE_SQL};`);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
      const rows = database
        .prepare<[], { name: string; sql: string | null }>(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (
        rows.length !== 1 ||
        rows[0]?.name !== "pending_action_calls" ||
        rows[0].sql === null ||
        normalizedSql(rows[0].sql) !== normalizedSql(TABLE_SQL)
      ) {
        throw invalidInbox();
      }
    })
    .immediate();
}

function deriveKeys(credential: LoadedCentralCredential): {
  readonly encryptionKey: Buffer;
  readonly lookupKey: Buffer;
} {
  let keyMaterial: Buffer | undefined;
  try {
    const exported = credential.privateKey.export({ format: "der", type: "pkcs8" });
    if (!Buffer.isBuffer(exported) || exported.length < 1) throw invalidInbox();
    keyMaterial = exported;
    const salt = Buffer.from(credential.keyThumbprint, "ascii");
    return {
      encryptionKey: Buffer.from(
        hkdfSync("sha256", keyMaterial, salt, ENCRYPTION_KEY_INFO, KEY_BYTES),
      ),
      lookupKey: Buffer.from(hkdfSync("sha256", keyMaterial, salt, LOOKUP_KEY_INFO, KEY_BYTES)),
    };
  } catch {
    throw invalidInbox();
  } finally {
    keyMaterial?.fill(0);
  }
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const names = Object.keys(value).sort();
  const expected = [...required].sort();
  return names.length === expected.length && expected.every((name, index) => names[index] === name);
}

function pendingActionFromMessage(message: CentralMessage): PendingActionCall | undefined {
  if (message.payload.type !== "action_call") return undefined;
  if (
    !exactKeys(message.payload, ["type", "call_id", "action_type", "payload"]) ||
    typeof message.payload.call_id !== "string" ||
    !CALL_ID.test(message.payload.call_id) ||
    typeof message.payload.action_type !== "string" ||
    !ACTION_NAME.test(message.payload.action_type) ||
    !isCentralRecord(message.payload.payload) ||
    typeof message.sender_agent_id !== "string" ||
    message.sender_agent_id.length < 1 ||
    message.sender_agent_id.length > 256 ||
    typeof message.created_at !== "string" ||
    message.created_at.length < 1 ||
    message.created_at.length > 128
  ) {
    throw invalidInbox();
  }
  try {
    assertNoCentralCredentialFields(message.payload.payload);
  } catch {
    throw invalidInbox();
  }
  return {
    call_id: message.payload.call_id,
    sender_agent_id: message.sender_agent_id,
    action_type: message.payload.action_type,
    payload: message.payload.payload,
    created_at: message.created_at,
  };
}

function parsePendingAction(plaintext: Buffer): PendingActionCall {
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw invalidInbox();
  }
  if (
    !isCentralRecord(value) ||
    !exactKeys(value, ["call_id", "sender_agent_id", "action_type", "payload", "created_at"])
  ) {
    throw invalidInbox();
  }
  return pendingActionFromMessage({
    sender_agent_id: value.sender_agent_id as string,
    payload: {
      type: "action_call",
      call_id: value.call_id,
      action_type: value.action_type,
      payload: value.payload,
    },
    created_at: value.created_at as string,
  }) as PendingActionCall;
}

function resourcesFor(inbox: object): InboxResources {
  const resources = inboxResources.get(inbox);
  if (resources === undefined) throw invalidInbox();
  return resources;
}

function recordKey(key: Buffer, callId: string): string {
  if (!CALL_ID.test(callId)) throw invalidInbox();
  return createHmac("sha256", key).update(callId, "ascii").digest("base64url");
}

function additionalData(key: string): Buffer {
  if (!RECORD_KEY.test(key)) throw invalidInbox();
  return Buffer.from(
    JSON.stringify({ kind: "ambassador-pending-action", version: SCHEMA_VERSION, recordKey: key }),
    "utf8",
  );
}

function encrypt(key: Buffer, recordKeyValue: string, plaintext: Buffer): PendingActionRow {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(recordKeyValue));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { record_key: recordKeyValue, iv, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(
  encryptionKey: Buffer,
  lookupKey: Buffer,
  row: PendingActionRow,
): PendingActionCall {
  if (
    !RECORD_KEY.test(row.record_key) ||
    !Buffer.isBuffer(row.iv) ||
    row.iv.length !== IV_BYTES ||
    !Buffer.isBuffer(row.tag) ||
    row.tag.length !== TAG_BYTES ||
    !Buffer.isBuffer(row.ciphertext) ||
    row.ciphertext.length < 1 ||
    row.ciphertext.length > MAX_TOTAL_CIPHERTEXT_BYTES
  ) {
    throw invalidInbox();
  }
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, row.iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(row.record_key));
    decipher.setAuthTag(row.tag);
    plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    const result = parsePendingAction(plaintext);
    if (recordKey(lookupKey, result.call_id) !== row.record_key) throw invalidInbox();
    return result;
  } catch {
    throw invalidInbox();
  } finally {
    plaintext?.fill(0);
  }
}

export class PendingActionInbox {
  constructor(path: string, credential: LoadedCentralCredential) {
    const artifact = preparePrivateSqliteArtifact(path, invalidInbox);
    let database: Database.Database | undefined;
    let keys: { readonly encryptionKey: Buffer; readonly lookupKey: Buffer } | undefined;
    try {
      keys = deriveKeys(credential);
      database = new Database(path, { timeout: BUSY_TIMEOUT_MS });
      artifact.validate();
      artifact.releaseFile();
      database.defaultSafeIntegers(true);
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      database.pragma("trusted_schema = OFF");
      initialize(database);
      artifact.validateDirectory();
      inboxResources.set(this, { database, ...keys });
      this.list();
    } catch (error) {
      inboxResources.delete(this);
      database?.close();
      keys?.encryptionKey.fill(0);
      keys?.lookupKey.fill(0);
      throw error;
    } finally {
      artifact.close();
    }
  }

  capture(message: CentralMessage): boolean {
    const action = pendingActionFromMessage(message);
    if (action === undefined) return false;
    const resources = resourcesFor(this);
    const lookup = recordKey(resources.lookupKey, action.call_id);
    const existing = resources.database
      .prepare<[string], PendingActionRow>(
        "SELECT record_key, iv, tag, ciphertext FROM pending_action_calls WHERE record_key = ?",
      )
      .get(lookup);
    const serialized = Buffer.from(JSON.stringify(action), "utf8");
    try {
      if (serialized.length < 1 || serialized.length > MAX_TOTAL_CIPHERTEXT_BYTES) {
        throw invalidInbox();
      }
      if (existing !== undefined) {
        if (
          JSON.stringify(decrypt(resources.encryptionKey, resources.lookupKey, existing)) !==
          serialized.toString("utf8")
        ) {
          throw invalidInbox();
        }
        return false;
      }
      const totals = resources.database
        .prepare<[], { count: bigint; bytes: bigint }>(
          "SELECT count(*) AS count, coalesce(sum(length(ciphertext)), 0) AS bytes FROM pending_action_calls",
        )
        .get();
      if (
        totals === undefined ||
        safeInteger(totals.count) >= MAX_PENDING_ACTIONS ||
        safeInteger(totals.bytes) + serialized.length > MAX_TOTAL_CIPHERTEXT_BYTES
      ) {
        throw invalidInbox();
      }
      const encrypted = encrypt(resources.encryptionKey, lookup, serialized);
      const changes = safeInteger(
        resources.database
          .prepare(
            "INSERT INTO pending_action_calls (record_key, iv, tag, ciphertext) VALUES (?, ?, ?, ?)",
          )
          .run(encrypted.record_key, encrypted.iv, encrypted.tag, encrypted.ciphertext).changes,
      );
      if (changes !== 1) throw invalidInbox();
      return true;
    } finally {
      serialized.fill(0);
    }
  }

  list(): PendingActionCall[] {
    const resources = resourcesFor(this);
    const rows = resources.database
      .prepare<[], PendingActionRow>(
        "SELECT record_key, iv, tag, ciphertext FROM pending_action_calls ORDER BY record_key",
      )
      .all();
    if (rows.length > MAX_PENDING_ACTIONS) throw invalidInbox();
    return rows
      .map((row) => decrypt(resources.encryptionKey, resources.lookupKey, row))
      .sort((left, right) =>
        left.created_at === right.created_at
          ? left.call_id.localeCompare(right.call_id)
          : left.created_at.localeCompare(right.created_at),
      );
  }

  remove(callId: string): boolean {
    const resources = resourcesFor(this);
    const changes = safeInteger(
      resources.database
        .prepare("DELETE FROM pending_action_calls WHERE record_key = ?")
        .run(recordKey(resources.lookupKey, callId)).changes,
    );
    if (changes > 1) throw invalidInbox();
    return changes === 1;
  }

  close(): void {
    const resources = resourcesFor(this);
    if (resources.database.open) resources.database.close();
    resources.encryptionKey.fill(0);
    resources.lookupKey.fill(0);
    inboxResources.delete(this);
  }
}
