import { isAbsolute } from "node:path";

import Database from "better-sqlite3";

import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const MAX_SESSIONS = 1_024;
const SESSION_ID = /^[\x20-\x7e]{1,512}$/u;
const AGENT_KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const CORRELATION_ID = /^[\x20-\x7e]{1,256}$/u;
const TABLE_SQL = `
  CREATE TABLE acp_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 512),
    agent_kind TEXT NOT NULL CHECK (length(agent_kind) BETWEEN 1 AND 64),
    working_directory TEXT NOT NULL CHECK (length(working_directory) BETWEEN 1 AND 4096),
    central_message_id TEXT,
    call_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= created_at_ms),
    retired_at_ms INTEGER,
    CHECK (
      (status = 'active' AND retired_at_ms IS NULL)
      OR (status = 'retired' AND retired_at_ms >= created_at_ms)
    )
  ) STRICT
`;
const MESSAGE_INDEX_SQL =
  "CREATE UNIQUE INDEX acp_sessions_central_message_id ON acp_sessions (central_message_id)";
const CALL_INDEX_SQL = "CREATE UNIQUE INDEX acp_sessions_call_id ON acp_sessions (call_id)";

export type AcpSessionStatus = "active" | "retired";

export interface AcpSessionRecord {
  readonly session_id: string;
  readonly agent_kind: string;
  readonly working_directory: string;
  readonly central_message_id?: string;
  readonly call_id?: string;
  readonly status: AcpSessionStatus;
  readonly created_at_ms: number;
  readonly last_used_at_ms: number;
  readonly retired_at_ms?: number;
}

interface SessionRow {
  readonly session_id: string;
  readonly agent_kind: string;
  readonly working_directory: string;
  readonly central_message_id: string | null;
  readonly call_id: string | null;
  readonly status: string;
  readonly created_at_ms: bigint;
  readonly last_used_at_ms: bigint;
  readonly retired_at_ms: bigint | null;
}

interface SessionResources {
  readonly database: Database.Database;
}

const resources = new WeakMap<object, SessionResources>();

export class AcpSessionStoreError extends Error {
  constructor() {
    super("The ACP session store is invalid");
    this.name = "AcpSessionStoreError";
  }
}

function invalidStore(): AcpSessionStoreError {
  return new AcpSessionStoreError();
}

function safeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidStore();
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidStore();
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
      if (version > SCHEMA_VERSION) throw invalidStore();
      if (version === 0) {
        const row = database
          .prepare<[], { count: bigint }>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .get();
        if (row === undefined || safeInteger(row.count) !== 0) throw invalidStore();
        database.exec(`${TABLE_SQL}; ${MESSAGE_INDEX_SQL}; ${CALL_INDEX_SQL};`);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
      const rows = database
        .prepare<[], { name: string; sql: string | null }>(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (
        rows.length !== 3 ||
        rows[0]?.name !== "acp_sessions" ||
        rows[0].sql === null ||
        normalizedSql(rows[0].sql) !== normalizedSql(TABLE_SQL) ||
        rows[1]?.name !== "acp_sessions_call_id" ||
        rows[1].sql === null ||
        normalizedSql(rows[1].sql) !== normalizedSql(CALL_INDEX_SQL) ||
        rows[2]?.name !== "acp_sessions_central_message_id" ||
        rows[2].sql === null ||
        normalizedSql(rows[2].sql) !== normalizedSql(MESSAGE_INDEX_SQL)
      ) {
        throw invalidStore();
      }
    })
    .immediate();
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRecord(value: AcpSessionRecord): AcpSessionRecord {
  if (
    !SESSION_ID.test(value.session_id) ||
    !AGENT_KIND.test(value.agent_kind) ||
    !isAbsolute(value.working_directory) ||
    value.working_directory.length > 4_096 ||
    (value.central_message_id !== undefined && !CORRELATION_ID.test(value.central_message_id)) ||
    (value.call_id !== undefined && !CORRELATION_ID.test(value.call_id)) ||
    !validTime(value.created_at_ms) ||
    !validTime(value.last_used_at_ms) ||
    value.last_used_at_ms < value.created_at_ms ||
    (value.status === "active" && value.retired_at_ms !== undefined) ||
    (value.status === "retired" &&
      (value.retired_at_ms === undefined ||
        !validTime(value.retired_at_ms) ||
        value.retired_at_ms < value.created_at_ms))
  ) {
    throw invalidStore();
  }
  return value;
}

function fromRow(row: SessionRow): AcpSessionRecord {
  if (row.status !== "active" && row.status !== "retired") throw invalidStore();
  return validateRecord({
    session_id: row.session_id,
    agent_kind: row.agent_kind,
    working_directory: row.working_directory,
    ...(row.central_message_id === null ? {} : { central_message_id: row.central_message_id }),
    ...(row.call_id === null ? {} : { call_id: row.call_id }),
    status: row.status,
    created_at_ms: safeInteger(row.created_at_ms),
    last_used_at_ms: safeInteger(row.last_used_at_ms),
    ...(row.retired_at_ms === null ? {} : { retired_at_ms: safeInteger(row.retired_at_ms) }),
  });
}

