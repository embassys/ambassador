import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const destination = join(repository, ".build/desktop/app");
const gateway = join(destination, "gateway");
const downloadRoot = join(repository, ".build/desktop/downloads");
const runtimeVersion = "24.19.0";
const platform = process.platform;
const arch = process.arch;
if (
  !(
    (platform === "darwin" && ["arm64", "x64"].includes(arch)) ||
    (["linux", "win32"].includes(platform) && arch === "x64")
  )
)
  throw new Error("This desktop target has not been approved.");
const packageManager = process.env.npm_execpath;
if (!packageManager || !/\.(?:[cm]?js)$/u.test(packageManager))
  throw new Error("Run this build through the approved pnpm run command.");

async function run(executable, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repository, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Build command failed (${code}).`)),
    );
  });
}
async function fetchBytes(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(downloadRoot, { recursive: true });
const archiveName =
  platform === "win32"
    ? `win-${arch}/node.exe`
    : `node-v${runtimeVersion}-${platform}-${arch}.tar.gz`;
const base = `https://nodejs.org/dist/v${runtimeVersion}/`;
const checksums = (await fetchBytes(`${base}SHASUMS256.txt`)).toString("utf8");
const expected = checksums
  .split("\n")
  .map((line) => line.trim().split(/\s+/u))
  .find((entry) => entry[1] === archiveName)?.[0];
if (!expected || !/^[a-f0-9]{64}$/u.test(expected))
  throw new Error("The runtime is absent from the official checksum manifest.");
const cached = join(downloadRoot, archiveName.replaceAll("/", "-"));
let bytes;
try {
  bytes = await readFile(cached);
} catch {
  bytes = await fetchBytes(`${base}${archiveName}`);
}
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw new Error("Runtime checksum mismatch. Remove the cached download and investigate.");
await writeFile(cached, bytes);
const unpacked = join(downloadRoot, `node-${platform}-${arch}`);
await mkdir(unpacked, { recursive: true });
let runtimeSource;
if (platform === "win32") runtimeSource = cached;
else {
  await run("tar", ["-xzf", cached, "-C", unpacked, "--strip-components=1"]);
  runtimeSource = join(unpacked, "bin/node");
}
await run(process.execPath, [packageManager, "run", "build"]);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
// Keep pnpm's deploy/rebuild state outside the working checkout.
const source = join(repository, ".build/desktop/source");
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
const corePackage = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "LICENSE",
  "README.md",
  ...corePackage.files,
]) {
  await cp(join(repository, file), join(source, file), { recursive: true });
}
const workspace =
  "packages:\n  - .\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nblockExoticSubdeps: true\nallowBuilds:\n  better-sqlite3: true\n";
await writeFile(join(source, "pnpm-workspace.yaml"), workspace);
await run(
  runtimeSource,
  [
    packageManager,
    "--dir",
    source,
    "--filter",
    "@embassys/ambassador",
    "deploy",
    "--legacy",
    "--prod",
    gateway,
  ],
  {
    env: { ...process.env, PATH: `${dirname(runtimeSource)}${delimiter}${process.env.PATH ?? ""}` },
  },
);
await writeFile(join(gateway, "pnpm-workspace.yaml"), workspace);
await mkdir(join(gateway, "runtime"), { recursive: true });
const runtime = join(gateway, "runtime", platform === "win32" ? "node.exe" : "node");
await copyFile(runtimeSource, runtime);
await chmod(runtime, 0o755);
// Native modules must match the standalone runtime, not Electron or the builder's Node.
await run(runtime, [packageManager, "--dir", gateway, "rebuild", "better-sqlite3"], {
  env: { ...process.env, PATH: `${dirname(runtime)}${delimiter}${process.env.PATH ?? ""}` },
});
await build({
  entryPoints: [join(repository, "desktop/src/main.ts")],
  outfile: join(destination, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["electron"],
});
await build({
  entryPoints: [join(repository, "desktop/src/preload.cts")],
  outfile: join(destination, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});
await build({
  entryPoints: [join(repository, "desktop/src/app.tsx")],
  outfile: join(destination, "app.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome144",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
await cp(join(repository, "desktop/src/index.html"), join(destination, "index.html"));
await cp(join(repository, "desktop/src/styles.css"), join(destination, "styles.css"));
const desktop = JSON.parse(await readFile(join(repository, "desktop/package.json"), "utf8"));
const core = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
await writeFile(
  join(destination, "package.json"),
  JSON.stringify(
    {
      name: "ambassador-development",
      productName: "Ambassador Development",
      version: desktop.version,
      private: true,
      type: "module",
      main: "main.js",
    },
    null,
    2,
  ),
);
await writeFile(
  join(destination, "build-manifest.json"),
  JSON.stringify(
    {
      app: desktop.version,
      core: core.version,
      node: runtimeVersion,
      runtimeSha256: expected,
      electron: desktop.devDependencies.electron,
      platform,
      arch,
      protocol: 1,
      source: createHash("sha256")
        .update(await readFile(join(gateway, "dist/desktop/worker.js")))
        .digest("hex"),
      qualification: "Unsigned development build; native qualification pending.",
    },
    null,
    2,
  ),
);
console.log(`Desktop development build: ${destination}`);
