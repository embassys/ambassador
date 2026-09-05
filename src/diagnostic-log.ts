import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  write,
} from "node:fs";
import { join } from "node:path";
import { type PreparedSqliteArtifact, preparePrivateSqliteArtifact } from "./sqlite-artifact.js";
import { redactVerboseValue, type VerboseLogger } from "./verbose-log.js";

const MAX_RECORD_BYTES = 64 * 1024;

export class DiagnosticLog {
  readonly runId = randomUUID();
  readonly #maximumFileBytes: number;
  readonly #maximumFiles: number;
  readonly #maximumQueueBytes: number;
  readonly #onNotice: (notice: string) => void;
  #file: number | undefined;
  #artifact: PreparedSqliteArtifact | undefined;
  #bytes = 0;
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
      readonly onNotice?: (notice: string) => void;
    } = {},
  ) {
    this.#maximumFileBytes = options.maximumFileBytes ?? 8 * 1024 * 1024;
    this.#maximumFiles = options.maximumFiles ?? 4;
    this.#maximumQueueBytes = options.maximumQueueBytes ?? 1024 * 1024;
    this.#onNotice = options.onNotice ?? (() => undefined);
    if (
      ![this.#maximumFileBytes, this.#maximumFiles, this.#maximumQueueBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      this.#maximumFiles > 16
    )
      throw new Error("Invalid diagnostic limits");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#open();
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
        constants.O_WRONLY |
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

  #notice(notice: string): void {
    try {
      this.#onNotice(notice);
    } catch {
      /* Diagnostics cannot change an operation's outcome. */
    }
  }

  #line(event: string, data?: unknown): Buffer {
    const record = { timestamp: new Date().toISOString(), run_id: this.runId, event };
    let text: string;
    try {
      text = JSON.stringify({
        ...record,
        ...(data === undefined ? {} : { data: redactVerboseValue(data) }),
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
    if (this.#bytes + line.length > this.#maximumFileBytes) {
      // Validate all existing rotation destinations before changing any file.
      for (let index = 1; index < this.#maximumFiles; index += 1) {
        try {
          const stats = lstatSync(this.#path(index));
          if (
            !stats.isFile() ||
            stats.nlink !== 1 ||
            (typeof process.getuid === "function" && stats.uid !== process.getuid())
          )
            throw new Error("Invalid diagnostic archive");
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
