import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDERS = new Set(["codex", "claude", "gemini"]);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function metadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureLiteralDirectory(path) {
  const entry = await metadata(path);
  if (entry === undefined) {
    await mkdir(path, { mode: 0o755 });
    await chmod(path, 0o755);
    return;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe output path");
}

async function removeLiteralDirectory(path) {
  const entry = await metadata(path);
  if (entry === undefined) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("unsafe output target");
  await rm(path, { recursive: true });
}

async function inventory(root) {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
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

function directoriesFor(files) {
  const directories = new Set();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent.split(sep).join("/"));
      parent = dirname(parent);
    }
  }
  return [...directories].sort();
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function expectedOutputs(provider) {
  const roots = [
    [join(repositoryRoot, "packages", "connector-core", "src"), "connector-core/src"],
    [join(repositoryRoot, "packages", `${provider}-connector`, "src"), `${provider}-connector/src`],
  ];
  const outputs = [];
  for (const [sourceRoot, outputPrefix] of roots) {
    const source = await inventory(sourceRoot);
    if (source.files.some((file) => !file.endsWith(".ts"))) {
      throw new Error("unexpected connector source");
    }
    for (const file of source.files) {
      outputs.push(`${outputPrefix}/${file.replace(/\.ts$/u, ".js")}`);
    }
  }
  return outputs.sort();
}

function run(executable, arguments_, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolveRun();
      else reject(new Error("connector compiler failed"));
    });
  });
}

async function main() {
  const [provider, ...rest] = process.argv.slice(2);
  if (provider === undefined || rest.length !== 0 || !PROVIDERS.has(provider)) {
    throw new Error("invalid provider");
  }

  const buildParent = join(repositoryRoot, ".build");
  const connectorsParent = join(buildParent, "connectors");
  const buildRoot = join(connectorsParent, provider);
  const temporaryRoot = join(connectorsParent, `${provider}.tmp`);
  await ensureLiteralDirectory(buildParent);
  await ensureLiteralDirectory(connectorsParent);
  await removeLiteralDirectory(buildRoot);
  await removeLiteralDirectory(temporaryRoot);

  const tsc = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  const configuration = join(
    repositoryRoot,
    "packages",
    `${provider}-connector`,
    "tsconfig.build.json",
  );
  await run(
    process.execPath,
    [tsc, "-p", configuration, "--outDir", temporaryRoot],
    repositoryRoot,
  );

  const expectedFiles = await expectedOutputs(provider);
  const actual = await inventory(temporaryRoot);
  if (
    !equalArrays(actual.files, expectedFiles) ||
    !equalArrays(actual.directories, directoriesFor(expectedFiles))
  ) {
    throw new Error("unexpected connector build inventory");
  }
  await rename(temporaryRoot, buildRoot);
}

try {
  await main();
} catch {
  process.stderr.write("a2a connector build failed\n");
  process.exitCode = 1;
}
