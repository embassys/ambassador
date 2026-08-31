import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, join } from "node:path";

export const CODEX_SCHEMA_SHA256 =
  "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9";
export const CODEX_VERSION_STDOUT = "codex-cli 0.149.0\n";
export const CX04_CONFIRMATION = "run-authenticated-codex-0.149.0-on-disposable-account";

const SCHEMA_FILE = "codex_app_server_protocol.v2.schemas.json";
const COMMAND_CAPTURE_BYTES = 1024 * 1024;
const CONFIG_BYTES = 1024 * 1024;
const PHASES = new Set([
  "precondition",
  "package",
  "version",
  "schema",
  "behavior",
  "config",
  "artifact",
  "cleanup",
  "internal",
]);

function phaseError(phase) {
  return Object.assign(new Error("CX04 qualification phase failed"), { phase });
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function boundedCapture(stream, maximumBytes, onOverflow) {
  const chunks = [];
  let bytes = 0;
  stream.on("data", (chunk) => {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      onOverflow();
      return;
    }
    chunks.push(value);
  });
  return () => Buffer.concat(chunks).toString("utf8");
}

export function runBoundedCommand(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.cwd,
      env: { ...request.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let overflowed = false;
    const stop = () => {
      overflowed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const stdout = boundedCapture(child.stdout, COMMAND_CAPTURE_BYTES, stop);
    const stderr = boundedCapture(child.stderr, COMMAND_CAPTURE_BYTES, stop);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, request.timeoutMs ?? 120_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut || overflowed) {
        reject(phaseError(request.phase ?? "internal"));
        return;
      }
      resolve({ code, signal, stdout: stdout(), stderr: stderr() });
    });
  });
}

async function requiredCommand(run, request, phase) {
  let result;
  try {
    result = await run({ ...request, phase });
  } catch {
    throw phaseError(phase);
  }
  if (result.code !== 0 || result.signal !== null) throw phaseError(phase);
  return result;
}

export async function preparePackedConnector(options, run) {
  const tarball = join(options.temporaryRoot, "codex-connector.tgz");
  const installRoot = join(options.temporaryRoot, "install");
  const environment = {
    ...options.environment,
    CI: "true",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
  };
  await requiredCommand(
    run,
    {
      executable: options.nodeExecutable,
      arguments: [join(options.repositoryRoot, "scripts", "build-connector.mjs"), "codex"],
      cwd: options.repositoryRoot,
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: options.nodeExecutable,
      arguments: [join(options.repositoryRoot, "scripts", "stage-connector.mjs"), "codex"],
      cwd: options.repositoryRoot,
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: options.nodeExecutable,
      arguments: [join(options.repositoryRoot, "scripts", "check-packed-connector.mjs"), "codex"],
      cwd: options.repositoryRoot,
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: options.pnpmExecutable,
      arguments: ["pack", "--ignore-scripts", "--out", tarball],
      cwd: join(options.repositoryRoot, ".stage", "connectors", "codex", "package"),
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: options.pnpmExecutable,
      arguments: ["add", "--offline", "--ignore-scripts", "--package-import-method=copy", tarball],
      cwd: installRoot,
      environment,
    },
    "package",
  );
  return {
    tarball,
    installRoot,
    connectorExecutable: join(installRoot, "node_modules", ".bin", "a2a-codex-connector"),
  };
}

export async function verifyCodexInstallation(options, dependencies) {
  const version = await requiredCommand(
    dependencies.run,
    {
      executable: options.executable,
      arguments: ["--version"],
      cwd: options.schemaDirectories[0],
      environment: options.environment,
      timeoutMs: 5_000,
    },
    "version",
  );
  if (version.stdout !== CODEX_VERSION_STDOUT) throw phaseError("version");

  const digests = [];
  for (const directory of options.schemaDirectories) {
    await requiredCommand(
      dependencies.run,
      {
        executable: options.executable,
        arguments: ["app-server", "generate-json-schema", "--out", directory],
        cwd: directory,
        environment: options.environment,
        timeoutMs: 30_000,
      },
      "schema",
    );
    let bytes;
    try {
      bytes = await dependencies.readSchema(join(directory, SCHEMA_FILE));
    } catch {
      throw phaseError("schema");
    }
    digests.push(createHash("sha256").update(bytes).digest("hex"));
  }
  if (
    digests.length !== 2 ||
    digests[0] !== digests[1] ||
    digests[0] !== options.expectedSchemaSha256
  ) {
    throw phaseError("schema");
  }
  return { schemaSha256: digests[0] };
}

