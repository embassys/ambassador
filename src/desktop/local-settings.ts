import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { secureWindowsArtifact } from "../windows-access-control.js";

/** Nonsecret, owner-only desktop preferences. The caller serializes writes. */
export async function readLocalSettings<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error("Invalid desktop settings file.");
    file = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new Error("Invalid desktop settings.");
    const bytes = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 256 * 1024) throw new Error("Desktop settings are too large.");
    return schema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await file.close();
  }
}

export async function writeLocalSettings(path: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value);
  if (Buffer.byteLength(contents) > 256 * 1024) throw new Error("Desktop settings are too large.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform === "win32") await secureWindowsArtifact(temporary, "file");
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
