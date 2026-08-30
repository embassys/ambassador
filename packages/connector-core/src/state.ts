import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import Database from "better-sqlite3";

import {
  ConnectorError,
  connectorError,
  type ProviderKind,
  RETIREMENT_BYTES,
  URI_UNRESERVED_ID_PATTERN,
  WEBHOOK_TOKEN_PATTERN,
} from "./constants.js";
import { CORRELATION_DDL, OWNER_DDL } from "./state-schema.js";

const OWNER_APPLICATION_ID = 0x4132434f;
const CORRELATION_APPLICATION_ID = 0x41324353;
const CORRELATION_LEAVES = new Set([
  "owner.sqlite3",
  "owner.sqlite3-journal",
  "correlation.sqlite3",
  "correlation.sqlite3-wal",
  "correlation.sqlite3-shm",
  "correlation.sqlite3-journal",
  "retired.v1",
]);
const LIVE_STATES = new Map<string, { correlation: Database.Database; owner: Database.Database }>();
const WAL_TARGET_BYTES = 4 * 1_024 * 1_024;
const WAL_HARD_BYTES = 16 * 1_024 * 1_024;

export type PairedStateFaultBarrier =
  | "conversation_update"
  | "uncertain_after_message_update"
  | "lost_reply_after_message_update"
  | "completion_after_conversation_update"
  | "reply_ack_after_conversation_update"
  | "completion_ack_after_conversation_update";

export interface StateOptions {
  stateDirectory: string;
  webhookToken: string;
  providerKind: ProviderKind;
  workingDirectory: string;
  nowMs?: number;
  filesystemQualification?: "proven_local" | "network" | "unproven";
  stateActionObserverForTest?: {
    observe(event: Readonly<Record<string, unknown>>): void;
  };
  reservation?: ConnectorStateReservation;
}

interface Keys {
  aes: Buffer;
  hmac: Buffer;
}

export interface StoredConversation {
  conversationHmac: Buffer;
  conversationId: string;
  sessionId: string | null;
  lifecycle: "binding" | "active" | "uncertain" | "closed";
}

export interface StoredMessage {
  messageHmac: Buffer;
  messageId: string;
  conversationHmac: Buffer;
  turnId: string | null;
  lifecycle: string;
  terminalOperation: "reply" | "complete" | null;
  completionOutcome: string | null;
  completionReason: string | null;
  retryKind: "reply" | "complete" | "outcome_lookup" | "ack" | null;
  retryNotBeforeMs: number | null;
  retryAttemptCount: number;
  turnStartedAtMs: number | null;
  turnDeadlineMs: number | null;
}

function normalizedSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function ownerSchemaDigest(value: string): string {
  return createHash("sha256").update(normalizedSql(value)).digest("hex");
}

function validateTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799_999) {
    connectorError("connector_state_unavailable");
  }
  return value;
}

function validatePrivateDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    connectorError("connector_state_unavailable");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o700) connectorError("connector_state_unavailable");
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined || metadata.uid !== effectiveUid)
      connectorError("connector_state_unavailable");
  }
}

function validateOwnedDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    connectorError("connector_state_unavailable");
  }
  if (process.platform !== "win32") {
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined || metadata.uid !== effectiveUid) {
      connectorError("connector_state_unavailable");
    }
  }
}

function validatePrivateFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    connectorError("connector_state_unavailable");
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o600) connectorError("connector_state_unavailable");
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined || metadata.uid !== effectiveUid)
      connectorError("connector_state_unavailable");
  }
}

function validateLeaves(stateDirectory: string, retirement = false): void {
  for (const leaf of readdirSync(stateDirectory)) {
    if (!CORRELATION_LEAVES.has(leaf)) {
      connectorError(retirement ? "connector_state_retire_refused" : "connector_state_unavailable");
    }
    const path = join(stateDirectory, leaf);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      connectorError(retirement ? "connector_state_retire_refused" : "connector_state_unavailable");
    }
    if (process.platform !== "win32") {
      const effectiveUid = process.geteuid?.();
      if (
        (metadata.mode & 0o777) !== 0o600 ||
        effectiveUid === undefined ||
        metadata.uid !== effectiveUid
      ) {
        connectorError(
          retirement ? "connector_state_retire_refused" : "connector_state_unavailable",
        );
      }
    }
  }
}

function ensureDirectory(path: string): void {
  if (!isAbsolute(path)) connectorError("connector_state_unavailable");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  validatePrivateDirectory(path);
}

function qualifyLocalStateDirectory(path: string): void {
  let type: number;
  try {
    type = Number(statfsSync(path).type);
  } catch {
    connectorError("connector_state_unavailable");
  }
  const localTypes =
    process.platform === "darwin"
      ? new Set([17, 23, 26])
      : new Set([0xef53, 0x0102_1994, 0x794c_7630, 0x5846_5342, 0x9123_683e, 0x2fc1_2fc1]);
  if (!localTypes.has(type)) connectorError("connector_state_unavailable");
}

function ensureProtectedStateDirectory(path: string): string[] {
  if (!isAbsolute(path)) connectorError("connector_state_unavailable");
  const accountHome = dirname(dirname(dirname(dirname(path))));
  validateOwnedDirectory(accountHome);
  const chain: string[] = [];
  const created: string[] = [];
  let current = path;
  while (current !== accountHome) {
    chain.push(current);
    current = dirname(current);
  }
  for (const directory of chain.reverse()) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
      created.push(directory);
    }
    validatePrivateDirectory(directory);
  }
  return created;
}

function configureOwner(database: Database.Database): void {
  database.pragma("busy_timeout=1000");
  database.pragma("synchronous=FULL");
  database.pragma("trusted_schema=OFF");
  database.pragma("temp_store=MEMORY");
  database.pragma("max_page_count=64");
  database.pragma("journal_size_limit=65536");
}

function configureCorrelation(database: Database.Database): void {
  database.pragma("synchronous=FULL");
  database.pragma("foreign_keys=ON");
  database.pragma("trusted_schema=OFF");
  database.pragma("temp_store=MEMORY");
  database.pragma("busy_timeout=1000");
  database.pragma("wal_autocheckpoint=256");
  database.pragma("journal_size_limit=4194304");
  database.pragma("max_page_count=65536");
}

function createOwner(path: string): void {
  const database = new Database(path);
  try {
    database.pragma("page_size=4096");
    database.pragma("journal_mode=DELETE");
    configureOwner(database);
    database.exec(OWNER_DDL);
    database.prepare("INSERT INTO owner_guard(singleton, ever_initialized) VALUES (1, 0)").run();
    database.pragma(`application_id=${OWNER_APPLICATION_ID}`);
    database.pragma("user_version=1");
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
  syncFile(path);
  syncFile(dirname(path));
}

function validateOwnerDatabase(database: Database.Database): void {
  if (
    database.pragma("application_id", { simple: true }) !== OWNER_APPLICATION_ID ||
    database.pragma("user_version", { simple: true }) !== 1 ||
    database.pragma("page_size", { simple: true }) !== 4_096 ||
    database.pragma("journal_mode", { simple: true }) !== "delete"
  )
    connectorError("connector_state_unavailable");
  const objects = database
    .prepare<[], { name: string; sql: string; type: string }>(
      "SELECT name, sql, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  if (
    objects.length !== 1 ||
    objects[0]?.name !== "owner_guard" ||
    objects[0].type !== "table" ||
    normalizedSql(objects[0].sql) !== normalizedSql(OWNER_DDL)
  )
    connectorError("connector_state_unavailable");
  const rows = database
    .prepare<[], { singleton: number; ever_initialized: number }>(
      "SELECT singleton, ever_initialized FROM owner_guard",
    )
    .all();
  if (
    rows.length !== 1 ||
    rows[0]?.singleton !== 1 ||
    (rows[0].ever_initialized !== 0 && rows[0].ever_initialized !== 1)
  )
    connectorError("connector_state_unavailable");
}

function openOwner(stateDirectory: string): Database.Database {
  const path = join(stateDirectory, "owner.sqlite3");
  if (!existsSync(path)) createOwner(path);
  validatePrivateFile(path);
  const database = new Database(path);
  try {
    configureOwner(database);
    validateOwnerDatabase(database);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof ConnectorError) throw error;
    connectorError("connector_state_unavailable");
  }
}

