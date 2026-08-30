import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import Database from "better-sqlite3";
import { startFakeConnectorGateway } from "./support/connector/index.js";
import {
  K02_TOKEN,
  k02ApprovalControlArguments,
  k02Message,
  loadK02Production,
  seedK02ConversationCapacityForTest,
  startK02Scenario,
} from "./support/connector/k02-production.js";

const PROVIDERS = ["codex", "claude", "gemini"] as const;
const WORKING_DIRECTORY = resolve(".");

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

interface CapturedChild {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
}

function startCapturedChild(
  executable: string,
  arguments_: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): CapturedChild {
  const child = spawn(executable, arguments_, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-65_536);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

async function waitForCapturedExit(
  process: CapturedChild,
  description: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    process.exit,
    delay(5_000, undefined, { ref: false }).then(() => {
      if (process.child.exitCode === null && process.child.signalCode === null) {
        process.child.kill("SIGKILL");
      }
      throw new Error(`timed out waiting for ${description}`);
    }),
  ]);
}

async function waitForReadiness(process: CapturedChild, line: string): Promise<void> {
  await Promise.race([
    (async () => {
      while (!process.stdout().includes(line)) {
        if (process.child.exitCode !== null || process.child.signalCode !== null) {
          throw new Error(
            `connector exited before readiness: ${process.stdout()}${process.stderr()}`,
          );
        }
        await delay(10);
      }
    })(),
    delay(5_000, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for connector readiness");
    }),
  ]);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  assert.ok(port >= 1_024 && port <= 65_535 && port !== 8787);
  return port;
}

async function assertLoopbackPortReusable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function startGatewayConnectionGuard(t: TestContext): Promise<() => number> {
  let acceptedConnections = 0;
  const server = createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(8787, "127.0.0.1", () => resolveListen());
  });
  t.after(
    async () =>
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  );
  return () => acceptedConnections;
}

