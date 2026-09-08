import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { diagnosticMetadata } from "../diagnostic-log.js";
import { redactVerboseValue } from "../verbose-log.js";
import { secureWindowsArtifact } from "../windows-access-control.js";
import { DESKTOP_LOG_FILE_BYTES, DESKTOP_LOG_FILES } from "./diagnostic-policy.js";
import {
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticRecord,
  diagnosticQuerySchema,
} from "./diagnostic-query.js";

export type { DiagnosticPage, DiagnosticQuery, DiagnosticRecord } from "./diagnostic-query.js";

const RECORD_LIMIT = 64 * 1024;
const SCAN_LIMIT = 2 * 1024 * 1024;
const EXPORT_LIMIT = 32 * 1024 * 1024;
const identity = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(DESKTOP_LOG_FILES - 1),
  ino: z.number().nonnegative(),
  dev: z.number().nonnegative(),
  size: z.number().int().min(0).max(DESKTOP_LOG_FILE_BYTES),
  born: z.number().nonnegative(),
});
const cursorSchema = z.strictObject({
  version: z.literal(1),
  filter: z.string().length(64),
  files: z.array(identity).max(DESKTOP_LOG_FILES),
  file: z.number().int().min(0).max(DESKTOP_LOG_FILES),
  position: z.number().int().min(0).max(DESKTOP_LOG_FILE_BYTES),
  skip: z.boolean(),
});
type Cursor = z.infer<typeof cursorSchema>;
const pathFor = (directory: string, index: number) =>
  join(directory, index ? `events.${index}.jsonl` : "events.jsonl");
const missing = (error: unknown) =>
  error && typeof error === "object" && "code" in error && error.code === "ENOENT";