function acquireOwner(database: Database.Database): void {
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    if (error instanceof Error && /locked|busy/iu.test(error.message)) {
      connectorError("connector_already_running");
    }
    connectorError("connector_state_unavailable");
  }
}

function openOwnerForExclusiveCheck(stateDirectory: string): Database.Database {
  const path = join(stateDirectory, "owner.sqlite3");
  if (!existsSync(path)) createOwner(path);
  validatePrivateFile(path);
  const database = new Database(path);
  try {
    database.pragma("busy_timeout=1000");
    database.pragma("trusted_schema=OFF");
    database.pragma("temp_store=MEMORY");
    acquireOwner(database);
    validateOwnerDatabase(database);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof ConnectorError) throw error;
    connectorError("connector_state_unavailable");
  }
}

function validateStartMarker(
  stateDirectory: string,
  present = existsSync(join(stateDirectory, "retired.v1")),
): void {
  if (!present) return;
  const marker = join(stateDirectory, "retired.v1");
  validatePrivateFile(marker);
  if (readFileSync(marker).equals(RETIREMENT_BYTES)) connectorError("connector_state_retired");
  connectorError("connector_state_unavailable");
}

export class ConnectorStateReservation {
  #owner: Database.Database | undefined;

  constructor(
    readonly stateDirectory: string,
    owner: Database.Database,
  ) {
    this.#owner = owner;
  }

  take(stateDirectory: string): Database.Database {
    if (stateDirectory !== this.stateDirectory || this.#owner === undefined) {
      connectorError("connector_state_unavailable");
    }
    const owner = this.#owner;
    this.#owner = undefined;
    return owner;
  }

  close(): void {
    const owner = this.#owner;
    this.#owner = undefined;
    if (owner === undefined) return;
    try {
      owner.exec("ROLLBACK");
    } catch {}
    owner.close();
  }
}

export function reserveConnectorState(
  stateDirectory: string,
  retirement = false,
): ConnectorStateReservation {
  const created = ensureProtectedStateDirectory(stateDirectory);
  try {
    qualifyLocalStateDirectory(stateDirectory);
    validateLeaves(stateDirectory, retirement);
    if (!retirement) {
      validateStartMarker(stateDirectory, readdirSync(stateDirectory).includes("retired.v1"));
    }
    const owner = openOwnerForExclusiveCheck(stateDirectory);
    try {
      validateLeaves(stateDirectory, retirement);
      if (!retirement) validateStartMarker(stateDirectory);
      return new ConnectorStateReservation(stateDirectory, owner);
    } catch (error) {
      try {
        owner.exec("ROLLBACK");
      } catch {}
      owner.close();
      throw error;
    }
  } catch (error) {
    for (const directory of created.reverse()) {
      try {
        rmdirSync(directory);
      } catch {}
    }
    if (retirement) connectorError("connector_state_retire_refused");
    throw error;
  }
}

function frame(domain: number, parts: readonly Buffer[]): Buffer {
  const fields = parts.map((part) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.byteLength);
    return Buffer.concat([length, part]);
  });
  return Buffer.concat([
    Buffer.from("A2A-CONNECTOR-STATE\0", "ascii"),
    Buffer.from([1, domain]),
    ...fields,
  ]);
}

function hmac(key: Buffer, domain: number, parts: readonly Buffer[]): Buffer {
  return createHmac("sha256", key).update(frame(domain, parts)).digest();
}

function derive(token: string, salt: Buffer): Keys {
  if (!WEBHOOK_TOKEN_PATTERN.test(token)) connectorError("webhook_token_unavailable");
  const derived = scryptSync(Buffer.from(token, "hex"), salt, 64, {
    N: 131_072,
    r: 8,
    p: 1,
    maxmem: 268_435_456,
  });
  return { aes: derived.subarray(0, 32), hmac: derived.subarray(32, 64) };
}

