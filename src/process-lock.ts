import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { GatewayError } from "./errors.js";
import { preparePrivateSqliteArtifact } from "./sqlite-artifact.js";

const LOCK_HANDOFF_TIMEOUT_MS = 1_000;
const activeLockKeys = new Set<string>();
const pendingLockPaths = new Set<string>();

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    return typeof error.code === "string" ? error.code : undefined;
  }
  return undefined;
}

function invalidLockArtifact(): GatewayError {
  return new GatewayError("lock_invalid", "The gateway lock artifact is invalid", 7);
}

function daemonRunning(): GatewayError {
  return new GatewayError("daemon_running", "The gateway is already running", 7);
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function filesystemLockKey(path: string): string {
  try {
    const stats = lstatSync(path, { bigint: true });
    return `artifact:${stats.dev}:${stats.ino}`;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const parentStats = lstatSync(dirname(path), { bigint: true });
    return `new:${parentStats.dev}:${parentStats.ino}:${pathKey(basename(path))}`;
  }
}

export class ProcessLock {
  private released = false;

  private constructor(
    private readonly database: Database.Database,
    private readonly keys: string[],
  ) {}

  static async acquire(path: string): Promise<ProcessLock> {
    const artifactPath = resolve(path);
    const pendingPath = pathKey(artifactPath);
    if (pendingLockPaths.has(pendingPath)) throw daemonRunning();
    pendingLockPaths.add(pendingPath);
    const keys: string[] = [];

    try {
      await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
      const initialKey = filesystemLockKey(artifactPath);
      if (activeLockKeys.has(initialKey)) throw daemonRunning();
      activeLockKeys.add(initialKey);
      keys.push(initialKey);
      pendingLockPaths.delete(pendingPath);

      const artifact = preparePrivateSqliteArtifact(artifactPath, invalidLockArtifact);
      let database: Database.Database | undefined;

      try {
        const artifactKey = filesystemLockKey(artifactPath);
        if (artifactKey !== initialKey) {
          if (activeLockKeys.has(artifactKey)) throw daemonRunning();
          activeLockKeys.add(artifactKey);
          keys.push(artifactKey);
        }
        database = new Database(artifactPath, { timeout: LOCK_HANDOFF_TIMEOUT_MS });
        artifact.validate();
        // Closing another descriptor for this inode after BEGIN can release POSIX process locks.
        artifact.releaseFile();
        database.pragma(`busy_timeout = ${LOCK_HANDOFF_TIMEOUT_MS}`);
        database.pragma("trusted_schema = OFF");
        database.exec("BEGIN EXCLUSIVE");
        artifact.validateDirectory();
        return new ProcessLock(database, keys);
      } catch (error) {
        database?.close();
        const code = errorCode(error);
        if (code?.startsWith("SQLITE_BUSY")) throw daemonRunning();
        if (code === "SQLITE_NOTADB" || code === "SQLITE_FORMAT" || code === "SQLITE_CORRUPT") {
          throw invalidLockArtifact();
        }
        throw error;
      } finally {
        artifact.close();
      }
    } catch (error) {
      pendingLockPaths.delete(pendingPath);
      for (const key of keys) activeLockKeys.delete(key);
      if (errorCode(error) === "ENOENT" && keys.some((key) => key.startsWith("artifact:"))) {
        throw daemonRunning();
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
      try {
        this.database.close();
      } finally {
        for (const key of this.keys) activeLockKeys.delete(key);
      }
    }
  }
}