async function openLog(directory: string, index: number) {
  const path = pathFor(directory, index);
  const parent = await lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw new Error("Invalid diagnostic directory.");
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || (process.getuid && before.uid !== process.getuid()))
    throw new Error("Invalid diagnostic file.");
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const stat = await file.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > DESKTOP_LOG_FILE_BYTES)
      throw new Error("Diagnostic file changed or exceeds its size limit.");
    return { file, stat };
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function initialCursor(directory: string, filter: string): Promise<Cursor> {
  const files: Cursor["files"] = [];
  for (let index = 0; index < DESKTOP_LOG_FILES; index++) {
    try {
      const { file, stat } = await openLog(directory, index);
      await file.close();
      files.push({ index, ino: stat.ino, dev: stat.dev, size: stat.size, born: stat.birthtimeMs });
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return { version: 1, filter, files, file: 0, position: files[0]?.size ?? 0, skip: false };
}

/** Read backwards using a reusable block, retaining at most one bounded record. */
class ReverseReader {
  #block = Buffer.alloc(0);
  #start = 0;
  #end = 0;
  bytesRead = 0;
  constructor(readonly file: FileHandle) {}
  async byteRange(end: number): Promise<Buffer> {
    if (end <= this.#start || end > this.#end) {
      this.#start = Math.max(0, end - RECORD_LIMIT);
      this.#block = Buffer.alloc(end - this.#start);
      this.#end = end;
      let offset = 0;
      while (offset < this.#block.length) {
        const { bytesRead } = await this.file.read(
          this.#block,
          offset,
          this.#block.length - offset,
          this.#start + offset,
        );
        if (!bytesRead) throw new Error("Logs changed while reading. Load newest events again.");
        offset += bytesRead;
      }
      this.bytesRead += this.#block.length;
    }
    return this.#block.subarray(0, end - this.#start);
  }
  async previous(position: number, skipping: boolean) {
    let end = position;
    let parts: Buffer[] = [];
    let length = 0;
    let skip = skipping;
    // A complete JSONL record ends in LF. Partial writes are never displayed.
    const last = await this.byteRange(end);
    if (last[last.length - 1] === 10) {
      end--;
      // A skipped oversized record may end exactly at a block boundary.
      // This LF belongs to the preceding complete record, which is readable.
      skip = false;
    } else skip = true;
    while (end > 0) {
      const block = await this.byteRange(end);
      const boundary = block.lastIndexOf(10);
      const part = block.subarray(boundary + 1);
      length += part.length;
      if (length > RECORD_LIMIT) {
        skip = true;
        parts = [];
      }
      if (!skip) parts.unshift(part);
      end -= part.length;
      if (boundary >= 0 || end === 0)
        return {
          line: skip ? undefined : Buffer.concat(parts).toString("utf8"),
          position: end,
          skip: false,
        };
      if (this.bytesRead >= SCAN_LIMIT) return { line: undefined, position: end, skip: true };
    }
    return {
      line: skip ? undefined : Buffer.concat(parts).toString("utf8"),
      position: 0,
      skip: false,
    };
  }
}

export async function readDiagnostics(
  directory: string,
  rawQuery: DiagnosticQuery = {},
): Promise<DiagnosticPage> {
  const query = diagnosticQuerySchema.parse(rawQuery);
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))
    throw new Error("Choose an end time after the start time.");
  const filter = createHash("sha256")
    .update(JSON.stringify([query.search ?? "", query.from ?? "", query.to ?? ""]))
    .digest("hex");
  let cursor: Cursor;
  try {
    cursor = query.cursor
      ? cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")))
      : await initialCursor(directory, filter);
  } catch (error) {
    if (!query.cursor) throw error;
    throw new Error("Log cursor expired. Load newest events again.");
  }
  if (
    cursor.filter !== filter ||
    cursor.file > cursor.files.length ||
    cursor.position > (cursor.files[cursor.file]?.size ?? 0) ||
    new Set(cursor.files.map((file) => file.index)).size !== cursor.files.length
  )
    throw new Error("Log filters or files changed. Load newest events again.");
  const records: DiagnosticRecord[] = [];
  const warnings = new Set<string>();
  let bytes = 0;
  let scanned = 0;
  while (
    cursor.file < cursor.files.length &&
    records.length < (query.limit ?? 100) &&
    scanned < SCAN_LIMIT
  ) {
    const saved = cursor.files[cursor.file];
    if (!saved) break;
    let opened: Awaited<ReturnType<typeof openLog>>;
    try {
      opened = await openLog(directory, saved.index);
    } catch (error) {
      if (missing(error)) throw new Error("Logs changed. Load newest events again.");
      throw error;
    }
    const { file, stat } = opened;
    try {
      if (
        stat.ino !== saved.ino ||
        stat.dev !== saved.dev ||
        stat.birthtimeMs !== saved.born ||
        stat.size < saved.size
      )
        throw new Error("Logs changed. Load newest events again.");
      const reader = new ReverseReader(file);
      while (
        cursor.position > 0 &&
        records.length < (query.limit ?? 100) &&
        scanned + reader.bytesRead < SCAN_LIMIT
      ) {
        const before = cursor.position;
        const previous = await reader.previous(cursor.position, cursor.skip);
        cursor.position = previous.position;
        cursor.skip = previous.skip;
        if (!previous.line) {
          warnings.add("Incomplete, malformed or oversized records were omitted.");
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(previous.line);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !("timestamp" in parsed) ||
            typeof parsed.timestamp !== "string" ||
            !Number.isFinite(Date.parse(parsed.timestamp)) ||
            !("event" in parsed) ||
            typeof parsed.event !== "string" ||
            parsed.event.length > 256
          )
            throw new Error("Invalid record");
          const timestamp = Date.parse(parsed.timestamp);
          if (
            (query.from && timestamp < Date.parse(query.from)) ||
            (query.to && timestamp > Date.parse(query.to))
          )
            continue;
          const safe = redactVerboseValue(parsed) as Record<string, unknown>;
          if (
            query.search &&
            !JSON.stringify(safe).toLowerCase().includes(query.search.toLowerCase())
          )
            continue;
          const record: DiagnosticRecord = {
            id: createHash("sha256")
              .update(`${saved.index}:${saved.ino}:${before}:${previous.line}`)
              .digest("hex"),
            timestamp: parsed.timestamp,
            event: String(redactVerboseValue(parsed.event)),
            ...(typeof safe.run_id === "string" ? { run_id: safe.run_id } : {}),
            ...(safe.data === undefined ? {} : { data: safe.data }),
          };
          const length = Buffer.byteLength(JSON.stringify(record));
          if (records.length && bytes + length > 512 * 1024) {
            cursor.position = before;
            cursor.skip = false;
            break;
          }
          records.push(record);
          bytes += length;
        } catch {
          warnings.add("Malformed or oversized records were omitted.");
        }
      }
      scanned += reader.bytesRead;
    } finally {
      await file.close();
    }
    if (cursor.position === 0) {
      cursor.file++;
      cursor.position = cursor.files[cursor.file]?.size ?? 0;
      cursor.skip = false;
    } else break;
  }
  const hasMore = cursor.file < cursor.files.length;
  return {
    records,
    hasMore,
    ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") } : {}),
    warnings: [...warnings],
  };
}

export interface SupportExport {
  readonly contents: string;
  readonly recordCount: number;
  readonly bytes: number;
  readonly includeBodies: boolean;
  readonly warnings: string[];
}
export async function prepareSupportExport(
  directory: string,
  input: { includeBodies?: boolean; query?: DiagnosticQuery },
): Promise<SupportExport> {
  const includeBodies = input.includeBodies === true;
  const query = diagnosticQuerySchema.parse(input.query ?? {});
  const lines: string[] = [];
  const warnings = new Set<string>();
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await readDiagnostics(directory, { ...query, cursor, limit: 100 });
    for (const warning of page.warnings) warnings.add(warning);
    for (const { id: _id, data, ...metadata } of page.records) {
      const retained = includeBodies ? data : diagnosticMetadata(data);
      const line = JSON.stringify({
        ...metadata,
        ...(retained === undefined ? {} : { data: retained }),
      });
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > EXPORT_LIMIT)
        throw new Error("Export exceeds 32 MiB. Choose a narrower time range.");
      lines.push(line);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const header = JSON.stringify({
    event: "ambassador.support_export",
    created_at: new Date().toISOString(),
    include_bodies: includeBodies,
    record_count: lines.length,
    warnings: [...warnings],
  });
  const contents = `${header}\n${lines.reverse().join("\n")}\n`;
  return {
    contents,
    recordCount: lines.length,
    bytes: Buffer.byteLength(contents),
    includeBodies,
    warnings: [...warnings],
  };
}
export async function saveSupportExport(path: string, preview: SupportExport): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    if (process.platform === "win32") await secureWindowsArtifact(path, "file");
    await file.writeFile(preview.contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
