import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  write,
} from "node:fs";
import { join } from "node:path";
import { type PreparedSqliteArtifact, preparePrivateSqliteArtifact } from "./sqlite-artifact.js";
import { redactVerboseValue, type VerboseLogger } from "./verbose-log.js";

const MAX_RECORD_BYTES = 64 * 1024;
const DAY = 86400000;
const missing = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");

/** A fixed allowlist: arbitrary strings, bodies and nested provider output never enter production logs. */
export function diagnosticMetadata(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      ["duration_ms", "count", "bytes", "attempt", "pending", "port"].includes(key) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    )
      result[key] = value;
    else if (
      key === "status" &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
    )
      result[key] = value;
    else if (
      key === "method" &&
      typeof value === "string" &&
      ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(value)
    )
      result[key] = value;
    else if (
      ["request_id", "operation_id", "call_id", "message_id", "instance_id"].includes(key) &&
      typeof value === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value)
    )
      result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

export class DiagnosticLog {
  readonly runId = randomUUID();
  readonly #maximumFileBytes: number;
  readonly #maximumFiles: number;
  readonly #maximumQueueBytes: number;
  readonly #onNotice: (notice: string) => void;
  #file: number | undefined;
  #artifact: PreparedSqliteArtifact | undefined;
  #bytes = 0;
  #bornAt = 0;
  #lastMaintenance = 0;
  readonly #maximumAgeMs: number | undefined;
  readonly #bodyMode: "detailed" | "metadata";
  readonly #now: () => number;
  #maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  #queuedBytes = 0;
  #dropped = 0;
  #failed = false;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    options: {
      readonly maximumFileBytes?: number;
      readonly maximumFiles?: number;
      readonly maximumQueueBytes?: number;
      readonly maximumAgeMs?: number;
      readonly bodyMode?: "detailed" | "metadata";
      readonly now?: () => number;
      readonly onNotice?: (notice: string) => void;
    } = {},
  ) {
    this.#maximumFileBytes = options.maximumFileBytes ?? 8 * 1024 * 1024;
    this.#maximumFiles = options.maximumFiles ?? 4;
    this.#maximumQueueBytes = options.maximumQueueBytes ?? 1024 * 1024;
    this.#maximumAgeMs = options.maximumAgeMs;
    this.#bodyMode = options.bodyMode ?? "detailed";
    this.#now = options.now ?? Date.now;
    if (
      this.#maximumAgeMs !== undefined &&
      (!Number.isSafeInteger(this.#maximumAgeMs) || this.#maximumAgeMs <= 0)
    )
      throw new Error("Invalid diagnostic retention");
    this.#onNotice = options.onNotice ?? (() => undefined);
    if (
      ![this.#maximumFileBytes, this.#maximumFiles, this.#maximumQueueBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      this.#maximumFiles > 16
    )
      throw new Error("Invalid diagnostic limits");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      this.#open();
      this.#maintain();
    } catch (error) {
      this.#closeFile();
      throw error;
    }
    if (this.#maximumAgeMs !== undefined) {
      this.#maintenanceTimer = setInterval(() => {
        void this.maintain().catch(() =>
          this.#notice("Diagnostic retention could not remove expired files."),
        );
      }, 60000);
      this.#maintenanceTimer.unref();
    }
  }

  #path(index = 0): string {
    return join(this.directory, index === 0 ? "events.jsonl" : `events.${index}.jsonl`);
  }

  #open(): void {
    const path = this.#path();
    const artifact = preparePrivateSqliteArtifact(
      path,
      () => new Error("Diagnostic file is invalid"),
    );
    let file: number | undefined;
    try {
      file = openSync(
        path,
        constants.O_RDWR |
          constants.O_APPEND |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      artifact.validate();
      const stats = fstatSync(file);
      const expected = lstatSync(path);
      if (stats.ino !== expected.ino || stats.dev !== expected.dev)
        throw new Error("Diagnostic file changed");
      this.#file = file;
      this.#artifact = artifact;
      this.#bytes = stats.size;
      this.#bornAt = this.#oldest(file, stats.size, stats.birthtimeMs);
    } catch (error) {
      if (file !== undefined) closeSync(file);
      artifact.close();
      throw error;
    }
  }

  #closeFile(): void {
    const file = this.#file;
    const artifact = this.#artifact;
    this.#file = undefined;
    this.#artifact = undefined;
    try {
      if (file !== undefined) closeSync(file);
    } finally {
      artifact?.close();
    }
  }

  #oldest(file: number, size: number, fallback: number): number {
    if (!size) return this.#now();
    const bytes = Buffer.alloc(Math.min(size, MAX_RECORD_BYTES));
    const length = readSync(file, bytes, 0, bytes.length, 0);
    const end = bytes.indexOf(10);
    try {
      const value: unknown = JSON.parse(
        bytes.subarray(0, end >= 0 ? end : length).toString("utf8"),
      );
      if (
        value &&
        typeof value === "object" &&
        "timestamp" in value &&
        typeof value.timestamp === "string"
      ) {
        const time = Date.parse(value.timestamp);
        if (Number.isFinite(time)) return Math.min(time, this.#now());
      }
    } catch {
      /* An unreadable segment uses its filesystem birth time, never a new retention period. */
    }
    return Math.min(fallback, this.#now());
  }

  #validateFiles(): { index: number; bornAt: number }[] {
    this.#artifact?.validate();
    const files: { index: number; bornAt: number }[] = [];
    for (let index = 0; index < this.#maximumFiles; index++) {
      const path = this.#path(index);
      let file: number | undefined;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("Invalid diagnostic archive");
        file = openSync(
          path,
          constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
        );
        const opened = fstatSync(file);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev)
          throw new Error("Diagnostic archive changed");
        files.push({ index, bornAt: this.#oldest(file, stat.size, stat.birthtimeMs) });
      } catch (error) {
        if (!missing(error)) throw error;
      } finally {
        if (file !== undefined) closeSync(file);
      }
    }
    return files;
  }

  #maintain(): void {
    if (this.#maximumAgeMs === undefined) return;
    const expired = this.#validateFiles().filter(
      (file) => file.bornAt <= this.#now() - (this.#maximumAgeMs ?? 0),
    );
    if (expired.some((file) => file.index === 0)) this.#closeFile();
    try {
      for (const file of expired) unlinkSync(this.#path(file.index));
    } finally {
      if (this.#file === undefined) this.#open();
    }
    this.#lastMaintenance = this.#now();
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Diagnostic log is closed"));
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  maintain(): Promise<void> {
    return this.#enqueue(() => this.#maintain());
  }

  clear(): Promise<void> {
    return this.#enqueue(() => {
      const files = this.#validateFiles();
      this.#closeFile();
      try {
        for (const file of files) unlinkSync(this.#path(file.index));
      } finally {
        this.#open();
      }
      this.#dropped = 0;
      this.#failed = false;
    });
  }

  #notice(notice: string): void {
    try {
      this.#onNotice(notice);
    } catch {
      /* Diagnostics cannot change an operation's outcome. */
    }
  }

  #line(event: string, data?: unknown): Buffer {
    const record = { timestamp: new Date(this.#now()).toISOString(), run_id: this.runId, event };
    let text: string;
    try {
      const safe =
        this.#bodyMode === "metadata" ? diagnosticMetadata(data) : redactVerboseValue(data);
      text = JSON.stringify({
        ...record,
        ...(safe === undefined ? {} : { data: safe }),
      });
    } catch {
      text = JSON.stringify({ ...record, data: "[unserializable]" });
    }
    const size = Buffer.byteLength(text) + 1;
    if (size > Math.min(MAX_RECORD_BYTES, this.#maximumFileBytes))
      text = JSON.stringify({ ...record, data: "[bounded]", original_bytes: size });
    return Buffer.from(`${text}\n`, "utf8");
  }

  readonly log: VerboseLogger = (event, data) => {
    if (this.#closed || this.#failed) return;
    const line = this.#line(event, data);
    if (this.#queuedBytes + line.length > this.#maximumQueueBytes) {
      this.#dropped += 1;
      if (this.#dropped === 1)
        this.#notice("Diagnostic records were dropped because the write queue is full.");
      return;
    }
    this.#queuedBytes += line.length;
    this.#tail = this.#tail.then(async () => {
      try {
        if (!this.#failed) await this.#write(line);
      } catch {
        this.#failed = true;
        this.#notice(
          "Diagnostic logging stopped after a file write failure. Check the diagnostic directory and available disk space.",
        );
      } finally {
        this.#queuedBytes -= line.length;
      }
    });
  };

  async #write(line: Buffer): Promise<void> {
    if (this.#artifact === undefined) throw new Error("Diagnostic file is closed");
    this.#artifact.validate();
    if (this.#now() - this.#lastMaintenance >= 60000) this.#maintain();
    if (
      this.#bytes + line.length > this.#maximumFileBytes ||
      (this.#maximumAgeMs !== undefined && this.#bytes > 0 && this.#now() - this.#bornAt >= DAY)
    ) {
      this.#validateFiles();
      this.#closeFile();
      for (let index = this.#maximumFiles - 1; index >= 0; index -= 1) {
        try {
          if (index === this.#maximumFiles - 1) unlinkSync(this.#path(index));
          else renameSync(this.#path(index), this.#path(index + 1));
        } catch (error) {
          if (
            !(
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        }
      }
      this.#open();
    }
    let offset = 0;
    const file = this.#file;
    if (file === undefined) throw new Error("Diagnostic file is closed");
    while (offset < line.length) {
      const written = await new Promise<number>((resolve, reject) =>
        write(file, line, offset, line.length - offset, null, (error, bytes) =>
          error === null ? resolve(bytes) : reject(error),
        ),
      );
      if (written <= 0) throw new Error("Diagnostic write made no progress");
      offset += written;
    }
    this.#bytes += line.length;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#maintenanceTimer);
    await this.#tail;
    try {
      if (!this.#failed && this.#dropped > 0)
        await this.#write(this.#line("diagnostic.dropped", { count: this.#dropped }));
    } catch {
      this.#notice("Diagnostic logging could not finish writing its final record.");
    } finally {
      try {
        this.#closeFile();
      } catch {
        /* A prior rotation failure may have closed the file. */
      }
    }
  }
}