function encrypt(
  key: Buffer,
  raw: Buffer,
  aad: Buffer,
): { iv: Buffer; ciphertext: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  return {
    iv,
    ciphertext: Buffer.concat([cipher.update(raw), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}

function decrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, tag: Buffer, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    connectorError("connector_state_unavailable");
  }
}

function validateId(raw: Buffer, providerId = false): string {
  const value = raw.toString("utf8");
  if (Buffer.from(value, "utf8").compare(raw) !== 0) connectorError("connector_state_unavailable");
  const bytes = Buffer.byteLength(value, "utf8");
  if (providerId ? bytes < 1 || bytes > 1_024 : !URI_UNRESERVED_ID_PATTERN.test(value))
    connectorError("connector_state_unavailable");
  return value;
}

function createCorrelation(path: string, options: StateOptions, nowMs: number): void {
  const database = new Database(path);
  try {
    database.pragma("page_size=4096");
    database.pragma("journal_mode=WAL");
    configureCorrelation(database);
    database.exec(CORRELATION_DDL);
    database.pragma(`application_id=${CORRELATION_APPLICATION_ID}`);
    database.pragma("user_version=1");
    const salt = randomBytes(16);
    const keys = derive(options.webhookToken, salt);
    const provider = Buffer.from(options.providerKind, "ascii");
    const directory = Buffer.from(options.workingDirectory, "utf8");
    database
      .prepare(
        "INSERT INTO store_meta(singleton, schema_version, provider_kind, kdf_salt, scope_hmac, created_at_ms) VALUES (1, 1, ?, ?, ?, ?)",
      )
      .run(options.providerKind, salt, hmac(keys.hmac, 0x01, [provider, directory]), nowMs);
    keys.aes.fill(0);
    keys.hmac.fill(0);
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
  for (const suffix of ["-wal", "-shm"] as const) {
    const leaf = `${path}${suffix}`;
    if (existsSync(leaf)) chmodSync(leaf, 0o600);
  }
  syncFile(path);
  syncFile(dirname(path));
}

function expectedCorrelationObjects(): Map<string, { type: string; sql: string }> {
  const temporary = new Database(":memory:");
  try {
    temporary.exec(CORRELATION_DDL);
    return new Map(
      temporary
        .prepare<[], { name: string; sql: string; type: string }>(
          "SELECT name, sql, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => [row.name, { type: row.type, sql: normalizedSql(row.sql) }]),
    );
  } finally {
    temporary.close();
  }
}

const EXPECTED_CORRELATION_OBJECTS = expectedCorrelationObjects();

interface LifecyclePairRow {
  conversation_lifecycle: string;
  message_lifecycle: string;
  terminal_operation: string | null;
  blocked_class: string | null;
  provider_session_hmac: Buffer | null;
  provider_turn_hmac: Buffer | null;
}

function allowedLifecyclePair(row: LifecyclePairRow): boolean {
  const conversation = row.conversation_lifecycle;
  const message = row.message_lifecycle;
  const terminal = row.terminal_operation;
  let allowed: readonly string[];
  if (message === "received") allowed = ["binding", "active"];
  else if (message === "binding") allowed = ["binding"];
  else if (["turn_starting", "turn_running", "waiting_for_approval"].includes(message))
    allowed = ["active"];
  else if (message === "uncertain") allowed = ["uncertain"];
  else if (message === "central_pending" || message === "ack_pending" || message === "closed") {
    if (terminal === "reply") {
      allowed = message === "closed" ? ["active"] : ["active", "uncertain"];
    } else if (terminal === "complete") {
      allowed = message === "central_pending" ? ["binding", "active", "uncertain"] : ["closed"];
    } else return false;
  } else if (message === "blocked") {
    if (row.blocked_class === null) return false;
    if (terminal === null) allowed = ["binding", "active", "uncertain"];
    else if (terminal === "reply") allowed = ["active", "uncertain"];
    else if (terminal === "complete") allowed = ["binding", "active", "uncertain", "closed"];
    else return false;
  } else return false;
  if (!allowed.includes(conversation)) return false;
  if (
    (row.provider_turn_hmac !== null || terminal === "reply") &&
    row.provider_session_hmac === null
  )
    return false;
  return true;
}

function openCorrelation(
  path: string,
  options: StateOptions,
): { database: Database.Database; keys: Keys; provider: Buffer; directory: Buffer } {
  validatePrivateFile(path);
  const database = new Database(path);
  try {
    configureCorrelation(database);
    if (
      database.pragma("application_id", { simple: true }) !== CORRELATION_APPLICATION_ID ||
      database.pragma("user_version", { simple: true }) !== 1 ||
      database.pragma("page_size", { simple: true }) !== 4_096 ||
      database.pragma("journal_mode", { simple: true }) !== "wal" ||
      database.pragma("foreign_keys", { simple: true }) !== 1 ||
      database.pragma("trusted_schema", { simple: true }) !== 0 ||
      database.pragma("max_page_count", { simple: true }) !== 65_536
    )
      connectorError("connector_state_unavailable");
    const integrity = database.pragma("integrity_check") as Record<string, unknown>[];
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== "ok" ||
      (database.pragma("foreign_key_check") as unknown[]).length !== 0
    )
      connectorError("connector_state_unavailable");
    const objects = database
      .prepare<[], { name: string; sql: string; type: string }>(
        "SELECT name, sql, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    if (objects.length !== EXPECTED_CORRELATION_OBJECTS.size)
      connectorError("connector_state_unavailable");
    for (const object of objects) {
      const expected = EXPECTED_CORRELATION_OBJECTS.get(object.name);
      if (
        expected === undefined ||
        expected.type !== object.type ||
        expected.sql !== normalizedSql(object.sql)
      )
        connectorError("connector_state_unavailable");
    }
    const metas = database
      .prepare<[], { provider_kind: string; kdf_salt: Buffer; scope_hmac: Buffer }>(
        "SELECT provider_kind, kdf_salt, scope_hmac FROM store_meta",
      )
      .all();
    const meta = metas[0];
    if (
      metas.length !== 1 ||
      meta === undefined ||
      !Buffer.isBuffer(meta.kdf_salt) ||
      meta.kdf_salt.byteLength !== 16 ||
      !Buffer.isBuffer(meta.scope_hmac) ||
      meta.scope_hmac.byteLength !== 32
    )
      connectorError("connector_state_unavailable");
    const keys = derive(options.webhookToken, meta.kdf_salt);
    const provider = Buffer.from(options.providerKind, "ascii");
    const directory = Buffer.from(options.workingDirectory, "utf8");
    const expectedScope = hmac(keys.hmac, 0x01, [provider, directory]);
    if (
      meta.provider_kind !== options.providerKind ||
      !timingSafeEqual(meta.scope_hmac, expectedScope)
    ) {
      keys.aes.fill(0);
      keys.hmac.fill(0);
      connectorError("connector_scope_mismatch");
    }
    return { database, keys, provider, directory };
  } catch (error) {
    database.close();
    if (error instanceof ConnectorError) throw error;
    connectorError("connector_state_unavailable");
  }
}

export class ConnectorState {
  #deferStorageBoundaryForTest = false;

  constructor(
    private readonly stateDirectory: string,
    readonly database: Database.Database,
    readonly owner: Database.Database,
    private readonly keys: Keys,
    private readonly provider: Buffer,
    private readonly directory: Buffer,
    private readonly actionObserver?: {
      observe(event: Readonly<Record<string, unknown>>): void;
    },
  ) {}

  beforeExternalEffect(): void {
    this.#checkStorageBoundary();
    this.actionObserver?.observe({ kind: "external_effect" });
  }

  runSeedTransactionForTest(operation: () => void): void {
    this.#deferStorageBoundaryForTest = true;
    try {
      this.database.transaction(operation)();
    } finally {
      this.#deferStorageBoundaryForTest = false;
    }
    this.#afterWrite();
  }

  #afterWrite(): void {
    const pages = Number(this.database.pragma("page_count", { simple: true }));
    if (!Number.isSafeInteger(pages) || pages < 0 || pages > 65_536)
      connectorError("connector_state_unavailable");
    if (!this.#deferStorageBoundaryForTest) this.#checkStorageBoundary();
  }

  #walBytes(): number {
    try {
      return statSync(join(this.stateDirectory, "correlation.sqlite3-wal")).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      connectorError("connector_state_unavailable");
    }
  }

  #checkpoint(mode: "PASSIVE" | "TRUNCATE"): void {
    this.actionObserver?.observe({ kind: "wal_checkpoint", mode });
    try {
      this.database.pragma(`wal_checkpoint(${mode})`);
    } catch {
      if (mode === "PASSIVE") connectorError("connector_state_unavailable");
    }
  }

  #checkStorageBoundary(): void {
    let bytes = this.#walBytes();
    if (bytes > WAL_TARGET_BYTES) {
      this.#checkpoint("PASSIVE");
      bytes = this.#walBytes();
    }
    if (bytes > WAL_HARD_BYTES) {
      this.#checkpoint("TRUNCATE");
      bytes = this.#walBytes();
    }
    if (bytes > WAL_HARD_BYTES) connectorError("connector_state_unavailable");
  }

  close(): void {
    LIVE_STATES.delete(this.stateDirectory);
    this.keys.aes.fill(0);
    this.keys.hmac.fill(0);
    if (this.database.open) this.database.close();
    if (this.owner.open) {
      try {
        this.owner.exec("ROLLBACK");
      } catch {}
      this.owner.close();
    }
  }

  validateStartupState(): void {
    const messageCount = this.database
      .prepare<[], { count: number }>("SELECT count(*) AS count FROM messages")
      .get()?.count;
    const pairs = this.database
      .prepare<[], LifecyclePairRow & { conversation_hmac: Buffer }>(
        `SELECT c.conversation_hmac,
          c.lifecycle AS conversation_lifecycle,
          m.lifecycle AS message_lifecycle,
          m.terminal_operation,
          m.blocked_class,
          c.provider_session_hmac,
          m.provider_turn_hmac
        FROM messages m JOIN conversations c USING(conversation_hmac)`,
      )
      .all();
    if (messageCount !== pairs.length || pairs.some((row) => !allowedLifecyclePair(row)))
      connectorError("connector_state_unavailable");
    const invalidParent = this.database
      .prepare<[], { lifecycle: string; message_count: number }>(
        `SELECT c.lifecycle, count(m.message_hmac) AS message_count
         FROM conversations c LEFT JOIN messages m USING(conversation_hmac)
         GROUP BY c.conversation_hmac
         HAVING (c.lifecycle IN ('binding','uncertain') AND count(m.message_hmac) != 1)
            OR count(m.message_hmac) > 1`,
      )
      .get();
    if (invalidParent !== undefined) connectorError("connector_state_unavailable");
    this.#checkStorageBoundary();
  }

  deleteClosedMessagesAtStartup(): void {
    const result = this.database.transaction(() => {
      const closed = this.database
        .prepare<[], LifecyclePairRow>(
          `SELECT c.lifecycle AS conversation_lifecycle,
            m.lifecycle AS message_lifecycle,
            m.terminal_operation,
            m.blocked_class,
            c.provider_session_hmac,
            m.provider_turn_hmac
           FROM messages m JOIN conversations c USING(conversation_hmac)
           WHERE m.lifecycle='closed'`,
        )
        .all();
      if (closed.some((row) => !allowedLifecyclePair(row))) {
        connectorError("connector_state_unavailable");
      }
      return this.database.prepare("DELETE FROM messages WHERE lifecycle='closed'").run();
    })();
    if (result.changes > 0) this.#afterWrite();
  }

  #readMessagePair(messageHmac: Buffer): LifecyclePairRow | undefined {
    return this.database
      .prepare<[Buffer], LifecyclePairRow>(
        `SELECT c.lifecycle AS conversation_lifecycle,
          m.lifecycle AS message_lifecycle,
          m.terminal_operation,
          m.blocked_class,
          c.provider_session_hmac,
          m.provider_turn_hmac
         FROM messages m JOIN conversations c USING(conversation_hmac)
         WHERE m.message_hmac=?`,
      )
      .get(messageHmac);
  }

  transitionPair(options: {
    conversationId: string;
    messageId: string;
    fromConversation: string | readonly string[];
    fromMessage: string | readonly string[];
    toConversation: string;
    toMessage: string;
    nowMs: number;
    messageValues?: Readonly<Record<string, unknown>>;
    failAfter?: PairedStateFaultBarrier;
  }): void {
    const time = validateTime(options.nowMs);
    const conversationHmac = this.conversationIndex(options.conversationId);
    const messageHmac = this.messageIndex(options.messageId);
    const fromConversation = Array.isArray(options.fromConversation)
      ? options.fromConversation
      : [options.fromConversation];
    const fromMessage = Array.isArray(options.fromMessage)
      ? options.fromMessage
      : [options.fromMessage];
    const values = options.messageValues ?? {};
    const permittedColumns = new Set([
      "blocked_class",
      "terminal_operation",
      "completion_outcome",
      "completion_reason",
      "retry_kind",
      "retry_not_before_ms",
      "retry_attempt_count",
      "turn_started_at_ms",
      "turn_deadline_ms",
    ]);
    if (Object.keys(values).some((key) => !permittedColumns.has(key)))
      connectorError("connector_state_unavailable");
    const readPair = () =>
      this.database
        .prepare<[Buffer, Buffer], LifecyclePairRow>(
          `SELECT c.lifecycle AS conversation_lifecycle,
            m.lifecycle AS message_lifecycle,
            m.terminal_operation,
            m.blocked_class,
            c.provider_session_hmac,
            m.provider_turn_hmac
           FROM messages m JOIN conversations c USING(conversation_hmac)
           WHERE c.conversation_hmac=? AND m.message_hmac=?`,
        )
        .get(conversationHmac, messageHmac);
    this.database.transaction(() => {
      const old = readPair();
      if (
        old === undefined ||
        !fromConversation.includes(old.conversation_lifecycle) ||
        !fromMessage.includes(old.message_lifecycle) ||
        !allowedLifecyclePair(old)
      )
        connectorError("connector_state_unavailable");
      const updateConversation = () => {
        const placeholders = fromConversation.map(() => "?").join(",");
        const result = this.database
          .prepare(
            `UPDATE conversations SET lifecycle=?, updated_at_ms=? WHERE conversation_hmac=? AND lifecycle IN (${placeholders})`,
          )
          .run(options.toConversation, time, conversationHmac, ...fromConversation);
        if (result.changes !== 1) connectorError("connector_state_unavailable");
      };
      const updateMessage = () => {
        const assignments = [
          "lifecycle=@to",
          "updated_at_ms=@now",
          ...Object.keys(values).map((name) => `${name}=@${name}`),
        ];
        const placeholders = fromMessage.map((_, index) => `@from${index}`).join(",");
        const fromValues = Object.fromEntries(
          fromMessage.map((value, index) => [`from${index}`, value]),
        );
        const result = this.database
          .prepare(
            `UPDATE messages SET ${assignments.join(",")} WHERE message_hmac=@message AND lifecycle IN (${placeholders})`,
          )
          .run({
            to: options.toMessage,
            now: time,
            message: messageHmac,
            ...values,
            ...fromValues,
          });
        if (result.changes !== 1) connectorError("connector_state_unavailable");
      };
      const messageFirst =
        options.failAfter === "uncertain_after_message_update" ||
        options.failAfter === "lost_reply_after_message_update";
      if (messageFirst) {
        updateMessage();
        if (options.failAfter !== undefined) connectorError("connector_state_unavailable");
        updateConversation();
      } else {
        updateConversation();
        if (options.failAfter !== undefined) connectorError("connector_state_unavailable");
        updateMessage();
      }
      const current = readPair();
      if (
        current === undefined ||
        current.conversation_lifecycle !== options.toConversation ||
        current.message_lifecycle !== options.toMessage ||
        !allowedLifecyclePair(current)
      )
        connectorError("connector_state_unavailable");
    })();
    this.#afterWrite();
  }

  conversationIndex(id: string): Buffer {
    return hmac(this.keys.hmac, 0x02, [Buffer.from(id, "ascii")]);
  }
  messageIndex(id: string): Buffer {
    return hmac(this.keys.hmac, 0x03, [Buffer.from(id, "ascii")]);
  }

  readConversation(id: string): StoredConversation | undefined {
    const index = this.conversationIndex(id);
    const row = this.database
      .prepare<[Buffer], Record<string, unknown>>(
        "SELECT * FROM conversations WHERE conversation_hmac=?",
      )
      .get(index);
    return row === undefined ? undefined : this.decodeConversation(row);
  }

  readConversationByHmac(index: Buffer): StoredConversation | undefined {
    const row = this.database
      .prepare<[Buffer], Record<string, unknown>>(
        "SELECT * FROM conversations WHERE conversation_hmac=?",
      )
      .get(index);
    return row === undefined ? undefined : this.decodeConversation(row);
  }

  readMessage(id: string): StoredMessage | undefined {
    const index = this.messageIndex(id);
    const row = this.database
      .prepare<[Buffer], Record<string, unknown>>("SELECT * FROM messages WHERE message_hmac=?")
      .get(index);
    return row === undefined ? undefined : this.decodeMessage(row);
  }

  allOpenMessages(): StoredMessage[] {
    return this.database
      .prepare<[], Record<string, unknown>>(
        "SELECT * FROM messages WHERE lifecycle != 'closed' ORDER BY rowid",
      )
      .all()
      .map((row) => this.decodeMessage(row));
  }

  insertConversationAndMessage(
    conversationId: string,
    messageId: string,
    nowMs: number,
  ): { conversation: StoredConversation; message: StoredMessage } {
    const time = validateTime(nowMs);
    const conversationRaw = Buffer.from(conversationId, "ascii");
    const messageRaw = Buffer.from(messageId, "ascii");
    const conversationHmac = this.conversationIndex(conversationId);
    const messageHmac = this.messageIndex(messageId);
    const conversationEnvelope = encrypt(
      this.keys.aes,
      conversationRaw,
      frame(0x11, [this.provider, this.directory, conversationHmac]),
    );
    const messageEnvelope = encrypt(
      this.keys.aes,
      messageRaw,
      frame(0x12, [this.provider, this.directory, conversationHmac, messageHmac]),
    );
    this.database.transaction(() => {
      if (
        this.database
          .prepare("SELECT 1 FROM conversations WHERE rowid >= 100000 ORDER BY rowid LIMIT 1")
          .get() !== undefined ||
        this.database.prepare("SELECT 1 FROM messages ORDER BY rowid LIMIT 1 OFFSET 1").get() !==
          undefined
      )
        connectorError("connector_state_capacity");
      this.database
        .prepare(
          "INSERT INTO conversations(conversation_hmac, conversation_iv, conversation_ciphertext, conversation_tag, lifecycle, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'binding', ?, ?)",
        )
        .run(
          conversationHmac,
          conversationEnvelope.iv,
          conversationEnvelope.ciphertext,
          conversationEnvelope.tag,
          time,
          time,
        );
      this.database
        .prepare(
          "INSERT INTO messages(message_hmac, message_iv, message_ciphertext, message_tag, conversation_hmac, lifecycle, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)",
        )
        .run(
          messageHmac,
          messageEnvelope.iv,
          messageEnvelope.ciphertext,
          messageEnvelope.tag,
          conversationHmac,
          time,
          time,
        );
    })();
    this.#afterWrite();
    return {
      conversation: this.readConversation(conversationId) as StoredConversation,
      message: this.readMessage(messageId) as StoredMessage,
    };
  }

  insertContinuation(conversationId: string, messageId: string, nowMs: number): StoredMessage {
    const conversation = this.readConversation(conversationId);
    if (conversation?.lifecycle !== "active" || conversation.sessionId === null)
      connectorError("connector_conversation_unavailable");
    const time = validateTime(nowMs);
    const messageHmac = this.messageIndex(messageId);
    const raw = Buffer.from(messageId, "ascii");
    const envelope = encrypt(
      this.keys.aes,
      raw,
      frame(0x12, [this.provider, this.directory, conversation.conversationHmac, messageHmac]),
    );
    this.database.transaction(() => {
      if (
        this.database.prepare("SELECT 1 FROM messages ORDER BY rowid LIMIT 1 OFFSET 1").get() !==
        undefined
      )
        connectorError("connector_state_capacity");
      const current = this.database
        .prepare<[Buffer], { lifecycle: string }>(
          "SELECT lifecycle FROM conversations WHERE conversation_hmac=?",
        )
        .get(conversation.conversationHmac);
      if (current?.lifecycle !== "active") connectorError("connector_conversation_unavailable");
      this.database
        .prepare(
          "INSERT INTO messages(message_hmac, message_iv, message_ciphertext, message_tag, conversation_hmac, lifecycle, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)",
        )
        .run(
          messageHmac,
          envelope.iv,
          envelope.ciphertext,
          envelope.tag,
          conversation.conversationHmac,
          time,
          time,
        );
    })();
    this.#afterWrite();
    return this.readMessage(messageId) as StoredMessage;
  }

  dispatch(messageId: string, continuation: boolean, nowMs: number): StoredMessage {
    const time = validateTime(nowMs);
    const existing = this.readMessage(messageId);
    if (existing === undefined) connectorError("connector_state_unavailable");
    const conversation = this.readConversationByHmac(existing.conversationHmac);
    if (conversation === undefined) connectorError("connector_state_unavailable");
    this.transitionPair({
      conversationId: conversation.conversationId,
      messageId,
      fromConversation: continuation ? "active" : "binding",
      fromMessage: "received",
      toConversation: continuation ? "active" : "binding",
      toMessage: continuation ? "turn_starting" : "binding",
      nowMs: time,
      messageValues: {
        turn_started_at_ms: time,
        turn_deadline_ms: time + 900_000,
      },
    });
    const stored = this.readMessage(messageId);
    if (stored === undefined) connectorError("connector_state_unavailable");
    return stored;
  }

  bindSession(
    conversationId: string,
    messageId: string,
    sessionId: string,
    nowMs: number,
    failAfterConversation = false,
  ): void {
    const time = validateTime(nowMs);
    const conversation = this.readConversation(conversationId);
    if (conversation === undefined) connectorError("connector_state_unavailable");
    const raw = Buffer.from(sessionId, "utf8");
    const sessionHmac = hmac(this.keys.hmac, 0x04, [raw]);
    const envelope = encrypt(
      this.keys.aes,
      raw,
      frame(0x13, [this.provider, this.directory, conversation.conversationHmac, sessionHmac]),
    );
    this.database.transaction(() => {
      const conversationResult = this.database
        .prepare(
          "UPDATE conversations SET provider_session_hmac=?, provider_session_iv=?, provider_session_ciphertext=?, provider_session_tag=?, lifecycle='active', updated_at_ms=? WHERE conversation_hmac=? AND lifecycle='binding'",
        )
        .run(
          sessionHmac,
          envelope.iv,
          envelope.ciphertext,
          envelope.tag,
          time,
          conversation.conversationHmac,
        );
      if (conversationResult.changes !== 1) connectorError("connector_state_unavailable");
      if (failAfterConversation) connectorError("connector_state_unavailable");
      const messageResult = this.database
        .prepare(
          "UPDATE messages SET lifecycle='turn_starting', updated_at_ms=? WHERE message_hmac=? AND lifecycle='binding'",
        )
        .run(time, this.messageIndex(messageId));
      if (messageResult.changes !== 1) connectorError("connector_state_unavailable");
    })();
    this.#afterWrite();
  }

  bindTurn(messageId: string, sessionId: string, turnId: string, nowMs: number): void {
    const time = validateTime(nowMs);
    const message = this.readMessage(messageId);
    if (message === undefined) connectorError("connector_state_unavailable");
    const session = Buffer.from(sessionId, "utf8");
    const raw = Buffer.from(turnId, "utf8");
    const sessionHmac = hmac(this.keys.hmac, 0x04, [session]);
    const turnHmac = hmac(this.keys.hmac, 0x05, [session, raw]);
    const envelope = encrypt(
      this.keys.aes,
      raw,
      frame(0x14, [
        this.provider,
        this.directory,
        message.conversationHmac,
        message.messageHmac,
        sessionHmac,
        turnHmac,
      ]),
    );
    this.database.transaction(() => {
      const old = this.#readMessagePair(message.messageHmac);
      if (
        old === undefined ||
        old.message_lifecycle !== "turn_starting" ||
        old.provider_session_hmac === null ||
        !timingSafeEqual(old.provider_session_hmac, sessionHmac) ||
        !allowedLifecyclePair(old)
      ) {
        connectorError("connector_state_unavailable");
      }
      const result = this.database
        .prepare(
          "UPDATE messages SET provider_turn_hmac=?, provider_turn_iv=?, provider_turn_ciphertext=?, provider_turn_tag=?, lifecycle='turn_running', updated_at_ms=? WHERE message_hmac=? AND lifecycle='turn_starting'",
        )
        .run(turnHmac, envelope.iv, envelope.ciphertext, envelope.tag, time, message.messageHmac);
      if (result.changes !== 1) connectorError("connector_state_unavailable");
      const current = this.#readMessagePair(message.messageHmac);
      if (
        current === undefined ||
        current.message_lifecycle !== "turn_running" ||
        !allowedLifecyclePair(current)
      ) {
        connectorError("connector_state_unavailable");
      }
    })();
    this.#afterWrite();
  }

  transitionMessage(
    messageId: string,
    from: string | readonly string[],
    to: string,
    nowMs: number,
    values: Readonly<Record<string, unknown>> = {},
  ): void {
    const time = validateTime(nowMs);
    const allowed = Array.isArray(from) ? from : [from];
    const assignments = [
      "lifecycle=@to",
      "updated_at_ms=@now",
      ...Object.keys(values).map((name) => `${name}=@${name}`),
    ];
    const placeholders = allowed.map((_, index) => `@from${index}`).join(",");
    const fromValues = Object.fromEntries(allowed.map((value, index) => [`from${index}`, value]));
    const messageHmac = this.messageIndex(messageId);
    this.database.transaction(() => {
      const old = this.#readMessagePair(messageHmac);
      if (
        old === undefined ||
        !allowed.includes(old.message_lifecycle) ||
        !allowedLifecyclePair(old)
      ) {
        connectorError("connector_state_unavailable");
      }
      const result = this.database
        .prepare(
          `UPDATE messages SET ${assignments.join(",")} WHERE message_hmac=@message AND lifecycle IN (${placeholders})`,
        )
        .run({ to, now: time, message: messageHmac, ...values, ...fromValues });
      if (result.changes !== 1) connectorError("connector_state_unavailable");
      const current = this.#readMessagePair(messageHmac);
      if (
        current === undefined ||
        current.message_lifecycle !== to ||
        !allowedLifecyclePair(current)
      ) {
        connectorError("connector_state_unavailable");
      }
    })();
    this.#afterWrite();
  }

  transitionConversation(
    conversationId: string,
    from: string | readonly string[],
    to: string,
    nowMs: number,
  ): void {
    const allowed = Array.isArray(from) ? from : [from];
    const placeholders = allowed.map(() => "?").join(",");
    const result = this.database
      .prepare(
        `UPDATE conversations SET lifecycle=?, updated_at_ms=? WHERE conversation_hmac=? AND lifecycle IN (${placeholders})`,
      )
      .run(to, nowMs, this.conversationIndex(conversationId), ...allowed);
    if (result.changes !== 1) connectorError("connector_state_unavailable");
    this.#afterWrite();
  }

  deleteClosedMessage(messageId: string): void {
    const messageHmac = this.messageIndex(messageId);
    this.database.transaction(() => {
      const old = this.#readMessagePair(messageHmac);
      if (old === undefined || old.message_lifecycle !== "closed" || !allowedLifecyclePair(old)) {
        connectorError("connector_state_unavailable");
      }
      const result = this.database
        .prepare("DELETE FROM messages WHERE message_hmac=? AND lifecycle='closed'")
        .run(messageHmac);
      if (result.changes !== 1) connectorError("connector_state_unavailable");
    })();
    this.#afterWrite();
  }

  decodeConversation(row: Record<string, unknown>): StoredConversation {
    const conversationHmac = row.conversation_hmac as Buffer;
    const raw = decrypt(
      this.keys.aes,
      row.conversation_iv as Buffer,
      row.conversation_ciphertext as Buffer,
      row.conversation_tag as Buffer,
      frame(0x11, [this.provider, this.directory, conversationHmac]),
    );
    const id = validateId(raw);
    if (!timingSafeEqual(conversationHmac, this.conversationIndex(id)))
      connectorError("connector_state_unavailable");
    let sessionId: string | null = null;
    if (row.provider_session_hmac !== null) {
      const sessionHmac = row.provider_session_hmac as Buffer;
      const sessionRaw = decrypt(
        this.keys.aes,
        row.provider_session_iv as Buffer,
        row.provider_session_ciphertext as Buffer,
        row.provider_session_tag as Buffer,
        frame(0x13, [this.provider, this.directory, conversationHmac, sessionHmac]),
      );
      sessionId = validateId(sessionRaw, true);
      if (!timingSafeEqual(sessionHmac, hmac(this.keys.hmac, 0x04, [sessionRaw])))
        connectorError("connector_state_unavailable");
    }
    return {
      conversationHmac,
      conversationId: id,
      sessionId,
      lifecycle: row.lifecycle as StoredConversation["lifecycle"],
    };
  }

  decodeMessage(row: Record<string, unknown>): StoredMessage {
    const messageHmac = row.message_hmac as Buffer;
    const conversationHmac = row.conversation_hmac as Buffer;
    const raw = decrypt(
      this.keys.aes,
      row.message_iv as Buffer,
      row.message_ciphertext as Buffer,
      row.message_tag as Buffer,
      frame(0x12, [this.provider, this.directory, conversationHmac, messageHmac]),
    );
    const id = validateId(raw);
    if (!timingSafeEqual(messageHmac, this.messageIndex(id)))
      connectorError("connector_state_unavailable");
    let turnId: string | null = null;
    if (row.provider_turn_hmac !== null) {
      const conversationRow = this.database
        .prepare<[Buffer], Record<string, unknown>>(
          "SELECT * FROM conversations WHERE conversation_hmac=?",
        )
        .get(conversationHmac);
      if (conversationRow === undefined) connectorError("connector_state_unavailable");
      const conversation = this.decodeConversation(conversationRow);
      if (conversation.sessionId === null) connectorError("connector_state_unavailable");
      const session = Buffer.from(conversation.sessionId, "utf8");
      const sessionHmac = hmac(this.keys.hmac, 0x04, [session]);
      const turnHmac = row.provider_turn_hmac as Buffer;
      const turnRaw = decrypt(
        this.keys.aes,
        row.provider_turn_iv as Buffer,
        row.provider_turn_ciphertext as Buffer,
        row.provider_turn_tag as Buffer,
        frame(0x14, [
          this.provider,
          this.directory,
          conversationHmac,
          messageHmac,
          sessionHmac,
          turnHmac,
        ]),
      );
      turnId = validateId(turnRaw, true);
      if (!timingSafeEqual(turnHmac, hmac(this.keys.hmac, 0x05, [session, turnRaw])))
        connectorError("connector_state_unavailable");
    }
    return {
      messageHmac,
      messageId: id,
      conversationHmac,
      turnId,
      lifecycle: row.lifecycle as string,
      terminalOperation: row.terminal_operation as StoredMessage["terminalOperation"],
      completionOutcome: row.completion_outcome as string | null,
      completionReason: row.completion_reason as string | null,
      retryKind: row.retry_kind as StoredMessage["retryKind"],
      retryNotBeforeMs: row.retry_not_before_ms as number | null,
      retryAttemptCount: row.retry_attempt_count as number,
      turnStartedAtMs: row.turn_started_at_ms as number | null,
      turnDeadlineMs: row.turn_deadline_ms as number | null,
    };
  }
}

