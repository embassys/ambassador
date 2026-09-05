import { isAbsolute } from "node:path";

import Database from "better-sqlite3";

import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const SCHEMA_VERSION = 2;
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

const PEER_SQL =
  "CREATE TABLE acp_peers (session_id TEXT PRIMARY KEY REFERENCES acp_sessions(session_id) ON DELETE CASCADE, scope TEXT NOT NULL, peer_agent_id TEXT NOT NULL, UNIQUE (scope, peer_agent_id)) STRICT";
const DISPATCH_SQL =
  "CREATE TABLE acp_dispatches (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES acp_sessions(session_id) ON DELETE CASCADE, call_id TEXT UNIQUE, state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'completed', 'uncertain')), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)) STRICT";
const ACTION_SQL =
  "CREATE TABLE acp_actions (call_id TEXT PRIMARY KEY, session_id TEXT REFERENCES acp_sessions(session_id) ON DELETE CASCADE, completed INTEGER NOT NULL CHECK (completed IN (0, 1)), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)) STRICT";
const ACTION_INDEX_SQL = "CREATE INDEX acp_actions_pending ON acp_actions (session_id, completed)";
const DISPATCH_INDEX_SQL =
  "CREATE INDEX acp_dispatches_pending ON acp_dispatches (session_id, state)";
const DISPATCH_RETENTION_SQL =
  "CREATE INDEX acp_dispatches_retention ON acp_dispatches (state, updated_at_ms)";
const ACTION_RETENTION_SQL =
  "CREATE INDEX acp_actions_retention ON acp_actions (completed, updated_at_ms)";
