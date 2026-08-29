/**
 * Scan only a quiescent artifact tree. Callers must stop and reap the managed
 * process tree before invoking this module. The scanner revalidates directories
 * and opens files with no-follow semantics, but Node has no portable openat
 * traversal. Concurrent artifact writers, renames, and link changes are
 * outside this support contract. Callers must treat any such activity as a
 * harness failure and must not rely on this scanner to detect every race.
 */

import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const HARD_LIMITS = Object.freeze({
  maxFiles: 4_096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalFileBytes: 64 * 1024 * 1024,
  maxCaptureBytes: 1024 * 1024,
  maxTotalCaptureBytes: 8 * 1024 * 1024,
  maxDepth: 32,
});
const MAX_ROOTS = 16;
const MAX_CAPTURES = 64;
const MAX_MARKERS = 256;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class ScanFinding extends Error {
  constructor(message) {
    super(message);
    this.name = "ScanFinding";
  }
}

class ScanConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScanConfigurationError";
  }
}

function configurationError(message) {
  return new ScanConfigurationError(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key))
  );
}

function requireLabel(value, field) {
  if (typeof value !== "string" || !LABEL.test(value)) {
    throw configurationError(`${field} must use 1 to 64 lowercase label characters`);
  }
  return value;
}

function requirePositiveInteger(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configurationError(`${field} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function parseLimits(value) {
  if (value === undefined) return { ...HARD_LIMITS };
  if (!isObject(value) || !exactKeys(value, [], Object.keys(HARD_LIMITS))) {
    throw configurationError("limits contains an unknown field or is not an object");
  }
  const limits = { ...HARD_LIMITS };
  for (const name of Object.keys(HARD_LIMITS)) {
    if (value[name] !== undefined) {
      limits[name] = requirePositiveInteger(value[name], `limits.${name}`, HARD_LIMITS[name]);
    }
  }
  return limits;
}

function decodeMarker(marker, index) {
  if (!isObject(marker) || !exactKeys(marker, ["name", "encoding", "value"])) {
    throw configurationError(`markers[${index}] has an invalid shape`);
  }
  const name = requireLabel(marker.name, `markers[${index}].name`);
  if (typeof marker.value !== "string") {
    throw configurationError(`markers[${index}].value must be a string`);
  }

  let bytes;
  switch (marker.encoding) {
    case "utf8":
      bytes = Buffer.from(marker.value, "utf8");
      break;
    case "base64": {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(marker.value)) {
        throw configurationError(`markers[${index}].value is not canonical base64`);
      }
      bytes = Buffer.from(marker.value, "base64");
      if (bytes.toString("base64") !== marker.value) {
        throw configurationError(`markers[${index}].value is not canonical base64`);
      }
      break;
    }
    default:
      throw configurationError(`markers[${index}].encoding must be utf8 or base64`);
  }

  if (bytes.byteLength < 6 || bytes.byteLength > 16 * 1024) {
    throw configurationError(`markers[${index}] must decode to 6 through 16384 bytes`);
  }
  return { name, bytes };
}

function parseManifest(value) {
  if (!isObject(value) || !exactKeys(value, ["roots", "captures", "markers"], ["limits"])) {
    throw configurationError("manifest has an invalid shape");
  }
  if (!Array.isArray(value.roots) || value.roots.length > MAX_ROOTS) {
    throw configurationError(`roots must contain at most ${MAX_ROOTS} entries`);
  }
  const roots = value.roots.map((root, index) => {
    if (typeof root !== "string" || root.length === 0 || root.length > 4_096 || !isAbsolute(root)) {
      throw configurationError(`roots[${index}] must be a bounded absolute path`);
    }
    return root;
  });

  if (!Array.isArray(value.captures) || value.captures.length > MAX_CAPTURES) {
    throw configurationError(`captures must contain at most ${MAX_CAPTURES} entries`);
  }
  const captures = value.captures.map((capture, index) => {
    if (!isObject(capture) || !exactKeys(capture, ["name", "value"], ["truncated"])) {
      throw configurationError(`captures[${index}] has an invalid shape`);
    }
    if (typeof capture.value !== "string") {
      throw configurationError(`captures[${index}].value must be a string`);
    }
    if (capture.truncated !== undefined && typeof capture.truncated !== "boolean") {
      throw configurationError(`captures[${index}].truncated must be a boolean`);
    }
    return {
      name: requireLabel(capture.name, `captures[${index}].name`),
      bytes: Buffer.from(capture.value, "utf8"),
      truncated: capture.truncated ?? false,
    };
  });

  if (
    !Array.isArray(value.markers) ||
    value.markers.length === 0 ||
    value.markers.length > MAX_MARKERS
  ) {
    throw configurationError(`markers must contain 1 through ${MAX_MARKERS} entries`);
  }
  const markers = value.markers.map(decodeMarker);
  const names = new Set();
  for (const marker of markers) {
    if (names.has(marker.name)) throw configurationError("marker names must be unique");
    names.add(marker.name);
  }

  return { roots, captures, markers, limits: parseLimits(value.limits) };
}

async function readManifest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_MANIFEST_BYTES) throw configurationError("manifest exceeds 2 MiB");
    chunks.push(bytes);
  }
  if (size === 0) throw configurationError("manifest is required on stdin");
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw configurationError("manifest is not valid JSON");
  }
  return value;
}

function assertNoMarker(bytes, markers, location) {
  for (const marker of markers) {
    if (bytes.indexOf(marker.bytes) !== -1) {
      throw new ScanFinding(`forbidden ${marker.name} found in ${location}`);
    }
  }
}

async function readBoundedFile(path, maximum, remainingTotalBytes) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw configurationError("this platform lacks no-follow artifact-file opens");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw configurationError("artifact entry could not be opened safely");
  }
  let metadata;
  try {
    metadata = await handle.stat();
  } catch {
    await handle.close().catch(() => undefined);
    throw configurationError("artifact entry could not be inspected safely");
  }
  if (!metadata.isFile()) {
    await handle.close().catch(() => undefined);
    throw configurationError("artifact entry changed type during the scan");
  }
  if (metadata.size > maximum) {
    await handle.close().catch(() => undefined);
    throw configurationError("artifact file exceeds the configured byte limit");
  }
  if (metadata.size > remainingTotalBytes) {
    await handle.close().catch(() => undefined);
    throw configurationError("artifact tree exceeds the configured total-byte limit");
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maximum || size > remainingTotalBytes) {
        throw configurationError("artifact file changed or exceeded its configured byte limit");
      }
      chunks.push(bytes);
    }
    const finalMetadata = await handle.stat();
    if (
      !finalMetadata.isFile() ||
      finalMetadata.dev !== metadata.dev ||
      finalMetadata.ino !== metadata.ino ||
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ctimeMs !== metadata.ctimeMs ||
      size !== metadata.size
    ) {
      throw configurationError("artifact file changed during the scan");
    }
  } catch (error) {
    if (error instanceof ScanConfigurationError) throw error;
    throw configurationError("artifact file could not be read safely");
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { bytes: Buffer.concat(chunks, size), size };
}

function isWithin(candidate, parent) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

async function validateDirectory(path, artifactRoot, repositoryRoot) {
  let metadata;
  let resolvedPath;
  try {
    metadata = await lstat(path);
    resolvedPath = await realpath(path);
  } catch {
    throw configurationError("artifact directory could not be inspected safely");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw configurationError("artifact trees must contain only real directories");
  }
  if (!isWithin(resolvedPath, artifactRoot) || overlaps(resolvedPath, repositoryRoot)) {
    throw configurationError("artifact directory escaped its approved root");
  }
  return resolvedPath;
}

async function scanRoot(root, rootIndex, manifest, counters, repositoryRoot) {
  let suppliedRootMetadata;
  let resolvedRoot;
  try {
    suppliedRootMetadata = await lstat(root);
    resolvedRoot = await realpath(root);
  } catch {
    throw configurationError("artifact root could not be inspected safely");
  }
  if (!suppliedRootMetadata.isDirectory() || suppliedRootMetadata.isSymbolicLink()) {
    throw configurationError("each artifact root must be a real directory");
  }
  if (overlaps(resolvedRoot, repositoryRoot)) {
    throw configurationError("artifact roots must not overlap the repository source tree");
  }

  const pending = [{ path: resolvedRoot, depth: 0 }];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    if (directory.depth > manifest.limits.maxDepth) {
      throw configurationError("artifact tree exceeds the configured depth limit");
    }
    const directoryPath = await validateDirectory(directory.path, resolvedRoot, repositoryRoot);
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      throw configurationError("artifact directory could not be enumerated safely");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const path = resolve(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw configurationError("artifact trees must not contain symbolic links");
      }
      if (entry.isDirectory()) {
        pending.push({ path, depth: directory.depth + 1 });
        continue;
      }
      if (!entry.isFile()) {
        throw configurationError("artifact trees must contain only files and directories");
      }
      counters.files += 1;
      if (counters.files > manifest.limits.maxFiles) {
        throw configurationError("artifact tree exceeds the configured file-count limit");
      }
      const file = await readBoundedFile(
        path,
        manifest.limits.maxFileBytes,
        manifest.limits.maxTotalFileBytes - counters.fileBytes,
      );
      counters.fileBytes += file.size;
      assertNoMarker(
        file.bytes,
        manifest.markers,
        `artifact-root-${rootIndex + 1}-file-${counters.files}`,
      );
    }
  }
}

export async function scanArtifactManifest(manifestValue) {
  const manifest = parseManifest(manifestValue);
  const counters = { files: 0, fileBytes: 0, captures: 0, captureBytes: 0 };
  for (const capture of manifest.captures) {
    if (capture.truncated) {
      throw configurationError(`capture-${capture.name} is truncated`);
    }
    if (capture.bytes.byteLength > manifest.limits.maxCaptureBytes) {
      throw configurationError("capture exceeds the configured byte limit");
    }
    counters.captures += 1;
    counters.captureBytes += capture.bytes.byteLength;
    if (counters.captureBytes > manifest.limits.maxTotalCaptureBytes) {
      throw configurationError("captures exceed the configured total-byte limit");
    }
    assertNoMarker(capture.bytes, manifest.markers, `capture-${capture.name}`);
  }

  const repositoryRoot = await realpath(REPOSITORY_ROOT);
  for (let index = 0; index < manifest.roots.length; index += 1) {
    const root = manifest.roots[index];
    if (root !== undefined) await scanRoot(root, index, manifest, counters, repositoryRoot);
  }
  return counters;
}

async function main() {
  try {
    const manifest = await readManifest();
    const counters = await scanArtifactManifest(manifest);
    process.stdout.write(
      `artifact scan passed: ${counters.files} files, ${counters.fileBytes} file bytes, ${counters.captures} captures, ${counters.captureBytes} capture bytes\n`,
    );
  } catch (error) {
    if (error instanceof ScanFinding) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const message =
      error instanceof ScanConfigurationError ? error.message : "unexpected scan failure";
    process.stderr.write(`artifact scan configuration failed: ${message}\n`);
    process.exitCode = 2;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
