import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startConnectorRuntime } from "../packages/connector-core/src/connector.js";
import type { ProviderPort } from "../packages/connector-core/src/runtime-types.js";
import {
  CL02_SESSION_ID,
  collectEvents,
  createCl02Adapter,
  initRecord,
  inputRecord,
  resultRecord,
  resumeRequest,
  startFakeClaudeCli,
  startRequest,
  syntheticCl02Environment,
} from "./support/claude-code/index.js";
import { startFakeConnectorGateway } from "./support/connector/index.js";
import { K02_TOKEN, k02Message } from "./support/connector/k02-production.js";

function eventName(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as { event?: unknown }).event
    : undefined;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function turnPlan(sessionId: string, inputUuid: string, input: string, reply: string) {
  return {
    kind: "turn" as const,
    writesBeforeInput: [{ kind: "json" as const, value: initRecord(process.cwd(), { sessionId }) }],
    writesAfterInput: [
      { kind: "json" as const, value: inputRecord(input, sessionId, inputUuid) },
      { kind: "json" as const, value: resultRecord(reply, { sessionId }) },
    ],
  };
}

async function runCl02Command(
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const child = spawn(executable, [...arguments_], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...(options.env ?? process.env) },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  return await new Promise((resolveCommand, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveCommand({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } else {
        reject(new Error("CL02 artifact command failed"));
      }
    });
  });
}

async function runCl02DiagnosticWorker(request: {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly input: string;
}): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const workerPath = fileURLToPath(
    new URL("./support/claude-code/adapter-diagnostic-worker.js", import.meta.url),
  );
  const child = spawn(process.execPath, [workerPath], {
    cwd: process.cwd(),
    env: syntheticCl02Environment("diagnostic-worker"),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  return await new Promise((resolveWorker, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveWorker({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } else {
        reject(new Error("CL02 diagnostic worker failed"));
      }
    });
  });
}

async function scanCl02Files(
  root: string,
  markers: readonly string[],
  controls: readonly string[] = [],
): Promise<void> {
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries) {
    const path = join(root, String(entry));
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      continue;
    }
    for (const marker of [...markers, ...controls]) {
      assert.equal(body.includes(Buffer.from(marker)), false, `${marker} survived in ${path}`);
    }
  }
}

