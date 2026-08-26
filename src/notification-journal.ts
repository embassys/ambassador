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
    notification_ack_state TEXT NOT NULL CHECK (
      notification_ack_state IN ('pending', 'in_flight', 'confirmed')
    ),
    notification_ack_attempt_count INTEGER NOT NULL CHECK (
      notification_ack_attempt_count BETWEEN 0 AND ${MAX_SAFE_INTEGER}
    ),
    notification_ack_next_attempt_at_ms INTEGER CHECK (
      notification_ack_next_attempt_at_ms BETWEEN 0 AND ${MAX_TIMESTAMP_MS}
    ),
    wake_state TEXT NOT NULL CHECK (
      wake_state IN (
        'pending',
        'in_flight',
        'retry_wait',
        'accepted_wait',
        'content_acknowledged'
      )
    ),
    wake_attempt_count INTEGER NOT NULL CHECK (
      wake_attempt_count BETWEEN 0 AND ${MAX_SAFE_INTEGER}
    ),
    wake_next_attempt_at_ms INTEGER CHECK (
      wake_next_attempt_at_ms BETWEEN 0 AND ${MAX_TIMESTAMP_MS}
    ),
    wake_may_have_reached INTEGER NOT NULL CHECK (wake_may_have_reached IN (0, 1)),
    CHECK (
      (notification_ack_state = 'pending' AND notification_ack_next_attempt_at_ms IS NOT NULL)
      OR (
        notification_ack_state = 'in_flight'
        AND notification_ack_attempt_count > 0
        AND notification_ack_next_attempt_at_ms IS NULL
      )
      OR (
        notification_ack_state = 'confirmed'
        AND notification_ack_next_attempt_at_ms IS NULL
      )
    ),
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
        wake_state = 'retry_wait'
        AND wake_attempt_count > 0
        AND wake_next_attempt_at_ms IS NOT NULL
      )
      OR (
        wake_state = 'accepted_wait'
        AND wake_attempt_count > 0
        AND wake_next_attempt_at_ms IS NOT NULL
        AND wake_may_have_reached = 1
      )
      OR (
        wake_state = 'content_acknowledged'
        AND wake_next_attempt_at_ms IS NULL
      )
    )
  ) STRICT
`;

const ACK_INDEX_SQL = `
  CREATE INDEX notification_relay_ack_due_idx
  ON notification_relay (notification_ack_next_attempt_at_ms, message_id)
  WHERE notification_ack_state = 'pending'
`;

const WAKE_INDEX_SQL = `
  CREATE INDEX notification_relay_wake_due_idx
  ON notification_relay (wake_next_attempt_at_ms, message_id)
  WHERE wake_state IN ('pending', 'retry_wait', 'accepted_wait')
