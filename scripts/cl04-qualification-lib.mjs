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
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const CLAUDE_CODE_VERSION_STDOUT = "2.1.251 (Claude Code)\n";
export const CL04_CONFIRMATION = "run-authenticated-claude-code-2.1.251-on-disposable-account";

const COMMAND_CAPTURE_BYTES = 1024 * 1024;
const PHASES = new Set([
  "precondition",
  "integration",
  "package",
  "version",
  "behavior",
  "artifact",
  "cleanup",
  "internal",
]);
const CHECK_NAMES = [
  "packedInstall",
  "exactVersion",
  "sessionBeforeInput",
  "structuredInput",
  "twoTurnResume",
  "safeRestrictedStartup",
  "inRootRead",
  "outOfRootReadDenied",
  "workspaceWritePolicy",
  "outOfRootWriteDenied",
  "networkDenied",
  "approvalDenied",
  "externalProcessTopology",
  "cancellation",
  "timeout",
  "normalExit",
  "heldGroupSealing",
  "connectorHardDeathStartup",
  "connectorHardDeathActive",
  "monitorHardDeathContainment",
  "noBlindReplay",
  "providerHistoryResume",
  "artifactsClean",
];

function phaseError(phase) {
  return Object.assign(new Error("CL04 qualification phase failed"), { phase });
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function qualificationEnvironment(inherited) {
  const names = [
    "COREPACK_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
  ];
  if (process.platform === "darwin") names.push("__CF_USER_TEXT_ENCODING");
  const environment = {};
  for (const name of names) {
    const value = inherited[name];
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}

function packageEnvironment(inherited) {
  return {
    ...qualificationEnvironment(inherited),
    CI: "true",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
  };
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

function commandGroupEmpty(groupId) {
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    return error && typeof error === "object" && error.code === "ESRCH";
  }
}

async function waitForCommandGroup(groupId, deadline) {
  while (!commandGroupEmpty(groupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function signalCommandGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
}

async function containCommandGroup(groupId) {
  const deadline = Date.now() + 3_000;
  signalCommandGroup(groupId, "SIGTERM");
  const termDeadline = Math.min(deadline, Date.now() + 100);
  if (!(await waitForCommandGroup(groupId, termDeadline))) {
    signalCommandGroup(groupId, "SIGKILL");
  }
  if (!(await waitForCommandGroup(groupId, deadline))) throw phaseError("cleanup");
}

export async function runBoundedCommand(request) {
  const child = spawn(request.executable, [...request.arguments], {
    cwd: request.cwd,
    env: { ...request.environment },
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ kind: "close", code, signal }));
  });
  const failed = new Promise((resolve) => {
    child.once("error", () => resolve({ kind: "error" }));
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    await Promise.race([failed, new Promise((resolve) => setTimeout(resolve, 100))]);
    throw phaseError(request.phase ?? "internal");
  }
  const groupId = child.pid;
  let overflowed = false;
  let releaseOverflow;
  const overflow = new Promise((resolve) => {
    releaseOverflow = resolve;
  });
  const stopForOverflow = () => {
    overflowed = true;
    releaseOverflow();
  };
  const stdout = boundedCapture(child.stdout, COMMAND_CAPTURE_BYTES, stopForOverflow);
  const stderr = boundedCapture(child.stderr, COMMAND_CAPTURE_BYTES, stopForOverflow);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), request.timeoutMs ?? 120_000);
    timer.unref();
  });
  const result = await Promise.race([
    closed,
    failed,
    timeout,
    overflow.then(() => ({ kind: "overflow" })),
  ]);
  clearTimeout(timer);
  if (result.kind !== "close" || overflowed) {
    await containCommandGroup(groupId);
    const reaped = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 3_000)),
    ]);
    if (reaped.kind !== "close") throw phaseError("cleanup");
    throw phaseError(request.phase ?? "internal");
  }
  if (!(await waitForCommandGroup(groupId, Date.now() + 100))) {
    await containCommandGroup(groupId);
    throw phaseError(request.phase ?? "internal");
  }
  return { code: result.code, signal: result.signal, stdout: stdout(), stderr: stderr() };
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

async function canonicalFile(path, executable = false) {
  if (!isAbsolute(path)) throw phaseError("precondition");
  try {
    const canonical = await realpath(path);
    const entry = await lstat(canonical);
    if (
      !isAbsolute(canonical) ||
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      (executable && (entry.mode & 0o111) === 0)
    ) {
      throw phaseError("precondition");
    }
    return canonical;
  } catch {
    throw phaseError("precondition");
  }
}