async function userInfoPreload(
  t: TestContext,
  accountHome: string,
  providerProcessMarker?: string,
  filesystem?: {
    behavior: "unproven" | "wrong_uid" | "observe_sync";
    marker: string;
  },
): Promise<string> {
  const preloadDirectory = await temporaryDirectory(t, "a2a-k02-user-info-");
  const preload = join(preloadDirectory, "user-info.mjs");
  const processGuard =
    providerProcessMarker === undefined
      ? []
      : [
          `const providerProcessMarker = ${JSON.stringify(providerProcessMarker)};`,
          "const rejectProviderProcess = () => {",
          '  fs.appendFileSync(providerProcessMarker, "provider process attempted\\n", { mode: 0o600 });',
          '  throw new Error("provider process attempted before CLI admission");',
          "};",
          'for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {',
          "  childProcess[name] = rejectProviderProcess;",
          "}",
        ];
  const filesystemGuard =
    filesystem === undefined
      ? []
      : filesystem.behavior === "unproven"
        ? [
            `const filesystemMarker = ${JSON.stringify(filesystem.marker)};`,
            "const filesystemFailure = () => {",
            '  fs.appendFileSync(filesystemMarker, "statfs\\n", { mode: 0o600 });',
            '  const error = new Error("filesystem residence unproven");',
            '  error.code = "ENOSYS";',
            "  return error;",
            "};",
            "fs.statfsSync = () => {",
            "  throw filesystemFailure();",
            "};",
            "fs.statfs = (_path, options, callback) => {",
            '  const done = typeof options === "function" ? options : callback;',
            "  queueMicrotask(() => done(filesystemFailure()));",
            "};",
            "fs.promises.statfs = async () => { throw filesystemFailure(); };",
          ]
        : filesystem.behavior === "wrong_uid"
          ? [
              `const filesystemMarker = ${JSON.stringify(filesystem.marker)};`,
              "const withWrongUid = (path, metadata) => {",
              `  if (String(path) === ${JSON.stringify(accountHome)}) {`,
              '    fs.appendFileSync(filesystemMarker, "wrong_uid\\n", { mode: 0o600 });',
              '    Object.defineProperty(metadata, "uid", { value: Number(metadata.uid) + 1 });',
              "  }",
              "  return metadata;",
              "};",
              "const realLstatSync = fs.lstatSync;",
              "fs.lstatSync = (path, options) => {",
              "  return withWrongUid(path, realLstatSync(path, options));",
              "};",
              "const realLstat = fs.lstat;",
              "fs.lstat = (path, options, callback) => {",
              '  const done = typeof options === "function" ? options : callback;',
              '  const selectedOptions = typeof options === "function" ? undefined : options;',
              "  realLstat(path, selectedOptions, (error, metadata) => {",
              "    done(error, error === null ? withWrongUid(path, metadata) : metadata);",
              "  });",
              "};",
              "const realPromiseLstat = fs.promises.lstat;",
              "fs.promises.lstat = async (path, options) => {",
              "  return withWrongUid(path, await realPromiseLstat(path, options));",
              "};",
            ]
          : [
              `const filesystemMarker = ${JSON.stringify(filesystem.marker)};`,
              "const recordSync = (metadata) => {",
              '  const kind = metadata.isDirectory() ? "directory" : "file";',
              '  fs.appendFileSync(filesystemMarker, kind + "\\n", { mode: 0o600 });',
              "};",
              "const realFsyncSync = fs.fsyncSync;",
              "fs.fsyncSync = (descriptor) => {",
              "  recordSync(fs.fstatSync(descriptor));",
              "  return realFsyncSync(descriptor);",
              "};",
              "const realFsync = fs.fsync;",
              "fs.fsync = (descriptor, callback) => {",
              "  recordSync(fs.fstatSync(descriptor));",
              "  return realFsync(descriptor, callback);",
              "};",
              'const probeHandle = await fs.promises.open(filesystemMarker, "a", 0o600);',
              "const fileHandlePrototype = Object.getPrototypeOf(probeHandle);",
              "await probeHandle.close();",
              "const realHandleSync = fileHandlePrototype.sync;",
              "fileHandlePrototype.sync = async function () {",
              "  recordSync(await this.stat());",
              "  return realHandleSync.call(this);",
              "};",
            ];
  await writeFile(
    preload,
    [
      'import os from "node:os";',
      ...(providerProcessMarker === undefined
        ? []
        : ['import childProcess from "node:child_process";']),
      ...(providerProcessMarker === undefined && filesystem === undefined
        ? []
        : ['import fs from "node:fs";']),
      'import { syncBuiltinESMExports } from "node:module";',
      ...processGuard,
      ...filesystemGuard,
      "const realUserInfo = os.userInfo;",
      `os.userInfo = () => ({ ...realUserInfo(), homedir: ${JSON.stringify(accountHome)} });`,
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return pathToFileURL(preload).href;
}

async function startupBarrierPreload(
  t: TestContext,
  accountHome: string,
  scriptLines: readonly string[],
): Promise<string> {
  const preloadDirectory = await temporaryDirectory(t, "a2a-k02-startup-barrier-");
  const preload = join(preloadDirectory, "startup-barrier.mjs");
  await writeFile(
    preload,
    [
      'import fs from "node:fs";',
      'import os from "node:os";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const realUserInfo = os.userInfo;",
      `os.userInfo = () => ({ ...realUserInfo(), homedir: ${JSON.stringify(accountHome)} });`,
      ...scriptLines,
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return pathToFileURL(preload).href;
}

async function waitForMarker(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const contents = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (contents.includes(expected)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${expected}`);
    await delay(10);
  }
}

async function capturedOutcome(
  process: CapturedChild,
  readiness: string,
): Promise<"exited" | "ready"> {
  const deadline = Date.now() + 5_000;
  while (true) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) return "exited";
    if (process.stdout().includes(readiness)) return "ready";
    if (Date.now() >= deadline) throw new Error("timed out waiting for connector outcome");
    await delay(10);
  }
}

function startArguments(port: number, workingDirectory: string): string[] {
  return [
    "start",
    `--webhook-port=${port}`,
    "--webhook-token-env=A2A_CONNECTOR_WEBHOOK_TOKEN",
    `--working-directory=${workingDirectory}`,
    "--policy=read-only",
  ];
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerStateDirectory(accountHome: string, provider: (typeof PROVIDERS)[number]): string {
  if (process.platform === "linux") {
    return join(accountHome, ".local", "state", "a2a-connectors", provider);
  }
  assert.equal(process.platform, "darwin", "K02 Windows connector support is deferred");
  return join(accountHome, "Library", "Application Support", "a2a-connectors", provider);
}

test("K02-D01 exposes only the exact public start and retire-state command grammar", async (t) => {
  const module = await loadK02Production("K02-K03:D01-cli");
  const directory = await temporaryDirectory(t, "a2a-k02-d01-");
  const accountHomeInput = join(directory, "account-home");
  const workspaceDirectory = join(directory, "workspace");
  const linkedDirectory = join(directory, "linked-workspace");
  const regularFile = join(directory, "regular-file");
  await mkdir(accountHomeInput, { mode: 0o700 });
  await mkdir(workspaceDirectory, { mode: 0o700 });
  const accountHome = await realpath(accountHomeInput);
  const canonicalDirectory = await realpath(workspaceDirectory);
  await symlink(canonicalDirectory, linkedDirectory, "dir");
  await writeFile(regularFile, "not a directory", { encoding: "utf8", mode: 0o600 });
  const gatewayConnections = await startGatewayConnectionGuard(t);

  for (const [port, policy] of [
    [1_024, "read-only"],
    [65_535, "workspace-write"],
  ] as const) {
    assert.deepEqual(
      module.parseConnectorArgumentsForTest([
        "start",
        `--policy=${policy}`,
        `--working-directory=${canonicalDirectory}`,
        "--webhook-token-env=_A2A0",
        `--webhook-port=${port}`,
      ]),
      {
        command: "start",
        webhookPort: port,
        webhookTokenEnvironmentName: "_A2A0",
        workingDirectory: canonicalDirectory,
        policy,
      },
    );
  }
  assert.deepEqual(
    module.parseConnectorArgumentsForTest(["retire-state", "--confirm=retire-all-correlation"]),
    { command: "retire-state" },
  );

  const valid = startArguments(44_123, canonicalDirectory);
  const optionNames = [
    "--webhook-port",
    "--webhook-token-env",
    "--working-directory",
    "--policy",
  ] as const;
  const invalidArguments: string[][] = [
    [],
    ["start"],
    ["unknown"],
    ["start", "positional", ...valid.slice(1)],
    ["start", "--webhook-port", "44123"],
    [...valid, "--unknown=value"],
    ["retire-state"],
    ["retire-state", "--confirm=yes"],
    ["retire-state", "--confirm=retire-all-correlation", "--force=true"],
    ["retire-state", "--confirm", "retire-all-correlation"],
  ];
  for (const optionName of optionNames) {
    invalidArguments.push(valid.filter((argument) => !argument.startsWith(`${optionName}=`)));
    const current = valid.find((argument) => argument.startsWith(`${optionName}=`));
    assert.ok(current !== undefined);
    invalidArguments.push([...valid, current]);
    invalidArguments.push(
      valid.map((argument) =>
        argument.startsWith(`${optionName}=`) ? `${optionName}=` : argument,
      ),
    );
  }
  for (const port of [
    "0",
    "1023",
    "8787",
    "65536",
    "+1024",
    "-1024",
    "01024",
    "1024.0",
    "1e3",
    " 1024",
    "1024 ",
    "١٠٢٤",
  ]) {
    invalidArguments.push(
      valid.map((argument) =>
        argument.startsWith("--webhook-port=") ? `--webhook-port=${port}` : argument,
      ),
    );
  }
  for (const name of ["0TOKEN", "A-B", "A=B", "A.B", "Å_TOKEN", "A TOKEN"]) {
    invalidArguments.push(
      valid.map((argument) =>
        argument.startsWith("--webhook-token-env=") ? `--webhook-token-env=${name}` : argument,
      ),
    );
  }
  for (const policy of ["Read-only", "read_only", "unrestricted", "workspace-write "]) {
    invalidArguments.push(
      valid.map((argument) => (argument.startsWith("--policy=") ? `--policy=${policy}` : argument)),
    );
  }
  for (const path of ["relative", join(directory, "missing"), regularFile, linkedDirectory]) {
    invalidArguments.push(
      valid.map((argument) =>
        argument.startsWith("--working-directory=") ? `--working-directory=${path}` : argument,
      ),
    );
  }
  invalidArguments.push(...k02ApprovalControlArguments(valid).map((arguments_) => [...arguments_]));

  for (const arguments_ of invalidArguments) {
    assert.throws(
      () => module.parseConnectorArgumentsForTest(arguments_),
      /invalid_connector_arguments/u,
    );
  }

  for (const provider of PROVIDERS) {
    const stateDirectory = providerStateDirectory(accountHome, provider);
    const providerProcessMarker = join(directory, `${provider}-provider-process-attempted`);
    const preload = await userInfoPreload(t, accountHome, providerProcessMarker);
    const cli = resolve(`.test-dist/packages/${provider}-connector/src/cli.js`);
    for (const [index, arguments_] of invalidArguments.entries()) {
      const captured = startCapturedChild(
        process.execPath,
        [`--import=${preload}`, cli, ...arguments_],
        {
          cwd: canonicalDirectory,
          env: {
            ...process.env,
            A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN,
          },
        },
      );
      assert.deepEqual(
        await waitForCapturedExit(captured, `${provider} invalid CLI vector ${index}`),
        { code: 2, signal: null },
      );
      assert.equal(captured.stdout(), "");
      assert.equal(captured.stderr(), "a2a connector: invalid_connector_arguments\n");
      await delay(0);
      await assert.rejects(readdir(stateDirectory), /ENOENT/u);
      assert.deepEqual(await readdir(accountHome), []);
      assert.deepEqual(await readdir(canonicalDirectory), []);
      await assert.rejects(readFile(providerProcessMarker), /ENOENT/u);
      assert.equal(gatewayConnections(), 0);
    }
  }
});

test("K02-D02 starts each exact foreground entrypoint with ordered fixed errors", async (t) => {
  await loadK02Production("K02-K03:D02-startup");
  const root = await temporaryDirectory(t, "a2a-k02-d02-");
  const accountHomeInput = join(root, "account-home");
  const workingDirectoryInput = join(root, "workspace");
  await mkdir(accountHomeInput, { mode: 0o700 });
  await mkdir(workingDirectoryInput, { mode: 0o700 });
  const accountHome = await realpath(accountHomeInput);
  const workingDirectory = await realpath(workingDirectoryInput);
  const preload = await userInfoPreload(t, accountHome);
  const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN, port: 8787 });
  const completedProviders: string[] = [];

  for (const provider of PROVIDERS) {
    const cli = resolve(`.test-dist/packages/${provider}-connector/src/cli.js`);
    const stateDirectory = providerStateDirectory(accountHome, provider);
    const nodeArguments = [`--import=${preload}`, cli];
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN,
    };
    const run = (arguments_: readonly string[], env = environment): CapturedChild =>
      startCapturedChild(process.execPath, [...nodeArguments, ...arguments_], {
        cwd: workingDirectory,
        env,
      });

    const invalid = run([]);
    assert.deepEqual(await waitForCapturedExit(invalid, `${provider} invalid arguments`), {
      code: 2,
      signal: null,
    });
    assert.equal(invalid.stdout(), "");
    assert.equal(invalid.stderr(), "a2a connector: invalid_connector_arguments\n");
    await assert.rejects(readdir(stateDirectory), /ENOENT/u);

    const invalidDirectory = run([
      "start",
      `--webhook-port=${await unusedPort()}`,
      "--webhook-token-env=A2A_CONNECTOR_WEBHOOK_TOKEN",
      `--working-directory=${join(root, "missing-workspace")}`,
      "--policy=read-only",
    ]);
    assert.deepEqual(await waitForCapturedExit(invalidDirectory, `${provider} invalid directory`), {
      code: 2,
      signal: null,
    });
    assert.equal(invalidDirectory.stdout(), "");
    assert.equal(invalidDirectory.stderr(), "a2a connector: invalid_connector_arguments\n");
    await assert.rejects(readdir(stateDirectory), /ENOENT/u);

    const webhookPort = await unusedPort();
    const arguments_ = startArguments(webhookPort, workingDirectory);
    const missingTokenEnvironment = { ...process.env };
    delete missingTokenEnvironment.A2A_CONNECTOR_WEBHOOK_TOKEN;
    const missingToken = run(arguments_, missingTokenEnvironment);
    assert.deepEqual(await waitForCapturedExit(missingToken, `${provider} missing token`), {
      code: 4,
      signal: null,
    });
    assert.equal(missingToken.stdout(), "");
    assert.equal(missingToken.stderr(), "a2a connector: webhook_token_unavailable\n");
    assert.ok((await readdir(stateDirectory)).includes("owner.sqlite3"));
    assert.equal((await readdir(stateDirectory)).includes("correlation.sqlite3"), false);

    const malformedToken = run(arguments_, {
      ...environment,
      A2A_CONNECTOR_WEBHOOK_TOKEN: `${K02_TOKEN}\n`,
    });
    assert.deepEqual(await waitForCapturedExit(malformedToken, `${provider} malformed token`), {
      code: 4,
      signal: null,
    });
    assert.equal(malformedToken.stdout(), "");
    assert.equal(malformedToken.stderr(), "a2a connector: webhook_token_unavailable\n");

    const foreground = run(arguments_);
    t.after(async () => {
      if (foreground.child.exitCode === null && foreground.child.signalCode === null) {
        foreground.child.kill("SIGKILL");
      }
      await foreground.exit;
    });
    const readiness = `Connector webhook: http://127.0.0.1:${webhookPort}/webhook\n`;
    await waitForReadiness(foreground, readiness);
    assert.equal(foreground.stdout(), readiness);
    assert.equal(foreground.stderr(), "");
    assert.equal(foreground.child.exitCode, null);
    const liveLeaves = await readdir(stateDirectory);
    assert.ok(liveLeaves.includes("correlation.sqlite3"));
    assert.ok(liveLeaves.includes("owner.sqlite3"));
    const allowedLiveLeaves = new Set([
      "owner.sqlite3",
      "owner.sqlite3-journal",
      "correlation.sqlite3",
      "correlation.sqlite3-wal",
      "correlation.sqlite3-shm",
      "correlation.sqlite3-journal",
    ]);
    assert.ok(liveLeaves.every((leaf) => allowedLiveLeaves.has(leaf)));

    const contender = run(startArguments(await unusedPort(), workingDirectory));
    assert.deepEqual(await waitForCapturedExit(contender, `${provider} singleton contender`), {
      code: 7,
      signal: null,
    });
    assert.equal(contender.stdout(), "");
    assert.equal(contender.stderr(), "a2a connector: connector_already_running\n");

    await delay(25);
    assert.equal(foreground.child.exitCode, null);
    assert.equal(foreground.child.kill("SIGTERM"), true);
    assert.deepEqual(await waitForCapturedExit(foreground, `${provider} foreground shutdown`), {
      code: 0,
      signal: null,
    });
    assert.equal(foreground.stdout(), readiness);
    assert.equal(foreground.stderr(), "");

    const fatalPort = await unusedPort();
    const fatalForeground = run(startArguments(fatalPort, workingDirectory));
    t.after(async () => {
      if (fatalForeground.child.exitCode === null && fatalForeground.child.signalCode === null) {
        fatalForeground.child.kill("SIGKILL");
      }
      await fatalForeground.exit;
    });
    const fatalReadiness = `Connector webhook: http://127.0.0.1:${fatalPort}/webhook\n`;
    await waitForReadiness(fatalForeground, fatalReadiness);
    const malformedIdWake = `runtime_fatal_${provider}`;
    gateway.setNextPollResultForTest({
      messages: [{ ...k02Message("ignored_string_id", "runtime_fatal_conversation"), id: 7 }],
    });
    assert.equal(
      (await gateway.sendWake(`http://127.0.0.1:${fatalPort}/webhook`, malformedIdWake)).status,
      202,
    );
    assert.deepEqual(await waitForCapturedExit(fatalForeground, `${provider} runtime fatal`), {
      code: 1,
      signal: null,
    });
    assert.equal(fatalForeground.stdout(), fatalReadiness);
    assert.equal(fatalForeground.stderr(), "a2a connector: connector_gateway_operation_failed\n");
    await assertLoopbackPortReusable(fatalPort);

    const occupied = createServer();
    await new Promise<void>((resolveListen, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => resolveListen());
    });
    const occupiedAddress = occupied.address();
    assert.ok(occupiedAddress !== null && typeof occupiedAddress === "object");
    const listenerFailure = run(startArguments(occupiedAddress.port, workingDirectory));
    assert.deepEqual(await waitForCapturedExit(listenerFailure, `${provider} listener conflict`), {
      code: 8,
      signal: null,
    });
    assert.equal(listenerFailure.stdout(), "");
    assert.equal(listenerFailure.stderr(), "a2a connector: connector_listener_unavailable\n");
    await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));

    const scopeMismatch = run(startArguments(await unusedPort(), workingDirectory), {
      ...environment,
      A2A_CONNECTOR_WEBHOOK_TOKEN: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
    });
    assert.deepEqual(await waitForCapturedExit(scopeMismatch, `${provider} scope mismatch`), {
      code: 7,
      signal: null,
    });
    assert.equal(scopeMismatch.stdout(), "");
    assert.equal(scopeMismatch.stderr(), "a2a connector: connector_scope_mismatch\n");

    const ownerDatabase = join(stateDirectory, "owner.sqlite3");
    await chmod(ownerDatabase, 0o644);
    const unavailableState = run(startArguments(await unusedPort(), workingDirectory));
    assert.deepEqual(await waitForCapturedExit(unavailableState, `${provider} unavailable state`), {
      code: 7,
      signal: null,
    });
    assert.equal(unavailableState.stdout(), "");
    assert.equal(unavailableState.stderr(), "a2a connector: connector_state_unavailable\n");
    await chmod(ownerDatabase, 0o600);

    const unexpectedLeaf = join(stateDirectory, "unexpected");
    await writeFile(unexpectedLeaf, "refuse", { encoding: "utf8", mode: 0o600 });
    const refusedRetirement = run(["retire-state", "--confirm=retire-all-correlation"]);
    assert.deepEqual(
      await waitForCapturedExit(refusedRetirement, `${provider} refused retirement`),
      { code: 7, signal: null },
    );
    assert.equal(refusedRetirement.stdout(), "");
    assert.equal(refusedRetirement.stderr(), "a2a connector: connector_state_retire_refused\n");
    await rm(unexpectedLeaf);

    const retired = run(["retire-state", "--confirm=retire-all-correlation"]);
    assert.deepEqual(await waitForCapturedExit(retired, `${provider} retirement`), {
      code: 0,
      signal: null,
    });
    assert.equal(retired.stdout(), "Connector correlation state retired.\n");
    assert.equal(retired.stderr(), "");
    const retiredStart = run(startArguments(await unusedPort(), workingDirectory));
    assert.deepEqual(await waitForCapturedExit(retiredStart, `${provider} retired start`), {
      code: 7,
      signal: null,
    });
    assert.equal(retiredStart.stdout(), "");
    assert.equal(retiredStart.stderr(), "a2a connector: connector_state_retired\n");
    for (const output of [
      invalid.stdout(),
      invalid.stderr(),
      invalidDirectory.stdout(),
      invalidDirectory.stderr(),
      missingToken.stdout(),
      missingToken.stderr(),
      malformedToken.stdout(),
      malformedToken.stderr(),
      foreground.stdout(),
      foreground.stderr(),
      contender.stdout(),
      contender.stderr(),
      listenerFailure.stdout(),
      listenerFailure.stderr(),
      scopeMismatch.stdout(),
      scopeMismatch.stderr(),
      unavailableState.stdout(),
      unavailableState.stderr(),
      refusedRetirement.stdout(),
      refusedRetirement.stderr(),
      retired.stdout(),
      retired.stderr(),
      retiredStart.stdout(),
      retiredStart.stderr(),
    ]) {
      assert.equal(output.includes(K02_TOKEN), false);
      assert.equal(output.includes("A2A_CONNECTOR_WEBHOOK_TOKEN"), false);
      assert.equal(output.includes(workingDirectory), false);
      assert.equal(output.includes(stateDirectory), false);
    }
    completedProviders.push(provider);
    const providersRoot = dirname(stateDirectory);
    assert.deepEqual((await readdir(providersRoot)).sort(), [...completedProviders].sort());
  }
});