`;

export type NotificationAcknowledgementState = "pending" | "in_flight" | "confirmed";
export type NotificationWakeState =
  | "pending"
  | "in_flight"
  | "retry_wait"
  | "accepted_wait"
  | "content_acknowledged";

export interface NotificationRelayRecord {
  messageId: string;
  notificationAcknowledgementState: NotificationAcknowledgementState;
  notificationAcknowledgementAttemptCount: number;
  notificationAcknowledgementNextAttemptAtMs?: number;
  wakeState: NotificationWakeState;
  wakeAttemptCount: number;
  wakeNextAttemptAtMs?: number;
  wakeMayHaveReachedWebhook: boolean;
}

export interface NotificationIngestResult {
  inserted: number;
  duplicates: number;
}

export interface NotificationAcknowledgementClaim {
  messageId: string;
  attemptCount: number;
}

export interface NotificationWakeClaim {
  messageId: string;
  attemptCount: number;
  mayHaveReachedWebhook: boolean;
}

export interface NotificationRecoveryResult {
  notificationAcknowledgements: number;
  wakes: number;
}

interface NotificationRow {
  message_id: string;
  notification_ack_state: string;
  notification_ack_attempt_count: bigint;
  notification_ack_next_attempt_at_ms: bigint | null;
  wake_state: string;
  wake_attempt_count: bigint;
  wake_next_attempt_at_ms: bigint | null;
  wake_may_have_reached: bigint;
}

interface JournalResources {
  database: Database.Database;
}

const journalResources = new WeakMap<object, JournalResources>();

export function validateNotificationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
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

function inputTimestamp(value: number, field: string): number {
  const timestamp = safeInteger(value, field);
  if (timestamp > MAX_TIMESTAMP_MS) {
    throw new RangeError(`${field} is outside the supported timestamp range`);
  }
  return timestamp;
}

function attemptCount(value: unknown, field: string): number {
  return safeInteger(value, field);
}

function nextAttemptCount(current: unknown, field: string): number {
  const count = attemptCount(current, field);
  if (count === MAX_SAFE_INTEGER) throw new Error("notification attempt count is exhausted");
  return count + 1;
}

function acknowledgementState(value: string): NotificationAcknowledgementState {
  switch (value) {
    case "pending":
    case "in_flight":
    case "confirmed":
      return value;
    default:
      throw new Error("notification journal contains an invalid acknowledgement state");
  }
}

function wakeState(value: string): NotificationWakeState {
  switch (value) {
    case "pending":
    case "in_flight":
    case "retry_wait":
    case "accepted_wait":
    case "content_acknowledged":
      return value;
    default:
      throw new Error("notification journal contains an invalid wake state");
  }
}

function booleanInteger(value: unknown, field: string): boolean {
  const integer = safeInteger(value, field);
  if (integer !== 0 && integer !== 1) {
    throw new Error(`notification journal ${field} is not a boolean integer`);
  }
  return integer === 1;
}

function optionalTimestamp(value: bigint | null, field: string): number | undefined {
  return value === null ? undefined : inputTimestamp(safeInteger(value, field), field);
}

function recordFromRow(row: NotificationRow): NotificationRelayRecord {
  const notificationAcknowledgementNextAttemptAtMs = optionalTimestamp(
    row.notification_ack_next_attempt_at_ms,
    "notification_ack_next_attempt_at_ms",
  );
  const wakeNextAttemptAtMs = optionalTimestamp(
    row.wake_next_attempt_at_ms,
    "wake_next_attempt_at_ms",
  );
  return {
    messageId: validateNotificationId(row.message_id),
    notificationAcknowledgementState: acknowledgementState(row.notification_ack_state),
    notificationAcknowledgementAttemptCount: attemptCount(
      row.notification_ack_attempt_count,
      "notification_ack_attempt_count",
    ),
    ...(notificationAcknowledgementNextAttemptAtMs === undefined
      ? {}
      : { notificationAcknowledgementNextAttemptAtMs }),
    wakeState: wakeState(row.wake_state),
    wakeAttemptCount: attemptCount(row.wake_attempt_count, "wake_attempt_count"),
    ...(wakeNextAttemptAtMs === undefined ? {} : { wakeNextAttemptAtMs }),
    wakeMayHaveReachedWebhook: booleanInteger(row.wake_may_have_reached, "wake_may_have_reached"),
  };
}

function invalidJournalArtifact(): Error {
  return new Error("Notification journal path must be a private regular file");
}

function normalizedSql(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function migrate(database: Database.Database): void {
  database
    .transaction(() => {
      const version = safeInteger(
        database.pragma("user_version", { simple: true }),
        "schema version",
      );
      if (version > SCHEMA_VERSION) {
        throw new Error("notification journal schema is newer than this gateway supports");
      }

      if (version === 0) {
        const row = database
          .prepare<[], { count: bigint }>(`
            SELECT count(*) AS count
            FROM sqlite_schema
            WHERE name NOT LIKE 'sqlite_%'
          `)
          .get();
        if (row === undefined || safeInteger(row.count, "schema object count") !== 0) {
          throw new Error("notification journal has an unversioned schema");
        }
        database.exec(`${TABLE_SQL}; ${ACK_INDEX_SQL}; ${WAKE_INDEX_SQL};`);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
      }

      validateSchema(database);
    })
    .immediate();
}

function validateSchema(database: Database.Database): void {
  const expected = new Map([
    ["notification_relay", normalizedSql(TABLE_SQL)],
    ["notification_relay_ack_due_idx", normalizedSql(ACK_INDEX_SQL)],
    ["notification_relay_wake_due_idx", normalizedSql(WAKE_INDEX_SQL)],
  ]);
  const rows = database
    .prepare<[], { name: string; sql: string | null }>(`
      SELECT name, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all();
  if (rows.length !== expected.size) throw new Error("notification journal schema is invalid");
  for (const row of rows) {
    const expectedSql = expected.get(row.name);
    if (row.sql === null || expectedSql === undefined || normalizedSql(row.sql) !== expectedSql) {
      throw new Error("notification journal schema is invalid");
    }
  }

  const table = database
    .prepare<[string], { strict: bigint }>(
      "SELECT strict FROM pragma_table_list WHERE name = ? AND type = 'table'",
    )
    .get("notification_relay");
  if (table === undefined || safeInteger(table.strict, "strict table flag") !== 1) {
    throw new Error("notification journal table is not strict");
  }
}

