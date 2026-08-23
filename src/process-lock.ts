import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { SidecarError } from "./errors.js";

export interface ProcessLockOptions {
  pid?: number;
  token?: string;
  isProcessAlive?: (pid: number) => boolean;
}

interface LockRecord {
  pid: number;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function parseRecord(value: string): LockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SidecarError("lock_invalid", "The daemon lock file is invalid", 7);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "pid,token" ||
    !("pid" in parsed) ||
    !Number.isSafeInteger(parsed.pid) ||
    Number(parsed.pid) <= 0 ||
    !("token" in parsed) ||
    typeof parsed.token !== "string" ||
    parsed.token.length < 1 ||
    parsed.token.length > 128
  ) {
    throw new SidecarError("lock_invalid", "The daemon lock file is invalid", 7);
  }
  return { pid: Number(parsed.pid), token: parsed.token };
}

async function existingRecord(path: string): Promise<LockRecord> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size > 4096) {
    throw new SidecarError("lock_invalid", "The daemon lock file is invalid", 7);
  }
  return parseRecord(await readFile(path, "utf8"));
}

export class ProcessLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly record: LockRecord,
  ) {}

  static async acquire(path: string, options: ProcessLockOptions = {}): Promise<ProcessLock> {
    const record = {
      pid: options.pid ?? process.pid,
      token: options.token ?? randomUUID(),
    };
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.token.length === 0) {
      throw new SidecarError("lock_invalid", "The daemon lock parameters are invalid", 7);
    }
    const isAlive = options.isProcessAlive ?? processIsAlive;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ProcessLock(path, record);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await existingRecord(path);
        if (isAlive(existing.pid)) {
          throw new SidecarError("daemon_running", "The sidecar daemon is already running", 7);
        }
        await unlink(path);
      }
    }

    throw new SidecarError("lock_busy", "The sidecar daemon lock could not be acquired", 7);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const current = await existingRecord(this.path);
      if (current.pid === this.record.pid && current.token === this.record.token) {
        await unlink(this.path);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}