export function openConnectorState(options: StateOptions): ConnectorState {
  if (
    options.filesystemQualification === "network" ||
    options.filesystemQualification === "unproven"
  )
    connectorError("connector_state_filesystem_unqualified");
  let owner: Database.Database;
  if (options.reservation === undefined) {
    ensureDirectory(options.stateDirectory);
    validateLeaves(options.stateDirectory);
    validateStartMarker(
      options.stateDirectory,
      readdirSync(options.stateDirectory).includes("retired.v1"),
    );
    owner = openOwner(options.stateDirectory);
    acquireOwner(owner);
  } else {
    owner = options.reservation.take(options.stateDirectory);
  }
  let opened: ReturnType<typeof openCorrelation> | undefined;
  try {
    validateLeaves(options.stateDirectory);
    validateStartMarker(options.stateDirectory);
    const guard = owner
      .prepare<[], { ever_initialized: number }>(
        "SELECT ever_initialized FROM owner_guard WHERE singleton=1",
      )
      .get();
    const correlationPath = join(options.stateDirectory, "correlation.sqlite3");
    if (guard?.ever_initialized === 0) {
      if (
        [
          "correlation.sqlite3",
          "correlation.sqlite3-wal",
          "correlation.sqlite3-shm",
          "correlation.sqlite3-journal",
        ].some((leaf) => existsSync(join(options.stateDirectory, leaf)))
      ) {
        connectorError("connector_state_unavailable");
      }
      const updated = owner
        .prepare(
          "UPDATE owner_guard SET ever_initialized=1 WHERE singleton=1 AND ever_initialized=0",
        )
        .run();
      if (updated.changes !== 1) connectorError("connector_state_unavailable");
      owner.exec("COMMIT");
      syncFile(join(options.stateDirectory, "owner.sqlite3"));
      syncFile(options.stateDirectory);
      acquireOwner(owner);
      validateLeaves(options.stateDirectory);
      validateStartMarker(options.stateDirectory);
      const committed = owner
        .prepare<[], { ever_initialized: number }>(
          "SELECT ever_initialized FROM owner_guard WHERE singleton=1",
        )
        .get();
      if (
        committed?.ever_initialized !== 1 ||
        [
          "correlation.sqlite3",
          "correlation.sqlite3-wal",
          "correlation.sqlite3-shm",
          "correlation.sqlite3-journal",
        ].some((leaf) => existsSync(join(options.stateDirectory, leaf)))
      ) {
        connectorError("connector_state_unavailable");
      }
      createCorrelation(correlationPath, options, validateTime(options.nowMs ?? Date.now()));
    } else if (!existsSync(correlationPath)) connectorError("connector_state_unavailable");
    opened = openCorrelation(correlationPath, options);
    const state = new ConnectorState(
      realpathSync.native(options.stateDirectory),
      opened.database,
      owner,
      opened.keys,
      opened.provider,
      opened.directory,
      options.stateActionObserverForTest,
    );
    for (const conversation of opened.database
      .prepare<[], Record<string, unknown>>("SELECT * FROM conversations")
      .all())
      state.decodeConversation(conversation);
    for (const message of opened.database
      .prepare<[], Record<string, unknown>>("SELECT * FROM messages")
      .all())
      state.decodeMessage(message);
    state.validateStartupState();
    const newest = opened.database
      .prepare<[], { newest: number | null }>(
        `SELECT MAX(value) AS newest FROM (
          SELECT created_at_ms AS value FROM store_meta
          UNION ALL SELECT updated_at_ms AS value FROM conversations
          UNION ALL SELECT updated_at_ms AS value FROM messages
        )`,
      )
      .get()?.newest;
    if (newest !== null && newest !== undefined && newest > (options.nowMs ?? Date.now())) {
      connectorError("connector_state_unavailable");
    }
    state.deleteClosedMessagesAtStartup();
    LIVE_STATES.set(realpathSync.native(options.stateDirectory), {
      correlation: opened.database,
      owner,
    });
    return state;
  } catch (error) {
    if (opened !== undefined) {
      opened.keys.aes.fill(0);
      opened.keys.hmac.fill(0);
      if (opened.database.open) opened.database.close();
    }
    try {
      owner.exec("ROLLBACK");
    } catch {}
    owner.close();
    throw error;
  }
}