test("K02-S09 initializes once and fails closed at every owner/correlation crash boundary", async (t) => {
  const module = await loadK02Production("K02-K03:S09");
  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };

  await check("singleton remains held through token resolution", async () => {
    const root = await temporaryDirectory(t, "a2a-k02-s09-token-lock-");
    const accountHomeInput = join(root, "account-home");
    const workspaceInput = join(root, "workspace");
    const tokenEntered = join(root, "token-entered");
    const tokenRelease = join(root, "token-release");
    await mkdir(accountHomeInput, { mode: 0o700 });
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const gatedPreload = await startupBarrierPreload(t, accountHome, [
      `const tokenEntered = ${JSON.stringify(tokenEntered)};`,
      `const tokenRelease = ${JSON.stringify(tokenRelease)};`,
      "const originalEnvironment = process.env;",
      "let tokenPaused = false;",
      "process.env = new Proxy(originalEnvironment, {",
      "  get(target, property, receiver) {",
      '    if (property === "A2A_CONNECTOR_WEBHOOK_TOKEN" && !tokenPaused) {',
      "      tokenPaused = true;",
      '      fs.appendFileSync(tokenEntered, "resolving\\n", { mode: 0o600 });',
      "      const wait = new Int32Array(new SharedArrayBuffer(4));",
      "      while (!fs.existsSync(tokenRelease)) Atomics.wait(wait, 0, 0, 10);",
      "    }",
      "    return Reflect.get(target, property, receiver);",
      "  },",
      "});",
    ]);
    const plainPreload = await userInfoPreload(t, accountHome);
    const cli = resolve(".test-dist/packages/codex-connector/src/cli.js");
    const port = await unusedPort();
    const owner = startCapturedChild(
      process.execPath,
      [`--import=${gatedPreload}`, cli, ...startArguments(port, workspace)],
      {
        cwd: workspace,
        env: { ...process.env, A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN },
      },
    );
    t.after(async () => {
      await writeFile(tokenRelease, "release\n", { encoding: "utf8", mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      if (owner.child.exitCode === null && owner.child.signalCode === null)
        owner.child.kill("SIGKILL");
      await owner.exit;
    });
    await waitForMarker(tokenEntered, "resolving");

    const contenderPort = await unusedPort();
    const contenderReadiness = `Connector webhook: http://127.0.0.1:${contenderPort}/webhook\n`;
    const contender = startCapturedChild(
      process.execPath,
      [`--import=${plainPreload}`, cli, ...startArguments(contenderPort, workspace)],
      {
        cwd: workspace,
        env: { ...process.env, A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN },
      },
    );
    const outcome = await capturedOutcome(contender, contenderReadiness);
    if (outcome === "ready") contender.child.kill("SIGTERM");
    const contenderExit = await contender.exit;
    await writeFile(tokenRelease, "release\n", { encoding: "utf8", mode: 0o600 });
    const readiness = `Connector webhook: http://127.0.0.1:${port}/webhook\n`;
    await waitForReadiness(owner, readiness);
    owner.child.kill("SIGTERM");
    assert.deepEqual(await owner.exit, { code: 0, signal: null });
    assert.equal(outcome, "exited", "a contender bound while the owner was resolving its token");
    assert.deepEqual(contenderExit, { code: 7, signal: null });
    assert.equal(contender.stdout(), "");
    assert.equal(contender.stderr(), "a2a connector: connector_already_running\n");
  });

  await check("fresh start excludes retirement across marker publication", async () => {
    const root = await temporaryDirectory(t, "a2a-k02-s09-retire-race-");
    const accountHomeInput = join(root, "account-home");
    const workspaceInput = join(root, "workspace");
    const markerChecked = join(root, "marker-checked");
    const markerRelease = join(root, "marker-release");
    await mkdir(accountHomeInput, { mode: 0o700 });
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const retiredPath = join(providerStateDirectory(accountHome, "codex"), "retired.v1");
    const racePreload = await startupBarrierPreload(t, accountHome, [
      `const retiredPath = ${JSON.stringify(retiredPath)};`,
      `const markerChecked = ${JSON.stringify(markerChecked)};`,
      `const markerRelease = ${JSON.stringify(markerRelease)};`,
      "const realExistsSync = fs.existsSync;",
      "let markerPaused = false;",
      "fs.existsSync = (path) => {",
      "  if (!markerPaused && String(path) === retiredPath) {",
      "    markerPaused = true;",
      "    const existed = realExistsSync(path);",
      '    fs.appendFileSync(markerChecked, "checked\\n", { mode: 0o600 });',
      "    const wait = new Int32Array(new SharedArrayBuffer(4));",
      "    while (!realExistsSync(markerRelease)) Atomics.wait(wait, 0, 0, 10);",
      "    return existed;",
      "  }",
      "  return realExistsSync(path);",
      "};",
    ]);
    const plainPreload = await userInfoPreload(t, accountHome);
    const cli = resolve(".test-dist/packages/codex-connector/src/cli.js");
    const port = await unusedPort();
    const starting = startCapturedChild(
      process.execPath,
      [`--import=${racePreload}`, cli, ...startArguments(port, workspace)],
      {
        cwd: workspace,
        env: { ...process.env, A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN },
      },
    );
    t.after(async () => {
      await writeFile(markerRelease, "release\n", { encoding: "utf8", mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      if (starting.child.exitCode === null && starting.child.signalCode === null) {
        starting.child.kill("SIGKILL");
      }
      await starting.exit;
    });
    await waitForMarker(markerChecked, "checked");
    const retiring = startCapturedChild(
      process.execPath,
      [`--import=${plainPreload}`, cli, "retire-state", "--confirm=retire-all-correlation"],
      { cwd: workspace, env: process.env },
    );
    const retirementExit = await waitForCapturedExit(retiring, "concurrent retirement");
    await writeFile(markerRelease, "release\n", { encoding: "utf8", mode: 0o600 });
    const readiness = `Connector webhook: http://127.0.0.1:${port}/webhook\n`;
    await waitForReadiness(starting, readiness);
    starting.child.kill("SIGTERM");
    assert.deepEqual(await starting.exit, { code: 0, signal: null });
    assert.deepEqual(
      { exit: retirementExit, stdout: retiring.stdout(), stderr: retiring.stderr() },
      {
        exit: { code: 7, signal: null },
        stdout: "",
        stderr: "a2a connector: connector_state_retire_refused\n",
      },
      "retirement published a tombstone while a fresh start was already in progress",
    );
    await assert.rejects(readFile(retiredPath), /ENOENT/u);
  });

  await check("committed owner guard is durable before correlation creation", async () => {
    const root = await temporaryDirectory(t, "a2a-k02-s09-owner-sync-");
    const accountHomeInput = join(root, "account-home");
    const workspaceInput = join(root, "workspace");
    const syncMarker = join(root, "sync-order");
    await mkdir(accountHomeInput, { mode: 0o700 });
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const preload = await startupBarrierPreload(t, accountHome, [
      `const syncMarker = ${JSON.stringify(syncMarker)};`,
      "const descriptorPaths = new Map();",
      "const realOpenSync = fs.openSync;",
      "const realCloseSync = fs.closeSync;",
      "const realFsyncSync = fs.fsyncSync;",
      "fs.openSync = (path, ...arguments_) => {",
      "  const descriptor = realOpenSync(path, ...arguments_);",
      "  descriptorPaths.set(descriptor, String(path));",
      "  return descriptor;",
      "};",
      "fs.closeSync = (descriptor) => {",
      "  descriptorPaths.delete(descriptor);",
      "  return realCloseSync(descriptor);",
      "};",
      "fs.fsyncSync = (descriptor) => {",
      '  fs.appendFileSync(syncMarker, "sync:" + (descriptorPaths.get(descriptor) ?? "unknown") + "\\n", { mode: 0o600 });',
      "  return realFsyncSync(descriptor);",
      "};",
    ]);
    const cli = resolve(".test-dist/packages/codex-connector/src/cli.js");
    const port = await unusedPort();
    const captured = startCapturedChild(
      process.execPath,
      [`--import=${preload}`, cli, ...startArguments(port, workspace)],
      {
        cwd: workspace,
        env: { ...globalThis.process.env, A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN },
      },
    );
    t.after(async () => {
      if (captured.child.exitCode === null && captured.child.signalCode === null) {
        captured.child.kill("SIGKILL");
      }
      await captured.exit;
    });
    await waitForReadiness(captured, `Connector webhook: http://127.0.0.1:${port}/webhook\n`);
    captured.child.kill("SIGTERM");
    assert.deepEqual(await captured.exit, { code: 0, signal: null });
    const events = (await readFile(syncMarker, "utf8")).trim().split("\n");
    const ownerSyncs = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.endsWith("/owner.sqlite3"));
    const firstCorrelationSync = events.findIndex((event) =>
      event.endsWith("/correlation.sqlite3"),
    );
    assert.ok(firstCorrelationSync >= 0, "correlation database was never synced");
    assert.ok(
      ownerSyncs.length >= 2 &&
        (ownerSyncs[1]?.index ?? Number.POSITIVE_INFINITY) < firstCorrelationSync,
      `owner guard sync order was ${events.join(", ")}`,
    );
  });

  for (const barrier of [
    "before_owner_flag",
    "after_owner_flag",
    "before_correlation_create",
    "after_correlation_create",
  ] as const) {
    const stateDirectory = await temporaryDirectory(t, `a2a-k02-s09-${barrier}-`);
    const options = {
      stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex" as const,
      workingDirectory: WORKING_DIRECTORY,
    };
    await assert.rejects(
      module.initializeConnectorStateForTest({ ...options, crashAfter: barrier }),
      /connector_test_crash/u,
    );
    if (barrier === "before_owner_flag") {
      await module.initializeConnectorStateForTest(options);
      assert.deepEqual((await readdir(stateDirectory)).sort(), [
        "correlation.sqlite3",
        "owner.sqlite3",
      ]);
    } else {
      await assert.rejects(
        module.initializeConnectorStateForTest(options),
        /connector_state_unavailable/u,
      );
    }
  }
  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
});

test("K02-S10 rejects correlation-only rollback and documents mutually valid rollback residual risk", async (t) => {
  const module = await loadK02Production("K02-K03:S10");
  const stateDirectory = await temporaryDirectory(t, "a2a-k02-s10-");
  const oldSnapshot = await temporaryDirectory(t, "a2a-k02-s10-old-");
  const currentSnapshot = await temporaryDirectory(t, "a2a-k02-s10-current-");
  const options = {
    stateDirectory,
    webhookToken: K02_TOKEN,
    providerKind: "codex" as const,
    workingDirectory: WORKING_DIRECTORY,
  };
  const correlationLeaves = [
    "correlation.sqlite3",
    "correlation.sqlite3-wal",
    "correlation.sqlite3-shm",
    "correlation.sqlite3-journal",
  ] as const;
  const checkpointedConversationCount = (): number | undefined => {
    const database = new Database(join(stateDirectory, "correlation.sqlite3"));
    try {
      database.pragma("wal_checkpoint(TRUNCATE)");
      return database
        .prepare<[], { count: number }>("SELECT count(*) AS count FROM conversations")
        .get()?.count;
    } finally {
      database.close();
    }
  };
  await module.initializeConnectorStateForTest(options);
  assert.equal(checkpointedConversationCount(), 0);
  await copyFile(join(stateDirectory, "owner.sqlite3"), join(oldSnapshot, "owner.sqlite3"));
  await copyFile(
    join(stateDirectory, "correlation.sqlite3"),
    join(oldSnapshot, "correlation.sqlite3"),
  );
  await module.seedConnectorConversationsForTest({
    ...options,
    count: 1,
    activeConversationId: "s10_later_conversation",
    activeProviderSessionId: "s10_later_session",
  });
  assert.equal(checkpointedConversationCount(), 1);
  await copyFile(
    join(stateDirectory, "correlation.sqlite3"),
    join(currentSnapshot, "correlation.sqlite3"),
  );
  for (const leaf of correlationLeaves) await rm(join(stateDirectory, leaf), { force: true });
  assert.ok((await readdir(stateDirectory)).includes("owner.sqlite3"));
  await assert.rejects(
    module.initializeConnectorStateForTest(options),
    /connector_state_unavailable/u,
  );
  await copyFile(
    join(currentSnapshot, "correlation.sqlite3"),
    join(stateDirectory, "correlation.sqlite3"),
  );
  await module.initializeConnectorStateForTest(options);

  for (const leaf of [
    "owner.sqlite3",
    "owner.sqlite3-wal",
    "owner.sqlite3-shm",
    "owner.sqlite3-journal",
    ...correlationLeaves,
  ]) {
    await rm(join(stateDirectory, leaf), { force: true });
  }
  await copyFile(join(oldSnapshot, "owner.sqlite3"), join(stateDirectory, "owner.sqlite3"));
  await copyFile(
    join(oldSnapshot, "correlation.sqlite3"),
    join(stateDirectory, "correlation.sqlite3"),
  );
  await module.initializeConnectorStateForTest(options);
  const restored = new Database(join(stateDirectory, "correlation.sqlite3"), { readonly: true });
  try {
    assert.equal(
      restored.prepare<[], { count: number }>("SELECT count(*) AS count FROM conversations").get()
        ?.count,
      0,
    );
  } finally {
    restored.close();
  }
});

test("K02-S11 refuses only conversation 100001 and admits a mapped continuation", async (t) => {
  const module = await loadK02Production("K02-K03:S11");
  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };

  await check("conversation capacity warns and preserves mapped work", async () => {
    const stateDirectory = await temporaryDirectory(t, "a2a-k02-s11-");
    const activeConversationId = "s11_existing_conversation";
    const activeProviderSessionId = "s11_existing_session";
    await module.initializeConnectorStateForTest({
      stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: WORKING_DIRECTORY,
    });
    seedK02ConversationCapacityForTest({
      stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: WORKING_DIRECTORY,
      count: 100_000,
      activeConversationId,
      activeProviderSessionId,
    });
    const scenario = await startK02Scenario(t, "K02-K03:S11", {
      stateDirectory,
      workingDirectory: WORKING_DIRECTORY,
      scripts: [
        [
          { kind: "turn", provider_turn_id: "s11_continuation_turn" },
          { kind: "reply", text: "mapped continuation" },
        ],
      ],
    });
    let warnings = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      const newMessage = k02Message("s11_new_message", "s11_new_conversation");
      scenario.enqueue(newMessage);
      assert.equal((await scenario.wake(newMessage.id)).status, 202);
      await assert.doesNotReject(scenario.connector.waitForIdle());
      assert.deepEqual(scenario.connector.inspectAdmissionStateForTest(), {
        queuedIds: [],
        activeIds: [],
        replayEntries: 1,
      });
      assert.equal(scenario.provider.requests.length, 0);

      const continuationMessage = k02Message(
        "s11_continuation",
        activeConversationId,
        "mapped continuation",
        "s11_prior_message",
      );
      scenario.enqueue(continuationMessage);
      assert.equal((await scenario.wake(continuationMessage.id)).status, 202);
      await scenario.connector.waitForIdle();
      const resume = scenario.provider.requests[0];
      assert.equal(resume?.kind, "resume");
      if (resume?.kind === "resume") {
        assert.equal(resume.provider_session_id, activeProviderSessionId);
      }
      assert.equal(warnings, "a2a connector: connector_state_capacity\n");
    } finally {
      process.stderr.write = originalWrite;
    }

    const invalidContinuationMessage = k02Message("s11_null_predecessor", activeConversationId);
    scenario.enqueue(invalidContinuationMessage);
    assert.equal((await scenario.wake(invalidContinuationMessage.id)).status, 202);
    await assert.rejects(scenario.connector.waitForIdle(), /connector_conversation_unavailable/u);
    assert.equal(scenario.provider.requests.length, 1);
  });

  await check("received rows wait for their authenticated wake at message capacity", async () => {
    const stateDirectory = await temporaryDirectory(t, "a2a-k02-s11-message-quota-");
    const activeConversationId = "s11_message_quota_existing";
    const activeProviderSessionId = "s11_message_quota_session";
    await module.initializeConnectorStateForTest({
      stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: WORKING_DIRECTORY,
    });
    await module.seedConnectorConversationsForTest({
      stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: WORKING_DIRECTORY,
      count: 2,
      activeConversationId,
      activeProviderSessionId,
      openMessageCount: 2,
    });
    const messageQuota = await startK02Scenario(t, "K02-K03:S11", {
      stateDirectory,
      workingDirectory: WORKING_DIRECTORY,
      scripts: [
        [
          { kind: "turn", provider_turn_id: "s11_received_turn" },
          { kind: "reply", text: "matched durable received row" },
        ],
      ],
    });
    assert.deepEqual(
      messageQuota.connector.inspectAdmissionStateForTest(),
      { queuedIds: [], activeIds: [], replayEntries: 0 },
      "startup scheduled a durable received row without an authenticated wake",
    );
    for (let turn = 0; turn < 4; turn += 1) {
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    assert.equal(messageQuota.gateway.calls.length, 0, "startup polled for a durable received row");
    assert.equal(messageQuota.provider.requests.length, 0);

    let warnings = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      const excessMessage = k02Message("s11_message_quota_excess", "s11_message_quota_new");
      messageQuota.enqueue(excessMessage);
      assert.equal((await messageQuota.wake(excessMessage.id)).status, 202);
      await assert.doesNotReject(messageQuota.connector.waitForIdle());
      assert.deepEqual(messageQuota.connector.inspectAdmissionStateForTest(), {
        queuedIds: [],
        activeIds: [],
        replayEntries: 1,
      });
      assert.equal(warnings, "a2a connector: connector_state_capacity\n");
    } finally {
      process.stderr.write = originalWrite;
    }

    const received = k02Message(
      "seed_message_0",
      activeConversationId,
      "matched durable received row",
      "s11_prior_message",
    );
    messageQuota.enqueue(received);
    assert.equal((await messageQuota.wake(received.id)).status, 202);
    await messageQuota.connector.waitForIdle();
    assert.equal(messageQuota.provider.requests[0]?.kind, "resume");
    assert.deepEqual(
      messageQuota.gateway.calls.map((call) => call.name),
      ["poll_messages", "poll_messages", "reply_message", "ack_message"],
    );
    const quotaDatabase = new Database(join(stateDirectory, "correlation.sqlite3"), {
      readonly: true,
    });
    try {
      assert.deepEqual(
        quotaDatabase
          .prepare<[], { lifecycle: string }>("SELECT lifecycle FROM messages ORDER BY rowid")
          .all(),
        [{ lifecycle: "received" }],
        "the unmatched durable received row did not remain dormant",
      );
    } finally {
      quotaDatabase.close();
    }
  });

  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
});