async function runCl02ArtifactScan(request: {
  readonly roots: readonly string[];
  readonly captures: readonly { readonly name: string; readonly value: string }[];
  readonly markers: readonly string[];
}): Promise<void> {
  const child = spawn(process.execPath, [join(process.cwd(), "scripts", "t02-artifact-scan.mjs")], {
    cwd: process.cwd(),
    env: syntheticCl02Environment("artifact-scanner"),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(
    JSON.stringify({
      roots: request.roots.map((root) => resolve(root)),
      captures: request.captures,
      markers: request.markers.map((value, index) => ({
        name: `cl02_marker_${index}`,
        encoding: "utf8",
        value,
      })),
    }),
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  await new Promise<void>((resolveScan, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolveScan();
      else
        reject(new Error(`CL02 artifact scan failed: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
  assert.match(Buffer.concat(stdout).toString("utf8"), /^artifact scan passed:/u);
}

test("CL02-L20 excludes content credentials history and fake controls from runtime and package artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cl02-artifact-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  const home = join(root, "home");
  const runtimeTemp = join(root, "tmp");
  const installRoot = join(root, "clean-install");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(runtimeTemp, { mode: 0o700 });
  await mkdir(installRoot, { mode: 0o700 });
  const markers = [
    "CL02_A2A_CONTENT_SECRET",
    "CL02_REPLY_SECRET",
    "CL02_TOOL_DETAIL_SECRET",
    "CL02_APPROVAL_SECRET",
    "CL02_CLAUDE_CREDENTIAL_SECRET",
    "CL02_PROVIDER_HISTORY_SECRET",
    "CL02_DIAGNOSTIC_SECRET",
  ] as const;
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L20", {
    workingDirectory: workspace,
    inheritedEnvironment: {
      ...syntheticCl02Environment(home),
      TMPDIR: runtimeTemp,
      ANTHROPIC_API_KEY: markers[4],
      CL02_WEBHOOK_TOKEN: "a".repeat(48),
    },
    turnPlan: {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(workspace) }],
      writesAfterInput: [
        {
          kind: "json",
          value: inputRecord(markers[0], CL02_SESSION_ID, "00000000-0000-4000-8000-000000000601"),
        },
        {
          kind: "json",
          value: {
            type: "assistant",
            uuid: "00000000-0000-4000-8000-000000000602",
            session_id: CL02_SESSION_ID,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool_1",
                  name: "Read",
                  input: { detail: markers[2] },
                },
              ],
            },
            parent_tool_use_id: null,
          },
        },
        {
          kind: "json",
          value: {
            type: "assistant",
            uuid: "00000000-0000-4000-8000-000000000604",
            session_id: CL02_SESSION_ID,
            message: {
              role: "assistant",
              content: [{ type: "text", text: markers[5] }],
            },
            parent_tool_use_id: null,
          },
        },
        { kind: "stderr_utf8", value: `${markers[6]}\n` },
        { kind: "json", value: resultRecord(markers[1]) },
      ],
    },
    uuidForTest: (kind) =>
      kind === "session" ? CL02_SESSION_ID : "00000000-0000-4000-8000-000000000601",
  });
  const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN });
  const connector = await startConnectorRuntime({
    providerKind: "claude",
    webhookPort: await unusedLoopbackPort(),
    webhookToken: K02_TOKEN,
    workingDirectory: workspace,
    policy: "read-only",
    gatewayEndpoint: gateway.endpoint,
    stateDirectory,
    provider: adapter as unknown as ProviderPort,
  });
  t.after(async () => await connector.close());
  const message = k02Message("cl02_l20_message", "cl02_l20_conversation", markers[0]);
  gateway.enqueueMessage(message);
  assert.equal((await gateway.sendWake(connector.webhookUrl, message.id)).status, 202);
  await connector.waitForIdle();
  assert.equal(gateway.tombstone(message.id)?.outcome, "replied");

  const approval = await createCl02Adapter(t, "CL02-CL03:L20", {
    workingDirectory: workspace,
    inheritedEnvironment: { ...syntheticCl02Environment(home), TMPDIR: runtimeTemp },
    turnPlan: {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(workspace) }],
      writesAfterInput: [
        {
          kind: "json",
          value: inputRecord(
            "approval input",
            CL02_SESSION_ID,
            "00000000-0000-4000-8000-000000000603",
          ),
        },
        { kind: "json", value: { type: "approval_request", detail: markers[3] } },
      ],
    },
    uuidForTest: (kind) =>
      kind === "session" ? CL02_SESSION_ID : "00000000-0000-4000-8000-000000000603",
  });
  const approvalEvents = await collectEvents(
    approval.adapter.start(startRequest("approval input")),
  );
  assert.ok(!JSON.stringify(approvalEvents).includes(markers[3]));

  const diagnosticFake = await startFakeClaudeCli(t, [
    { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
    {
      kind: "turn",
      writesBeforeInput: [{ kind: "json", value: initRecord(workspace) }],
      writesAfterInput: [
        { kind: "json", value: inputRecord(markers[0]) },
        { kind: "stderr_utf8", value: `${markers[6]}\n` },
        { kind: "utf8", value: `{"diagnostic":"${markers[1]}"\n` },
      ],
      exitCode: 87,
    },
  ]);
  const diagnosticCapture = await runCl02DiagnosticWorker({
    executablePath: diagnosticFake.executablePath,
    workingDirectory: workspace,
    environment: { ...syntheticCl02Environment(home), TMPDIR: runtimeTemp },
    input: markers[0],
  });
  assert.deepEqual(diagnosticCapture.stdout, Buffer.from('{"done":true}\n'));
  assert.deepEqual(diagnosticCapture.stderr, Buffer.alloc(0));

  const controls = [
    "ForTest",
    "fixtureExecutablePath",
    "processBarrierForTest",
    "processObserverForTest",
    "afterVersionProbeForTest",
    "CL02-CL03",
  ];
  const captures: { name: string; value: string }[] = [fake, approval.fake, diagnosticFake].flatMap(
    (candidate) =>
      candidate.launches.map((entry) => ({
        name: `${entry.mode}_${entry.pid}`,
        value: JSON.stringify({ arguments: entry.arguments, environment: entry.environment }),
      })),
  );
  captures.push({ name: "connector_stdout", value: diagnosticCapture.stdout.toString("utf8") });
  captures.push({ name: "connector_stderr", value: diagnosticCapture.stderr.toString("utf8") });
  for (const marker of markers) {
    assert.ok(captures.every((capture) => !capture.value.includes(marker)));
  }
  await runCl02ArtifactScan({
    roots: [
      root,
      dirname(fake.executablePath),
      dirname(approval.fake.executablePath),
      dirname(diagnosticFake.executablePath),
    ],
    captures,
    markers: [...markers, ...controls],
  });

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const buildCapture = await runCl02Command(
    process.execPath,
    [join("scripts", "build-connector.mjs"), "claude"],
    { env: environment },
  );
  captures.push({ name: "build_stdout", value: buildCapture.stdout.toString("utf8") });
  captures.push({ name: "build_stderr", value: buildCapture.stderr.toString("utf8") });
  const stageCapture = await runCl02Command(
    process.execPath,
    [join("scripts", "stage-connector.mjs"), "claude"],
    { env: environment },
  );
  captures.push({ name: "stage_stdout", value: stageCapture.stdout.toString("utf8") });
  captures.push({ name: "stage_stderr", value: stageCapture.stderr.toString("utf8") });
  const buildRoot = join(process.cwd(), ".build", "connectors", "claude");
  const stageRoot = join(process.cwd(), ".stage", "connectors", "claude", "package");
  await scanCl02Files(buildRoot, markers, controls);
  await scanCl02Files(stageRoot, markers, controls);

  const tarball = join(root, "claude-connector.tgz");
  const packCapture = await runCl02Command("pnpm", ["pack", "--out", tarball], {
    cwd: stageRoot,
    env: environment,
  });
  captures.push({ name: "pack_stdout", value: packCapture.stdout.toString("utf8") });
  captures.push({ name: "pack_stderr", value: packCapture.stderr.toString("utf8") });
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "cl02-clean-install", private: true })}\n`,
    { mode: 0o600 },
  );
  const installCapture = await runCl02Command(
    "pnpm",
    ["add", "--offline", "--ignore-scripts", "--package-import-method=copy", tarball],
    { cwd: installRoot, env: { ...environment, CI: "true" } },
  );
  captures.push({ name: "install_stdout", value: installCapture.stdout.toString("utf8") });
  captures.push({ name: "install_stderr", value: installCapture.stderr.toString("utf8") });
  await scanCl02Files(installRoot, markers, controls);
  const packedCheckCapture = await runCl02Command(
    process.execPath,
    [join("scripts", "check-packed-connector.mjs"), "claude"],
    {
      env: environment,
    },
  );
  captures.push({
    name: "packed_check_stdout",
    value: packedCheckCapture.stdout.toString("utf8"),
  });
  captures.push({
    name: "packed_check_stderr",
    value: packedCheckCapture.stderr.toString("utf8"),
  });
  for (const capture of captures) {
    for (const marker of [...markers, ...controls]) {
      assert.equal(capture.value.includes(marker), false, `${marker} survived in ${capture.name}`);
    }
  }
});

test("CL02-L21 never opens mutates repairs or deletes provider-owned Claude history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cl02-history-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const history = join(root, "provider-history.jsonl");
  await writeFile(history, "CL02_HISTORY_SECRET\n", { mode: 0o000 });
  const inputIds = ["00000000-0000-4000-8000-000000000611", "00000000-0000-4000-8000-000000000612"];
  let inputIndex = 0;
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L21", {
    inheritedEnvironment: syntheticCl02Environment(root),
    uuidForTest: (kind) =>
      kind === "session" ? CL02_SESSION_ID : (inputIds[inputIndex++] as string),
    turnPlan: turnPlan(CL02_SESSION_ID, inputIds[0] as string, "first", "reply one"),
  });
  assert.equal(
    eventName((await collectEvents(adapter.start(startRequest("first")))).at(-1)),
    "reply",
  );
  await rm(history, { force: true });
  fake.enqueue(turnPlan(CL02_SESSION_ID, inputIds[1] as string, "second", "reply two"));
  assert.equal(
    eventName((await collectEvents(adapter.resume(resumeRequest("second")))).at(-1)),
    "reply",
  );
  assert.deepEqual(
    fake.launches.slice(-2).map((entry) => entry.mode),
    ["turn", "turn"],
  );
});

test("CL02-L22 preserves one resumed session and concurrent conversations through the K04 chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-cl02-chain-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspace, { mode: 0o700 });
  const sessionIds = [
    "00000000-0000-4000-8000-000000000621",
    "00000000-0000-4000-8000-000000000622",
  ];
  const inputIds = [
    "00000000-0000-4000-8000-000000000631",
    "00000000-0000-4000-8000-000000000632",
    "00000000-0000-4000-8000-000000000633",
  ];
  let sessionIndex = 0;
  let inputIndex = 0;
  const { fake, adapter } = await createCl02Adapter(t, "CL02-CL03:L22", {
    workingDirectory: workspace,
    uuidForTest: (kind) =>
      kind === "session"
        ? (sessionIds[sessionIndex++] as string)
        : (inputIds[inputIndex++] as string),
    turnPlan: turnPlan(sessionIds[0] as string, inputIds[0] as string, "first", "one"),
  });
  fake.enqueue(turnPlan(sessionIds[1] as string, inputIds[1] as string, "parallel", "two"));
  fake.enqueue(turnPlan(sessionIds[0] as string, inputIds[2] as string, "followup", "three"));
  const gateway = await startFakeConnectorGateway(t, { token: K02_TOKEN });
  const connector = await startConnectorRuntime({
    providerKind: "claude",
    webhookPort: await unusedLoopbackPort(),
    webhookToken: K02_TOKEN,
    workingDirectory: workspace,
    policy: "read-only",
    gatewayEndpoint: gateway.endpoint,
    stateDirectory,
    provider: adapter as unknown as ProviderPort,
  });
  t.after(async () => await connector.close());
  const first = k02Message("cl02_chain_1", "cl02_conversation_a", "first");
  const parallel = k02Message("cl02_chain_2", "cl02_conversation_b", "parallel");
  gateway.enqueueMessage(first);
  gateway.enqueueMessage(parallel);
  await Promise.all([
    gateway.sendWake(connector.webhookUrl, first.id),
    gateway.sendWake(connector.webhookUrl, parallel.id),
  ]);
  await connector.waitForIdle();
  const followup = k02Message("cl02_chain_3", "cl02_conversation_a", "followup");
  gateway.enqueueMessage(followup);
  await gateway.sendWake(connector.webhookUrl, followup.id);
  await connector.waitForIdle();
  assert.deepEqual(
    [first.id, parallel.id, followup.id].map((id) => gateway.tombstone(id)?.outcome),
    ["replied", "replied", "replied"],
  );
  assert.equal(fake.launches.filter((entry) => entry.mode === "turn").length, 3);
});
