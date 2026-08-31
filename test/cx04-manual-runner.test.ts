import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const {
  CODEX_SCHEMA_SHA256,
  CODEX_VERSION_STDOUT,
  CX04_CONFIRMATION,
  configFingerprint,
  preparePackedConnector,
  runCx04Qualification,
  verifyCodexInstallation,
} = (await import(
  pathToFileURL(join(process.cwd(), "scripts", "cx04-qualification-lib.mjs")).href
)) as typeof import("../scripts/cx04-qualification-lib.mjs");

test("CX04 manual runner requires the exact opt-in before any action", async () => {
  let actions = 0;
  const result = await runCx04Qualification([], {
    async execute() {
      actions += 1;
      throw new Error("must not run");
    },
    writeStdout() {
      actions += 1;
    },
    writeStderr() {},
  });

  assert.equal(result, 2);
  assert.equal(actions, 0);
});

test("CX04 pack and install commands disable lifecycle scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cx04-package-inputs-"));
  const pnpmCli = join(root, "tooling", "pnpm.mjs");
  const pnpmStore = join(root, "store", "v11");
  const pnpmCache = join(root, "cache", "pnpm");
  await Promise.all([
    mkdir(join(pnpmStore, "files", "00"), { recursive: true }),
    mkdir(
      join(pnpmCache, "v11", "metadata", "registry.npmjs.org", "@modelcontextprotocol"),
      { recursive: true },
    ),
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
  try {
    await preparePackedConnector(
      {
        repositoryRoot: "/repo",
        temporaryRoot: "/tmp/cx04",
        nodeExecutable: process.execPath,
        pnpmCli,
        pnpmStore,
        pnpmCache,
        environment: { PATH: "/bin" },
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

  const canonicalNode = await realpath(process.execPath);
  const canonicalCli = await realpath(pnpmCli).catch(() => pnpmCli);
  const canonicalStore = await realpath(pnpmStore).catch(() => pnpmStore);
  const canonicalCache = await realpath(pnpmCache).catch(() => pnpmCache);

  assert.deepEqual(
    calls.map((call) => [call.executable, ...call.arguments]),
    [
      [canonicalNode, canonicalCli, "--version"],
      [canonicalNode, "/repo/scripts/build-connector.mjs", "codex"],
      [canonicalNode, "/repo/scripts/stage-connector.mjs", "codex"],
      [
        canonicalNode,
        "/repo/scripts/check-packed-connector.mjs",
        "codex",
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
        "/tmp/cx04/codex-connector.tgz",
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
        "/tmp/cx04/codex-connector.tgz",
      ],
    ],
  );
  assert.ok(calls.every((call) => call.environment.npm_config_ignore_scripts === "true"));
  assert.ok(calls.every((call) => call.environment.npm_config_offline === "true"));
});

test("CX04 rejects unqualified package inputs before packaging", async () => {
  let calls = 0;
  await assert.rejects(
    preparePackedConnector(
      {
        repositoryRoot: "/repo",
        temporaryRoot: "/tmp/cx04",
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
      error.message === "CX04 qualification phase failed",
  );
  assert.equal(calls, 0);
});

test("CX04 matrix evidence is closed and fake-safe", async () => {
  const { validateMatrixObservation } = (await import(
    pathToFileURL(join(process.cwd(), "scripts", "cx04-real-codex-driver.mjs")).href
  )) as { validateMatrixObservation(value: unknown): boolean };
  const accepted = {
    twoTurnResume: true,
    readOnlySandbox: true,
    workspaceWriteSandbox: true,
    outOfRootDenied: true,
    networkDenied: true,
    cancellation: true,
    hardCrashContainment: true,
    exactRecovery: true,
    artifactsClean: true,
  };
  assert.equal(validateMatrixObservation(accepted), true);
  assert.equal(validateMatrixObservation({ ...accepted, exactRecovery: false }), false);
  assert.equal(validateMatrixObservation({ ...accepted, unreviewed: true }), false);
});

test("CX04 verifies the exact version and two independent stable schema generations", async () => {
  const calls: Array<{ executable: string; arguments: readonly string[] }> = [];
  const schema = Buffer.from("schema fixture", "utf8");
  const digest = createHash("sha256").update(schema).digest("hex");
  const result = await verifyCodexInstallation(
    {
      executable: "/opt/codex",
      schemaDirectories: ["/tmp/schema-a", "/tmp/schema-b"],
      expectedSchemaSha256: digest,
      environment: { PATH: "/bin" },
    },
    {
      async run(request) {
        calls.push({ executable: request.executable, arguments: [...request.arguments] });
        if (request.arguments[0] === "--version") {
          return { code: 0, signal: null, stdout: CODEX_VERSION_STDOUT, stderr: "" };
        }
        return { code: 0, signal: null, stdout: "", stderr: "" };
      },
      async readSchema(path) {
        assert.match(path, /codex_app_server_protocol\.v2\.schemas\.json$/u);
        return schema;
      },
    },
  );

  assert.equal(result.schemaSha256, digest);
  assert.deepEqual(calls, [
    { executable: "/opt/codex", arguments: ["--version"] },
    {
      executable: "/opt/codex",
      arguments: ["app-server", "generate-json-schema", "--out", "/tmp/schema-a"],
    },
    {
      executable: "/opt/codex",
      arguments: ["app-server", "generate-json-schema", "--out", "/tmp/schema-b"],
    },
  ]);
  assert.ok(calls.every((call) => !call.arguments.includes("--experimental")));
});

test("CX04 config fingerprint retains only absence or SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cx04-fingerprint-"));
  try {
    const path = join(root, "config.toml");
    assert.deepEqual(await configFingerprint(path), { kind: "absent" });
    await writeFile(path, "sensitive configuration\n", { mode: 0o600 });
    const fingerprint = await configFingerprint(path);
    assert.deepEqual(fingerprint, {
      kind: "sha256",
      value: createHash("sha256").update("sensitive configuration\n").digest("hex"),
    });
    assert.ok(!JSON.stringify(fingerprint).includes("sensitive configuration"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CX04 config fingerprint does not mistake a dangling config link for absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cx04-config-link-"));
  try {
    const path = join(root, "config.toml");
    await symlink(join(root, "missing.toml"), path);
    await assert.rejects(configFingerprint(path), (error: unknown) => {
      return error instanceof Error && !error.message.includes(root);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CX04 success record is content-free and covers the accepted real matrix", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const secretValues = [
    "fixture-token-value",
    "fixture-prompt-value",
    "fixture-reply-value",
    "fixture-config-value",
  ];
  const result = await runCx04Qualification([`--confirm=${CX04_CONFIRMATION}`], {
    async execute() {
      return {
        platform: "darwin-arm64",
        nodeVersion: process.versions.node,
        codexVersion: "0.149.0",
        schemaSha256: CODEX_SCHEMA_SHA256,
        tarballSha256: "a".repeat(64),
        checks: {
          packedInstall: true,
          twoTurnResume: true,
          readOnlySandbox: true,
          workspaceWriteSandbox: true,
          outOfRootDenied: true,
          networkDenied: true,
          cancellation: true,
          hardCrashContainment: true,
          exactRecovery: true,
          configUnchanged: true,
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
  const record = JSON.parse(stdout.join("")) as Record<string, unknown>;
  assert.deepEqual(record, {
    qualification: "cx04",
    result: "passed",
    platform: "darwin-arm64",
    node_version: process.versions.node,
    codex_version: "0.149.0",
    schema_sha256: CODEX_SCHEMA_SHA256,
    tarball_sha256: "a".repeat(64),
    packed_install: true,
    two_turn_resume: true,
    read_only_sandbox: true,
    workspace_write_sandbox: true,
    out_of_root_denied: true,
    network_denied: true,
    cancellation: true,
    hard_crash_containment: true,
    exact_recovery: true,
    config_unchanged: true,
    artifacts_clean: true,
    provider_history: "codex_owned_not_scanned_or_deleted",
    support_claim: "preview_candidate_only",
  });
  for (const value of secretValues) assert.ok(!stdout.join("").includes(value));
});

test("CX04 failures expose only the fixed phase code", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runCx04Qualification([`--confirm=${CX04_CONFIRMATION}`], {
    async execute() {
      throw Object.assign(new Error("provider output and local paths must stay hidden"), {
        phase: "schema",
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
  assert.equal(stderr.join(""), "cx04 qualification: schema_failed\n");
  assert.ok(!stderr.join("").includes("provider output"));
});

test("CX04 real runner is manual-only and absent from provider packages", async () => {
  const [runner, rootManifest, providerManifest] = await Promise.all([
    readFile("scripts/cx04-qualify-codex.mjs", "utf8"),
    readFile("package.json", "utf8"),
    readFile("packages/codex-connector/package.json", "utf8"),
  ]);
  assert.ok(runner.includes(CX04_CONFIRMATION));
  assert.ok(!runner.includes("node:test"));
  assert.ok(!runner.includes("--experimental"));
  assert.ok(!rootManifest.includes("cx04-qualify-codex"));
  assert.ok(!providerManifest.includes("cx04"));
});