test("K02-S12 opens no state until the injected filesystem qualification proves local", async (t) => {
  const module = await loadK02Production("K02-K03:S12");
  for (const filesystemQualification of ["network", "unproven"] as const) {
    const stateDirectory = await temporaryDirectory(t, `a2a-k02-s12-${filesystemQualification}-`);
    await assert.rejects(
      module.initializeConnectorStateForTest({
        stateDirectory,
        webhookToken: K02_TOKEN,
        providerKind: "codex",
        workingDirectory: WORKING_DIRECTORY,
        filesystemQualification,
      }),
      /connector_state_filesystem_unqualified/u,
    );
    assert.deepEqual(await readdir(stateDirectory), []);
  }
  const localDirectory = await temporaryDirectory(t, "a2a-k02-s12-local-");
  await module.initializeConnectorStateForTest({
    stateDirectory: localDirectory,
    webhookToken: K02_TOKEN,
    providerKind: "codex",
    workingDirectory: WORKING_DIRECTORY,
    filesystemQualification: "proven_local",
  });
  assert.deepEqual((await readdir(localDirectory)).sort(), [
    "correlation.sqlite3",
    "owner.sqlite3",
  ]);

  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };
  const cli = resolve(".test-dist/packages/codex-connector/src/cli.js");
  const runPublic = (
    preload: string,
    arguments_: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) =>
    startCapturedChild(process.execPath, [`--import=${preload}`, cli, ...arguments_], {
      cwd,
      env,
    });

  await check("0750 account home with private connector directories", async () => {
    const root = await temporaryDirectory(t, "a2a-k02-s12-home-mode-");
    const accountHomeInput = join(root, "account-home");
    const workspaceInput = join(root, "workspace");
    await mkdir(accountHomeInput, { mode: 0o750 });
    await chmod(accountHomeInput, 0o750);
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const preload = await userInfoPreload(t, accountHome);
    const port = await unusedPort();
    const captured = runPublic(preload, startArguments(port, workspace), workspace, {
      ...process.env,
      A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN,
    });
    t.after(async () => {
      if (captured.child.exitCode === null && captured.child.signalCode === null) {
        captured.child.kill("SIGKILL");
      }
      await captured.exit;
    });
    await waitForReadiness(captured, `Connector webhook: http://127.0.0.1:${port}/webhook\n`);
    const providerDirectory = providerStateDirectory(accountHome, "codex");
    let current = providerDirectory;
    while (current !== accountHome) {
      assert.equal((await stat(current)).mode & 0o777, 0o700, `${current} is not private`);
      current = dirname(current);
    }
    assert.equal((await stat(accountHome)).mode & 0o777, 0o750);
    captured.child.kill("SIGTERM");
    assert.deepEqual(await captured.exit, { code: 0, signal: null });
  });

  await check(
    "production filesystem qualification targets the final provider location",
    async () => {
      const root = await temporaryDirectory(t, "a2a-k02-s12-final-location-");
      const accountHomeInput = join(root, "account-home");
      const workspaceInput = join(root, "workspace");
      const marker = join(root, "statfs-target");
      await mkdir(accountHomeInput, { mode: 0o700 });
      await mkdir(workspaceInput, { mode: 0o700 });
      const accountHome = await realpath(accountHomeInput);
      const workspace = await realpath(workspaceInput);
      const expectedStateLocation = providerStateDirectory(accountHome, "codex");
      const preload = await startupBarrierPreload(t, accountHome, [
        `const expectedStateLocation = ${JSON.stringify(expectedStateLocation)};`,
        `const statfsMarker = ${JSON.stringify(marker)};`,
        "const realStatfsSync = fs.statfsSync;",
        "const realStatfs = fs.statfs;",
        "const realPromiseStatfs = fs.promises.statfs;",
        "const checkStatfsPath = (path) => {",
        '  fs.appendFileSync(statfsMarker, String(path) + "\\n", { mode: 0o600 });',
        "  if (String(path) !== expectedStateLocation) {",
        '    const error = new Error("filesystem qualification used the wrong target");',
        '    error.code = "ENOSYS";',
        "    throw error;",
        "  }",
        "};",
        "fs.statfsSync = (path, options) => {",
        "  checkStatfsPath(path);",
        "  return realStatfsSync(path, options);",
        "};",
        "fs.statfs = (path, options, callback) => {",
        "  const done = typeof options === 'function' ? options : callback;",
        "  const selectedOptions = typeof options === 'function' ? undefined : options;",
        "  try { checkStatfsPath(path); } catch (error) { queueMicrotask(() => done(error)); return; }",
        "  return realStatfs(path, selectedOptions, done);",
        "};",
        "fs.promises.statfs = async (path, options) => {",
        "  checkStatfsPath(path);",
        "  return await realPromiseStatfs(path, options);",
        "};",
      ]);
      const port = await unusedPort();
      const captured = runPublic(preload, startArguments(port, workspace), workspace, {
        ...process.env,
        A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN,
      });
      t.after(async () => {
        if (captured.child.exitCode === null && captured.child.signalCode === null) {
          captured.child.kill("SIGKILL");
        }
        await captured.exit;
      });
      await waitForReadiness(captured, `Connector webhook: http://127.0.0.1:${port}/webhook\n`);
      assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n"), [
        expectedStateLocation,
      ]);
      captured.child.kill("SIGTERM");
      assert.deepEqual(await captured.exit, { code: 0, signal: null });
    },
  );

  await check("unproven production filesystem", async () => {
    const root = await temporaryDirectory(t, "a2a-k02-s12-public-unproven-");
    const accountHomeInput = join(root, "account-home");
    const workspaceInput = join(root, "workspace");
    const marker = join(root, "filesystem-probe");
    await mkdir(accountHomeInput, { mode: 0o700 });
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const preload = await userInfoPreload(t, accountHome, undefined, {
      behavior: "unproven",
      marker,
    });
    const environment = { ...process.env };
    delete environment.A2A_CONNECTOR_WEBHOOK_TOKEN;
    const captured = runPublic(
      preload,
      startArguments(await unusedPort(), workspace),
      workspace,
      environment,
    );
    assert.deepEqual(await waitForCapturedExit(captured, "unproven production filesystem"), {
      code: 7,
      signal: null,
    });
    assert.equal(captured.stdout(), "");
    assert.equal(captured.stderr(), "a2a connector: connector_state_unavailable\n");
    assert.match(await readFile(marker, "utf8"), /statfs\n/u);
    await assert.rejects(readdir(providerStateDirectory(accountHome, "codex")), /ENOENT/u);
  });

  await check("effective UID rejection", async () => {
    const root = await temporaryDirectory(t, "a2a-k02-s12-public-uid-");
    const accountHomeInput = join(root, "account-home");
    const workspaceInput = join(root, "workspace");
    const marker = join(root, "uid-probe");
    await mkdir(accountHomeInput, { mode: 0o700 });
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const preload = await userInfoPreload(t, accountHome, undefined, {
      behavior: "wrong_uid",
      marker,
    });
    const environment = { ...process.env };
    delete environment.A2A_CONNECTOR_WEBHOOK_TOKEN;
    const captured = runPublic(
      preload,
      startArguments(await unusedPort(), workspace),
      workspace,
      environment,
    );
    assert.deepEqual(await waitForCapturedExit(captured, "wrong effective UID"), {
      code: 7,
      signal: null,
    });
    assert.equal(captured.stdout(), "");
    assert.equal(captured.stderr(), "a2a connector: connector_state_unavailable\n");
    assert.match(await readFile(marker, "utf8"), /wrong_uid\n/u);
    await assert.rejects(readdir(providerStateDirectory(accountHome, "codex")), /ENOENT/u);
  });

  const durableRoot = await temporaryDirectory(t, "a2a-k02-s12-public-durable-");
  const durableHomeInput = join(durableRoot, "account-home");
  const durableWorkspaceInput = join(durableRoot, "workspace");
  const durabilityMarker = join(durableRoot, "durability-probe");
  await mkdir(durableHomeInput, { mode: 0o700 });
  await mkdir(durableWorkspaceInput, { mode: 0o700 });
  const durableHome = await realpath(durableHomeInput);
  const durableWorkspace = await realpath(durableWorkspaceInput);
  const durablePreload = await userInfoPreload(t, durableHome, undefined, {
    behavior: "observe_sync",
    marker: durabilityMarker,
  });
  const durablePort = await unusedPort();
  await check("initialization durability", async () => {
    const captured = runPublic(
      durablePreload,
      startArguments(durablePort, durableWorkspace),
      durableWorkspace,
      { ...process.env, A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN },
    );
    t.after(async () => {
      if (captured.child.exitCode === null && captured.child.signalCode === null) {
        captured.child.kill("SIGKILL");
      }
      await captured.exit;
    });
    const readiness = `Connector webhook: http://127.0.0.1:${durablePort}/webhook\n`;
    await waitForReadiness(captured, readiness);
    assert.equal(captured.child.kill("SIGTERM"), true);
    assert.deepEqual(await waitForCapturedExit(captured, "durable initialization shutdown"), {
      code: 0,
      signal: null,
    });
    assert.deepEqual((await readFile(durabilityMarker, "utf8")).trim().split("\n"), [
      "file",
      "directory",
      "file",
      "directory",
      "file",
      "directory",
    ]);
  });

  await check("protected parent chain", async () => {
    const connectorRoot = dirname(providerStateDirectory(durableHome, "codex"));
    await chmod(connectorRoot, 0o755);
    const environment = { ...process.env };
    delete environment.A2A_CONNECTOR_WEBHOOK_TOKEN;
    const preload = await userInfoPreload(t, durableHome);
    const captured = runPublic(
      preload,
      startArguments(await unusedPort(), durableWorkspace),
      durableWorkspace,
      environment,
    );
    assert.deepEqual(await waitForCapturedExit(captured, "weak protected parent"), {
      code: 7,
      signal: null,
    });
    assert.equal(captured.stdout(), "");
    assert.equal(captured.stderr(), "a2a connector: connector_state_unavailable\n");
  });

  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
});

