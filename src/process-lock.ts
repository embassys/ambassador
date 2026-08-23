import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { SidecarError } from "./errors.js";

const POSIX = process.platform !== "win32";
const LOCK_HANDOFF_TIMEOUT_MS = 1_000;

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

async function prepareArtifact(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(directory, 0o700);

  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }

  const stats = await lstat(path);
  if (!stats.isFile()) {
    throw new SidecarError("lock_invalid", "The daemon lock artifact is invalid", 7);
  }
  if (POSIX) await chmod(path, 0o600);
}

export class ProcessLock {
  private released = false;

  private constructor(private readonly database: Database.Database) {}

  static async acquire(path: string): Promise<ProcessLock> {
    await prepareArtifact(path);
    const database = new Database(path, { timeout: LOCK_HANDOFF_TIMEOUT_MS });

    try {
      database.pragma(`busy_timeout = ${LOCK_HANDOFF_TIMEOUT_MS}`);
      database.pragma("trusted_schema = OFF");
      database.exec("BEGIN EXCLUSIVE");
      return new ProcessLock(database);
    } catch (error) {
      database.close();
      const code = errorCode(error);
      if (code?.startsWith("SQLITE_BUSY")) {
        throw new SidecarError("daemon_running", "The sidecar daemon is already running", 7);
      }
      if (code === "SQLITE_NOTADB" || code === "SQLITE_FORMAT" || code === "SQLITE_CORRUPT") {
        throw new SidecarError("lock_invalid", "The daemon lock artifact is invalid", 7);
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      this.database.exec("ROLLBACK");
    } finally {
      this.database.close();
    }
  }
}
