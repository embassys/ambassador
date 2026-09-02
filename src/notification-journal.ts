import Database from "better-sqlite3";

import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const TABLE_SQL = `
  CREATE TABLE notification_relay (
    message_id TEXT PRIMARY KEY CHECK (
      length(message_id) BETWEEN 1 AND 128
      AND message_id NOT GLOB '*[^A-Za-z0-9._~-]*'
    ),
    wake_state TEXT NOT NULL CHECK (
      wake_state IN ('pending', 'in_flight', 'retry_wait', 'accepted_wait')
    ),
    wake_attempt_count INTEGER NOT NULL CHECK (
      wake_attempt_count BETWEEN 0 AND ${MAX_SAFE_INTEGER}
    ),
    wake_next_attempt_at_ms INTEGER CHECK (
      wake_next_attempt_at_ms BETWEEN 0 AND ${MAX_TIMESTAMP_MS}
    ),
    wake_may_have_reached INTEGER NOT NULL CHECK (wake_may_have_reached IN (0, 1)),
    CHECK (
      (
        wake_state = 'pending'
        AND wake_attempt_count = 0
        AND wake_next_attempt_at_ms IS NOT NULL
        AND wake_may_have_reached = 0
      )
      OR (
        wake_state = 'in_flight'
        AND wake_attempt_count > 0
        AND wake_next_attempt_at_ms IS NULL
      )
      OR (
        wake_state IN ('retry_wait', 'accepted_wait')
        AND wake_attempt_count > 0
        AND wake_next_attempt_at_ms IS NOT NULL
      )
    )
  ) STRICT
`;

const WAKE_INDEX_SQL = `
  CREATE INDEX notification_relay_wake_due_idx
  ON notification_relay (wake_next_attempt_at_ms, message_id)
  WHERE wake_state IN ('pending', 'retry_wait', 'accepted_wait')
`;

export type NotificationWakeState = "pending" | "in_flight" | "retry_wait" | "accepted_wait";

export interface NotificationRelayRecord {
  readonly messageId: string;
  readonly wakeState: NotificationWakeState;
  readonly wakeAttemptCount: number;
  readonly wakeNextAttemptAtMs?: number;
  readonly wakeMayHaveReachedWebhook: boolean;
}

export interface NotificationIngestResult {
  readonly inserted: number;
  readonly duplicates: number;
}

export interface NotificationWakeClaim {
  readonly messageId: string;
  readonly attemptCount: number;
  readonly mayHaveReachedWebhook: boolean;
}

interface NotificationRow {
  readonly message_id: string;
  readonly wake_state: string;
  readonly wake_attempt_count: bigint;
  readonly wake_next_attempt_at_ms: bigint | null;
  readonly wake_may_have_reached: bigint;
}

interface JournalResources {
  readonly database: Database.Database;
}

const journalResources = new WeakMap<object, JournalResources>();

export function validateNotificationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value)
  ) {
    throw new TypeError("notification ID must use 1 to 128 URI-unreserved ASCII characters");
  }
  return value;
}

function resourcesFor(journal: object): JournalResources {
  const resources = journalResources.get(journal);
  if (resources === undefined) throw new Error("notification journal is not initialized");
  return resources;
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(MAX_SAFE_INTEGER)) {
      throw new Error(`notification journal ${field} is outside the safe integer range`);
    }
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`notification journal ${field} is not a non-negative safe integer`);
  }
  return value;
}

function timestamp(value: number, field: string): number {
  const result = safeInteger(value, field);
  if (result > MAX_TIMESTAMP_MS) throw new RangeError(`${field} is outside the timestamp range`);
  return result;
}

function wakeState(value: string): NotificationWakeState {
  if (["pending", "in_flight", "retry_wait", "accepted_wait"].includes(value)) {
    return value as NotificationWakeState;
  }
  throw new Error("notification journal contains an invalid wake state");
}