test("K02-S13 distinguishes partial markers while retirement resumes every crash barrier", async (t) => {
  const module = await loadK02Production("K02-K03:S13");
  const barriers = [
    { kind: "marker_created" } as const,
    ...Array.from({ length: 28 }, (_, bytes) => ({ kind: "marker_prefix" as const, bytes })),
    { kind: "marker_final_write" } as const,
    { kind: "marker_file_sync" } as const,
    { kind: "marker_directory_sync" } as const,
    ...[
      "correlation.sqlite3",
      "correlation.sqlite3-wal",
      "correlation.sqlite3-shm",
      "correlation.sqlite3-journal",
    ].map((leaf) => ({ kind: "artifact_deleted" as const, leaf })),
  ];
  for (const [index, crashAfter] of barriers.entries()) {
    const stateDirectory = await temporaryDirectory(t, `a2a-k02-s13-${index}-`);
    await module.initializeConnectorStateForTest({
      stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: WORKING_DIRECTORY,
    });
    await assert.rejects(
      module.retireConnectorStateForTest({
        stateDirectory,
        providerKind: "codex",
        arguments: ["retire-state", "--confirm=retire-all-correlation"],
        crashAfter,
      }),
      /connector_test_crash/u,
    );
    const partialMarker =
      crashAfter.kind === "marker_created" || crashAfter.kind === "marker_prefix";
    await assert.rejects(
      module.initializeConnectorStateForTest({
        stateDirectory,
        webhookToken: K02_TOKEN,
        providerKind: "codex",
        workingDirectory: WORKING_DIRECTORY,
      }),
      partialMarker ? /connector_state_unavailable/u : /connector_state_retired/u,
    );
    assert.deepEqual(
      await module.retireConnectorStateForTest({
        stateDirectory,
        providerKind: "codex",
        arguments: ["retire-state", "--confirm=retire-all-correlation"],
      }),
      { exitCode: 0, stdout: "Connector correlation state retired.\n", stderr: "" },
    );
    assert.equal(
      await readFile(join(stateDirectory, "retired.v1"), "ascii"),
      "a2a-connector-retirement-v1\n",
    );
    assert.deepEqual((await readdir(stateDirectory)).sort(), ["owner.sqlite3", "retired.v1"]);
  }
});

