import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { LoadedCentralCredential } from "./central-credential.js";
import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

export const ENCRYPTED_STORE_QUOTA_BYTES = 1024 * 1024 * 1024;
export const ENCRYPTED_RECORD_MAX_BYTES = 512 * 1024;
const RECORD_KEY = /^[A-Za-z0-9_-]{43}$/u;
const RECORD_SQL =
  "CREATE TABLE records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_key TEXT NOT NULL UNIQUE CHECK (length(record_key) = 43), correlation_key TEXT UNIQUE CHECK (correlation_key IS NULL OR length(correlation_key) = 43), iv BLOB NOT NULL CHECK (length(iv) = 12), tag BLOB NOT NULL CHECK (length(tag) = 16), ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 524288)) STRICT";
const USAGE_SQL =
  "CREATE TABLE usage (id INTEGER PRIMARY KEY CHECK (id = 1), identity TEXT NOT NULL CHECK (length(identity) = 43), records INTEGER NOT NULL CHECK (records >= 0), bytes INTEGER NOT NULL CHECK (bytes >= 0)) STRICT";

interface Row {
  sequence: bigint;
  record_key: string;
  correlation_key: string | null;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export interface EncryptedRecordStoreOptions<T> {
  readonly scope: string;
  readonly parse: (plaintext: Buffer) => T;
  readonly identifier: (value: T) => string;
  readonly error: () => Error;
  readonly maximumBytes?: number;
}

export interface RecordPage<T> {
  readonly items: readonly { readonly sequence: number; readonly value: T }[];
  readonly hasMore: boolean;
}

function integer(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid store integer");
  return result;
}

function sql(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

export class EncryptedRecordStore<T> {
  readonly #database: Database.Database;
  readonly #encryptionKey: Buffer;
  readonly #lookupKey: Buffer;
  readonly #options: EncryptedRecordStoreOptions<T>;
  readonly #maximumBytes: number;

  constructor(
    path: string,
    credential: LoadedCentralCredential,
    options: EncryptedRecordStoreOptions<T>,
  ) {
    this.#options = options;
    this.#maximumBytes = options.maximumBytes ?? ENCRYPTED_STORE_QUOTA_BYTES;
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1) throw options.error();
    const material = credential.privateKey.export({ format: "der", type: "pkcs8" });
    if (!Buffer.isBuffer(material)) throw options.error();
    try {
      const derive = (purpose: string) =>
        Buffer.from(
          hkdfSync(
            "sha256",
            material,
            Buffer.from(credential.keyThumbprint, "ascii"),
            Buffer.from(
              JSON.stringify({ kind: `${options.scope}-${purpose}`, version: 1 }),
              "utf8",
            ),
            32,
          ),
        );
      this.#encryptionKey = derive("encryption");
      this.#lookupKey = derive("lookup");
    } finally {
      material.fill(0);
    }
    let artifact: ReturnType<typeof preparePrivateSqliteArtifact> | undefined;
    let database: Database.Database | undefined;
    try {
      artifact = preparePrivateSqliteArtifact(path, options.error);
      database = new Database(path, { timeout: 5_000 });
      this.#database = database;
      artifact.validate();
      artifact.releaseFile();
      database.defaultSafeIntegers(true);
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("trusted_schema = OFF");
      this.#initialize();
      artifact.validateDirectory();
      // Validate the identity even when the store is empty, without decrypting its contents.
      if (this.#usage().identity !== this.#key("store-identity")) throw options.error();
      const first = database
        .prepare<[], Row>("SELECT * FROM records ORDER BY sequence LIMIT 1")
        .get();
      if (first !== undefined) this.#decrypt(first);
    } catch {
      database?.close();
      this.#encryptionKey.fill(0);
      this.#lookupKey.fill(0);
      throw options.error();
    } finally {
      artifact?.close();
    }
  }

  #initialize(): void {
    this.#database
      .transaction(() => {
        const version = integer(this.#database.pragma("user_version", { simple: true }) as number);
        const definitions = this.#database
          .prepare<[], { name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all();
        if (version === 0 && definitions.length !== 0) throw this.#options.error();
        if (version !== 0 && version !== 2) throw this.#options.error();
        if (version === 0) {
          this.#database.exec(`${RECORD_SQL}; ${USAGE_SQL}`);
          this.#database
            .prepare("INSERT INTO usage VALUES (1, ?, 0, 0)")
            .run(this.#key("store-identity"));
          this.#database.pragma("user_version = 2");
        }
        const actual = this.#database
          .prepare<[], { name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all();
        if (
          actual.length !== 2 ||
          actual[0]?.name !== "records" ||
          sql(actual[0].sql) !== sql(RECORD_SQL) ||
          actual[1]?.name !== "usage" ||
          sql(actual[1].sql) !== sql(USAGE_SQL)
        )
          throw this.#options.error();
      })
      .immediate();
  }

  #key(identifier: string): string {
    return createHmac("sha256", this.#lookupKey).update(identifier, "utf8").digest("base64url");
  }

  #aad(key: string): Buffer {
    return Buffer.from(
      JSON.stringify({ kind: this.#options.scope, version: 1, recordKey: key }),
      "utf8",
    );
  }

  #usage(): { readonly identity: string; readonly records: number; readonly bytes: number } {
    const row = this.#database
      .prepare<[], { identity: string; records: bigint; bytes: bigint }>(
        "SELECT identity, records, bytes FROM usage WHERE id = 1",
      )
      .get();
    if (row === undefined) throw this.#options.error();
    return { identity: row.identity, records: integer(row.records), bytes: integer(row.bytes) };
  }

  #decrypt(row: Row): T {
    let plaintext: Buffer | undefined;
    try {
      if (
        !RECORD_KEY.test(row.record_key) ||
        row.iv.length !== 12 ||
        row.tag.length !== 16 ||
        row.ciphertext.length < 1 ||
        row.ciphertext.length > ENCRYPTED_RECORD_MAX_BYTES
      )
        throw this.#options.error();
      const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, row.iv);
      decipher.setAAD(this.#aad(row.record_key));
      decipher.setAuthTag(row.tag);
      plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const value = this.#options.parse(plaintext);
      if (this.#key(this.#options.identifier(value)) !== row.record_key)
        throw this.#options.error();
      return value;
    } catch {
      throw this.#options.error();
    } finally {
      plaintext?.fill(0);
    }
  }

  get(identifier: string): T | undefined {
    const row = this.#database
      .prepare<[string], Row>("SELECT * FROM records WHERE record_key = ?")
      .get(this.#key(identifier));
    return row === undefined ? undefined : this.#decrypt(row);
  }

  find(correlation: string): T | undefined {
    const row = this.#database
      .prepare<[string], Row>("SELECT * FROM records WHERE correlation_key = ?")
      .get(this.#key(`correlation:${correlation}`));
    return row === undefined ? undefined : this.#decrypt(row);
  }

  put(
    value: T,
    options: { readonly replace?: boolean; readonly correlation?: string } = {},
  ): boolean {
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    try {
      if (plaintext.length > ENCRYPTED_RECORD_MAX_BYTES) throw this.#options.error();
      const validated = this.#options.parse(plaintext);
      const key = this.#key(this.#options.identifier(validated));
      return this.#database
        .transaction(() => {
          const prior = this.#database
            .prepare<[string], Row>("SELECT * FROM records WHERE record_key = ?")
            .get(key);
          if (prior !== undefined && options.replace !== true) {
            if (JSON.stringify(this.#decrypt(prior)) !== plaintext.toString("utf8"))
              throw this.#options.error();
            return false;
          }
          const growth = plaintext.length - (prior?.ciphertext.length ?? 0);
          if (this.#usage().bytes + growth > this.#maximumBytes) throw this.#options.error();
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
          cipher.setAAD(this.#aad(key));
          const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
          const correlation =
            options.correlation === undefined
              ? null
              : this.#key(`correlation:${options.correlation}`);
          if (prior === undefined) {
            this.#database
              .prepare(
                "INSERT INTO records (record_key, correlation_key, iv, tag, ciphertext) VALUES (?, ?, ?, ?, ?)",
              )
              .run(key, correlation, iv, cipher.getAuthTag(), ciphertext);
          } else {
            this.#database
              .prepare(
                "UPDATE records SET correlation_key = ?, iv = ?, tag = ?, ciphertext = ? WHERE record_key = ?",
              )
              .run(correlation, iv, cipher.getAuthTag(), ciphertext, key);
          }
          this.#database
            .prepare("UPDATE usage SET records = records + ?, bytes = bytes + ? WHERE id = 1")
            .run(prior === undefined ? 1 : 0, growth);
          return true;
        })
        .immediate();
    } finally {
      plaintext.fill(0);
    }
  }

  page(after = 0, limit = 50, maximumBytes = 512 * 1024): RecordPage<T> {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256 ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1
    )
      throw this.#options.error();
    const items: { sequence: number; value: T }[] = [];
    let bytes = 0;
    const next = this.#database.prepare<[number], Row>(
      "SELECT * FROM records WHERE sequence > ? ORDER BY sequence LIMIT 1",
    );
    let row = next.get(after);
    while (row !== undefined && items.length < limit) {
      if (items.length > 0 && bytes + row.ciphertext.length > maximumBytes) break;
      const sequence = integer(row.sequence);
      items.push({ sequence, value: this.#decrypt(row) });
      bytes += row.ciphertext.length;
      row = next.get(sequence);
    }
    return { items, hasMore: row !== undefined };
  }

  remove(identifiers: readonly string[]): number {
    if (identifiers.length > 256) throw this.#options.error();
    return this.#database
      .transaction(() => {
        let removed = 0;
        for (const identifier of new Set(identifiers)) {
          const row = this.#database
            .prepare<[string], { bytes: bigint }>(
              "DELETE FROM records WHERE record_key = ? RETURNING length(ciphertext) AS bytes",
            )
            .get(this.#key(identifier));
          if (row === undefined) continue;
          this.#database
            .prepare("UPDATE usage SET records = records - 1, bytes = bytes - ? WHERE id = 1")
            .run(integer(row.bytes));
          removed += 1;
        }
        return removed;
      })
      .immediate();
  }

  close(): void {
    if (this.#database.open) this.#database.close();
    this.#encryptionKey.fill(0);
    this.#lookupKey.fill(0);
  }
}
