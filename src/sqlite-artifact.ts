import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

const POSIX = process.platform !== "win32";

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

function sameArtifact(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function secureExistingFile(path: string, invalidArtifact: () => Error): void {
  let pathStats: Stats;
  try {
    pathStats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!pathStats.isFile() || pathStats.nlink !== 1) throw invalidArtifact();

  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const descriptorStats = fstatSync(descriptor);
    pathStats = lstatSync(path);
    if (
      !descriptorStats.isFile() ||
      !pathStats.isFile() ||
      descriptorStats.nlink !== 1 ||
      pathStats.nlink !== 1 ||
      !sameArtifact(descriptorStats, pathStats)
    ) {
      throw invalidArtifact();
    }
    if (POSIX) fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }
}

export function preparePrivateSqliteArtifact(
  path: string,
  invalidArtifact: () => Error,
): PreparedSqliteArtifact {
  const directoryPath = dirname(path);
  const initialDirectoryStats = lstatSync(directoryPath);
  if (!initialDirectoryStats.isDirectory()) throw invalidArtifact();

  let directoryDescriptor: number | undefined;
  let fileDescriptor: number | undefined;
  try {
    if (POSIX) {
      directoryDescriptor = openSync(
        directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const descriptorStats = fstatSync(directoryDescriptor);
      const pathStats = lstatSync(directoryPath);
      if (!descriptorStats.isDirectory() || !pathStats.isDirectory()) throw invalidArtifact();
      if (!sameArtifact(descriptorStats, pathStats)) throw invalidArtifact();
      if (typeof process.getuid === "function" && descriptorStats.uid !== process.getuid()) {
        throw invalidArtifact();
      }
      fchmodSync(directoryDescriptor, 0o700);
    }

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      secureExistingFile(`${path}${suffix}`, invalidArtifact);
    }

    try {
      fileDescriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!lstatSync(path).isFile()) throw invalidArtifact();
      fileDescriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }

    const validateDirectory = () => {
      const currentDirectoryStats = lstatSync(directoryPath);
      const expectedDirectoryStats =
        directoryDescriptor === undefined ? initialDirectoryStats : fstatSync(directoryDescriptor);
      if (
        !currentDirectoryStats.isDirectory() ||
        !sameArtifact(expectedDirectoryStats, currentDirectoryStats)
      ) {
        throw invalidArtifact();
      }
    };
    const validate = () => {
      const descriptorStats = fstatSync(fileDescriptor as number);
      const pathStats = lstatSync(path);
      if (
        !descriptorStats.isFile() ||
        !pathStats.isFile() ||
        descriptorStats.nlink !== 1 ||
        pathStats.nlink !== 1 ||
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
    if (POSIX) fchmodSync(fileDescriptor, 0o600);

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