test("K02-D03 keeps connector-core unpackaged and fixes every private provider manifest", async () => {
  await loadK02Production("K02-K03:D03-manifests");
  await assert.rejects(readFile(resolve("packages/connector-core/package.json")), /ENOENT/u);
  const rootManifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(rootManifest.scripts?.["connectors:check"], "node scripts/connectors-check.mjs");
  for (const provider of PROVIDERS) {
    const providerCli = await readFile(
      resolve(`packages/${provider}-connector/src/cli.ts`),
      "utf8",
    );
    assert.equal(
      providerCli.includes("../../connector-core/src/index.js"),
      false,
      `${provider} public CLI deep-imports the repository test boundary`,
    );
    const manifest = JSON.parse(
      await readFile(resolve(`packages/${provider}-connector/package.json`), "utf8"),
    ) as unknown;
    assert.deepEqual(manifest, {
      name: `@a2adev/${provider}-connector`,
      version: "0.0.0-private",
      private: true,
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/nikrooz/a2a.git",
        directory: `packages/${provider}-connector`,
      },
      publishConfig: { access: "public" },
      type: "module",
      bin: { [`a2a-${provider}-connector`]: `dist/${provider}-connector/src/cli.js` },
      files: [
        "dist/connector-core/src",
        `dist/${provider}-connector/src`,
        "LICENSE",
        "README.md",
        "SECURITY.md",
      ],
      engines: { node: ">=24.19.0 <25" },
      dependencies: {
        "@modelcontextprotocol/client": "2.0.0",
        "better-sqlite3": "13.0.3",
        zod: "4.4.3",
      },
    });
  }
});