export async function configFingerprint(path) {
  let before;
  try {
    before = await stat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { kind: "absent" };
    throw phaseError("config");
  }
  if (!before.isFile() || before.size > CONFIG_BYTES) throw phaseError("config");
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw phaseError("config");
  }
  const after = await stat(path).catch(() => {
    throw phaseError("config");
  });
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    bytes.fill(0);
    throw phaseError("config");
  }
  const value = createHash("sha256").update(bytes).digest("hex");
  bytes.fill(0);
  return { kind: "sha256", value };
}

function equalFingerprint(left, right) {
  return (
    left.kind === right.kind &&
    (left.kind === "absent" || (right.kind === "sha256" && left.value === right.value))
  );
}

function sameFileIdentity(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

async function resolveExecutable(name, environment) {
  const path = environment.PATH;
  if (typeof path !== "string" || path === "") throw phaseError("precondition");
  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return canonical;
    } catch {
      // Continue through the fixed PATH lookup.
    }
  }
  throw phaseError("precondition");
}

function providerStateDirectory(accountHome) {
  if (process.platform === "darwin") {
    return join(accountHome, "Library", "Application Support", "a2a-connectors", "codex");
  }
  return join(accountHome, ".local", "state", "a2a-connectors", "codex");
}

function providerEnvironment(inherited) {
  const names =
    process.platform === "darwin"
      ? [
          "HOME",
          "PATH",
          "LANG",
          "LC_ALL",
          "LC_CTYPE",
          "TERM",
          "TMPDIR",
          "TZ",
          "__CF_USER_TEXT_ENCODING",
        ]
      : ["HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"];
  const environment = {};
  for (const name of names) {
    const value = inherited[name];
    if (
      typeof value === "string" &&
      !name.startsWith("A2A_") &&
      !/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)/iu.test(name)
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

async function requireAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw phaseError("precondition");
  }
  throw phaseError("precondition");
}

async function validateInstalledPackage(installRoot) {
  const packageRoot = join(installRoot, "node_modules", "@a2adev", "codex-connector");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw phaseError("package");
  }
  if (
    !exactKeys(manifest, [
      "name",
      "version",
      "private",
      "license",
      "repository",
      "publishConfig",
      "type",
      "bin",
      "files",
      "engines",
      "dependencies",
    ]) ||
    manifest.name !== "@a2adev/codex-connector" ||
    manifest.version !== "0.0.0-private" ||
    manifest.private !== true ||
    Object.hasOwn(manifest, "scripts")
  ) {
    throw phaseError("package");
  }
  return packageRoot;
}

function validateEvidence(evidence) {
  const checkNames = [
    "packedInstall",
    "twoTurnResume",
    "readOnlySandbox",
    "workspaceWriteSandbox",
    "outOfRootDenied",
    "networkDenied",
    "cancellation",
    "hardCrashContainment",
    "exactRecovery",
    "configUnchanged",
    "artifactsClean",
  ];
  if (
    !exactKeys(evidence, [
      "platform",
      "nodeVersion",
      "codexVersion",
      "schemaSha256",
      "tarballSha256",
      "checks",
    ]) ||
    typeof evidence.platform !== "string" ||
    evidence.nodeVersion !== process.versions.node ||
    evidence.codexVersion !== "0.149.0" ||
    evidence.schemaSha256 !== CODEX_SCHEMA_SHA256 ||
    !/^[0-9a-f]{64}$/u.test(evidence.tarballSha256) ||
    !exactKeys(evidence.checks, checkNames) ||
    checkNames.some((name) => evidence.checks[name] !== true)
  ) {
    throw phaseError("behavior");
  }
}

function qualificationRecord(evidence) {
  return {
    qualification: "cx04",
    result: "passed",
    platform: evidence.platform,
    node_version: evidence.nodeVersion,
    codex_version: evidence.codexVersion,
    schema_sha256: evidence.schemaSha256,
    tarball_sha256: evidence.tarballSha256,
    packed_install: evidence.checks.packedInstall,
    two_turn_resume: evidence.checks.twoTurnResume,
    read_only_sandbox: evidence.checks.readOnlySandbox,
    workspace_write_sandbox: evidence.checks.workspaceWriteSandbox,
    out_of_root_denied: evidence.checks.outOfRootDenied,
    network_denied: evidence.checks.networkDenied,
    cancellation: evidence.checks.cancellation,
    hard_crash_containment: evidence.checks.hardCrashContainment,
    exact_recovery: evidence.checks.exactRecovery,
    config_unchanged: evidence.checks.configUnchanged,
    artifacts_clean: evidence.checks.artifactsClean,
    provider_history: "codex_owned_not_scanned_or_deleted",
    support_claim: "preview_candidate_only",
  };
}