export async function initializeConnectorStateForTest(
  options: StateOptions & {
    crashAfter?:
      | "before_owner_flag"
      | "after_owner_flag"
      | "before_correlation_create"
      | "after_correlation_create";
  },
): Promise<void> {
  if (
    options.filesystemQualification === "network" ||
    options.filesystemQualification === "unproven"
  )
    connectorError("connector_state_filesystem_unqualified");
  ensureDirectory(options.stateDirectory);
  validateLeaves(options.stateDirectory);
  const marker = join(options.stateDirectory, "retired.v1");
  if (existsSync(marker))
    connectorError(
      readFileSync(marker).equals(RETIREMENT_BYTES)
        ? "connector_state_retired"
        : "connector_state_unavailable",
    );
  const owner = openOwner(options.stateDirectory);
  acquireOwner(owner);
  try {
    const guard = owner
      .prepare<[], { ever_initialized: number }>(
        "SELECT ever_initialized FROM owner_guard WHERE singleton=1",
      )
      .get();
    const path = join(options.stateDirectory, "correlation.sqlite3");
    if (guard?.ever_initialized === 0) {
      if (existsSync(path)) connectorError("connector_state_unavailable");
      if (options.crashAfter === "before_owner_flag") throw new Error("connector_test_crash");
      owner
        .prepare(
          "UPDATE owner_guard SET ever_initialized=1 WHERE singleton=1 AND ever_initialized=0",
        )
        .run();
      owner.exec("COMMIT");
      if (
        options.crashAfter === "after_owner_flag" ||
        options.crashAfter === "before_correlation_create"
      )
        throw new Error("connector_test_crash");
      createCorrelation(path, options, validateTime(options.nowMs ?? Date.now()));
      if (options.crashAfter === "after_correlation_create") {
        const database = new Database(path);
        database.exec("DROP TABLE store_meta");
        database.close();
        throw new Error("connector_test_crash");
      }
    } else if (!existsSync(path)) connectorError("connector_state_unavailable");
    if (owner.inTransaction) owner.exec("COMMIT");
    const opened = openCorrelation(path, options);
    opened.keys.aes.fill(0);
    opened.keys.hmac.fill(0);
    opened.database.close();
  } finally {
    if (owner.open) {
      try {
        if (owner.inTransaction) owner.exec("ROLLBACK");
      } catch {}
      owner.close();
    }
  }
}

