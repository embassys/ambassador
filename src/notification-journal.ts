import Database from "better-sqlite3";

import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const TABLE_SQL = `
  CREATE TABLE notification_delivery (
    message_id TEXT PRIMARY KEY CHECK (
      length(message_id) BETWEEN 1 AND 128
      AND message_id NOT GLOB '*[^A-Za-z0-9._~-]*'
    ),
    delivery_state TEXT NOT NULL CHECK (
      delivery_state IN ('pending', 'delivering', 'accepted', 'completed', 'acknowledging')
    )
  ) STRICT
`;

export type NotificationDeliveryState =
  | "pending"
  | "delivering"
  | "accepted"
  | "completed"
  | "acknowledging";

export interface NotificationDeliveryRecord {
  readonly messageId: string;
  readonly deliveryState: NotificationDeliveryState;
}

export interface NotificationIngestResult {
  readonly inserted: number;
  readonly duplicates: number;
}

interface NotificationRow {
  readonly message_id: string;
  readonly delivery_state: string;
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

function safeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid count");
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid count");
  }
  return value;
}

function deliveryState(value: string): NotificationDeliveryState {
  if (["pending", "delivering", "accepted", "completed", "acknowledging"].includes(value)) {
    return value as NotificationDeliveryState;
  }
  throw new Error("notification journal contains an invalid delivery state");
}

function record(row: NotificationRow): NotificationDeliveryRecord {
  return {
    messageId: validateNotificationId(row.message_id),
    deliveryState: deliveryState(row.delivery_state),
  };
}

function normalizedSql(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

function initialize(database: Database.Database): void {
  database
    .transaction(() => {
      const version = safeInteger(database.pragma("user_version", { simple: true }));
      if (version > SCHEMA_VERSION) throw new Error("notification journal schema is too new");
      if (version === 0) {
        const row = database
          .prepare<[], { count: bigint }>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
          )
          .get();
        if (row === undefined || safeInteger(row.count) !== 0) {
          throw new Error("notification journal has an obsolete or unversioned schema");
        }
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
        rows[0]?.name !== "notification_delivery" ||
        rows[0].sql === null ||
        normalizedSql(rows[0].sql) !== normalizedSql(TABLE_SQL)
      ) {
        throw new Error("notification journal schema is invalid");
      }
    })
    .immediate();
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
      initialize(database);
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

  ingest(messageIds: readonly string[]): NotificationIngestResult {
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
          "INSERT INTO notification_delivery (message_id, delivery_state) VALUES (?, 'pending') ON CONFLICT(message_id) DO NOTHING",
        );
        let inserted = 0;
        for (const id of unique) {
          const changes = safeInteger(insert.run(id).changes);
          inserted += changes;
          if (changes === 0) duplicates += 1;
        }
        return { inserted, duplicates };
      })
      .immediate();
  }

  get(messageId: string): NotificationDeliveryRecord | undefined {
    const row = resourcesFor(this)
      .database.prepare<[string], NotificationRow>(
        "SELECT message_id, delivery_state FROM notification_delivery WHERE message_id = ?",
      )
      .get(validateNotificationId(messageId));
    return row === undefined ? undefined : record(row);
  }

  count(): number {
    const row = resourcesFor(this)
      .database.prepare<[], { count: bigint }>(
        "SELECT count(*) AS count FROM notification_delivery",
      )
      .get();
    if (row === undefined) throw new Error("notification journal count failed");
    return safeInteger(row.count);
  }

  discardUndelivered(): number {
    return safeInteger(
      resourcesFor(this)
        .database.prepare(
          "DELETE FROM notification_delivery WHERE delivery_state IN ('pending', 'delivering')",
        )
        .run().changes,
    );
  }

  recoverableAcknowledgements(): NotificationDeliveryRecord[] {
    return resourcesFor(this)
      .database.prepare<[], NotificationRow>(
        "SELECT message_id, delivery_state FROM notification_delivery WHERE delivery_state IN ('accepted', 'completed') ORDER BY message_id",
      )
      .all()
      .map(record);
  }

  beginDelivery(messageId: string): void {
    this.#transition(messageId, ["pending"], "delivering");
  }

  recordDelivered(messageId: string, state: "accepted" | "completed"): void {
    this.#transition(messageId, ["delivering"], state);
  }

  beginAcknowledgement(messageId: string): void {
    this.#transition(messageId, ["accepted", "completed"], "acknowledging");
  }

  removeAcknowledged(messageId: string): void {
    const id = validateNotificationId(messageId);
    const changes = safeInteger(
      resourcesFor(this)
        .database.prepare(
          "DELETE FROM notification_delivery WHERE message_id = ? AND delivery_state = 'acknowledging'",
        )
        .run(id).changes,
    );
    if (changes !== 1) throw new Error("notification acknowledgement removal failed");
  }

  #transition(
    messageId: string,
    from: readonly NotificationDeliveryState[],
    to: NotificationDeliveryState,
  ): void {
    const id = validateNotificationId(messageId);
    const placeholders = from.map(() => "?").join(", ");
    const changes = safeInteger(
      resourcesFor(this)
        .database.prepare(
          `UPDATE notification_delivery SET delivery_state = ? WHERE message_id = ? AND delivery_state IN (${placeholders})`,
        )
        .run(to, id, ...from).changes,
    );
    if (changes !== 1) throw new Error("notification journal transition failed");
  }
}
