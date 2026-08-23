import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";

import Database from "better-sqlite3";

import type { Notification, PollResponse, WakeReportStatus } from "./protocol.js";

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const MIN_DATE_MS = -8_640_000_000_000_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const DELIVERY_COLUMNS = `
  notification_id,
  delivery_id,
  binding_id,
  binding_fingerprint,
  issued_at_ms,
  expires_at_ms,
  state,
  attempt_count,
  next_attempt_at_ms,
  runtime_session_id,
  may_have_reached_runtime,
  report_sequence
`;

const REPORT_REASONS = {
  retrying: new Set(["runtime_unavailable", "rate_limited", "timeout", "outcome_unknown"]),
  failed: new Set([
    "binding_not_found",
    "unauthorized",
    "invalid_config",
    "unsupported_runtime",
    "rejected",
  ]),
  uncertain: new Set(["expired_after_attempt", "retry_window_exhausted", "binding_changed"]),
} as const;

export type DeliveryState =
  | "pending"
  | "waking"
  | "retry_wait"
  | "accepted"
  | "failed"
  | "expired"
  | "uncertain";

export interface DeliveryRecord {
  notificationId: string;
  deliveryId: string;
  bindingId: string;
  bindingFingerprint?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  state: DeliveryState;
  attemptCount: number;
  nextAttemptAtMs: number;
  runtimeSessionId?: string;
  mayHaveReachedRuntime: boolean;
  reportSequence: number;
}

export type OutboxRecord =
  | {
      id: string;
      kind: "ack";
      notificationId: string;
      deliveryId: string;
      persistedAt: string;
    }
  | {
      id: string;
      kind: "report";
      notificationId: string;
      deliveryId: string;
      sequence: number;
      status: WakeReportStatus;
      reason?: string;
      observedAt: string;
      nextAttemptAt?: string;
    };

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export interface ClaimResult {
  status: "claimed" | "not_due" | "binding_changed";
  delivery?: DeliveryRecord;
}

export interface RecordedWakeResult {
  status: WakeReportStatus;
  reason?: string;
  nextAttemptAtMs?: number;
  sessionId?: string;
  mayHaveReachedRuntime?: boolean;
}

interface DeliveryRow {
  notification_id: string;
  delivery_id: string;
  binding_id: string;
  binding_fingerprint: string | null;
  issued_at_ms: bigint;
  expires_at_ms: bigint;
  state: string;
  attempt_count: bigint;
  next_attempt_at_ms: bigint;
  runtime_session_id: string | null;
  may_have_reached_runtime: bigint;
  report_sequence: bigint;
}

interface OutboxRow {
  id: string;
  kind: string;
  notification_id: string;
  delivery_id: string;
  sequence: bigint | null;
  status: string | null;
  reason: string | null;
  persisted_at_ms: bigint | null;
  observed_at_ms: bigint | null;
  next_attempt_at_ms: bigint | null;
}

interface ValidatedNotification {
  notification: Notification;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface JournalResources {
  database: Database.Database;
  idGenerator: () => string;
}

const journalResources = new WeakMap<object, JournalResources>();

function resourcesFor(journal: object): JournalResources {
  const resources = journalResources.get(journal);
  if (resources === undefined) throw new Error("journal is not initialized");
  return resources;
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(MAX_SAFE_INTEGER)) {
      throw new Error(`journal ${field} is outside the safe integer range`);
    }
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`journal ${field} is not a safe integer`);
  }
  return value;
}

function inputInteger(value: number, field: string, minimum = 0): number {
  const integer = safeInteger(value, field);
  if (integer < minimum) throw new RangeError(`${field} must be at least ${minimum}`);
  return integer;
}

function timestampMs(value: number, field: string): number {
  const timestamp = safeInteger(value, field);
  if (timestamp < MIN_DATE_MS || timestamp > MAX_DATE_MS) {
    throw new RangeError(`${field} is outside the supported date range`);
  }
  return timestamp;
}