export function inspectConnectorStateForTest(stateDirectory: string): {
  correlationPragmas: Record<string, string | number>;
  ownerPragmas: Record<string, string | number>;
  ownerSchemaSha256: string;
  ownerGuard: { singleton: number; ever_initialized: number };
} {
  const live = LIVE_STATES.get(realpathSync.native(stateDirectory));
  const correlation =
    live?.correlation ?? new Database(join(stateDirectory, "correlation.sqlite3"));
  const owner = live?.owner ?? new Database(join(stateDirectory, "owner.sqlite3"));
  try {
    if (live === undefined) {
      configureCorrelation(correlation);
      configureOwner(owner);
    }
    const simple = (database: Database.Database, name: string) =>
      database.pragma(name, { simple: true }) as string | number;
    const schema = owner
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_schema WHERE name='owner_guard'")
      .get();
    const guard = owner
      .prepare<[], { singleton: number; ever_initialized: number }>(
        "SELECT singleton, ever_initialized FROM owner_guard",
      )
      .get();
    if (schema === undefined || guard === undefined) connectorError("connector_state_unavailable");
    return {
      correlationPragmas: Object.fromEntries(
        [
          "application_id",
          "user_version",
          "page_size",
          "journal_mode",
          "synchronous",
          "foreign_keys",
          "trusted_schema",
          "temp_store",
          "busy_timeout",
          "wal_autocheckpoint",
          "journal_size_limit",
          "max_page_count",
        ].map((name) => [name, simple(correlation, name)]),
      ),
      ownerPragmas: Object.fromEntries(
        [
          "application_id",
          "user_version",
          "page_size",
          "journal_mode",
          "synchronous",
          "trusted_schema",
          "temp_store",
          "busy_timeout",
          "max_page_count",
          "journal_size_limit",
        ].map((name) => [name, simple(owner, name)]),
      ),
      ownerSchemaSha256: ownerSchemaDigest(schema.sql),
      ownerGuard: guard,
    };
  } finally {
    if (live === undefined) {
      correlation.close();
      owner.close();
    }
  }
}

