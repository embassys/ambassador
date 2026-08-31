import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const { CL04_CONFIRMATION, preparePackedClaudeConnector, runBoundedCommand, runCl04Qualification } =
  (await import(
    pathToFileURL(join(process.cwd(), "scripts", "cl04-qualification-lib.mjs")).href
  )) as typeof import("../scripts/cl04-qualification-lib.mjs");

test("CL04 requires the exact opt-in before any action", async () => {
  for (const arguments_ of [
    [],
    ["--confirm=run-authenticated-claude-code-on-disposable-account"],
    [`--confirm=${CL04_CONFIRMATION}`, "--extra"],
  ]) {
    let actions = 0;
    const stderr: string[] = [];
    const result = await runCl04Qualification(arguments_, {
      async execute() {
        actions += 1;
        throw new Error("must not run");
      },
      writeStdout() {
        actions += 1;
      },
      writeStderr(value) {
        stderr.push(value);
      },
    });

    assert.equal(result, 2);
    assert.equal(actions, 0);
    assert.equal(stderr.join(""), "cl04 qualification: explicit_confirmation_required\n");
  }
});

test("CL04 packs and installs only the Claude artifact with lifecycle scripts disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cl04-package-inputs-"));
  const pnpmCli = join(root, "tooling", "pnpm.mjs");
  const pnpmStore = join(root, "store", "v11");
  const pnpmCache = join(root, "cache", "pnpm");
  await Promise.all([
    mkdir(join(pnpmStore, "files", "00"), { recursive: true }),
    mkdir(join(pnpmCache, "v11", "metadata", "registry.npmjs.org", "@modelcontextprotocol"), {
      recursive: true,
    }),
    mkdir(join(root, "tooling"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(pnpmCli, "// pinned pnpm fixture\n"),
    writeFile(join(pnpmStore, "index.db"), "fixture-index\n"),
    writeFile(
      join(
        pnpmCache,
        "v11",
        "metadata",
        "registry.npmjs.org",
        "@modelcontextprotocol",
        "client.jsonl",
      ),
      "fixture metadata\n",
    ),
    writeFile(
      join(pnpmCache, "v11", "metadata", "registry.npmjs.org", "better-sqlite3.jsonl"),
      "fixture metadata\n",
    ),
    writeFile(
      join(pnpmCache, "v11", "metadata", "registry.npmjs.org", "zod.jsonl"),
      "fixture metadata\n",
    ),
  ]);
  const calls: Array<{
    executable: string;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
  }> = [];
  const [canonicalNode, canonicalCli, canonicalStore, canonicalCache] = await Promise.all([
    realpath(process.execPath),
    realpath(pnpmCli),
    realpath(pnpmStore),
    realpath(pnpmCache),
  ]);
  try {
    await preparePackedClaudeConnector(
      {
        repositoryRoot: "/repo",
        temporaryRoot: "/tmp/cl04",
        nodeExecutable: process.execPath,
        pnpmCli,
        pnpmStore,
        pnpmCache,
        environment: {
          HOME: "/account",
          PATH: "/bin",
          CLAUDE_CODE_OAUTH_TOKEN: "must-not-be-copied",
        },
      },
      async (request) => {
        calls.push({
          executable: request.executable,
          arguments: [...request.arguments],
          environment: { ...request.environment },
        });
        return request.arguments[1] === "--version"
          ? { code: 0, signal: null, stdout: "11.22.0\n", stderr: "" }
          : { code: 0, signal: null, stdout: "", stderr: "" };
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  assert.deepEqual(
    calls.map((call) => [call.executable, ...call.arguments]),
    [
      [canonicalNode, canonicalCli, "--version"],
      [canonicalNode, "/repo/scripts/build-connector.mjs", "claude"],
      [canonicalNode, "/repo/scripts/stage-connector.mjs", "claude"],
      [
        canonicalNode,
        "/repo/scripts/check-packed-connector.mjs",
        "claude",
        `--store-dir=${canonicalStore}`,
        `--pnpm-cli=${canonicalCli}`,
        `--cache-dir=${canonicalCache}`,
      ],
      [
        canonicalNode,
        canonicalCli,
        "pack",
        `--config.store-dir=${canonicalStore}`,
        `--config.cache-dir=${canonicalCache}`,
        "--ignore-scripts",
        "--out",
        "/tmp/cl04/claude-connector.tgz",
      ],
      [
        canonicalNode,
        canonicalCli,
        "add",
        `--config.store-dir=${canonicalStore}`,
        `--config.cache-dir=${canonicalCache}`,
        "--offline",
        "--ignore-scripts",
        "--package-import-method=copy",
        "/tmp/cl04/claude-connector.tgz",
      ],
    ],
  );
  assert.ok(calls.every((call) => call.environment.npm_config_ignore_scripts === "true"));
  assert.ok(calls.every((call) => call.environment.npm_config_offline === "true"));
  assert.ok(calls.every((call) => call.environment.CLAUDE_CODE_OAUTH_TOKEN === undefined));
});

test("CL04 rejects unqualified package inputs before packaging", async () => {
  let calls = 0;
  await assert.rejects(
    preparePackedClaudeConnector(
      {
        repositoryRoot: "/repo",
        temporaryRoot: "/tmp/cl04",
        nodeExecutable: "relative-node",
        pnpmCli: "relative-pnpm",
        pnpmStore: "relative-store",
        pnpmCache: "relative-cache",
        environment: { PATH: "/bin" },
      },
      async () => {
        calls += 1;
        return { code: 0, signal: null, stdout: "", stderr: "" };
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { phase?: unknown }).phase === "precondition" &&
      error.message === "CL04 qualification phase failed",
  );
  assert.equal(calls, 0);
});

test("CL04 bounds and contains the complete helper process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cl04-helper-group-"));
  const pidPath = join(root, "descendant.pid");
  const script = [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    "const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    'process.stdout.write("x".repeat(1024 * 1024 + 1));',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  let descendantPid = 0;
  try {
    await assert.rejects(
      runBoundedCommand({
        executable: process.execPath,
        arguments: ["--input-type=module", "--eval", script],
        cwd: root,
        environment: { PATH: process.env.PATH ?? "" },
        timeoutMs: 5_000,
        phase: "behavior",
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { phase?: unknown }).phase === "behavior" &&
        error.message === "CL04 qualification phase failed",
    );
    descendantPid = Number(await readFile(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.throws(
      () => process.kill(descendantPid, 0),
      (error: unknown) =>
        error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  } finally {
    if (descendantPid > 0) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The bounded runner should already have removed it.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("CL04 real matrix evidence is closed and content-free", async () => {
  const { validateMatrixObservation } = (await import(
    pathToFileURL(join(process.cwd(), "scripts", "cl04-real-claude-driver.mjs")).href
  )) as { validateMatrixObservation(value: unknown): boolean };
  const accepted = {
    sessionBeforeInput: true,
    structuredInput: true,
    twoTurnResume: true,
    safeRestrictedStartup: true,
    inRootRead: true,
    outOfRootReadDenied: true,
    workspaceWritePolicy: true,
    outOfRootWriteDenied: true,
    networkDenied: true,
    approvalDenied: true,
    externalProcessTopology: true,
    cancellation: true,
    timeout: true,
    normalExit: true,
    heldGroupSealing: true,
    connectorHardDeathStartup: true,
    connectorHardDeathActive: true,
    monitorHardDeathContainment: true,
    noBlindReplay: true,
    providerHistoryResume: true,
    artifactsClean: true,
  };
  assert.equal(validateMatrixObservation(accepted), true);
  assert.equal(validateMatrixObservation({ ...accepted, noBlindReplay: false }), false);
  assert.equal(validateMatrixObservation({ ...accepted, unreviewed: true }), false);
});

test("CL04 success evidence is closed, content-free, and makes no support claim", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const secrets = [
    "fixture-credential",
    "fixture-prompt",
    "fixture-reply",
    "fixture-session-id",
    "fixture-process-id",
  ];
  const result = await runCl04Qualification([`--confirm=${CL04_CONFIRMATION}`], {
    async execute() {
      return {
        platform: "darwin-arm64",
        nodeVersion: process.versions.node,
        claudeCodeVersion: "2.1.251",
        tarballSha256: "a".repeat(64),
        checks: {
          packedInstall: true,
          exactVersion: true,
          sessionBeforeInput: true,
          structuredInput: true,
          twoTurnResume: true,
          safeRestrictedStartup: true,
          inRootRead: true,
          outOfRootReadDenied: true,
          workspaceWritePolicy: true,
          outOfRootWriteDenied: true,
          networkDenied: true,
          approvalDenied: true,
          externalProcessTopology: true,
          cancellation: true,
          timeout: true,
          normalExit: true,
          heldGroupSealing: true,
          connectorHardDeathStartup: true,
          connectorHardDeathActive: true,
          monitorHardDeathContainment: true,
          noBlindReplay: true,
          providerHistoryResume: true,
          artifactsClean: true,
        },
      };
    },
    writeStdout(value) {
      stdout.push(value);
    },
    writeStderr(value) {
      stderr.push(value);
    },
  });

  assert.equal(result, 0);
  assert.equal(stderr.join(""), "");
  assert.deepEqual(JSON.parse(stdout.join("")), {
    qualification: "cl04",
    result: "passed",
    platform: "darwin-arm64",
    node_version: process.versions.node,
    claude_code_version: "2.1.251",
    tarball_sha256: "a".repeat(64),
    packed_install: true,
    exact_version: true,
    session_before_input: true,
    structured_input: true,
    two_turn_resume: true,
    safe_restricted_startup: true,
    in_root_read: true,
    out_of_root_read_denied: true,
    workspace_write_policy: true,
    out_of_root_write_denied: true,
    network_denied: true,
    approval_denied: true,
    external_process_topology: true,
    cancellation: true,
    timeout: true,
    normal_exit: true,
    held_group_sealing: true,
    connector_hard_death_startup: true,
    connector_hard_death_active: true,
    monitor_hard_death_containment: true,
    no_blind_replay: true,
    provider_history_resume: true,
    artifacts_clean: true,
    provider_history: "claude_owned_not_scanned_or_deleted",
    support_claim: "none_pending_review",
  });
  for (const value of secrets) assert.ok(!stdout.join("").includes(value));
});

test("CL04 failures expose only a fixed phase code", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runCl04Qualification([`--confirm=${CL04_CONFIRMATION}`], {
    async execute() {
      throw Object.assign(new Error("provider output and local paths must stay hidden"), {
        phase: "integration",
      });
    },
    writeStdout(value) {
      stdout.push(value);
    },
    writeStderr(value) {
      stderr.push(value);
    },
  });

  assert.equal(result, 1);
  assert.equal(stdout.join(""), "");
  assert.equal(stderr.join(""), "cl04 qualification: integration_failed\n");
  assert.ok(!stderr.join("").includes("provider output"));
});

test("CL04 is manual-only and exposes no provider test control", async () => {
  const [runner, library, rootManifest, providerManifest, connectorCli] = await Promise.all([
    readFile("scripts/cl04-qualify-claude.mjs", "utf8"),
    readFile("scripts/cl04-qualification-lib.mjs", "utf8"),
    readFile("package.json", "utf8"),
    readFile("packages/claude-connector/package.json", "utf8"),
    readFile("packages/claude-connector/src/cli.ts", "utf8"),
  ]);
  assert.ok(runner.includes(CL04_CONFIRMATION));
  assert.ok(!runner.includes("node:test"));
  for (const forbidden of [
    "--driver",
    "--fault",
    "--observe",
    "--provider-path",
    "--state-path",
    "--test-control",
  ]) {
    assert.ok(!runner.includes(forbidden));
    assert.ok(!library.includes(forbidden));
    assert.ok(!connectorCli.includes(forbidden));
  }
  assert.ok(!rootManifest.includes("cl04-qualify-claude"));
  assert.ok(!providerManifest.includes("cl04"));
});