export async function executeSystemQualification(options) {
  if (!["darwin", "linux"].includes(process.platform)) throw phaseError("precondition");
  if (!/^24\.(?:19|[2-9][0-9])\./u.test(process.versions.node)) {
    throw phaseError("precondition");
  }
  const accountHome = userInfo().homedir;
  const stateDirectory = providerStateDirectory(accountHome);
  await requireAbsent(stateDirectory);
  const codexEnvironment = providerEnvironment(options.environment);
  const codexExecutable = await resolveExecutable("codex", codexEnvironment);
  const temporaryRoot = await mkdtemp(join(options.temporaryParent, "a2a-cx04-codex-"));
  await chmod(temporaryRoot, 0o700);
  try {
    const installRoot = join(temporaryRoot, "install");
    await mkdir(installRoot, { mode: 0o700 });
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ name: "cx04-manual-install", private: true })}\n`,
      { mode: 0o600 },
    );
    const packed = await preparePackedConnector(
      {
        repositoryRoot: options.repositoryRoot,
        temporaryRoot,
        pnpmExecutable: options.pnpmExecutable,
        nodeExecutable: process.execPath,
        environment: options.environment,
      },
      runBoundedCommand,
    );
    const packageRoot = await validateInstalledPackage(packed.installRoot);
    const schemaA = join(temporaryRoot, "schema-a");
    const schemaB = join(temporaryRoot, "schema-b");
    await Promise.all([mkdir(schemaA, { mode: 0o700 }), mkdir(schemaB, { mode: 0o700 })]);
    const configPath = join(accountHome, ".codex", "config.toml");
    const initialConfig = await configFingerprint(configPath);
    const assertConfigUnchanged = async () => {
      if (!equalFingerprint(initialConfig, await configFingerprint(configPath))) {
        throw phaseError("config");
      }
    };
    const executableBefore = await stat(codexExecutable).catch(() => {
      throw phaseError("version");
    });
    const verified = await verifyCodexInstallation(
      {
        executable: codexExecutable,
        schemaDirectories: [schemaA, schemaB],
        expectedSchemaSha256: CODEX_SCHEMA_SHA256,
        environment: codexEnvironment,
      },
      { run: runBoundedCommand, readSchema: readFile },
    );
    const executableAfter = await stat(codexExecutable).catch(() => {
      throw phaseError("version");
    });
    if (!sameFileIdentity(executableBefore, executableAfter)) throw phaseError("version");
    await assertConfigUnchanged();
    const driver = await import("./cx04-real-codex-driver.mjs");
    const behavior = await driver.runRealCodexMatrix({
      repositoryRoot: options.repositoryRoot,
      temporaryRoot,
      connectorExecutable: packed.connectorExecutable,
      packageRoot,
      stateDirectory,
      environment: options.environment,
      assertConfigUnchanged,
      artifactRoots: [schemaA, schemaB],
    });
    await assertConfigUnchanged();
    const tarballHandle = await open(packed.tarball, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let tarballBytes;
    try {
      tarballBytes = await tarballHandle.readFile();
    } finally {
      await tarballHandle.close();
    }
    const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");
    tarballBytes.fill(0);
    return {
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.versions.node,
      codexVersion: "0.149.0",
      schemaSha256: verified.schemaSha256,
      tarballSha256,
      checks: {
        packedInstall: true,
        ...behavior,
        configUnchanged: true,
      },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {
      throw phaseError("cleanup");
    });
  }
}

export async function runCx04Qualification(arguments_, dependencies) {
  if (arguments_.length !== 1 || arguments_[0] !== `--confirm=${CX04_CONFIRMATION}`) {
    dependencies.writeStderr("cx04 qualification: explicit_confirmation_required\n");
    return 2;
  }
  try {
    const evidence = await dependencies.execute();
    validateEvidence(evidence);
    dependencies.writeStdout(`${JSON.stringify(qualificationRecord(evidence))}\n`);
    return 0;
  } catch (error) {
    const candidate =
      error !== null && typeof error === "object" && typeof error.phase === "string"
        ? error.phase
        : "internal";
    const phase = PHASES.has(candidate) ? candidate : "internal";
    dependencies.writeStderr(`cx04 qualification: ${phase}_failed\n`);
    return 1;
  }
}