async function canonicalDirectory(path) {
  if (!isAbsolute(path)) throw phaseError("precondition");
  try {
    const canonical = await realpath(path);
    const entry = await lstat(canonical);
    if (!isAbsolute(canonical) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw phaseError("precondition");
    }
    return canonical;
  } catch {
    throw phaseError("precondition");
  }
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
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) {
        return { canonical, launchPath: candidate, metadata };
      }
    } catch {
      // Continue through the fixed PATH lookup.
    }
  }
  throw phaseError("precondition");
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

async function validatePnpmStore(path) {
  const canonical = await canonicalDirectory(path);
  try {
    const [index, shards] = await Promise.all([
      lstat(join(canonical, "index.db")),
      readdir(join(canonical, "files"), { withFileTypes: true }),
    ]);
    if (
      index.isSymbolicLink() ||
      !index.isFile() ||
      !shards.some((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    ) {
      throw phaseError("precondition");
    }
    return canonical;
  } catch {
    throw phaseError("precondition");
  }
}

async function validatePnpmCache(path) {
  const canonical = await canonicalDirectory(path);
  const metadata = join(canonical, "v11", "metadata", "registry.npmjs.org");
  const required = [
    join(metadata, "@modelcontextprotocol", "client.jsonl"),
    join(metadata, "better-sqlite3.jsonl"),
    join(metadata, "zod.jsonl"),
  ];
  try {
    const [metadataEntry, ...files] = await Promise.all([
      lstat(metadata),
      ...required.map(async (path) => await lstat(path)),
    ]);
    if (
      metadataEntry.isSymbolicLink() ||
      !metadataEntry.isDirectory() ||
      files.some((entry) => entry.isSymbolicLink() || !entry.isFile() || entry.size < 1)
    ) {
      throw phaseError("precondition");
    }
    return canonical;
  } catch {
    throw phaseError("precondition");
  }
}

async function qualifyPackagingInputs(options, run) {
  const [nodeExecutable, currentNode, pnpmCli, pnpmStore, pnpmCache] = await Promise.all([
    canonicalFile(options.nodeExecutable, true),
    canonicalFile(process.execPath, true),
    canonicalFile(options.pnpmCli),
    validatePnpmStore(options.pnpmStore),
    validatePnpmCache(options.pnpmCache),
  ]);
  if (nodeExecutable !== currentNode) throw phaseError("precondition");
  const version = await requiredCommand(
    run,
    {
      executable: nodeExecutable,
      arguments: [pnpmCli, "--version"],
      cwd: options.repositoryRoot,
      environment: packageEnvironment(options.environment),
      timeoutMs: 5_000,
    },
    "precondition",
  );
  if (version.stdout !== "11.22.0\n" || version.stderr !== "") {
    throw phaseError("precondition");
  }
  return { nodeExecutable, pnpmCli, pnpmStore, pnpmCache };
}

export async function preparePackedClaudeConnector(options, run) {
  const packaging = await qualifyPackagingInputs(options, run);
  const tarball = join(options.temporaryRoot, "claude-connector.tgz");
  const installRoot = join(options.temporaryRoot, "install");
  const environment = packageEnvironment(options.environment);
  await requiredCommand(
    run,
    {
      executable: packaging.nodeExecutable,
      arguments: [join(options.repositoryRoot, "scripts", "build-connector.mjs"), "claude"],
      cwd: options.repositoryRoot,
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: packaging.nodeExecutable,
      arguments: [join(options.repositoryRoot, "scripts", "stage-connector.mjs"), "claude"],
      cwd: options.repositoryRoot,
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: packaging.nodeExecutable,
      arguments: [
        join(options.repositoryRoot, "scripts", "check-packed-connector.mjs"),
        "claude",
        `--store-dir=${packaging.pnpmStore}`,
        `--pnpm-cli=${packaging.pnpmCli}`,
        `--cache-dir=${packaging.pnpmCache}`,
      ],
      cwd: options.repositoryRoot,
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: packaging.nodeExecutable,
      arguments: [
        packaging.pnpmCli,
        "pack",
        `--config.store-dir=${packaging.pnpmStore}`,
        `--config.cache-dir=${packaging.pnpmCache}`,
        "--ignore-scripts",
        "--out",
        tarball,
      ],
      cwd: join(options.repositoryRoot, ".stage", "connectors", "claude", "package"),
      environment,
    },
    "package",
  );
  await requiredCommand(
    run,
    {
      executable: packaging.nodeExecutable,
      arguments: [
        packaging.pnpmCli,
        "add",
        `--config.store-dir=${packaging.pnpmStore}`,
        `--config.cache-dir=${packaging.pnpmCache}`,
        "--offline",
        "--ignore-scripts",
        "--package-import-method=copy",
        tarball,
      ],
      cwd: installRoot,
      environment,
    },
    "package",
  );
  return {
    tarball,
    installRoot,
    connectorExecutable: join(installRoot, "node_modules", ".bin", "a2a-claude-connector"),
  };
}

async function discoverPackagingInputs(options, run) {
  const home = options.environment.HOME;
  if (typeof home !== "string" || !isAbsolute(home)) throw phaseError("precondition");
  const cliRoots = [
    options.environment.COREPACK_HOME,
    join(home, ".cache", "node", "corepack"),
    join(home, "Library", "Caches", "node", "corepack"),
  ].filter((candidate) => typeof candidate === "string" && isAbsolute(candidate));
  let pnpmCli;
  for (const root of cliRoots) {
    try {
      pnpmCli = await canonicalFile(join(root, "v1", "pnpm", "11.22.0", "bin", "pnpm.mjs"));
      break;
    } catch {
      // Continue through the fixed versioned Corepack-cache locations.
    }
  }
  if (pnpmCli === undefined) throw phaseError("precondition");
  const nodeExecutable = await canonicalFile(process.execPath, true);
  const environment = packageEnvironment(options.environment);
  const store = await requiredCommand(
    run,
    {
      executable: nodeExecutable,
      arguments: [pnpmCli, "store", "path"],
      cwd: options.repositoryRoot,
      environment,
      timeoutMs: 5_000,
    },
    "precondition",
  );
  const storeLines = store.stdout.trimEnd().split("\n");
  if (
    store.stderr !== "" ||
    storeLines.length !== 1 ||
    !isAbsolute(storeLines[0] ?? "") ||
    store.stdout !== `${storeLines[0]}\n`
  ) {
    throw phaseError("precondition");
  }
  const cacheCandidates = [
    typeof options.environment.XDG_CACHE_HOME === "string"
      ? join(options.environment.XDG_CACHE_HOME, "pnpm")
      : undefined,
    join(home, "Library", "Caches", "pnpm"),
    join(home, ".cache", "pnpm"),
  ].filter((candidate) => typeof candidate === "string" && isAbsolute(candidate));
  let pnpmCache;
  for (const candidate of cacheCandidates) {
    try {
      pnpmCache = await validatePnpmCache(candidate);
      break;
    } catch {
      // Continue through the fixed platform cache locations.
    }
  }
  if (pnpmCache === undefined) throw phaseError("precondition");
  return { nodeExecutable, pnpmCli, pnpmStore: storeLines[0], pnpmCache };
}

function providerStateDirectory(accountHome) {
  if (process.platform === "darwin") {
    return join(accountHome, "Library", "Application Support", "a2a-connectors", "claude");
  }
  return join(accountHome, ".local", "state", "a2a-connectors", "claude");
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
  const packageRoot = join(installRoot, "node_modules", "@a2adev", "claude-connector");
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
    manifest.name !== "@a2adev/claude-connector" ||
    manifest.version !== "0.0.0-private" ||
    manifest.private !== true ||
    Object.hasOwn(manifest, "scripts")
  ) {
    throw phaseError("package");
  }
  return packageRoot;
}

async function loadRealQualificationDriver() {
  try {
    const driver = await import("./cl04-real-claude-driver.mjs");
    if (typeof driver.runRealClaudeMatrix !== "function") throw phaseError("integration");
    return driver;
  } catch {
    throw phaseError("integration");
  }
}

function validateEvidence(evidence) {
  if (
    !exactKeys(evidence, [
      "platform",
      "nodeVersion",
      "claudeCodeVersion",
      "tarballSha256",
      "checks",
    ]) ||
    typeof evidence.platform !== "string" ||
    evidence.nodeVersion !== process.versions.node ||
    evidence.claudeCodeVersion !== "2.1.251" ||
    !/^[0-9a-f]{64}$/u.test(evidence.tarballSha256) ||
    !exactKeys(evidence.checks, CHECK_NAMES) ||
    CHECK_NAMES.some((name) => evidence.checks[name] !== true)
  ) {
    throw phaseError("behavior");
  }
}

function qualificationRecord(evidence) {
  return {
    qualification: "cl04",
    result: "passed",
    platform: evidence.platform,
    node_version: evidence.nodeVersion,
    claude_code_version: evidence.claudeCodeVersion,
    tarball_sha256: evidence.tarballSha256,
    packed_install: evidence.checks.packedInstall,
    exact_version: evidence.checks.exactVersion,
    session_before_input: evidence.checks.sessionBeforeInput,
    structured_input: evidence.checks.structuredInput,
    two_turn_resume: evidence.checks.twoTurnResume,
    safe_restricted_startup: evidence.checks.safeRestrictedStartup,
    in_root_read: evidence.checks.inRootRead,
    out_of_root_read_denied: evidence.checks.outOfRootReadDenied,
    workspace_write_policy: evidence.checks.workspaceWritePolicy,
    out_of_root_write_denied: evidence.checks.outOfRootWriteDenied,
    network_denied: evidence.checks.networkDenied,
    approval_denied: evidence.checks.approvalDenied,
    external_process_topology: evidence.checks.externalProcessTopology,
    cancellation: evidence.checks.cancellation,
    timeout: evidence.checks.timeout,
    normal_exit: evidence.checks.normalExit,
    held_group_sealing: evidence.checks.heldGroupSealing,
    connector_hard_death_startup: evidence.checks.connectorHardDeathStartup,
    connector_hard_death_active: evidence.checks.connectorHardDeathActive,
    monitor_hard_death_containment: evidence.checks.monitorHardDeathContainment,
    no_blind_replay: evidence.checks.noBlindReplay,
    provider_history_resume: evidence.checks.providerHistoryResume,
    artifacts_clean: evidence.checks.artifactsClean,
    provider_history: "claude_owned_not_scanned_or_deleted",
    support_claim: "none_pending_review",
  };
}

export async function executeSystemQualification(options) {
  if (!["darwin", "linux"].includes(process.platform)) throw phaseError("precondition");
  if (!/^24\.(?:19|[2-9][0-9])\./u.test(process.versions.node)) {
    throw phaseError("precondition");
  }

  const driver = await loadRealQualificationDriver();
  const accountHome = userInfo().homedir;
  const environment = qualificationEnvironment(options.environment);
  if (environment.HOME !== accountHome) throw phaseError("precondition");
  const stateDirectory = providerStateDirectory(accountHome);
  await requireAbsent(stateDirectory);
  const claude = await resolveExecutable("claude", environment);
  if (!/(?:^|\/)claude(?:-2\.1\.251)?$/u.test(claude.launchPath)) {
    throw phaseError("precondition");
  }
  const version = await requiredCommand(
    runBoundedCommand,
    {
      executable: claude.launchPath,
      arguments: ["--version"],
      cwd: options.repositoryRoot,
      environment,
      timeoutMs: 5_000,
    },
    "version",
  );
  if (version.stdout !== CLAUDE_CODE_VERSION_STDOUT || version.stderr !== "") {
    throw phaseError("version");
  }
  const versionedIdentity = await stat(claude.canonical).catch(() => {
    throw phaseError("version");
  });
  if (!sameFileIdentity(claude.metadata, versionedIdentity)) throw phaseError("version");
  const packaging = await discoverPackagingInputs(
    { repositoryRoot: options.repositoryRoot, environment },
    runBoundedCommand,
  );
  const temporaryRoot = await mkdtemp(join(options.temporaryParent, "a2a-cl04-claude-"));
  await chmod(temporaryRoot, 0o700);
  try {
    const installRoot = join(temporaryRoot, "install");
    const providerTemporaryRoot = join(temporaryRoot, "provider-tmp");
    await Promise.all([
      mkdir(installRoot, { mode: 0o700 }),
      mkdir(providerTemporaryRoot, { mode: 0o700 }),
    ]);
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ name: "cl04-manual-install", private: true })}\n`,
      { mode: 0o600 },
    );
    const packed = await preparePackedClaudeConnector(
      {
        repositoryRoot: options.repositoryRoot,
        temporaryRoot,
        ...packaging,
        environment,
      },
      runBoundedCommand,
    );
    const packageRoot = await validateInstalledPackage(packed.installRoot);
    const behavior = await driver.runRealClaudeMatrix({
      repositoryRoot: options.repositoryRoot,
      temporaryRoot,
      connectorExecutable: packed.connectorExecutable,
      packageRoot,
      stateDirectory,
      environment: { ...environment, TMPDIR: providerTemporaryRoot },
      providerTemporaryRoot,
      claudeExecutable: claude.canonical,
    });
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
      claudeCodeVersion: "2.1.251",
      tarballSha256,
      checks: { packedInstall: true, exactVersion: true, ...behavior },
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {
      throw phaseError("cleanup");
    });
  }
}

export async function runCl04Qualification(arguments_, dependencies) {
  if (arguments_.length !== 1 || arguments_[0] !== `--confirm=${CL04_CONFIRMATION}`) {
    dependencies.writeStderr("cl04 qualification: explicit_confirmation_required\n");
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
    dependencies.writeStderr(`cl04 qualification: ${phase}_failed\n`);
    return 1;
  }
}