function rowRecord(row: NotificationRow): NotificationRelayRecord {
  return {
    messageId: validateNotificationId(row.message_id),
    wakeState: wakeState(row.wake_state),
    wakeAttemptCount: safeInteger(row.wake_attempt_count, "wake attempt count"),
    ...(row.wake_next_attempt_at_ms === null
      ? {}
      : {
          wakeNextAttemptAtMs: timestamp(
            safeInteger(row.wake_next_attempt_at_ms, "wake next attempt"),
            "wake next attempt",
          ),
        }),
    wakeMayHaveReachedWebhook: safeInteger(row.wake_may_have_reached, "wake uncertainty") === 1,
  };
}

function normalizedSql(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function migrate(database: Database.Database): void {
  database
    .transaction(() => {
      const version = safeInteger(
        database.pragma("user_version", { simple: true }),
        "schema version",
      );
      if (version > SCHEMA_VERSION) throw new Error("notification journal schema is too new");
      if (version === 0) {
        const row = database
          .prepare<[], { count: bigint }>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .get();
        if (row === undefined || safeInteger(row.count, "schema object count") !== 0) {
          throw new Error("notification journal has an obsolete or unversioned schema");
        }
        database.exec(`${TABLE_SQL}; ${WAKE_INDEX_SQL};`);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
      const expected = new Map([
        ["notification_relay", normalizedSql(TABLE_SQL)],
        ["notification_relay_wake_due_idx", normalizedSql(WAKE_INDEX_SQL)],
      ]);
      const rows = database
        .prepare<[], { name: string; sql: string | null }>(
          "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (rows.length !== expected.size) throw new Error("notification journal schema is invalid");
      for (const schema of rows) {
        if (
          schema.sql === null ||
          expected.get(schema.name) === undefined ||
          normalizedSql(schema.sql) !== expected.get(schema.name)
        ) {
          throw new Error("notification journal schema is invalid");
        }
      }
    })
    .immediate();
}

function getRow(database: Database.Database, messageId: string): NotificationRow | undefined {
  return database
    .prepare<[string], NotificationRow>(
      `SELECT message_id, wake_state, wake_attempt_count, wake_next_attempt_at_ms,
              wake_may_have_reached
       FROM notification_relay WHERE message_id = ?`,
    )
    .get(messageId);
}

export class NotificationJournal {
  constructor(path: string) {
    const artifact = preparePrivateSqliteArtifact(path, () => new Error("Invalid journal path"));
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
      migrate(database);
      artifact.validateDirectory();
      journalResources.set(this, { database });
    } catch (error) {
      database?.close();
      throw error;
    } finally {
      artifact.close();
    }
  }

  close(): void {
    const { database } = resourcesFor(this);
    if (database.open) database.close();
  }

  discardAll(): number {
    const result = resourcesFor(this).database.prepare("DELETE FROM notification_relay").run();
    return safeInteger(result.changes, "discard changes");
  }

  ingest(messageIds: readonly string[], observedAtMs: number): NotificationIngestResult {
    const observedAt = timestamp(observedAtMs, "observedAtMs");
    const unique = new Set<string>();
    let duplicates = 0;
    for (const value of messageIds) {
      const id = validateNotificationId(value);
      if (unique.has(id)) duplicates += 1;
      else unique.add(id);
    }
    const database = resourcesFor(this).database;
    return database
      .transaction(() => {
        const insert = database.prepare(
          `INSERT INTO notification_relay (
             message_id, wake_state, wake_attempt_count,
             wake_next_attempt_at_ms, wake_may_have_reached
           ) VALUES (?, 'pending', 0, ?, 0)
           ON CONFLICT(message_id) DO NOTHING`,
        );
        let inserted = 0;
        for (const id of unique) {
          const result = insert.run(id, observedAt);
          const changes = safeInteger(result.changes, "ingest changes");
          inserted += changes;
          if (changes === 0) duplicates += 1;
        }
        return { inserted, duplicates };
      })
      .immediate();
  }

  get(messageId: string): NotificationRelayRecord | undefined {
    const row = getRow(resourcesFor(this).database, validateNotificationId(messageId));
    return row === undefined ? undefined : rowRecord(row);
  }

  count(): number {
    const row = resourcesFor(this)
      .database.prepare<[], { count: bigint }>("SELECT count(*) AS count FROM notification_relay")
      .get();
    if (row === undefined) throw new Error("notification journal count failed");
    return safeInteger(row.count, "row count");
  }

  claimDueWake(nowMs: number): NotificationWakeClaim | undefined {
    const now = timestamp(nowMs, "nowMs");
    const database = resourcesFor(this).database;
    return database
      .transaction(() => {
        const row = database
          .prepare<
            [number],
            Pick<NotificationRow, "message_id" | "wake_attempt_count" | "wake_may_have_reached">
          >(
            `SELECT message_id, wake_attempt_count, wake_may_have_reached
             FROM notification_relay
             WHERE wake_state IN ('pending', 'retry_wait', 'accepted_wait')
               AND wake_next_attempt_at_ms <= ?
             ORDER BY wake_next_attempt_at_ms, message_id LIMIT 1`,
          )
          .get(now);
        if (row === undefined) return undefined;
        const current = safeInteger(row.wake_attempt_count, "wake attempt count");
        if (current === MAX_SAFE_INTEGER) throw new Error("wake attempt count exhausted");
        const attemptCount = current + 1;
        const result = database
          .prepare(
            `UPDATE notification_relay
             SET wake_state = 'in_flight', wake_attempt_count = ?, wake_next_attempt_at_ms = NULL
             WHERE message_id = ?
               AND wake_state IN ('pending', 'retry_wait', 'accepted_wait')
               AND wake_next_attempt_at_ms <= ?`,
          )
          .run(attemptCount, row.message_id, now);
        if (safeInteger(result.changes, "wake claim changes") !== 1) return undefined;
        return {
          messageId: row.message_id,
          attemptCount,
          mayHaveReachedWebhook: safeInteger(row.wake_may_have_reached, "wake uncertainty") === 1,
        };
      })
      .immediate();
  }

  recordWakeAccepted(messageId: string, nextAttemptAtMs: number): void {
    this.#recordWakeOutcome(messageId, "accepted_wait", nextAttemptAtMs, true);
  }

  recordWakeRetry(
    messageId: string,
    nextAttemptAtMs: number,
    mayHaveReachedWebhook: boolean,
  ): void {
    this.#recordWakeOutcome(messageId, "retry_wait", nextAttemptAtMs, mayHaveReachedWebhook);
  }

  #recordWakeOutcome(
    messageId: string,
    state: "retry_wait" | "accepted_wait",
    nextAttemptAtMs: number,
    mayHaveReachedWebhook: boolean,
  ): void {
    const id = validateNotificationId(messageId);
    const next = timestamp(nextAttemptAtMs, "nextAttemptAtMs");
    const database = resourcesFor(this).database;
    const row = getRow(database, id);
    if (row === undefined || row.wake_state !== "in_flight") {
      throw new Error("notification wake is not in flight");
    }
    const result = database
      .prepare(
        `UPDATE notification_relay
         SET wake_state = ?, wake_next_attempt_at_ms = ?,
             wake_may_have_reached = CASE WHEN wake_may_have_reached = 1 OR ? = 1 THEN 1 ELSE 0 END
         WHERE message_id = ? AND wake_state = 'in_flight'`,
      )
      .run(state, next, mayHaveReachedWebhook ? 1 : 0, id);
    if (safeInteger(result.changes, "wake outcome changes") !== 1) {
      throw new Error("notification wake outcome failed");
    }
  }

  remove(messageId: string): boolean {
    const result = resourcesFor(this)
      .database.prepare("DELETE FROM notification_relay WHERE message_id = ?")
      .run(validateNotificationId(messageId));
    return safeInteger(result.changes, "remove changes") === 1;
  }

  nextWakeAtMs(): number | null {
    const row = resourcesFor(this)
      .database.prepare<[], { value: bigint | null }>(
        `SELECT min(wake_next_attempt_at_ms) AS value
         FROM notification_relay
         WHERE wake_state IN ('pending', 'retry_wait', 'accepted_wait')`,
      )
      .get();
    if (row === undefined || row.value === null) return null;
    return timestamp(safeInteger(row.value, "next wake"), "next wake");
  }
}