function parseTimestamp(value: string, field: string): number {
  if (typeof value !== "string") throw new TypeError(`${field} must be a timestamp string`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid timestamp`);
  return timestampMs(parsed, field);
}

function isoTimestamp(value: unknown, field: string): string {
  return new Date(timestampMs(safeInteger(value, field), field)).toISOString();
}

function protocolId(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new TypeError(`${field} must be a valid protocol ID`);
  }
  return value;
}

function boundedText(value: string, field: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new TypeError(`${field} must be between 1 and ${maximumLength} characters`);
  }
  return value;
}

function deliveryState(value: string): DeliveryState {
  switch (value) {
    case "pending":
    case "waking":
    case "retry_wait":
    case "accepted":
    case "failed":
    case "expired":
    case "uncertain":
      return value;
    default:
      throw new Error("journal contains an invalid delivery state");
  }
}

function reportStatus(value: string): WakeReportStatus {
  switch (value) {
    case "accepted":
    case "retrying":
    case "failed":
    case "expired":
    case "uncertain":
      return value;
    default:
      throw new Error("journal contains an invalid report status");
  }
}

function adjustedTimestamp(value: number, offset: number, operation: "add" | "subtract"): number {
  const adjusted = operation === "add" ? value + offset : value - offset;
  return timestampMs(safeInteger(adjusted, "adjusted timestamp"), "adjusted timestamp");
}

function controllerClockOffset(database: Database.Database): number {
  const row = database
    .prepare<[], { controller_clock_offset_ms: bigint }>(`
      SELECT controller_clock_offset_ms
      FROM sidecar_state
      WHERE singleton = 1
    `)
    .get();
  if (row === undefined) throw new Error("journal state row is missing");
  return safeInteger(row.controller_clock_offset_ms, "controller_clock_offset_ms");
}

function deliveryRecord(row: DeliveryRow, clockOffset: number): DeliveryRecord {
  const mayHaveReachedRuntime = safeInteger(
    row.may_have_reached_runtime,
    "may_have_reached_runtime",
  );
  if (mayHaveReachedRuntime !== 0 && mayHaveReachedRuntime !== 1) {
    throw new Error("journal contains an invalid runtime outcome flag");
  }

  return {
    notificationId: row.notification_id,
    deliveryId: row.delivery_id,
    bindingId: row.binding_id,
    ...(row.binding_fingerprint === null ? {} : { bindingFingerprint: row.binding_fingerprint }),
    issuedAtMs: adjustedTimestamp(
      timestampMs(safeInteger(row.issued_at_ms, "issued_at_ms"), "issued_at_ms"),
      clockOffset,
      "subtract",
    ),
    expiresAtMs: adjustedTimestamp(
      timestampMs(safeInteger(row.expires_at_ms, "expires_at_ms"), "expires_at_ms"),
      clockOffset,
      "subtract",
    ),
    state: deliveryState(row.state),
    attemptCount: inputInteger(safeInteger(row.attempt_count, "attempt_count"), "attempt_count"),
    nextAttemptAtMs: timestampMs(
      safeInteger(row.next_attempt_at_ms, "next_attempt_at_ms"),
      "next_attempt_at_ms",
    ),
    ...(row.runtime_session_id === null ? {} : { runtimeSessionId: row.runtime_session_id }),
    mayHaveReachedRuntime: mayHaveReachedRuntime === 1,
    reportSequence: inputInteger(
      safeInteger(row.report_sequence, "report_sequence"),
      "report_sequence",
    ),
  };
}

function sameNotification(row: DeliveryRow, value: ValidatedNotification): boolean {
  const { notification, issuedAtMs, expiresAtMs } = value;
  return (
    row.notification_id === notification.notification_id &&
    row.delivery_id === notification.delivery_id &&
    row.binding_id === notification.binding_id &&
    safeInteger(row.issued_at_ms, "issued_at_ms") === issuedAtMs &&
    safeInteger(row.expires_at_ms, "expires_at_ms") === expiresAtMs
  );
}

function sameBatchNotification(left: Notification, right: Notification): boolean {
  return (
    left.notification_id === right.notification_id &&
    left.delivery_id === right.delivery_id &&
    left.binding_id === right.binding_id &&
    left.issued_at === right.issued_at &&
    left.expires_at === right.expires_at
  );
}

function validateWakeResult(result: RecordedWakeResult): void {
  if (result.sessionId !== undefined) {
    protocolId(result.sessionId, "sessionId");
    if (result.status !== "accepted") {
      throw new TypeError("sessionId is allowed only for an accepted result");
    }
  }
  if (
    result.mayHaveReachedRuntime !== undefined &&
    typeof result.mayHaveReachedRuntime !== "boolean"
  ) {
    throw new TypeError("mayHaveReachedRuntime must be a boolean");
  }

  switch (result.status) {
    case "accepted":
    case "expired":
      if (result.reason !== undefined || result.nextAttemptAtMs !== undefined) {
        throw new TypeError(`${result.status} results omit reason and nextAttemptAtMs`);
      }
      return;
    case "retrying":
      if (result.reason === undefined || !REPORT_REASONS.retrying.has(result.reason)) {
        throw new TypeError("retrying result has an invalid reason");
      }
      if (result.nextAttemptAtMs === undefined) {
        throw new TypeError("retrying result requires nextAttemptAtMs");
      }
      timestampMs(result.nextAttemptAtMs, "nextAttemptAtMs");
      return;
    case "failed":
      if (result.reason === undefined || !REPORT_REASONS.failed.has(result.reason)) {
        throw new TypeError("failed result has an invalid reason");
      }
      if (result.nextAttemptAtMs !== undefined) {
        throw new TypeError("failed results omit nextAttemptAtMs");
      }
      return;
    case "uncertain":
      if (result.reason === undefined || !REPORT_REASONS.uncertain.has(result.reason)) {
        throw new TypeError("uncertain result has an invalid reason");
      }
      if (result.nextAttemptAtMs !== undefined) {
        throw new TypeError("uncertain results omit nextAttemptAtMs");
      }
      return;
    default:
      throw new TypeError("wake result has an invalid status");
  }
}

function invalidJournalArtifact(): Error {
  return new Error("Journal path must be a regular file");
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function prepareJournalArtifact(path: string): void {
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!lstatSync(path).isFile()) throw invalidJournalArtifact();
      descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }

    const descriptorStats = fstatSync(descriptor);
    const pathStats = lstatSync(path);
    if (
      !descriptorStats.isFile() ||
      !pathStats.isFile() ||
      descriptorStats.dev !== pathStats.dev ||
      descriptorStats.ino !== pathStats.ino
    ) {
      throw invalidJournalArtifact();
    }
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class Journal {
  constructor(path: string, idGenerator: () => string = crypto.randomUUID) {
    prepareJournalArtifact(path);
    const database = new Database(path, { timeout: BUSY_TIMEOUT_MS });

    try {
      database.defaultSafeIntegers(true);
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      database.pragma("trusted_schema = OFF");
      migrate(database);
      journalResources.set(this, { database, idGenerator });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    const { database } = resourcesFor(this);
    if (database.open) database.close();
  }

  ingestPoll(
    response: PollResponse,
    capacity: number,
    persistedAtMs: number,
    controllerObservedAtMs: number = persistedAtMs,
  ): IngestResult {
    const { database, idGenerator } = resourcesFor(this);
    if (response.protocol_version !== 1) throw new TypeError("unsupported poll protocol version");
    const queueCapacity = inputInteger(capacity, "capacity");
    const persistedAt = timestampMs(persistedAtMs, "persistedAtMs");
    const controllerObservedAt = timestampMs(controllerObservedAtMs, "controllerObservedAtMs");
    const serverTime = parseTimestamp(response.server_time, "server_time");
    const clockOffset = safeInteger(
      serverTime - controllerObservedAt,
      "controller_clock_offset_ms",
    );
    protocolId(response.cursor, "cursor");

    const uniqueByNotification = new Map<string, ValidatedNotification>();
    const notificationByDelivery = new Map<string, string>();
    let duplicateCount = 0;

    for (const notification of response.notifications) {
      protocolId(notification.notification_id, "notification_id");
      protocolId(notification.delivery_id, "delivery_id");
      protocolId(notification.binding_id, "binding_id");
      const validated = {
        notification,
        issuedAtMs: parseTimestamp(notification.issued_at, "issued_at"),
        expiresAtMs: parseTimestamp(notification.expires_at, "expires_at"),
      };
      const earlierNotification = uniqueByNotification.get(notification.notification_id);
      if (earlierNotification !== undefined) {
        if (!sameBatchNotification(earlierNotification.notification, notification)) {
          throw new Error("poll batch reuses a notification ID with different fields");
        }
        duplicateCount += 1;
        continue;
      }
      const earlierDeliveryNotification = notificationByDelivery.get(notification.delivery_id);
      if (
        earlierDeliveryNotification !== undefined &&
        earlierDeliveryNotification !== notification.notification_id
      ) {
        throw new Error("poll batch reuses a delivery ID for another notification");
      }
      uniqueByNotification.set(notification.notification_id, validated);
      notificationByDelivery.set(notification.delivery_id, notification.notification_id);
    }

    return database
      .transaction(() => {
        const unseen: ValidatedNotification[] = [];
        let duplicates = duplicateCount;
        const getByNotification = database.prepare<[string], DeliveryRow>(`
          SELECT ${DELIVERY_COLUMNS}
          FROM deliveries
          WHERE notification_id = ?
        `);
        const getByDelivery = database.prepare<[string], DeliveryRow>(`
          SELECT ${DELIVERY_COLUMNS}
          FROM deliveries
          WHERE delivery_id = ?
        `);

        for (const validated of uniqueByNotification.values()) {
          const { notification } = validated;
          const existingNotification = getByNotification.get(notification.notification_id);
          if (existingNotification !== undefined) {
            if (!sameNotification(existingNotification, validated)) {
              throw new Error("notification ID conflicts with the durable journal");
            }
            duplicates += 1;
            continue;
          }
          if (getByDelivery.get(notification.delivery_id) !== undefined) {
            throw new Error("delivery ID is already assigned to another notification");
          }
          unseen.push(validated);
        }

        const countRow = database
          .prepare<[], { count: bigint }>(`
            SELECT count(*) AS count
            FROM deliveries
            WHERE state IN ('pending', 'waking', 'retry_wait')
          `)
          .get();
        if (countRow === undefined) throw new Error("failed to count active deliveries");
        const active = inputInteger(safeInteger(countRow.count, "active count"), "active count");
        if (active + unseen.length > queueCapacity) {
          throw new Error("poll batch exceeds active delivery capacity");
        }

        const insertDelivery = database.prepare(`
          INSERT INTO deliveries (
            notification_id,
            delivery_id,
            binding_id,
            issued_at_ms,
            expires_at_ms,
            state,
            attempt_count,
            next_attempt_at_ms,
            may_have_reached_runtime,
            report_sequence
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 0, 0)
        `);
        const insertAcknowledgement = database.prepare(`
          INSERT INTO outbox (
            id,
            kind,
            notification_id,
            delivery_id,
            persisted_at_ms,
            send_attempts
          ) VALUES (?, 'ack', ?, ?, ?, 0)
        `);

        for (const validated of unseen) {
          const { notification, issuedAtMs, expiresAtMs } = validated;
          insertDelivery.run(
            notification.notification_id,
            notification.delivery_id,
            notification.binding_id,
            issuedAtMs,
            expiresAtMs,
            adjustedTimestamp(issuedAtMs, clockOffset, "subtract"),
          );
          insertAcknowledgement.run(
            nextOutboxId(idGenerator),
            notification.notification_id,
            notification.delivery_id,
            adjustedTimestamp(persistedAt, clockOffset, "add"),
          );
        }

        database
          .prepare(`
            UPDATE sidecar_state
            SET poll_cursor = ?, controller_clock_offset_ms = ?
            WHERE singleton = 1
          `)
          .run(response.cursor, clockOffset);

        return { inserted: unseen.length, duplicates };
      })
      .immediate();
  }

  getCursor(): string | null {
    const row = resourcesFor(this)
      .database.prepare<[], { poll_cursor: string | null }>(`
        SELECT poll_cursor
        FROM sidecar_state
        WHERE singleton = 1
      `)
      .get();
    if (row === undefined) throw new Error("journal state row is missing");
    return row.poll_cursor;
  }

  getControllerClockOffsetMs(): number | undefined {
    const row = resourcesFor(this)
      .database.prepare<[], { poll_cursor: string | null; controller_clock_offset_ms: bigint }>(`
        SELECT poll_cursor, controller_clock_offset_ms
        FROM sidecar_state
        WHERE singleton = 1
      `)
      .get();
    if (row === undefined) throw new Error("journal state row is missing");
    return row.poll_cursor === null
      ? undefined
      : safeInteger(row.controller_clock_offset_ms, "controller_clock_offset_ms");
  }

  getDelivery(deliveryId: string): DeliveryRecord | undefined {
    protocolId(deliveryId, "deliveryId");
    const { database } = resourcesFor(this);
    const row = database
      .prepare<[string], DeliveryRow>(`
        SELECT ${DELIVERY_COLUMNS}
        FROM deliveries
        WHERE delivery_id = ?
      `)
      .get(deliveryId);
    return row === undefined ? undefined : deliveryRecord(row, controllerClockOffset(database));
  }

  listDue(nowMs: number, limit: number): DeliveryRecord[] {
    const { database } = resourcesFor(this);
    const now = timestampMs(nowMs, "nowMs");
    const clockOffset = controllerClockOffset(database);
    const controllerNow = adjustedTimestamp(now, clockOffset, "add");
    const rowLimit = inputInteger(limit, "limit");
    if (rowLimit === 0) return [];
    return database
      .prepare<[number, number, number], DeliveryRow>(`
        SELECT ${DELIVERY_COLUMNS}
        FROM deliveries
        WHERE state IN ('pending', 'retry_wait')
          AND next_attempt_at_ms <= ?
          AND expires_at_ms > ?
        ORDER BY next_attempt_at_ms, issued_at_ms, rowid
        LIMIT ?
      `)
      .all(now, controllerNow, rowLimit)
      .map((row) => deliveryRecord(row, clockOffset));
  }

  claimDelivery(deliveryId: string, fingerprint: string, nowMs: number): ClaimResult {
    const { database, idGenerator } = resourcesFor(this);
    protocolId(deliveryId, "deliveryId");
    boundedText(fingerprint, "fingerprint", 512);
    const now = timestampMs(nowMs, "nowMs");
    const clockOffset = controllerClockOffset(database);
    const controllerNow = adjustedTimestamp(now, clockOffset, "add");

    return database
      .transaction((): ClaimResult => {
        const row = getDeliveryRow(database, deliveryId);
        if (
          row === undefined ||
          (row.state !== "pending" && row.state !== "retry_wait") ||
          safeInteger(row.next_attempt_at_ms, "next_attempt_at_ms") > now ||
          safeInteger(row.expires_at_ms, "expires_at_ms") <= controllerNow
        ) {
          return { status: "not_due" };
        }

        const mayHaveReachedRuntime =
          safeInteger(row.may_have_reached_runtime, "may_have_reached_runtime") === 1;
        if (
          row.binding_fingerprint !== null &&
          row.binding_fingerprint !== fingerprint &&
          mayHaveReachedRuntime
        ) {
          const sequence = nextReportSequence(row);
          database
            .prepare(`
              UPDATE deliveries
              SET state = 'uncertain', report_sequence = ?
              WHERE delivery_id = ?
            `)
            .run(sequence, deliveryId);
          insertReport(
            database,
            idGenerator,
            row,
            sequence,
            "uncertain",
            "binding_changed",
            controllerNow,
            null,
          );
          return { status: "binding_changed" };
        }

        const update = database
          .prepare(`
            UPDATE deliveries
            SET binding_fingerprint = ?,
                state = 'waking',
                attempt_count = attempt_count + 1
            WHERE delivery_id = ?
              AND state IN ('pending', 'retry_wait')
              AND next_attempt_at_ms <= ?
              AND expires_at_ms > ?
          `)
          .run(fingerprint, deliveryId, now, controllerNow);
        if (safeInteger(update.changes, "claim changes") !== 1) return { status: "not_due" };

        const claimed = getDeliveryRow(database, deliveryId);
        if (claimed === undefined) throw new Error("claimed delivery disappeared");
        return { status: "claimed", delivery: deliveryRecord(claimed, clockOffset) };
      })
      .immediate();
  }

  recordWakeResult(deliveryId: string, result: RecordedWakeResult, observedAtMs: number): void {
    const { database, idGenerator } = resourcesFor(this);
    protocolId(deliveryId, "deliveryId");
    validateWakeResult(result);
    const observedAt = timestampMs(observedAtMs, "observedAtMs");
    const clockOffset = controllerClockOffset(database);

    database
      .transaction(() => {
        const row = getDeliveryRow(database, deliveryId);
        if (row === undefined) throw new Error("cannot record a result for an unknown delivery");
        const currentState = deliveryState(row.state);
        const active =
          currentState === "pending" || currentState === "waking" || currentState === "retry_wait";
        if (!active) throw new Error("cannot transition a terminal delivery");
        if (
          (result.status === "accepted" || result.status === "retrying") &&
          currentState !== "waking"
        ) {
          throw new Error(`${result.status} requires an in-flight delivery`);
        }
        const sequence = nextReportSequence(row);
        const state: DeliveryState = result.status === "retrying" ? "retry_wait" : result.status;
        const previousMayHaveReached =
          safeInteger(row.may_have_reached_runtime, "may_have_reached_runtime") === 1;
        const mayHaveReachedRuntime =
          previousMayHaveReached ||
          result.mayHaveReachedRuntime === true ||
          result.status === "accepted";
        const nextAttemptAt =
          result.status === "retrying" && result.nextAttemptAtMs !== undefined
            ? result.nextAttemptAtMs
            : safeInteger(row.next_attempt_at_ms, "next_attempt_at_ms");
        const runtimeSessionId = result.sessionId ?? row.runtime_session_id;

        database
          .prepare(`
            UPDATE deliveries
            SET state = ?,
                next_attempt_at_ms = ?,
                runtime_session_id = ?,
                may_have_reached_runtime = ?,
                report_sequence = ?
            WHERE delivery_id = ?
          `)
          .run(
            state,
            nextAttemptAt,
            runtimeSessionId,
            mayHaveReachedRuntime ? 1 : 0,
            sequence,
            deliveryId,
          );
        insertReport(
          database,
          idGenerator,
          row,
          sequence,
          result.status,
          result.reason ?? null,
          adjustedTimestamp(observedAt, clockOffset, "add"),
          result.nextAttemptAtMs === undefined
            ? null
            : adjustedTimestamp(result.nextAttemptAtMs, clockOffset, "add"),
        );
      })
      .immediate();
  }

  expireDue(nowMs: number): number {
    const { database, idGenerator } = resourcesFor(this);
    const now = timestampMs(nowMs, "nowMs");
    const clockOffset = controllerClockOffset(database);
    const controllerNow = adjustedTimestamp(now, clockOffset, "add");
    return database
      .transaction(() => {
        const rows = database
          .prepare<[number], DeliveryRow>(`
            SELECT ${DELIVERY_COLUMNS}
            FROM deliveries
            WHERE state IN ('pending', 'retry_wait')
              AND expires_at_ms <= ?
            ORDER BY expires_at_ms, rowid
          `)
          .all(controllerNow);
        const update = database.prepare(`
          UPDATE deliveries
          SET state = ?, report_sequence = ?
          WHERE delivery_id = ?
        `);

        for (const row of rows) {
          const mayHaveReachedRuntime =
            safeInteger(row.may_have_reached_runtime, "may_have_reached_runtime") === 1;
          const status: WakeReportStatus = mayHaveReachedRuntime ? "uncertain" : "expired";
          const reason = mayHaveReachedRuntime ? "expired_after_attempt" : null;
          const sequence = nextReportSequence(row);
          update.run(status, sequence, row.delivery_id);
          insertReport(database, idGenerator, row, sequence, status, reason, controllerNow, null);
        }
        return rows.length;
      })
      .immediate();
  }

  recoverInFlight(nowMs: number): number {
    const { database, idGenerator } = resourcesFor(this);
    const now = timestampMs(nowMs, "nowMs");
    const clockOffset = controllerClockOffset(database);
    const controllerNow = adjustedTimestamp(now, clockOffset, "add");
    return database
      .transaction(() => {
        const rows = database
          .prepare<[], DeliveryRow>(`
            SELECT ${DELIVERY_COLUMNS}
            FROM deliveries
            WHERE state = 'waking'
            ORDER BY rowid
          `)
          .all();
        const update = database.prepare(`
          UPDATE deliveries
          SET state = ?,
              next_attempt_at_ms = ?,
              may_have_reached_runtime = 1,
              report_sequence = ?
          WHERE delivery_id = ?
        `);

        for (const row of rows) {
          const expired = safeInteger(row.expires_at_ms, "expires_at_ms") <= controllerNow;
          const status: WakeReportStatus = expired ? "uncertain" : "retrying";
          const reason = expired ? "expired_after_attempt" : "outcome_unknown";
          const nextAttemptAt = expired
            ? safeInteger(row.next_attempt_at_ms, "next_attempt_at_ms")
            : now;
          const sequence = nextReportSequence(row);
          update.run(
            expired ? "uncertain" : "retry_wait",
            nextAttemptAt,
            sequence,
            row.delivery_id,
          );
          insertReport(
            database,
            idGenerator,
            row,
            sequence,
            status,
            reason,
            controllerNow,
            expired ? null : controllerNow,
          );
        }
        return rows.length;
      })
      .immediate();
  }

  listOutbox(limit: number): OutboxRecord[] {
    const { database } = resourcesFor(this);
    const rowLimit = inputInteger(limit, "limit");
    if (rowLimit === 0) return [];
    return database
      .prepare<[number], OutboxRow>(`
        SELECT
          id,
          kind,
          notification_id,
          delivery_id,
          sequence,
          status,
          reason,
          persisted_at_ms,
          observed_at_ms,
          next_attempt_at_ms
        FROM outbox
        WHERE confirmed_at_ms IS NULL
        ORDER BY rowid
        LIMIT ?
      `)
      .all(rowLimit)
      .map((row): OutboxRecord => {
        if (row.kind === "ack") {
          if (row.persisted_at_ms === null) {
            throw new Error("journal acknowledgement has no persistence timestamp");
          }
          return {
            id: row.id,
            kind: "ack",
            notificationId: row.notification_id,
            deliveryId: row.delivery_id,
            persistedAt: isoTimestamp(row.persisted_at_ms, "persisted_at_ms"),
          };
        }
        if (
          row.kind !== "report" ||
          row.sequence === null ||
          row.status === null ||
          row.observed_at_ms === null
        ) {
          throw new Error("journal contains an invalid outbox row");
        }
        return {
          id: row.id,
          kind: "report",
          notificationId: row.notification_id,
          deliveryId: row.delivery_id,
          sequence: inputInteger(
            safeInteger(row.sequence, "report sequence"),
            "report sequence",
            1,
          ),
          status: reportStatus(row.status),
          ...(row.reason === null ? {} : { reason: row.reason }),
          observedAt: isoTimestamp(row.observed_at_ms, "observed_at_ms"),
          ...(row.next_attempt_at_ms === null
            ? {}
            : { nextAttemptAt: isoTimestamp(row.next_attempt_at_ms, "next_attempt_at_ms") }),
        };
      });
  }

  markOutboxAttempt(id: string): number {
    const { database } = resourcesFor(this);
    protocolId(id, "outbox id");
    return database
      .transaction(() => {
        const update = database
          .prepare(`
            UPDATE outbox
            SET send_attempts = send_attempts + 1
            WHERE id = ?
              AND confirmed_at_ms IS NULL
              AND send_attempts < ${MAX_SAFE_INTEGER}
          `)
          .run(id);
        if (safeInteger(update.changes, "outbox attempt changes") !== 1) {
          throw new Error("cannot mark an unavailable outbox record");
        }
        const row = database
          .prepare<[string], { send_attempts: bigint }>(`
            SELECT send_attempts
            FROM outbox
            WHERE id = ?
          `)
          .get(id);
        if (row === undefined) throw new Error("outbox record disappeared");
        return inputInteger(safeInteger(row.send_attempts, "send_attempts"), "send_attempts", 1);
      })
      .immediate();
  }

  hasPendingAcknowledgement(deliveryId: string): boolean {
    protocolId(deliveryId, "deliveryId");
    const row = resourcesFor(this)
      .database.prepare<[string], { pending: bigint }>(`
        SELECT EXISTS (
          SELECT 1
          FROM outbox
          WHERE kind = 'ack'
            AND delivery_id = ?
            AND confirmed_at_ms IS NULL
        ) AS pending
      `)
      .get(deliveryId);
    if (row === undefined) throw new Error("failed to inspect acknowledgement state");
    return safeInteger(row.pending, "pending acknowledgement") === 1;
  }

  nextActionAtMs(): number | null {
    const { database } = resourcesFor(this);
    const row = database
      .prepare<[], { next_attempt_at_ms: bigint | null; expires_at_ms: bigint | null }>(`
        SELECT
          MIN(next_attempt_at_ms) AS next_attempt_at_ms,
          MIN(expires_at_ms) AS expires_at_ms
        FROM deliveries
        WHERE state IN ('pending', 'retry_wait')
      `)
      .get();
    if (row === undefined || row.next_attempt_at_ms === null || row.expires_at_ms === null) {
      return null;
    }
    const nextAttempt = timestampMs(
      safeInteger(row.next_attempt_at_ms, "next_attempt_at_ms"),
      "next_attempt_at_ms",
    );
    const expiresAt = adjustedTimestamp(
      timestampMs(safeInteger(row.expires_at_ms, "expires_at_ms"), "expires_at_ms"),
      controllerClockOffset(database),
      "subtract",
    );
    return Math.min(nextAttempt, expiresAt);
  }

  confirmOutbox(id: string, confirmedAtMs: number): void {
    const { database } = resourcesFor(this);
    protocolId(id, "outbox id");
    const confirmedAt = timestampMs(confirmedAtMs, "confirmedAtMs");
    database
      .prepare(`
        UPDATE outbox
        SET confirmed_at_ms = ?
        WHERE id = ? AND confirmed_at_ms IS NULL
      `)
      .run(confirmedAt, id);
  }

  activeCount(): number {
    const row = resourcesFor(this)
      .database.prepare<[], { count: bigint }>(`
        SELECT count(*) AS count
        FROM deliveries
        WHERE state IN ('pending', 'waking', 'retry_wait')
      `)
      .get();
    if (row === undefined) throw new Error("failed to count active deliveries");
    return inputInteger(safeInteger(row.count, "active count"), "active count");
  }
}

function migrate(database: Database.Database): void {
  database
    .transaction(() => {
      const versionValue = database.pragma("user_version", { simple: true });
      const version = inputInteger(safeInteger(versionValue, "schema version"), "schema version");
      if (version > SCHEMA_VERSION) {
        throw new Error(`journal schema version ${version} is newer than this sidecar supports`);
      }

      if (version === 0) {
        const schemaRows = database
          .prepare<[], { count: bigint }>(`
              SELECT count(*) AS count
              FROM sqlite_schema
              WHERE name NOT LIKE 'sqlite_%'
            `)
          .get();
        if (
          schemaRows === undefined ||
          safeInteger(schemaRows.count, "schema object count") !== 0
        ) {
          throw new Error("journal has an unversioned schema");
        }
        createVersionOneSchema(database);
        database.pragma(`user_version = ${SCHEMA_VERSION}`);
      }

      const state = database
        .prepare<[], { schema_version: bigint }>(`
            SELECT schema_version
            FROM sidecar_state
            WHERE singleton = 1
          `)
        .get();
      if (
        state === undefined ||
        safeInteger(state.schema_version, "stored schema version") !== SCHEMA_VERSION
      ) {
        throw new Error("journal schema metadata does not match its migration version");
      }
    })
    .immediate();
}

function createVersionOneSchema(database: Database.Database): void {
  database.exec(`
      CREATE TABLE sidecar_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = ${SCHEMA_VERSION}),
        poll_cursor TEXT CHECK (
          poll_cursor IS NULL OR (
            length(poll_cursor) BETWEEN 1 AND 128
            AND poll_cursor NOT GLOB '*[^A-Za-z0-9._~-]*'
          )
        ),
        controller_clock_offset_ms INTEGER NOT NULL CHECK (
          controller_clock_offset_ms BETWEEN -${MAX_SAFE_INTEGER} AND ${MAX_SAFE_INTEGER}
        )
      ) STRICT;

      INSERT INTO sidecar_state (
        singleton,
        schema_version,
        poll_cursor,
        controller_clock_offset_ms
      ) VALUES (1, ${SCHEMA_VERSION}, NULL, 0);

      CREATE TABLE deliveries (
        notification_id TEXT NOT NULL UNIQUE CHECK (
          length(notification_id) BETWEEN 1 AND 128
          AND notification_id NOT GLOB '*[^A-Za-z0-9._~-]*'
        ),
        delivery_id TEXT PRIMARY KEY CHECK (
          length(delivery_id) BETWEEN 1 AND 128
          AND delivery_id NOT GLOB '*[^A-Za-z0-9._~-]*'
        ),
        binding_id TEXT NOT NULL CHECK (
          length(binding_id) BETWEEN 1 AND 128
          AND binding_id NOT GLOB '*[^A-Za-z0-9._~-]*'
        ),
        binding_fingerprint TEXT CHECK (
          binding_fingerprint IS NULL OR length(binding_fingerprint) BETWEEN 1 AND 512
        ),
        issued_at_ms INTEGER NOT NULL CHECK (
          issued_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        expires_at_ms INTEGER NOT NULL CHECK (
          expires_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'waking', 'retry_wait', 'accepted', 'failed', 'expired', 'uncertain')
        ),
        attempt_count INTEGER NOT NULL CHECK (
          attempt_count BETWEEN 0 AND ${MAX_SAFE_INTEGER}
        ),
        next_attempt_at_ms INTEGER NOT NULL CHECK (
          next_attempt_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        runtime_session_id TEXT CHECK (
          runtime_session_id IS NULL OR (
            length(runtime_session_id) BETWEEN 1 AND 128
            AND runtime_session_id NOT GLOB '*[^-A-Za-z0-9._~]*'
          )
        ),
        may_have_reached_runtime INTEGER NOT NULL CHECK (may_have_reached_runtime IN (0, 1)),
        report_sequence INTEGER NOT NULL CHECK (
          report_sequence BETWEEN 0 AND ${MAX_SAFE_INTEGER}
        ),
        UNIQUE (notification_id, delivery_id),
        CHECK (state != 'pending' OR (
          attempt_count = 0
          AND binding_fingerprint IS NULL
          AND may_have_reached_runtime = 0
        )),
        CHECK (state NOT IN ('waking', 'retry_wait', 'uncertain') OR attempt_count > 0),
        CHECK (may_have_reached_runtime = 0 OR attempt_count > 0)
      ) STRICT;

      CREATE INDEX deliveries_due_idx
      ON deliveries (next_attempt_at_ms, expires_at_ms)
      WHERE state IN ('pending', 'retry_wait');

      CREATE INDEX deliveries_expiry_idx
      ON deliveries (expires_at_ms)
      WHERE state IN ('pending', 'retry_wait');

      CREATE TABLE outbox (
        id TEXT PRIMARY KEY CHECK (
          length(id) BETWEEN 1 AND 128
          AND id NOT GLOB '*[^A-Za-z0-9._~-]*'
        ),
        kind TEXT NOT NULL CHECK (kind IN ('ack', 'report')),
        notification_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        sequence INTEGER CHECK (sequence BETWEEN 1 AND ${MAX_SAFE_INTEGER}),
        status TEXT CHECK (status IN ('accepted', 'retrying', 'failed', 'expired', 'uncertain')),
        reason TEXT CHECK (reason IN (
          'runtime_unavailable',
          'rate_limited',
          'timeout',
          'outcome_unknown',
          'binding_not_found',
          'unauthorized',
          'invalid_config',
          'unsupported_runtime',
          'rejected',
          'expired_after_attempt',
          'retry_window_exhausted',
          'binding_changed'
        )),
        persisted_at_ms INTEGER CHECK (
          persisted_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        observed_at_ms INTEGER CHECK (
          observed_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        next_attempt_at_ms INTEGER CHECK (
          next_attempt_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        send_attempts INTEGER NOT NULL DEFAULT 0 CHECK (
          send_attempts BETWEEN 0 AND ${MAX_SAFE_INTEGER}
        ),
        confirmed_at_ms INTEGER CHECK (
          confirmed_at_ms BETWEEN ${MIN_DATE_MS} AND ${MAX_DATE_MS}
        ),
        FOREIGN KEY (notification_id, delivery_id)
          REFERENCES deliveries (notification_id, delivery_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        CHECK (
          (
            kind = 'ack'
            AND sequence IS NULL
            AND status IS NULL
            AND reason IS NULL
            AND persisted_at_ms IS NOT NULL
            AND observed_at_ms IS NULL
            AND next_attempt_at_ms IS NULL
          ) OR (
            kind = 'report'
            AND sequence IS NOT NULL
            AND status IS NOT NULL
            AND persisted_at_ms IS NULL
            AND observed_at_ms IS NOT NULL
            AND (
              (status = 'accepted' AND reason IS NULL AND next_attempt_at_ms IS NULL)
              OR (status = 'retrying' AND reason IN (
                'runtime_unavailable', 'rate_limited', 'timeout', 'outcome_unknown'
              ) AND next_attempt_at_ms IS NOT NULL)
              OR (status = 'failed' AND reason IN (
                'binding_not_found', 'unauthorized', 'invalid_config',
                'unsupported_runtime', 'rejected'
              ) AND next_attempt_at_ms IS NULL)
              OR (status = 'expired' AND reason IS NULL AND next_attempt_at_ms IS NULL)
              OR (status = 'uncertain' AND reason IN (
                'expired_after_attempt', 'retry_window_exhausted', 'binding_changed'
              ) AND next_attempt_at_ms IS NULL)
            )
          )
        )
      ) STRICT;

      CREATE UNIQUE INDEX outbox_ack_notification_idx
      ON outbox (notification_id)
      WHERE kind = 'ack';

      CREATE UNIQUE INDEX outbox_report_sequence_idx
      ON outbox (notification_id, sequence)
      WHERE kind = 'report';

      CREATE INDEX outbox_unconfirmed_idx
      ON outbox (confirmed_at_ms)
      WHERE confirmed_at_ms IS NULL;
    `);
}

function getDeliveryRow(database: Database.Database, deliveryId: string): DeliveryRow | undefined {
  return database
    .prepare<[string], DeliveryRow>(`
        SELECT ${DELIVERY_COLUMNS}
        FROM deliveries
        WHERE delivery_id = ?
      `)
    .get(deliveryId);
}

function nextOutboxId(idGenerator: () => string): string {
  return protocolId(idGenerator(), "generated outbox ID");
}

function nextReportSequence(row: DeliveryRow): number {
  const current = inputInteger(
    safeInteger(row.report_sequence, "report_sequence"),
    "report_sequence",
  );
  if (current === MAX_SAFE_INTEGER) throw new Error("report sequence is exhausted");
  return current + 1;
}

function insertReport(
  database: Database.Database,
  idGenerator: () => string,
  row: DeliveryRow,
  sequence: number,
  status: WakeReportStatus,
  reason: string | null,
  observedAtMs: number,
  nextAttemptAtMs: number | null,
): void {
  database
    .prepare(`
        INSERT INTO outbox (
          id,
          kind,
          notification_id,
          delivery_id,
          sequence,
          status,
          reason,
          observed_at_ms,
          next_attempt_at_ms,
          send_attempts
        ) VALUES (?, 'report', ?, ?, ?, ?, ?, ?, ?, 0)
      `)
    .run(
      nextOutboxId(idGenerator),
      row.notification_id,
      row.delivery_id,
      sequence,
      status,
      reason,
      observedAtMs,
      nextAttemptAtMs,
    );
}
