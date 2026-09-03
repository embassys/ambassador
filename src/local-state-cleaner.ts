import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export async function clearLocalGatewayState(
  stateDirectory: string,
  lockPath: string,
): Promise<void> {
  const root = resolve(stateDirectory);
  const resolvedLockPath = resolve(lockPath);
  if (dirname(resolvedLockPath) !== root) {
    throw new Error("The Ambassador state path is invalid");
  }

  const lockName = basename(resolvedLockPath);
  const lockArtifacts = new Set([
    lockName,
    `${lockName}-journal`,
    `${lockName}-shm`,
    `${lockName}-wal`,
  ]);
  const entries = await readdir(root);
  for (const name of entries) {
    if (lockArtifacts.has(name)) continue;
    try {
      await rm(join(root, name), { recursive: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
