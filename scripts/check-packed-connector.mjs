import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const PROVIDERS = ["codex", "claude", "gemini"];
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function inventory(root, allowSymbolicRoot = false) {
  const rootEntry = await lstat(root);
  if (
    (!allowSymbolicRoot && rootEntry.isSymbolicLink()) ||
    (!rootEntry.isSymbolicLink() && !rootEntry.isDirectory())
  ) {
    throw new Error("unsafe inventory root");
  }
  const directories = [];
  const files = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = portableRelative(root, join(entry.parentPath, entry.name));
    if (entry.isDirectory()) directories.push(path);
    else if (entry.isFile()) files.push(path);
    else throw new Error("linked or special artifact");
  }
  return { directories: directories.sort(), files: files.sort() };
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function run(executable, arguments_, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function runRequired(executable, arguments_, options) {
  const result = await run(executable, arguments_, options);
  if (result.code !== 0 || result.signal !== null) throw new Error("artifact command failed");
  return result;
}

function tarText(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function tarOctal(bytes, offset, length) {
  const value = tarText(bytes, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("invalid tar number");
  return Number.parseInt(value, 8);
}

function readTarball(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const entries = [];
  const seen = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("invalid tar terminator");
      }
      ended = true;
      break;
    }
    const expectedChecksum = tarOctal(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    if (checksum !== expectedChecksum) throw new Error("invalid tar checksum");
    const prefix = tarText(header, 345, 155);
    const name = tarText(header, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (
      !path.startsWith("package/") ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").includes("..") ||
      seen.has(path)
    ) {
      throw new Error("unsafe tar path");
    }
    seen.add(path);
    const size = tarOctal(header, 124, 12);
    const mode = tarOctal(header, 100, 8) & 0o777;
    const typeByte = header[156] ?? 0;
    if (typeByte !== 0 && typeByte !== 0x30 && typeByte !== 0x35) {
      throw new Error("unexpected tar entry");
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error("truncated tar entry");
    entries.push({
      path,
      type: typeByte === 0x35 ? "directory" : "file",
      mode,
      bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || entries.length === 0) throw new Error("incomplete tarball");
  return entries;
}

async function checkTarball(provider, stageRoot, tarball, staged) {
  if ((await stat(tarball)).size > 32 * 1024 * 1024) throw new Error("oversized artifact");
  const entries = readTarball(await readFile(tarball));
  const files = entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.path.slice("package/".length))
    .sort();
  if (!equalArrays(files, staged.files)) throw new Error("packed file inventory changed");
  const expectedDirectories = new Set(staged.directories);
  for (const entry of entries) {
    const path = entry.path.slice("package/".length).replace(/\/$/u, "");
    if (
      path.includes("gateway") ||
      PROVIDERS.some(
        (candidate) => candidate !== provider && path.includes(`${candidate}-connector`),
      )
    ) {
      throw new Error("artifact contains unrelated product code");
    }
    if (entry.type === "directory") {
      if (!expectedDirectories.has(path) || entry.mode !== 0o755) {
        throw new Error("packed directory changed");
      }
      continue;
    }
    const stagedBytes = await readFile(join(stageRoot, path));
    const expectedMode = path === `dist/${provider}-connector/src/cli.js` ? 0o755 : 0o644;
    const contentMatches =
      path === "package.json"
        ? JSON.stringify(JSON.parse(entry.bytes.toString("utf8"))) ===
          JSON.stringify(JSON.parse(stagedBytes.toString("utf8")))
        : createHash("sha256").update(entry.bytes).digest("hex") ===
          createHash("sha256").update(stagedBytes).digest("hex");
    if (!contentMatches || entry.mode !== expectedMode) {
      throw new Error("packed file changed");
    }
  }
}

async function validatedStoreDirectory(argument) {
  if (argument === undefined) return undefined;
  const prefix = "--store-dir=";
  if (!argument.startsWith(prefix)) throw new Error("invalid pnpm store argument");
  const requested = argument.slice(prefix.length);
  if (!isAbsolute(requested)) throw new Error("invalid pnpm store argument");
  const canonical = await realpath(requested);
  const [store, index, fileShards] = await Promise.all([
    lstat(canonical),
    lstat(join(canonical, "index.db")),
    readdir(join(canonical, "files"), { withFileTypes: true }),
  ]);
  if (
    !store.isDirectory() ||
    store.isSymbolicLink() ||
    !index.isFile() ||
    index.isSymbolicLink() ||
    !fileShards.some((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  ) {
    throw new Error("invalid pnpm store argument");
  }
  return canonical;
}

async function validatedPnpmCli(argument) {
  if (argument === undefined) return undefined;
  const prefix = "--pnpm-cli=";
  if (!argument.startsWith(prefix)) throw new Error("invalid pnpm CLI argument");
  const requested = argument.slice(prefix.length);
  if (!isAbsolute(requested)) throw new Error("invalid pnpm CLI argument");
  const canonical = await realpath(requested);
  const entry = await lstat(canonical);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("invalid pnpm CLI argument");
  const version = await run(process.execPath, [canonical, "--version"], {
    cwd: repositoryRoot,
    env: process.env,
  });
  if (
    version.code !== 0 ||
    version.signal !== null ||
    version.stdout !== "11.22.0\n" ||
    version.stderr !== ""
  ) {
    throw new Error("invalid pnpm CLI argument");
  }
  return canonical;
}

async function validatedPnpmCache(argument) {
  if (argument === undefined) return undefined;
  const prefix = "--cache-dir=";
  if (!argument.startsWith(prefix)) throw new Error("invalid pnpm cache argument");
  const requested = argument.slice(prefix.length);
  if (!isAbsolute(requested)) throw new Error("invalid pnpm cache argument");
  const canonical = await realpath(requested);
  const metadataRoot = join(canonical, "v11", "metadata", "registry.npmjs.org");
  const [cache, metadata, client, sqlite, zod] = await Promise.all([
    lstat(canonical),
    lstat(metadataRoot),
    lstat(join(metadataRoot, "@modelcontextprotocol", "client.jsonl")),
    lstat(join(metadataRoot, "better-sqlite3.jsonl")),
    lstat(join(metadataRoot, "zod.jsonl")),
  ]);
  if (
    !cache.isDirectory() ||
    cache.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    [client, sqlite, zod].some(
      (entry) => !entry.isFile() || entry.isSymbolicLink() || entry.size < 1,
    )
  ) {
    throw new Error("invalid pnpm cache argument");
  }
  return canonical;
}

async function main() {
  const [provider, storeArgument, pnpmCliArgument, cacheArgument, ...rest] = process.argv.slice(2);
  if (
    provider === undefined ||
    rest.length !== 0 ||
    !PROVIDERS.includes(provider) ||
    (storeArgument !== undefined && !storeArgument.startsWith("--store-dir=")) ||
    (pnpmCliArgument !== undefined && !pnpmCliArgument.startsWith("--pnpm-cli=")) ||
    (cacheArgument !== undefined && !cacheArgument.startsWith("--cache-dir="))
  ) {
    throw new Error("invalid provider");
  }
  const storeDirectory = await validatedStoreDirectory(storeArgument);
  const pnpmCli = await validatedPnpmCli(pnpmCliArgument);
  const cacheDirectory = await validatedPnpmCache(cacheArgument);
  const pnpmStoreArgument =
    storeDirectory === undefined ? [] : [`--config.store-dir=${storeDirectory}`];
  const pnpmCacheArgument =
    cacheDirectory === undefined ? [] : [`--config.cache-dir=${cacheDirectory}`];
  const pnpmExecutable = pnpmCli === undefined ? "pnpm" : process.execPath;
  const pnpmArguments = (arguments_) =>
    pnpmCli === undefined ? arguments_ : [pnpmCli, ...arguments_];

  await runRequired(
    process.execPath,
    [join(repositoryRoot, "scripts", "build-connector.mjs"), provider],
    {
      cwd: repositoryRoot,
    },
  );
  await runRequired(
    process.execPath,
    [join(repositoryRoot, "scripts", "stage-connector.mjs"), provider],
    {
      cwd: repositoryRoot,
    },
  );

  const temporaryRoot = await mkdtemp(join(tmpdir(), `a2a-${provider}-packed-check-`));
  await chmod(temporaryRoot, 0o700);
  try {
    const stageRoot = join(repositoryRoot, ".stage", "connectors", provider, "package");
    const staged = await inventory(stageRoot);
    const tarball = join(temporaryRoot, `${provider}-connector.tgz`);
    await runRequired(
      pnpmExecutable,
      pnpmArguments(["pack", ...pnpmStoreArgument, ...pnpmCacheArgument, "--out", tarball]),
      {
        cwd: stageRoot,
        env: { ...process.env, npm_config_ignore_scripts: "true" },
      },
    );
    await checkTarball(provider, stageRoot, tarball, staged);

    const installRoot = join(temporaryRoot, "install");
    await mkdir(installRoot, { mode: 0o700 });
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ name: "connector-packed-check", private: true })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await runRequired(
      pnpmExecutable,
      pnpmArguments([
        "add",
        ...pnpmStoreArgument,
        ...pnpmCacheArgument,
        "--offline",
        "--ignore-scripts",
        "--package-import-method=copy",
        tarball,
      ]),
      {
        cwd: installRoot,
        env: {
          ...process.env,
          CI: "true",
          npm_config_ignore_scripts: "true",
          npm_config_offline: "true",
        },
      },
    );

    const installedPackage = join(installRoot, "node_modules", "@a2adev", `${provider}-connector`);
    const installed = await inventory(installedPackage, true);
    const packageManagerShim = `node_modules/.bin/a2a-${provider}-connector`;
    if (
      !equalArrays(installed.files, [...staged.files, packageManagerShim].sort()) ||
      !equalArrays(
        installed.directories,
        [...staged.directories, "node_modules", "node_modules/.bin"].sort(),
      )
    ) {
      throw new Error("installed artifact inventory changed");
    }
    if (((await stat(join(installedPackage, packageManagerShim))).mode & 0o111) === 0) {
      throw new Error("installed package-manager shim is not executable");
    }
    for (const file of staged.files) {
      const [stageBytes, installedBytes] = await Promise.all([
        readFile(join(stageRoot, file)),
        readFile(join(installedPackage, file)),
      ]);
      const contentMatches =
        file === "package.json"
          ? JSON.stringify(JSON.parse(installedBytes.toString("utf8"))) ===
            JSON.stringify(JSON.parse(stageBytes.toString("utf8")))
          : stageBytes.equals(installedBytes);
      if (!contentMatches) throw new Error("installed artifact changed");
    }

    const shim = join(installRoot, "node_modules", ".bin", `a2a-${provider}-connector`);
    const smoke = await run(shim, [], { cwd: installRoot, env: process.env });
    if (
      smoke.code !== 2 ||
      smoke.signal !== null ||
      smoke.stdout !== "" ||
      smoke.stderr !== "a2a connector: invalid_connector_arguments\n"
    ) {
      throw new Error("installed connector command failed");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch {
  process.stderr.write("a2a connector packed check failed\n");
  process.exitCode = 1;
}