export async function seedConnectorConversationsForTest(
  options: StateOptions & {
    count: number;
    activeConversationId: string;
    activeProviderSessionId: string;
    openMessageCount?: number;
  },
): Promise<void> {
  const state = openConnectorState(options);
  try {
    state.runSeedTransactionForTest(() => {
      for (let index = 0; index < options.count; index += 1) {
        const id = index === 0 ? options.activeConversationId : `seed_${index}`;
        const session = index === 0 ? options.activeProviderSessionId : `seed_session_${index}`;
        const messageId = `seed_message_${index}`;
        const now = Date.now();
        state.insertConversationAndMessage(id, messageId, now);
        state.dispatch(messageId, false, now);
        state.bindSession(id, messageId, session, now);
        if (index < (options.openMessageCount ?? 0)) {
          const result = state.database
            .prepare(
              "UPDATE messages SET lifecycle='received', turn_started_at_ms=NULL, turn_deadline_ms=NULL, updated_at_ms=? WHERE message_hmac=? AND lifecycle='turn_starting'",
            )
            .run(now, state.messageIndex(messageId));
          if (result.changes !== 1) connectorError("connector_state_unavailable");
        } else {
          state.transitionMessage(
            `seed_message_${index}`,
            "turn_starting",
            "central_pending",
            now,
            { terminal_operation: "reply" },
          );
          state.transitionMessage(`seed_message_${index}`, "central_pending", "ack_pending", now);
          state.transitionMessage(`seed_message_${index}`, "ack_pending", "closed", now);
          state.deleteClosedMessage(`seed_message_${index}`);
        }
      }
    });
  } finally {
    state.close();
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function retireConnectorStateForTest(options: {
  stateDirectory: string;
  providerKind: ProviderKind;
  arguments: readonly string[];
  reservation?: ConnectorStateReservation;
  crashAfter?:
    | { kind: "marker_created" }
    | { kind: "marker_prefix"; bytes: number }
    | { kind: "marker_final_write" }
    | { kind: "marker_file_sync" }
    | { kind: "marker_directory_sync" }
    | { kind: "artifact_deleted"; leaf: string };
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (
    options.arguments.length !== 2 ||
    options.arguments[0] !== "retire-state" ||
    options.arguments[1] !== "--confirm=retire-all-correlation"
  )
    connectorError("invalid_connector_arguments");
  try {
    let owner: Database.Database;
    if (options.reservation === undefined) {
      ensureDirectory(options.stateDirectory);
      validateLeaves(options.stateDirectory, true);
      owner = openOwner(options.stateDirectory);
      acquireOwner(owner);
    } else {
      owner = options.reservation.take(options.stateDirectory);
    }
    try {
      validateLeaves(options.stateDirectory, true);
      const marker = join(options.stateDirectory, "retired.v1");
      if (!existsSync(marker)) {
        const descriptor = openSync(marker, "wx", 0o600);
        closeSync(descriptor);
        if (options.crashAfter?.kind === "marker_created") throw new Error("connector_test_crash");
        const bytes =
          options.crashAfter?.kind === "marker_prefix"
            ? options.crashAfter.bytes
            : RETIREMENT_BYTES.byteLength;
        writeFileSync(marker, RETIREMENT_BYTES.subarray(0, bytes), { mode: 0o600 });
        if (options.crashAfter?.kind === "marker_prefix") throw new Error("connector_test_crash");
      }
      const existing = readFileSync(marker);
      if (
        existing.byteLength <= RETIREMENT_BYTES.byteLength &&
        RETIREMENT_BYTES.subarray(0, existing.byteLength).equals(existing)
      )
        writeFileSync(marker, RETIREMENT_BYTES, { mode: 0o600 });
      else if (!existing.equals(RETIREMENT_BYTES)) connectorError("connector_state_retire_refused");
      if (options.crashAfter?.kind === "marker_final_write")
        throw new Error("connector_test_crash");
      syncFile(marker);
      if (options.crashAfter?.kind === "marker_file_sync") throw new Error("connector_test_crash");
      syncFile(options.stateDirectory);
      if (options.crashAfter?.kind === "marker_directory_sync")
        throw new Error("connector_test_crash");
      for (const leaf of [
        "correlation.sqlite3-shm",
        "correlation.sqlite3-wal",
        "correlation.sqlite3-journal",
        "correlation.sqlite3",
      ]) {
        const path = join(options.stateDirectory, leaf);
        if (existsSync(path)) unlinkSync(path);
        if (options.crashAfter?.kind === "artifact_deleted" && options.crashAfter.leaf === leaf)
          throw new Error("connector_test_crash");
      }
      syncFile(options.stateDirectory);
    } finally {
      if (owner.open) {
        try {
          owner.exec("ROLLBACK");
        } catch {}
        owner.close();
      }
    }
    return { exitCode: 0, stdout: "Connector correlation state retired.\n", stderr: "" };
  } catch (error) {
    if (error instanceof Error && error.message === "connector_test_crash") throw error;
    if (error instanceof ConnectorError && error.code === "connector_state_retire_refused")
      throw error;
    connectorError("connector_state_retire_refused");
  }
}

export async function retireConnectorState(options: {
  stateDirectory: string;
  providerKind: ProviderKind;
  arguments: readonly string[];
  reservation: ConnectorStateReservation;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (
    options.arguments.length !== 2 ||
    options.arguments[0] !== "retire-state" ||
    options.arguments[1] !== "--confirm=retire-all-correlation"
  ) {
    connectorError("invalid_connector_arguments");
  }
  try {
    const owner = options.reservation.take(options.stateDirectory);
    try {
      validateLeaves(options.stateDirectory, true);
      const marker = join(options.stateDirectory, "retired.v1");
      if (!existsSync(marker)) {
        const descriptor = openSync(marker, "wx", 0o600);
        closeSync(descriptor);
        writeFileSync(marker, RETIREMENT_BYTES, { mode: 0o600 });
      }
      const existing = readFileSync(marker);
      if (
        existing.byteLength <= RETIREMENT_BYTES.byteLength &&
        RETIREMENT_BYTES.subarray(0, existing.byteLength).equals(existing)
      ) {
        writeFileSync(marker, RETIREMENT_BYTES, { mode: 0o600 });
      } else if (!existing.equals(RETIREMENT_BYTES)) {
        connectorError("connector_state_retire_refused");
      }
      syncFile(marker);
      syncFile(options.stateDirectory);
      for (const leaf of [
        "correlation.sqlite3-shm",
        "correlation.sqlite3-wal",
        "correlation.sqlite3-journal",
        "correlation.sqlite3",
      ]) {
        const path = join(options.stateDirectory, leaf);
        if (existsSync(path)) unlinkSync(path);
      }
      syncFile(options.stateDirectory);
    } finally {
      if (owner.open) {
        try {
          owner.exec("ROLLBACK");
        } catch {}
        owner.close();
      }
    }
    return { exitCode: 0, stdout: "Connector correlation state retired.\n", stderr: "" };
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "connector_state_retire_refused") {
      throw error;
    }
    connectorError("connector_state_retire_refused");
  }
}

export function accountStateDirectory(accountHome: string, provider: ProviderKind): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(accountHome);
  } catch {
    connectorError("connector_state_unavailable");
  }
  validateOwnedDirectory(canonical);
  if (process.platform === "linux")
    return join(canonical, ".local", "state", "a2a-connectors", provider);
  if (process.platform === "darwin")
    return join(canonical, "Library", "Application Support", "a2a-connectors", provider);
  connectorError("connector_state_unavailable");
}
