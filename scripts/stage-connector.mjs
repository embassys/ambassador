import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDERS = new Set(["codex", "claude", "gemini"]);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const SHEBANG = Buffer.from("#!/usr/bin/env node\n", "ascii");

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

async function expectedBuildFiles(provider) {
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

async function copyChecked(source, target, mode) {
  const sourceEntry = await lstat(source);
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
    throw new Error("unsafe staging source");
  }
  await copyFile(source, target);
  await chmod(target, mode);
  const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)]);
  if (!sourceBytes.equals(targetBytes)) throw new Error("staging changed bytes");
}

async function main() {
  const [provider, ...rest] = process.argv.slice(2);
  if (provider === undefined || rest.length !== 0 || !PROVIDERS.has(provider)) {
    throw new Error("invalid provider");
  }

  const buildRoot = join(repositoryRoot, ".build", "connectors", provider);
  const buildFiles = await expectedBuildFiles(provider);
  const build = await inventory(buildRoot);
  if (
    !equalArrays(build.files, buildFiles) ||
    !equalArrays(build.directories, directoriesFor(buildFiles))
  ) {
    throw new Error("unexpected connector build inventory");
  }

  const stageParent = join(repositoryRoot, ".stage");
  const connectorsParent = join(stageParent, "connectors");
  const providerRoot = join(connectorsParent, provider);
  const temporaryRoot = join(connectorsParent, `${provider}.tmp`);
  const packageRoot = join(temporaryRoot, "package");
  await ensureLiteralDirectory(stageParent);
  await ensureLiteralDirectory(connectorsParent);
  await removeLiteralDirectory(providerRoot);
  await removeLiteralDirectory(temporaryRoot);
  await mkdir(packageRoot, { recursive: true, mode: 0o755 });
  await chmod(temporaryRoot, 0o755);
  await chmod(packageRoot, 0o755);

  const stageFiles = [
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    ...buildFiles.map((file) => `dist/${file}`),
  ].sort();
  for (const directory of directoriesFor(stageFiles)) {
    const target = join(packageRoot, directory);
    await mkdir(target, { recursive: true, mode: 0o755 });
    await chmod(target, 0o755);
  }

  for (const file of buildFiles) {
    await copyChecked(
      join(buildRoot, file),
      join(packageRoot, "dist", file),
      file === `${provider}-connector/src/cli.js` ? 0o755 : 0o644,
    );
  }
  await copyChecked(join(repositoryRoot, "LICENSE"), join(packageRoot, "LICENSE"), 0o644);
  for (const leaf of ["README.md", "SECURITY.md", "package.json"]) {
    await copyChecked(
      join(repositoryRoot, "packages", `${provider}-connector`, leaf),
      join(packageRoot, leaf),
      0o644,
    );
  }

  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (
    manifest.name !== `@a2adev/${provider}-connector` ||
    manifest.version !== "0.0.0-private" ||
    manifest.private !== true ||
    "scripts" in manifest
  ) {
    throw new Error("unexpected provider manifest");
  }
  for (const cli of [
    join(repositoryRoot, "packages", `${provider}-connector`, "src", "cli.ts"),
    join(buildRoot, `${provider}-connector`, "src", "cli.js"),
    join(packageRoot, "dist", `${provider}-connector`, "src", "cli.js"),
  ]) {
    const bytes = await readFile(cli);
    if (!bytes.subarray(0, SHEBANG.byteLength).equals(SHEBANG)) {
      throw new Error("connector command shebang changed");
    }
  }

  const staged = await inventory(packageRoot);
  if (
    !equalArrays(staged.files, stageFiles) ||
    !equalArrays(staged.directories, directoriesFor(stageFiles))
  ) {
    throw new Error("unexpected connector stage inventory");
  }
  await rename(temporaryRoot, providerRoot);
}

try {
  await main();
} catch {
  process.stderr.write("a2a connector staging failed\n");
  process.exitCode = 1;
}
