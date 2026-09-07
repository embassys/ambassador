import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  type DiagnosticPage,
  type DiagnosticQuery,
  type DiagnosticRecord,
  diagnosticQuerySchema,
} from "./diagnostic-query.js";

export type { DiagnosticPage, DiagnosticQuery, DiagnosticRecord } from "./diagnostic-query.js";

import { redactVerboseValue } from "../verbose-log.js";
import { secureWindowsArtifact } from "../windows-access-control.js";

const FILE_LIMIT = 8 * 1024 * 1024;
const RECORD_LIMIT = 64 * 1024;
const RECORD_COUNT_LIMIT = 100_000;

async function collect(directory: string, rawQuery: DiagnosticQuery) {
  const query = diagnosticQuerySchema.parse(rawQuery);
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to))
    throw new Error("Choose an end time after the start time.");
  const records: DiagnosticRecord[] = [];
  const warnings = new Set<string>();
  let readCount = 0;
  for (let index = 0; index < 4; index++) {
    const path = join(directory, index === 0 ? "events.jsonl" : `events.${index}.jsonl`);
    let file: FileHandle | undefined;
    try {
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (process.getuid && before.uid !== process.getuid())
      )
        throw new Error("Invalid diagnostic file.");
      file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      const stat = await file.stat();
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > FILE_LIMIT)
        throw new Error("Diagnostic file changed or exceeds its size limit.");
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      let start = 0;
      while (start < read) {
        const end = bytes.indexOf(10, start);
        if (end < 0 || end >= read) {
          warnings.add("An incomplete final record was omitted.");
          break;
        }
        if (++readCount > RECORD_COUNT_LIMIT) {
          warnings.add("The record limit was reached. Narrow the time range.");
          break;
        }
        const length = end - start;
        const line = length <= RECORD_LIMIT ? bytes.subarray(start, end).toString("utf8") : "";
        start = end + 1;
        try {
          if (length > RECORD_LIMIT) throw new Error("Oversized record");
          const parsed: unknown = JSON.parse(line);
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
          const text = JSON.stringify(safe);
          if (query.search && !text.toLowerCase().includes(query.search.toLowerCase())) continue;
          records.push({
            id: createHash("sha256").update(`${index}:${end}:${line}`).digest("hex"),
            timestamp: parsed.timestamp,
            event: String(redactVerboseValue(parsed.event)),
            ...(typeof safe.run_id === "string" ? { run_id: safe.run_id } : {}),
            ...(safe.data === undefined ? {} : { data: safe.data }),
          });
        } catch {
          warnings.add("Malformed or oversized records were omitted.");
        }
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    } finally {
      await file?.close();
    }
    if (readCount > RECORD_COUNT_LIMIT) break;
  }
  records.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  return { records, warnings: [...warnings] };
}

export async function readDiagnostics(
  directory: string,
  rawQuery: DiagnosticQuery = {},
): Promise<DiagnosticPage> {
  const query = diagnosticQuerySchema.parse(rawQuery);
  const all = await collect(directory, query);
  const offset = query.offset ?? 0;
  const records: DiagnosticRecord[] = [];
  let bytes = 0;
  for (const record of all.records.slice(offset, offset + (query.limit ?? 100))) {
    const length = Buffer.byteLength(JSON.stringify(record));
    if (records.length && bytes + length > 512 * 1024) break;
    records.push(record);
    bytes += length;
  }
  return {
    records,
    total: all.records.length,
    hasMore: offset + records.length < all.records.length,
    nextOffset: offset + records.length,
    warnings: all.warnings,
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
  const { records, warnings } = await collect(directory, input.query ?? {});
  const includeBodies = input.includeBodies === true;
  const lines = records.reverse().map((record) => {
    const { id: _id, data, ...metadata } = record;
    return JSON.stringify({
      ...metadata,
      ...(includeBodies && data !== undefined ? { data } : {}),
    });
  });
  const contents =
    [
      JSON.stringify({
        event: "ambassador.support_export",
        created_at: new Date().toISOString(),
        include_bodies: includeBodies,
        record_count: records.length,
        warnings,
      }),
      ...lines,
    ].join("\n") + "\n";
  if (Buffer.byteLength(contents) > 4 * FILE_LIMIT + RECORD_LIMIT)
    throw new Error("Export exceeds its limit. Choose a narrower time range.");
  return {
    contents,
    recordCount: records.length,
    bytes: Buffer.byteLength(contents),
    includeBodies,
    warnings,
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
