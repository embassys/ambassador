import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";

import { secureWindowsArtifactSync, type WindowsArtifactKind } from "./windows-access-control.js";

export interface WindowsSqliteAccessControl {
  secure(path: string, kind: WindowsArtifactKind): void;
}

export interface PrivateSqliteArtifactOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAccessControl?: WindowsSqliteAccessControl;
}

export interface PreparedSqliteArtifact {
  validate: () => void;
  validateDirectory: () => void;
  releaseFile: () => void;
  close: () => void;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function sameArtifact(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureExistingFile(
  path: string,
  invalidArtifact: () => Error,
  platform: NodeJS.Platform,
  windowsAccessControl: WindowsSqliteAccessControl | undefined,
): void {
  let pathStats: BigIntStats;
  try {
    pathStats = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!pathStats.isFile() || pathStats.nlink !== 1n) throw invalidArtifact();

  if (platform === "win32") windowsAccessControl?.secure(path, "file");
  else chmodSync(path, 0o600);
  const currentStats = lstatSync(path, { bigint: true });
  if (
    !currentStats.isFile() ||
    currentStats.nlink !== 1n ||
    !sameArtifact(pathStats, currentStats)
  ) {
    throw invalidArtifact();
  }
}

export function preparePrivateSqliteArtifact(
  path: string,
  invalidArtifact: () => Error,
  options: PrivateSqliteArtifactOptions = {},
): PreparedSqliteArtifact {
  const platform = options.platform ?? process.platform;
  const windowsAccessControl =
    platform === "win32"
      ? (options.windowsAccessControl ?? { secure: secureWindowsArtifactSync })
      : undefined;
  const directoryPath = dirname(path);
  const initialDirectoryStats = lstatSync(directoryPath, { bigint: true });
  if (!initialDirectoryStats.isDirectory()) throw invalidArtifact();

  if (platform === "win32") windowsAccessControl?.secure(directoryPath, "directory");

  let directoryDescriptor: number | undefined;
  let fileDescriptor: number | undefined;
  try {
    if (platform !== "win32") {
      directoryDescriptor = openSync(
        directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const descriptorStats = fstatSync(directoryDescriptor, { bigint: true });
      const pathStats = lstatSync(directoryPath, { bigint: true });
      if (!descriptorStats.isDirectory() || !pathStats.isDirectory()) throw invalidArtifact();
      if (!sameArtifact(descriptorStats, pathStats)) throw invalidArtifact();
      if (
        typeof process.getuid === "function" &&
        descriptorStats.uid !== BigInt(process.getuid())
      ) {
        throw invalidArtifact();
      }
      fchmodSync(directoryDescriptor, 0o700);
    }

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      secureExistingFile(`${path}${suffix}`, invalidArtifact, platform, windowsAccessControl);
    }

    let created = false;
    try {
      fileDescriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const pathStats = lstatSync(path, { bigint: true });
      if (!pathStats.isFile() || pathStats.nlink !== 1n) throw invalidArtifact();
      if (platform === "win32") windowsAccessControl?.secure(path, "file");
      const noFollow = platform === "win32" ? 0 : constants.O_NOFOLLOW;
      fileDescriptor = openSync(path, constants.O_RDWR | noFollow);
    }
    if (created && platform === "win32") windowsAccessControl?.secure(path, "file");

    const validateDirectory = () => {
      const currentDirectoryStats = lstatSync(directoryPath, { bigint: true });
      const expectedDirectoryStats =
        directoryDescriptor === undefined
          ? initialDirectoryStats
          : fstatSync(directoryDescriptor, { bigint: true });
      if (
        !currentDirectoryStats.isDirectory() ||
        !sameArtifact(expectedDirectoryStats, currentDirectoryStats)
      ) {
        throw invalidArtifact();
      }
    };
    const validate = () => {
      const descriptorStats = fstatSync(fileDescriptor as number, { bigint: true });
      const pathStats = lstatSync(path, { bigint: true });
      if (
        !descriptorStats.isFile() ||
        !pathStats.isFile() ||
        descriptorStats.nlink !== 1n ||
        pathStats.nlink !== 1n ||
        !sameArtifact(descriptorStats, pathStats)
      ) {
        throw invalidArtifact();
      }
      validateDirectory();
    };
    const releaseFile = () => {
      if (fileDescriptor !== undefined) {
        closeSync(fileDescriptor);
        fileDescriptor = undefined;
      }
    };

    validate();
    if (platform !== "win32") fchmodSync(fileDescriptor, 0o600);

    return {
      validate,
      validateDirectory,
      releaseFile,
      close: () => {
        releaseFile();
        if (directoryDescriptor !== undefined) {
          closeSync(directoryDescriptor);
          directoryDescriptor = undefined;
        }
      },
    };
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    throw error;
  }
}