const IDLE_INDEX_SQL = "CREATE INDEX acp_sessions_idle ON acp_sessions (status, last_used_at_ms)";
const RETIRED_INDEX_SQL =
  "CREATE INDEX acp_sessions_retention ON acp_sessions (status, retired_at_ms, session_id)";

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
      const original = {
        acp_sessions: TABLE_SQL,
        acp_sessions_call_id: CALL_INDEX_SQL,
        acp_sessions_central_message_id: MESSAGE_INDEX_SQL,
      };
      const additions = {
        acp_peers: PEER_SQL,
        acp_dispatches: DISPATCH_SQL,
        acp_actions: ACTION_SQL,
        acp_actions_pending: ACTION_INDEX_SQL,
        acp_dispatches_pending: DISPATCH_INDEX_SQL,
        acp_sessions_idle: IDLE_INDEX_SQL,
        acp_sessions_retention: RETIRED_INDEX_SQL,
        acp_dispatches_retention: DISPATCH_RETENTION_SQL,
        acp_actions_retention: ACTION_RETENTION_SQL,
      };
      const validate = (expected: Record<string, string>): void => {
        const rows = database
          .prepare<[], { name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (
          rows.length !== Object.keys(expected).length ||
          rows.some(
            (row) =>
              expected[row.name] === undefined ||
              normalizedSql(row.sql) !== normalizedSql(expected[row.name] as string),
          )
        )
          throw invalidStore();
      };
      if (version === 0) {
        validate({});
        for (const statement of Object.values({ ...original, ...additions }))
          database.exec(statement);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
      } else if (version !== SCHEMA_VERSION) throw invalidStore();
      validate({ ...original, ...additions });
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
      const pageSize = safeInteger(database.pragma("page_size", { simple: true }));
      database.pragma(`max_page_count = ${Math.floor((256 * 1024 * 1024) / pageSize)}`);
      artifact.validateDirectory();
      resources.set(this, { database });
      const count = database
        .prepare<[], { count: bigint }>("SELECT count(*) AS count FROM acp_sessions")
        .get();
      if (count === undefined || safeInteger(count.count) > MAX_SESSIONS) throw invalidStore();
    } catch (error) {
      resources.delete(this);
      database?.close();
      throw error;
    } finally {
      artifact.close();
    }
  }

  create(
    record: AcpSessionRecord,
    peer?: { readonly scope: string; readonly agentId: string },
  ): void {
    const value = validateRecord(record);
    if (value.status !== "active") throw invalidStore();
    const database = databaseFor(this);
    database
      .transaction(() => {
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
        if (value.central_message_id !== undefined)
          this.trackMessage(value.session_id, value.central_message_id, value.call_id);
        else if (value.call_id !== undefined)
          database
            .prepare(
              "INSERT INTO acp_actions (call_id, session_id, completed, updated_at_ms) VALUES (?, ?, 0, ?) ON CONFLICT(call_id) DO UPDATE SET session_id = excluded.session_id WHERE acp_actions.session_id IS NULL",
            )
            .run(value.call_id, value.session_id, value.last_used_at_ms);
        if (peer !== undefined) this.bindPeer(value.session_id, peer.scope, peer.agentId);
      })
      .immediate();
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
        "SELECT s.* FROM acp_sessions s JOIN acp_dispatches d ON d.session_id = s.session_id WHERE d.message_id = ? AND s.status = 'active'",
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
    if (changes === 1)
      databaseFor(this).prepare("DELETE FROM acp_peers WHERE session_id = ?").run(sessionId);
    return changes === 1;
  }

  bindPeer(sessionId: string, scope: string, peerId: string): void {
    if (!SESSION_ID.test(sessionId) || !CORRELATION_ID.test(scope) || !CORRELATION_ID.test(peerId))
      throw invalidStore();
    databaseFor(this)
      .prepare("INSERT INTO acp_peers (session_id, scope, peer_agent_id) VALUES (?, ?, ?)")
      .run(sessionId, scope, peerId);
  }

  findPeer(scope: string, peerId: string): AcpSessionRecord | undefined {
    if (!CORRELATION_ID.test(scope) || !CORRELATION_ID.test(peerId)) throw invalidStore();
    const row = databaseFor(this)
      .prepare<[string, string], SessionRow>(
        "SELECT s.* FROM acp_sessions s JOIN acp_peers p ON p.session_id = s.session_id WHERE p.scope = ? AND p.peer_agent_id = ? AND s.status = 'active'",
      )
      .get(scope, peerId);
    return row === undefined ? undefined : fromRow(row);
  }

  trackMessage(sessionId: string, messageId: string, callId?: string): void {
    if (
      !SESSION_ID.test(sessionId) ||
      !CORRELATION_ID.test(messageId) ||
      (callId !== undefined && !CORRELATION_ID.test(callId))
    )
      throw invalidStore();
    const database = databaseFor(this);
    database
      .transaction(() => {
        const previous = database
          .prepare<[string], { session_id: string; call_id: string | null }>(
            "SELECT session_id, call_id FROM acp_dispatches WHERE message_id = ?",
          )
          .get(messageId);
        if (previous !== undefined) {
          if (previous.session_id !== sessionId || previous.call_id !== (callId ?? null))
            throw invalidStore();
          return;
        }
        database
          .prepare(
            "INSERT INTO acp_dispatches (message_id, session_id, call_id, state, updated_at_ms) VALUES (?, ?, ?, 'prepared', ?)",
          )
          .run(messageId, sessionId, callId ?? null, this.get(sessionId)?.last_used_at_ms ?? 0);
        if (callId !== undefined)
          database
            .prepare(
              "INSERT INTO acp_actions (call_id, session_id, completed, updated_at_ms) VALUES (?, ?, 0, ?) ON CONFLICT(call_id) DO UPDATE SET session_id = excluded.session_id WHERE acp_actions.session_id IS NULL",
            )
            .run(callId, sessionId, this.get(sessionId)?.last_used_at_ms ?? 0);
      })
      .immediate();
  }

  messageState(messageId: string): string | undefined {
    return databaseFor(this)
      .prepare<[string], { state: string }>("SELECT state FROM acp_dispatches WHERE message_id = ?")
      .get(messageId)?.state;
  }

  markMessage(
    messageId: string,
    state: "dispatched" | "completed" | "uncertain",
    nowMs = Date.now(),
  ): void {
    if (!CORRELATION_ID.test(messageId) || !validTime(nowMs)) throw invalidStore();
    const changed = databaseFor(this)
      .prepare(
        "UPDATE acp_dispatches SET state = ?, updated_at_ms = ? WHERE message_id = ? AND (state = 'prepared' OR state = 'dispatched')",
      )
      .run(state, nowMs, messageId).changes;
    if (safeInteger(changed) !== 1) throw invalidStore();
  }

  completeAction(callId: string, nowMs: number): boolean {
    if (!CORRELATION_ID.test(callId) || !validTime(nowMs)) throw invalidStore();
    const database = databaseFor(this);
    return database
      .transaction(() => {
        const previous = database
          .prepare<[string], { completed: bigint; session_id: string | null }>(
            "SELECT completed, session_id FROM acp_actions WHERE call_id = ?",
          )
          .get(callId);
        if (previous !== undefined && safeInteger(previous.completed) === 1) return false;
        database
          .prepare(
            "INSERT INTO acp_actions (call_id, session_id, completed, updated_at_ms) VALUES (?, NULL, 1, ?) ON CONFLICT(call_id) DO UPDATE SET completed = 1, updated_at_ms = excluded.updated_at_ms",
          )
          .run(callId, nowMs);
        if (previous?.session_id != null) this.touch(previous.session_id, nowMs);
        return true;
      })
      .immediate();
  }

  actionCompleted(callId: string): boolean {
    if (!CORRELATION_ID.test(callId)) throw invalidStore();
    return (
      databaseFor(this)
        .prepare("SELECT 1 FROM acp_actions WHERE call_id = ? AND completed = 1")
        .get(callId) !== undefined
    );
  }

  hasPendingActions(sessionId: string): boolean {
    return (
      databaseFor(this)
        .prepare("SELECT 1 FROM acp_actions WHERE session_id = ? AND completed = 0 LIMIT 1")
        .get(sessionId) !== undefined
    );
  }

  retireIdle(cutoffMs: number): number {
    if (!validTime(cutoffMs)) throw invalidStore();
    const database = databaseFor(this);
    return database
      .transaction(() => {
        const rows = database
          .prepare<[number], { session_id: string; last_used_at_ms: bigint }>(
            "SELECT session_id, last_used_at_ms FROM acp_sessions s WHERE status = 'active' AND last_used_at_ms <= ? AND NOT EXISTS (SELECT 1 FROM acp_actions a WHERE a.session_id = s.session_id AND a.completed = 0) AND NOT EXISTS (SELECT 1 FROM acp_dispatches d WHERE d.session_id = s.session_id AND d.state != 'completed') ORDER BY last_used_at_ms LIMIT 64",
          )
          .all(cutoffMs);
        for (const row of rows) this.retire(row.session_id, safeInteger(row.last_used_at_ms));
        return rows.length;
      })
      .immediate();
  }

  pruneSettled(cutoffMs: number): number {
    if (!validTime(cutoffMs)) throw invalidStore();
    const database = databaseFor(this);
    return database
      .transaction(() => {
        const actions = database
          .prepare(
            "DELETE FROM acp_actions WHERE call_id IN (SELECT call_id FROM acp_actions WHERE completed = 1 AND updated_at_ms <= ? LIMIT 256)",
          )
          .run(cutoffMs).changes;
        const dispatches = database
          .prepare(
            "DELETE FROM acp_dispatches WHERE message_id IN (SELECT message_id FROM acp_dispatches WHERE state = 'completed' AND updated_at_ms <= ? AND NOT EXISTS (SELECT 1 FROM acp_actions a WHERE a.call_id = acp_dispatches.call_id AND a.completed = 0) LIMIT 256)",
          )
          .run(cutoffMs).changes;
        return safeInteger(actions) + safeInteger(dispatches);
      })
      .immediate();
  }

  expiredRetired(
    cutoffMs: number,
    after?: { readonly time: number; readonly id: string },
  ): AcpSessionRecord[] {
    if (
      !validTime(cutoffMs) ||
      (after !== undefined && (!validTime(after.time) || !SESSION_ID.test(after.id)))
    )
      throw invalidStore();
    return databaseFor(this)
      .prepare<[number, number, number, string], SessionRow>(
        `SELECT * FROM acp_sessions WHERE status = 'retired' AND retired_at_ms <= ?
       AND (retired_at_ms > ? OR (retired_at_ms = ? AND session_id > ?))
       ORDER BY retired_at_ms ASC, session_id ASC LIMIT 32`,
      )
      .all(cutoffMs, after?.time ?? -1, after?.time ?? -1, after?.id ?? "")
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