function databaseFor(store: object): Database.Database {
  const value = resources.get(store)?.database;
  if (value === undefined) throw invalidStore();
  return value;
}

export class AcpSessionStore {
  constructor(path: string) {
    const artifact = preparePrivateSqliteArtifact(path, invalidStore);
    let database: Database.Database | undefined;
    try {
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
      resources.set(this, { database });
      this.list();
    } catch (error) {
      resources.delete(this);
      database?.close();
      throw error;
    } finally {
      artifact.close();
    }
  }

  create(record: AcpSessionRecord): void {
    const value = validateRecord(record);
    if (value.status !== "active") throw invalidStore();
    const database = databaseFor(this);
    const count = database
      .prepare<[], { count: bigint }>("SELECT count(*) AS count FROM acp_sessions")
      .get();
    if (count === undefined || safeInteger(count.count) >= MAX_SESSIONS) throw invalidStore();
    const changes = safeInteger(
      database
        .prepare(
          `INSERT INTO acp_sessions (
            session_id, agent_kind, working_directory, central_message_id, call_id,
            status, created_at_ms, last_used_at_ms, retired_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
        )
        .run(
          value.session_id,
          value.agent_kind,
          value.working_directory,
          value.central_message_id ?? null,
          value.call_id ?? null,
          value.created_at_ms,
          value.last_used_at_ms,
        ).changes,
    );
    if (changes !== 1) throw invalidStore();
  }

  get(sessionId: string): AcpSessionRecord | undefined {
    if (!SESSION_ID.test(sessionId)) throw invalidStore();
    const row = databaseFor(this)
      .prepare<[string], SessionRow>("SELECT * FROM acp_sessions WHERE session_id = ?")
      .get(sessionId);
    return row === undefined ? undefined : fromRow(row);
  }

  findActiveByMessage(messageId: string): AcpSessionRecord | undefined {
    if (!CORRELATION_ID.test(messageId)) throw invalidStore();
    const row = databaseFor(this)
      .prepare<[string], SessionRow>(
        "SELECT * FROM acp_sessions WHERE central_message_id = ? AND status = 'active'",
      )
      .get(messageId);
    return row === undefined ? undefined : fromRow(row);
  }

  list(): AcpSessionRecord[] {
    const rows = databaseFor(this)
      .prepare<[], SessionRow>(
        "SELECT * FROM acp_sessions ORDER BY created_at_ms DESC, session_id ASC",
      )
      .all();
    if (rows.length > MAX_SESSIONS) throw invalidStore();
    return rows.map(fromRow);
  }

  touch(sessionId: string, nowMs: number): void {
    if (!SESSION_ID.test(sessionId) || !validTime(nowMs)) throw invalidStore();
    const changes = safeInteger(
      databaseFor(this)
        .prepare(
          "UPDATE acp_sessions SET last_used_at_ms = max(last_used_at_ms, ?) WHERE session_id = ?",
        )
        .run(nowMs, sessionId).changes,
    );
    if (changes !== 1) throw invalidStore();
  }

  retire(sessionId: string, nowMs: number): boolean {
    if (!SESSION_ID.test(sessionId) || !validTime(nowMs)) throw invalidStore();
    const changes = safeInteger(
      databaseFor(this)
        .prepare(
          `UPDATE acp_sessions
           SET status = 'retired', retired_at_ms = ?, last_used_at_ms = max(last_used_at_ms, ?)
           WHERE session_id = ? AND status = 'active'`,
        )
        .run(nowMs, nowMs, sessionId).changes,
    );
    if (changes > 1) throw invalidStore();
    return changes === 1;
  }

  retireByCallId(callId: string, nowMs: number): boolean {
    if (!CORRELATION_ID.test(callId) || !validTime(nowMs)) throw invalidStore();
    const changes = safeInteger(
      databaseFor(this)
        .prepare(
          `UPDATE acp_sessions
           SET status = 'retired', retired_at_ms = ?, last_used_at_ms = max(last_used_at_ms, ?)
           WHERE call_id = ? AND status = 'active'`,
        )
        .run(nowMs, nowMs, callId).changes,
    );
    if (changes > 1) throw invalidStore();
    return changes === 1;
  }

  expiredRetired(cutoffMs: number): AcpSessionRecord[] {
    if (!validTime(cutoffMs)) throw invalidStore();
    return databaseFor(this)
      .prepare<[number], SessionRow>(
        `SELECT * FROM acp_sessions
         WHERE status = 'retired' AND retired_at_ms <= ?
         ORDER BY retired_at_ms ASC, session_id ASC`,
      )
      .all(cutoffMs)
      .map(fromRow);
  }

  forget(sessionId: string): boolean {
    if (!SESSION_ID.test(sessionId)) throw invalidStore();
    const changes = safeInteger(
      databaseFor(this).prepare("DELETE FROM acp_sessions WHERE session_id = ?").run(sessionId)
        .changes,
    );
    if (changes > 1) throw invalidStore();
    return changes === 1;
  }

  close(): void {
    const database = databaseFor(this);
    if (database.open) database.close();
    resources.delete(this);
  }
}
