import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { SidecarError } from "./errors.js";
import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const LOCK_HANDOFF_TIMEOUT_MS = 1_000;

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

function invalidLockArtifact(): SidecarError {
  return new SidecarError("lock_invalid", "The daemon lock artifact is invalid", 7);
}

export class ProcessLock {
  private released = false;

  private constructor(private readonly database: Database.Database) {}

  static async acquire(path: string): Promise<ProcessLock> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const artifact = preparePrivateSqliteArtifact(path, invalidLockArtifact);
    let database: Database.Database | undefined;

    try {
      database = new Database(path, { timeout: LOCK_HANDOFF_TIMEOUT_MS });
      artifact.validate();
      // Closing another descriptor for this inode after BEGIN can release POSIX process locks.
      artifact.releaseFile();
      database.pragma(`busy_timeout = ${LOCK_HANDOFF_TIMEOUT_MS}`);
      database.pragma("trusted_schema = OFF");
      database.exec("BEGIN EXCLUSIVE");
      artifact.validateDirectory();
      return new ProcessLock(database);
    } catch (error) {
      database?.close();
      const code = errorCode(error);
      if (code?.startsWith("SQLITE_BUSY")) {
        throw new SidecarError("daemon_running", "The sidecar daemon is already running", 7);
      }
      if (code === "SQLITE_NOTADB" || code === "SQLITE_FORMAT" || code === "SQLITE_CORRUPT") {
        throw new SidecarError("lock_invalid", "The daemon lock artifact is invalid", 7);
      }
      throw error;
    } finally {
      artifact.close();
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