function runRepositoryScript(
  script: string,
  arguments_: readonly string[],
  cwd = process.cwd(),
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveCheck, reject) => {
    const child = spawn(process.execPath, [resolve(script), ...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolveCheck({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

interface FileInventory {
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly links: readonly string[];
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function inventory(root: string): Promise<FileInventory> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const directories: string[] = [];
  const files: string[] = [];
  const links: string[] = [];
  for (const entry of entries) {
    const path = portableRelative(root, join(entry.parentPath, entry.name));
    if (entry.isDirectory()) directories.push(path);
    else if (entry.isFile()) files.push(path);
    else links.push(path);
  }
  return {
    directories: directories.sort(),
    files: files.sort(),
    links: links.sort(),
  };
}

function directoriesFor(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    while (parent !== "") {
      directories.add(parent);
      parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
    }
  }
  return [...directories].sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function assertMode(path: string, expected: number): Promise<void> {
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, expected, `${path} has an unexpected POSIX mode`);
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const expression of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(expression)) {
      assert.ok(match[1] !== undefined);
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function dependencyName(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier;
  return specifier.split("/").slice(0, 2).join("/");
}

const FORBIDDEN_PACKAGED_CONTROLS = [
  "startConnectorFoundation",
  "connector_test_crash",
  "crashAfter",
  "failStateAfter",
  "failPairedStateWriteAfter",
  "crashAtUnboundState",
  "crashAfterCancellation",
  "crashAfterLostReplyUncertain",
  "crashForRecoveryState",
  "crashAfterReceived",
  "crashAfterTurnStarting",
  "proveNoProviderDispatch",
  "stallWebhookResponseAfterCommit",
  "providerDispatchDelayMsForTest",
  "stateActionObserverForTest",
  "filesystemQualification",
] as const;

function packagedBoundaryFailures(source: string, label: string): string[] {
  const failures = new Set<string>();
  if (source.includes("../../connector-core/src/index.js")) {
    failures.add(`${label} deep-imports the repository test boundary`);
  }
  for (const control of new Set(source.match(/\b[A-Za-z_$][\w$]*ForTest\b/gu) ?? [])) {
    failures.add(`${label} exposes test control ${control}`);
  }
  for (const control of FORBIDDEN_PACKAGED_CONTROLS) {
    if (!source.includes(control)) continue;
    failures.add(
      control === "startConnectorFoundation"
        ? `${label} exposes the arbitrary gateway/state-root foundation`
        : `${label} exposes test control ${control}`,
    );
  }
  return [...failures];
}

async function assertStagedTestBoundary(
  stageRoot: string,
  files: readonly string[],
): Promise<void> {
  const failures: string[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".js"))) {
    failures.push(...packagedBoundaryFailures(await readFile(join(stageRoot, file), "utf8"), file));
  }
  assert.deepEqual(failures, [], failures.join("\n"));
}

async function assertBuildAndStage(provider: (typeof PROVIDERS)[number]): Promise<void> {
  const buildRoot = resolve(`.build/connectors/${provider}`);
  const stageRoot = resolve(`.stage/connectors/${provider}/package`);
  const coreSourceRoot = resolve("packages/connector-core/src");
  const providerSourceRoot = resolve(`packages/${provider}-connector/src`);
  const coreSource = await inventory(coreSourceRoot);
  const providerSource = await inventory(providerSourceRoot);
  assert.deepEqual(coreSource.links, []);
  assert.deepEqual(providerSource.links, []);
  const coreOutputs = coreSource.files
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `connector-core/src/${file.replace(/\.ts$/u, ".js")}`);
  const providerOutputs = providerSource.files
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `${provider}-connector/src/${file.replace(/\.ts$/u, ".js")}`);
  assert.equal(
    coreOutputs.length + providerOutputs.length,
    coreSource.files.length + providerSource.files.length,
    "connector source trees may contain only TypeScript source files",
  );
  const expectedBuildFiles = [...coreOutputs, ...providerOutputs].sort();
  const buildInventory = await inventory(buildRoot);
  assert.deepEqual(buildInventory, {
    directories: directoriesFor(expectedBuildFiles),
    files: expectedBuildFiles,
    links: [],
  });

  const expectedStageFiles = [
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "package.json",
    ...expectedBuildFiles.map((file) => `dist/${file}`),
  ].sort();
  const stageInventory = await inventory(stageRoot);
  assert.deepEqual(stageInventory, {
    directories: directoriesFor(expectedStageFiles),
    files: expectedStageFiles,
    links: [],
  });

  for (const file of expectedBuildFiles) {
    assert.equal(
      await sha256(join(stageRoot, "dist", file)),
      await sha256(join(buildRoot, file)),
      `staging changed compiled bytes for ${file}`,
    );
  }
  for (const file of ["README.md", "SECURITY.md", "package.json"] as const) {
    assert.equal(
      await sha256(join(stageRoot, file)),
      await sha256(resolve(`packages/${provider}-connector/${file}`)),
      `staging changed ${provider} ${file}`,
    );
  }
  assert.equal(await sha256(join(stageRoot, "LICENSE")), await sha256(resolve("LICENSE")));

  const cliSource = await readFile(resolve(`packages/${provider}-connector/src/cli.ts`));
  const cliBuild = await readFile(join(buildRoot, `${provider}-connector/src/cli.js`));
  const cliStage = await readFile(join(stageRoot, `dist/${provider}-connector/src/cli.js`));
  const shebang = Buffer.from("#!/usr/bin/env node\n", "ascii");
  assert.deepEqual(cliSource.subarray(0, shebang.byteLength), shebang);
  assert.deepEqual(cliBuild.subarray(0, shebang.byteLength), shebang);
  assert.deepEqual(cliStage.subarray(0, shebang.byteLength), shebang);

  for (const directory of stageInventory.directories) {
    await assertMode(join(stageRoot, directory), 0o755);
  }
  for (const file of stageInventory.files) {
    await assertMode(
      join(stageRoot, file),
      file === `dist/${provider}-connector/src/cli.js` ? 0o755 : 0o644,
    );
  }

  const declaredDependencies = new Set(["@modelcontextprotocol/client", "better-sqlite3", "zod"]);
  for (const file of stageInventory.files.filter((file) => file.endsWith(".js"))) {
    const absolute = join(stageRoot, file);
    const source = await readFile(absolute, "utf8");
    for (const specifier of importSpecifiers(source)) {
      assert.equal(specifier.includes("gateway"), false, `${file} imports gateway code`);
      for (const sibling of PROVIDERS.filter((candidate) => candidate !== provider)) {
        assert.equal(
          specifier.includes(`${sibling}-connector`),
          false,
          `${file} imports ${sibling}`,
        );
      }
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        assert.ok(specifier.endsWith(".js"), `${file} has a non-JavaScript relative import`);
        const target = resolve(dirname(absolute), specifier);
        const relativeTarget = relative(join(stageRoot, "dist"), target);
        assert.ok(
          relativeTarget !== "" &&
            relativeTarget !== ".." &&
            !relativeTarget.startsWith(`..${sep}`) &&
            !isAbsolute(relativeTarget),
          `${file} imports outside staged dist`,
        );
        assert.equal((await lstat(target)).isFile(), true);
        continue;
      }
      assert.equal(specifier.startsWith("file:"), false);
      assert.ok(
        declaredDependencies.has(dependencyName(specifier)),
        `${file} imports undeclared package ${specifier}`,
      );
    }
  }
}

async function removeDerivedTarget(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata?.isSymbolicLink()) await unlink(path);
  else if (metadata !== undefined) await rm(path, { recursive: true, force: true });
}

async function assertLinkedTargetRejected(
  t: TestContext,
  script: string,
  provider: (typeof PROVIDERS)[number],
  target: string,
): Promise<void> {
  const outside = await temporaryDirectory(t, `a2a-k02-${provider}-link-target-`);
  const sentinel = join(outside, "sentinel");
  await writeFile(sentinel, "preserve", { encoding: "utf8", mode: 0o600 });
  await removeDerivedTarget(target);
  await symlink(outside, target, "dir");
  try {
    const result = await runRepositoryScript(script, [provider]);
    assert.notEqual(result.code, 0, `${script} accepted a linked output target`);
    assert.equal(result.stdout.includes(outside), false);
    assert.equal(result.stderr.includes(outside), false);
    assert.equal((await lstat(target)).isSymbolicLink(), true);
    assert.equal(await readFile(sentinel, "utf8"), "preserve");
  } finally {
    await removeDerivedTarget(target);
  }
}

interface TarEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly mode: number;
  readonly bytes: Buffer;
}