function getRow(database: Database.Database, messageId: string): NotificationRow | undefined {
  return database
    .prepare<[string], NotificationRow>(`
      SELECT
        message_id,
        notification_ack_state,
        notification_ack_attempt_count,
        notification_ack_next_attempt_at_ms,
        wake_state,
        wake_attempt_count,
        wake_next_attempt_at_ms,
        wake_may_have_reached
      FROM notification_relay
      WHERE message_id = ?
    `)
    .get(messageId);
}

function changes(value: unknown, operation: string): number {
  return safeInteger(value, `${operation} changes`);
}

export class NotificationJournal {
  constructor(path: string) {
    const artifact = preparePrivateSqliteArtifact(path, invalidJournalArtifact);
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

  ingest(messageIds: readonly string[], observedAtMs: number): NotificationIngestResult {
    const { database } = resourcesFor(this);
    const observedAt = inputTimestamp(observedAtMs, "observedAtMs");
    const uniqueIds = new Set<string>();
    let duplicates = 0;
    for (const value of messageIds) {
      const messageId = validateNotificationId(value);
      if (uniqueIds.has(messageId)) duplicates += 1;
      else uniqueIds.add(messageId);
    }

    return database
      .transaction(() => {
        const exists = database.prepare<[string], { present: bigint }>(`
          SELECT EXISTS (
            SELECT 1 FROM notification_relay WHERE message_id = ?
          ) AS present
        `);
        const insert = database.prepare(`
          INSERT INTO notification_relay (
            message_id,
            notification_ack_state,
            notification_ack_attempt_count,
            notification_ack_next_attempt_at_ms,
            wake_state,
            wake_attempt_count,
            wake_next_attempt_at_ms,
            wake_may_have_reached
          ) VALUES (?, 'pending', 0, ?, 'pending', 0, ?, 0)
        `);
        let inserted = 0;
        for (const messageId of uniqueIds) {
          const row = exists.get(messageId);
          if (row === undefined) throw new Error("failed to inspect notification journal");
          if (safeInteger(row.present, "notification presence") === 1) {
            duplicates += 1;
            continue;
          }
          insert.run(messageId, observedAt, observedAt);
          inserted += 1;
        }
        return { inserted, duplicates };
      })
      .immediate();
  }

  get(messageId: string): NotificationRelayRecord | undefined {
    const id = validateNotificationId(messageId);
    const row = getRow(resourcesFor(this).database, id);
    return row === undefined ? undefined : recordFromRow(row);
  }

  claimDueNotificationAcknowledgement(nowMs: number): NotificationAcknowledgementClaim | undefined {
    const { database } = resourcesFor(this);
    const now = inputTimestamp(nowMs, "nowMs");
    return database
      .transaction(() => {
        const row = database
          .prepare<
            [number],
            Pick<NotificationRow, "message_id" | "notification_ack_attempt_count">
          >(`
            SELECT message_id, notification_ack_attempt_count
            FROM notification_relay
            WHERE notification_ack_state = 'pending'
              AND notification_ack_next_attempt_at_ms <= ?
            ORDER BY notification_ack_next_attempt_at_ms, message_id
            LIMIT 1
          `)
          .get(now);
        if (row === undefined) return undefined;
        const count = nextAttemptCount(
          row.notification_ack_attempt_count,
          "notification_ack_attempt_count",
        );
        const update = database
          .prepare(`
            UPDATE notification_relay
            SET notification_ack_state = 'in_flight',
                notification_ack_attempt_count = ?,
                notification_ack_next_attempt_at_ms = NULL
            WHERE message_id = ?
              AND notification_ack_state = 'pending'
              AND notification_ack_next_attempt_at_ms <= ?
          `)
          .run(count, row.message_id, now);
        if (changes(update.changes, "notification acknowledgement claim") !== 1) return undefined;
        return { messageId: row.message_id, attemptCount: count };
      })
      .immediate();
  }

  recordNotificationAcknowledgementSuccess(messageId: string): void {
    const id = validateNotificationId(messageId);
    const { database } = resourcesFor(this);
    database
      .transaction(() => {
        const row = getRow(database, id);
        if (row === undefined) throw new Error("cannot acknowledge an unknown notification");
        if (row.notification_ack_state === "confirmed") return;
        if (row.notification_ack_state !== "in_flight") {
          throw new Error("notification acknowledgement is not in flight");
        }
        database
          .prepare(`
            UPDATE notification_relay
            SET notification_ack_state = 'confirmed',
                notification_ack_next_attempt_at_ms = NULL
            WHERE message_id = ? AND notification_ack_state = 'in_flight'
          `)
          .run(id);
      })
      .immediate();
  }

  recordNotificationAcknowledgementRetry(messageId: string, nextAttemptAtMs: number): void {
    const id = validateNotificationId(messageId);
    const nextAttemptAt = inputTimestamp(nextAttemptAtMs, "nextAttemptAtMs");
    const { database } = resourcesFor(this);
    database
      .transaction(() => {
        const row = getRow(database, id);
        if (row === undefined) throw new Error("cannot retry an unknown notification");
        if (row.notification_ack_state === "confirmed") return;
        if (row.notification_ack_state !== "in_flight") {
          throw new Error("notification acknowledgement is not in flight");
        }
        database
          .prepare(`
            UPDATE notification_relay
            SET notification_ack_state = 'pending',
                notification_ack_next_attempt_at_ms = ?
            WHERE message_id = ? AND notification_ack_state = 'in_flight'
          `)
          .run(nextAttemptAt, id);
      })
      .immediate();
  }

  claimDueWake(nowMs: number): NotificationWakeClaim | undefined {
    const { database } = resourcesFor(this);
    const now = inputTimestamp(nowMs, "nowMs");
    return database
      .transaction(() => {
        const row = database
          .prepare<
            [number],
            Pick<NotificationRow, "message_id" | "wake_attempt_count" | "wake_may_have_reached">
          >(`
            SELECT message_id, wake_attempt_count, wake_may_have_reached
            FROM notification_relay
            WHERE wake_state IN ('pending', 'retry_wait', 'accepted_wait')
              AND wake_next_attempt_at_ms <= ?
            ORDER BY wake_next_attempt_at_ms, message_id
            LIMIT 1
          `)
          .get(now);
        if (row === undefined) return undefined;
        const count = nextAttemptCount(row.wake_attempt_count, "wake_attempt_count");
        const update = database
          .prepare(`
            UPDATE notification_relay
            SET wake_state = 'in_flight',
                wake_attempt_count = ?,
                wake_next_attempt_at_ms = NULL
            WHERE message_id = ?
              AND wake_state IN ('pending', 'retry_wait', 'accepted_wait')
              AND wake_next_attempt_at_ms <= ?
          `)
          .run(count, row.message_id, now);
        if (changes(update.changes, "wake claim") !== 1) return undefined;
        return {
          messageId: row.message_id,
          attemptCount: count,
          mayHaveReachedWebhook: booleanInteger(row.wake_may_have_reached, "wake_may_have_reached"),
        };
      })
      .immediate();
  }

  recordWakeAccepted(messageId: string, nextAttemptAtMs: number): void {
    this.recordWakeOutcome(messageId, "accepted_wait", nextAttemptAtMs, true);
  }

  recordWakeRetry(
    messageId: string,
    nextAttemptAtMs: number,
    mayHaveReachedWebhook: boolean,
  ): void {
    if (typeof mayHaveReachedWebhook !== "boolean") {
      throw new TypeError("mayHaveReachedWebhook must be a boolean");
    }
    this.recordWakeOutcome(messageId, "retry_wait", nextAttemptAtMs, mayHaveReachedWebhook);
  }

  private recordWakeOutcome(
    messageId: string,
    state: "retry_wait" | "accepted_wait",
    nextAttemptAtMs: number,
    mayHaveReachedWebhook: boolean,
  ): void {
    const id = validateNotificationId(messageId);
    const nextAttemptAt = inputTimestamp(nextAttemptAtMs, "nextAttemptAtMs");
    const { database } = resourcesFor(this);
    database
      .transaction(() => {
        const row = getRow(database, id);
        if (row === undefined) throw new Error("cannot record a wake for an unknown notification");
        if (row.wake_state === "content_acknowledged") return;
        if (row.wake_state !== "in_flight") throw new Error("notification wake is not in flight");
        const previousMayHaveReached = booleanInteger(
          row.wake_may_have_reached,
          "wake_may_have_reached",
        );
        database
          .prepare(`
            UPDATE notification_relay
            SET wake_state = ?,
                wake_next_attempt_at_ms = ?,
                wake_may_have_reached = ?
            WHERE message_id = ? AND wake_state = 'in_flight'
          `)
          .run(state, nextAttemptAt, previousMayHaveReached || mayHaveReachedWebhook ? 1 : 0, id);
      })
      .immediate();
  }

  /** Call only after the central ack_message operation has returned success. */
  confirmContentAcknowledgement(messageId: string): boolean {
    const id = validateNotificationId(messageId);
    const { database } = resourcesFor(this);
    return database
      .transaction(() => {
        if (getRow(database, id) === undefined) return false;
        database
          .prepare(`
            UPDATE notification_relay
            SET wake_state = 'content_acknowledged',
                wake_next_attempt_at_ms = NULL
            WHERE message_id = ? AND wake_state != 'content_acknowledged'
          `)
          .run(id);
        return true;
      })
      .immediate();
  }

  /** Remove wakes whose message bodies were consumed by central but lost with the prior process. */
  discardUnrecoverable(): number {
    const result = resourcesFor(this)
      .database.prepare("DELETE FROM notification_relay WHERE wake_state != 'content_acknowledged'")
      .run();
    return changes(result.changes, "unrecoverable notification discard");
  }

  recoverInFlight(
    nowMs: number,
    nextWakeRetryAtMs: (attemptCount: number) => number,
  ): NotificationRecoveryResult {
    const { database } = resourcesFor(this);
    const now = inputTimestamp(nowMs, "nowMs");
    return database
      .transaction(() => {
        const acknowledgementUpdate = database
          .prepare(`
            UPDATE notification_relay
            SET notification_ack_state = 'pending',
                notification_ack_next_attempt_at_ms = ?
            WHERE notification_ack_state = 'in_flight'
          `)
          .run(now);
        const wakeRows = database
          .prepare<[], Pick<NotificationRow, "message_id" | "wake_attempt_count">>(`
            SELECT message_id, wake_attempt_count
            FROM notification_relay
            WHERE wake_state = 'in_flight'
            ORDER BY message_id
          `)
          .all();
        const updateWake = database.prepare(`
          UPDATE notification_relay
          SET wake_state = 'retry_wait',
              wake_next_attempt_at_ms = ?,
              wake_may_have_reached = 1
          WHERE message_id = ? AND wake_state = 'in_flight'
        `);
        for (const row of wakeRows) {
          const count = attemptCount(row.wake_attempt_count, "wake_attempt_count");
          const nextAttemptAt = inputTimestamp(nextWakeRetryAtMs(count), "nextWakeRetryAtMs");
          const update = updateWake.run(nextAttemptAt, row.message_id);
          if (changes(update.changes, "wake recovery") !== 1) {
            throw new Error("failed to recover an in-flight wake");
          }
        }
        return {
          notificationAcknowledgements: changes(
            acknowledgementUpdate.changes,
            "notification acknowledgement recovery",
          ),
          wakes: wakeRows.length,
        };
      })
      .immediate();
  }

  nextNotificationAcknowledgementAtMs(): number | null {
    const row = resourcesFor(this)
      .database.prepare<[], { next_attempt_at_ms: bigint | null }>(`
        SELECT MIN(notification_ack_next_attempt_at_ms) AS next_attempt_at_ms
        FROM notification_relay
        WHERE notification_ack_state = 'pending'
      `)
      .get();
    return row?.next_attempt_at_ms === null || row?.next_attempt_at_ms === undefined
      ? null
      : inputTimestamp(
          safeInteger(row.next_attempt_at_ms, "notification_ack_next_attempt_at_ms"),
          "notification_ack_next_attempt_at_ms",
        );
  }

  nextWakeAtMs(): number | null {
    const row = resourcesFor(this)
      .database.prepare<[], { next_attempt_at_ms: bigint | null }>(`
        SELECT MIN(wake_next_attempt_at_ms) AS next_attempt_at_ms
        FROM notification_relay
        WHERE wake_state IN ('pending', 'retry_wait', 'accepted_wait')
      `)
      .get();
    return row?.next_attempt_at_ms === null || row?.next_attempt_at_ms === undefined
      ? null
      : inputTimestamp(
          safeInteger(row.next_attempt_at_ms, "wake_next_attempt_at_ms"),
          "wake_next_attempt_at_ms",
        );
  }
}