function tarText(bytes: Buffer, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function tarOctal(bytes: Buffer, offset: number, length: number): number {
  const value = tarText(bytes, offset, length).trim();
  assert.match(value, /^[0-7]+$/u);
  return Number.parseInt(value, 8);
}

function readTarball(bytes: Buffer): TarEntry[] {
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let sawEnd = false;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.ok(tar.subarray(offset).every((byte) => byte === 0));
      sawEnd = true;
      break;
    }
    const expectedChecksum = tarOctal(header, 148, 8);
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    assert.equal(checksum, expectedChecksum, "packed tar header checksum changed");
    const prefix = tarText(header, 345, 155);
    const name = tarText(header, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    assert.ok(path.startsWith("package/"));
    assert.equal(path.startsWith("/"), false);
    assert.equal(path.includes("\\"), false);
    assert.equal(path.split("/").includes(".."), false);
    assert.equal(seen.has(path), false, `duplicate packed path ${path}`);
    seen.add(path);
    const size = tarOctal(header, 124, 12);
    const mode = tarOctal(header, 100, 8) & 0o777;
    const typeByte = header[156] ?? 0;
    assert.ok(typeByte === 0 || typeByte === 0x30 || typeByte === 0x35);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert.ok(dataEnd <= tar.byteLength, `truncated packed path ${path}`);
    entries.push({
      path,
      type: typeByte === 0x35 ? "directory" : "file",
      mode,
      bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.length > 0);
  assert.equal(sawEnd, true, "packed tar lacks its zero-block terminator");
  return entries;
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = startCapturedChild(executable, arguments_, {
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  const outcome = await Promise.race([
    child.exit,
    delay(options.timeoutMs ?? 60_000, undefined, { ref: false }).then(() => {
      if (child.child.exitCode === null && child.child.signalCode === null) {
        child.child.kill("SIGKILL");
      }
      throw new Error(`timed out running ${executable}`);
    }),
  ]);
  return { ...outcome, stdout: child.stdout(), stderr: child.stderr() };
}

test("K02-D04 runs the closed-provider build and stage gate without stale or linked output", async (t) => {
  await loadK02Production("K02-K03:D04-build-stage");
  const foreignWorkingDirectory = await temporaryDirectory(t, "a2a-k02-package-cwd-");
  for (const script of ["scripts/build-connector.mjs", "scripts/stage-connector.mjs"]) {
    for (const arguments_ of [[], ["gateway"], ["codex", "claude"]]) {
      const result = await runRepositoryScript(script, arguments_);
      assert.notEqual(result.code, 0, `${script} accepted ${JSON.stringify(arguments_)}`);
    }
  }
  for (const provider of PROVIDERS) {
    const buildRoot = resolve(`.build/connectors/${provider}`);
    const buildTemporaryRoot = resolve(`.build/connectors/${provider}.tmp`);
    const stageProviderRoot = resolve(`.stage/connectors/${provider}`);
    const stageTemporaryRoot = resolve(`.stage/connectors/${provider}.tmp`);
    const stageRoot = join(stageProviderRoot, "package");

    const build = await runRepositoryScript(
      "scripts/build-connector.mjs",
      [provider],
      foreignWorkingDirectory,
    );
    assert.equal(build.code, 0, `${build.stdout}\n${build.stderr}`);
    await writeFile(join(buildRoot, "stale.js"), "stale build", {
      encoding: "utf8",
      mode: 0o600,
    });
    await mkdir(buildTemporaryRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(buildTemporaryRoot, "stale.js"), "stale temporary build", {
      encoding: "utf8",
      mode: 0o600,
    });
    const cleanBuild = await runRepositoryScript("scripts/build-connector.mjs", [provider]);
    assert.equal(cleanBuild.code, 0, `${cleanBuild.stdout}\n${cleanBuild.stderr}`);
    await assert.rejects(lstat(join(buildRoot, "stale.js")), /ENOENT/u);
    await assert.rejects(lstat(buildTemporaryRoot), /ENOENT/u);
    await assertLinkedTargetRejected(t, "scripts/build-connector.mjs", provider, buildRoot);
    await assertLinkedTargetRejected(
      t,
      "scripts/build-connector.mjs",
      provider,
      buildTemporaryRoot,
    );
    const restoredBuild = await runRepositoryScript("scripts/build-connector.mjs", [provider]);
    assert.equal(restoredBuild.code, 0, `${restoredBuild.stdout}\n${restoredBuild.stderr}`);

    const stage = await runRepositoryScript("scripts/stage-connector.mjs", [provider]);
    assert.equal(stage.code, 0, `${stage.stdout}\n${stage.stderr}`);
    await assertBuildAndStage(provider);
    await assertStagedTestBoundary(stageRoot, (await inventory(stageRoot)).files);
    await writeFile(join(stageRoot, "stale.txt"), "stale stage", {
      encoding: "utf8",
      mode: 0o600,
    });
    await mkdir(join(stageTemporaryRoot, "package"), { recursive: true, mode: 0o700 });
    await writeFile(join(stageTemporaryRoot, "package", "stale.txt"), "stale temporary stage", {
      encoding: "utf8",
      mode: 0o600,
    });
    const cleanStage = await runRepositoryScript("scripts/stage-connector.mjs", [provider]);
    assert.equal(cleanStage.code, 0, `${cleanStage.stdout}\n${cleanStage.stderr}`);
    await assert.rejects(lstat(join(stageRoot, "stale.txt")), /ENOENT/u);
    await assert.rejects(lstat(stageTemporaryRoot), /ENOENT/u);
    await assertLinkedTargetRejected(t, "scripts/stage-connector.mjs", provider, stageProviderRoot);
    await assertLinkedTargetRejected(
      t,
      "scripts/stage-connector.mjs",
      provider,
      stageTemporaryRoot,
    );
    const restoredStage = await runRepositoryScript("scripts/stage-connector.mjs", [provider]);
    assert.equal(restoredStage.code, 0, `${restoredStage.stdout}\n${restoredStage.stderr}`);
    await assertBuildAndStage(provider);
    await assertStagedTestBoundary(stageRoot, (await inventory(stageRoot)).files);
    await assert.rejects(lstat(buildTemporaryRoot), /ENOENT/u);
    await assert.rejects(lstat(stageTemporaryRoot), /ENOENT/u);
  }
});

test("K02-D05 gates the exact private packed and clean-installed command artifacts", async (t) => {
  await loadK02Production("K02-K03:D05-package");
  const pnpmVersion = await runCommand("pnpm", ["--version"], { cwd: process.cwd() });
  assert.deepEqual(
    { code: pnpmVersion.code, signal: pnpmVersion.signal, stdout: pnpmVersion.stdout },
    { code: 0, signal: null, stdout: "11.22.0\n" },
    pnpmVersion.stderr,
  );
  await startFakeConnectorGateway(t, { token: K02_TOKEN, port: 8787 });
  for (const provider of PROVIDERS) {
    const result = await runRepositoryScript("scripts/check-packed-connector.mjs", [provider]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    await assertBuildAndStage(provider);

    const stageRoot = resolve(`.stage/connectors/${provider}/package`);
    const stageInventory = await inventory(stageRoot);
    const artifactDirectory = await temporaryDirectory(t, `a2a-k02-${provider}-pack-`);
    const tarball = join(artifactDirectory, `${provider}-connector.tgz`);
    const packed = await runCommand("pnpm", ["pack", "--out", tarball], {
      cwd: stageRoot,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    assert.deepEqual(
      { code: packed.code, signal: packed.signal },
      { code: 0, signal: null },
      `${packed.stdout}\n${packed.stderr}`,
    );
    assert.ok((await stat(tarball)).size <= 32 * 1024 * 1024, "packed artifact is unbounded");
    const tarEntries = readTarball(await readFile(tarball));
    const tarFiles = tarEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.path.slice("package/".length))
      .sort();
    assert.deepEqual(tarFiles, stageInventory.files);
    const packedBoundaryFailures: string[] = [];
    for (const entry of tarEntries) {
      if (entry.type === "file" && entry.path.endsWith(".js")) {
        packedBoundaryFailures.push(
          ...packagedBoundaryFailures(entry.bytes.toString("utf8"), entry.path),
        );
      }
    }
    assert.deepEqual(packedBoundaryFailures, [], packedBoundaryFailures.join("\n"));
    const expectedDirectories = new Set(stageInventory.directories);
    for (const entry of tarEntries) {
      const path = entry.path.slice("package/".length).replace(/\/$/u, "");
      assert.equal(path.includes("gateway"), false, `packed gateway path ${path}`);
      for (const sibling of PROVIDERS.filter((candidate) => candidate !== provider)) {
        assert.equal(path.includes(`${sibling}-connector`), false, `packed sibling path ${path}`);
      }
      if (entry.type === "directory") {
        assert.equal(expectedDirectories.has(path), true, `unexpected packed directory ${path}`);
        assert.equal(entry.mode, 0o755);
        continue;
      }
      if (path === "package.json") {
        assert.deepEqual(
          JSON.parse(entry.bytes.toString("utf8")),
          JSON.parse(await readFile(join(stageRoot, path), "utf8")),
          "packing changed the package manifest",
        );
      } else {
        assert.equal(
          createHash("sha256").update(entry.bytes).digest("hex"),
          await sha256(join(stageRoot, path)),
          `packing changed ${path}`,
        );
      }
      assert.equal(
        entry.mode,
        path === `dist/${provider}-connector/src/cli.js` ? 0o755 : 0o644,
        `packed mode changed for ${path}`,
      );
    }
    const packedManifestEntry = tarEntries.find((entry) => entry.path === "package/package.json");
    assert.ok(packedManifestEntry?.type === "file");
    const packedManifest = JSON.parse(packedManifestEntry.bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(packedManifest.name, `@a2adev/${provider}-connector`);
    assert.equal(packedManifest.version, "0.0.0-private");
    assert.equal(packedManifest.private, true);
    assert.equal("scripts" in packedManifest, false);

    const installRoot = await temporaryDirectory(t, `a2a-k02-${provider}-install-`);
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ name: "k02-clean-install", private: true })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const installed = await runCommand(
      "pnpm",
      ["add", "--offline", "--ignore-scripts", "--package-import-method=copy", tarball],
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
    assert.deepEqual(
      { code: installed.code, signal: installed.signal },
      { code: 0, signal: null },
      `${installed.stdout}\n${installed.stderr}`,
    );
    const installedPackage = join(installRoot, "node_modules", "@a2adev", `${provider}-connector`);
    const installedInventory = await inventory(installedPackage);
    const packageManagerShim = `node_modules/.bin/a2a-${provider}-connector`;
    assert.deepEqual(installedInventory, {
      directories: [...stageInventory.directories, "node_modules", "node_modules/.bin"].sort(),
      files: [...stageInventory.files, packageManagerShim].sort(),
      links: [],
    });
    await assertMode(join(installedPackage, packageManagerShim), 0o755);
    for (const file of stageInventory.files) {
      if (file === "package.json") {
        assert.deepEqual(
          JSON.parse(await readFile(join(installedPackage, file), "utf8")),
          JSON.parse(await readFile(join(stageRoot, file), "utf8")),
          "clean install changed the package manifest",
        );
      } else {
        assert.equal(
          await sha256(join(installedPackage, file)),
          await sha256(join(stageRoot, file)),
          `clean install changed ${file}`,
        );
      }
    }
    await assertStagedTestBoundary(installedPackage, stageInventory.files);
    assert.deepEqual(await readdir(join(installRoot, "node_modules", "@a2adev")), [
      `${provider}-connector`,
    ]);

    const shim = join(installRoot, "node_modules", ".bin", `a2a-${provider}-connector`);
    assert.equal((await stat(shim)).mode & 0o111, 0o111);
    const accountHomeInput = join(artifactDirectory, "account-home");
    const workspaceInput = join(artifactDirectory, "workspace");
    await mkdir(accountHomeInput, { mode: 0o700 });
    await mkdir(workspaceInput, { mode: 0o700 });
    const accountHome = await realpath(accountHomeInput);
    const workspace = await realpath(workspaceInput);
    const preload = await userInfoPreload(t, accountHome);
    const shimEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      A2A_CONNECTOR_WEBHOOK_TOKEN: K02_TOKEN,
      NODE_OPTIONS: `--import=${preload}`,
    };

    const invalidShim = startCapturedChild(shim, [], {
      cwd: workspace,
      env: shimEnvironment,
    });
    assert.deepEqual(await waitForCapturedExit(invalidShim, `${provider} installed shim error`), {
      code: 2,
      signal: null,
    });
    assert.equal(invalidShim.stdout(), "");
    assert.equal(invalidShim.stderr(), "a2a connector: invalid_connector_arguments\n");

    const webhookPort = await unusedPort();
    const installedForeground = startCapturedChild(shim, startArguments(webhookPort, workspace), {
      cwd: workspace,
      env: shimEnvironment,
    });
    t.after(async () => {
      if (
        installedForeground.child.exitCode === null &&
        installedForeground.child.signalCode === null
      ) {
        installedForeground.child.kill("SIGKILL");
      }
      await installedForeground.exit;
    });
    const readiness = `Connector webhook: http://127.0.0.1:${webhookPort}/webhook\n`;
    await waitForReadiness(installedForeground, readiness);
    assert.equal(installedForeground.stdout(), readiness);
    assert.equal(installedForeground.stderr(), "");
    assert.equal(installedForeground.child.exitCode, null);
    assert.equal(installedForeground.child.kill("SIGTERM"), true);
    assert.deepEqual(
      await waitForCapturedExit(installedForeground, `${provider} installed shim shutdown`),
      { code: 0, signal: null },
    );
    assert.equal(installedForeground.stdout(), readiness);
    assert.equal(installedForeground.stderr(), "");
    for (const output of [
      invalidShim.stdout(),
      invalidShim.stderr(),
      installedForeground.stdout(),
      installedForeground.stderr(),
    ]) {
      assert.equal(output.includes(K02_TOKEN), false);
      assert.equal(output.includes(workspace), false);
      assert.equal(output.includes(accountHome), false);
    }
  }
});
