import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpSessionStore } from "../src/acp-session-store.js";
import { capabilityForKind } from "../src/agent-capabilities.js";
import { serializeCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient } from "../src/central-enrollment.js";
import { confirmStopRunning, runCli } from "../src/cli.js";
import { createDeliveryProfile, DeliveryProfileStore } from "../src/delivery-profile.js";
import { DirectDeliveryError } from "../src/direct-delivery.js";
import { LocalMcpServer } from "../src/local-mcp.js";
import { ProcessLock } from "../src/process-lock.js";
import { WebhookDeliveryError } from "../src/webhook-delivery.js";
import { startFakeCentral } from "./support/fake-central.js";
import { McpCallError, TestMcpClient } from "./support/mcp-client.js";

const NOW_SECONDS = 1_788_220_800;
const TEST_LOCAL_CONTROL_SECRET_STORE = {
  async load() {
    return "0123456789abcdef".repeat(4);
  },
  async createOrLoad() {
    return "0123456789abcdef".repeat(4);
  },
};

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function captureTerminal() {
  const output = captureIo();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  return {
    ...output,
    stdin,
    io: { ...output.io, stdin, stderr: { ...output.io.stderr, isTTY: true } },
  };
}

async function waitForOutput(output: () => string, pattern: RegExp): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const match = pattern.exec(output());
    if (match !== null) return match[1] ?? match[0];
    await delay(10);
  }
  assert.fail("Expected CLI output did not arrive");
}

test("process-stop confirmation requires an explicit terminal yes", async () => {
  for (const command of ["start", "clean"] as const) {
    for (const [answer, expected] of [
      ["y", true],
      [" YES ", true],
      ["", false],
      ["no", false],
      ["anything", false],
    ] as const) {
      const output = captureTerminal();
      const result = confirmStopRunning(command, output.io, new AbortController().signal);
      assert.match(output.stderr(), /Ambassador is already running/u);
      assert.match(output.stderr(), /\[y\/N\]/u);
      assert.match(
        output.stderr(),
        command === "clean" ? /clear local Ambassador state/u : /start a new instance/u,
      );
      output.stdin.write(`${answer}\n`);
      assert.equal(await result, expected);
      output.stdin.destroy();
    }
    for (const mode of ["eof", "abort", "noninteractive"] as const) {
      const output = captureTerminal();
      const controller = new AbortController();
      if (mode === "noninteractive") output.stdin.isTTY = false;
      const result = confirmStopRunning(command, output.io, controller.signal);
      if (mode === "eof") output.stdin.end();
      else if (mode === "abort") controller.abort();
      else output.stdin.end("yes\n");
      assert.equal(await result, false);
      if (mode === "noninteractive") assert.equal(output.stderr(), "");
      output.stdin.destroy();
    }
  }
});

for (const command of ["start", "clean"] as const) {
  test(`${command} stops the running instance after confirmation and then proceeds`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ambassador-stop-proceed-"));
    const controllers = [new AbortController(), new AbortController()] as const;
    const runs: Promise<number>[] = [];
    const output = captureTerminal();
    t.after(async () => {
      for (const controller of controllers) controller.abort();
      output.stdin.destroy();
      await Promise.all(runs);
      await rm(root, { recursive: true, force: true });
    });
    const originalOutput = captureIo();
    const overrides = {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localMcpPort: 0,
      localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
    };
    const original = runCli(["start"], {
      io: originalOutput.io,
      env: {},
      cwd: root,
      signal: controllers[0]?.signal,
      testOverrides: overrides,
    });
    runs.push(original);
    const endpoint = await waitForOutput(
      originalOutput.stdout,
      /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u,
    );
    const residuePath = join(root, "test-residue.txt");
    await writeFile(residuePath, "preserve until clean owns the lock");
    const replacement = runCli([command], {
      io: output.io,
      env: {},
      cwd: root,
      signal: controllers[1]?.signal,
      testOverrides: {
        ...overrides,
        localMcpPort: Number(new URL(endpoint).port),
        localControlMcpEndpoint: endpoint,
      },
    });
    runs.push(replacement);
    await waitForOutput(output.stderr, /\[y\/N\]/u);
    assert.equal(await readFile(residuePath, "utf8"), "preserve until clean owns the lock");
    assert.equal((await fetch(endpoint)).status, 400);
    output.stdin.write("yes\n");
    assert.equal(await original, 0);
    assert.equal(controllers[0]?.signal.aborted, false);
    if (command === "clean") {
      assert.equal(await replacement, 0);
      assert.deepEqual(await readdir(root), ["ambassador.lock", "diagnostics"]);
      assert.equal(output.stdout(), "Ambassador local state cleared\n");
    } else {
      await waitForOutput(output.stdout, /MCP endpoint: /u);
      assert.equal(await readFile(residuePath, "utf8"), "preserve until clean owns the lock");
      const client = new TestMcpClient(endpoint);
      await client.initialize();
      assert.ok((await client.listTools()).some(({ name }) => name === "register_agent"));
      controllers[1]?.abort();
      assert.equal(await replacement, 0);
    }
    assert.match(output.stderr(), /Stopping Ambassador/u);
    assert.equal(output.stderr().includes(await TEST_LOCAL_CONTROL_SECRET_STORE.load()), false);
  });
}

test("declining clean leaves the original process and local state intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-decline-stop-"));
  const controller = new AbortController();
  const output = captureTerminal();
  const originalOutput = captureIo();
  const overrides = {
    centralOrigin: "http://127.0.0.1:1",
    stateRoot: root,
    localMcpPort: 0,
    localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
  };
  const original = runCli(["start"], {
    io: originalOutput.io,
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: overrides,
  });
  t.after(async () => {
    controller.abort();
    output.stdin.destroy();
    await original;
    await rm(root, { recursive: true, force: true });
  });
  const endpoint = await waitForOutput(
    originalOutput.stdout,
    /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u,
  );
  await writeFile(join(root, "keep.txt"), "keep");
  const cleaning = runCli(["clean"], {
    io: output.io,
    env: {},
    cwd: root,
    testOverrides: { ...overrides, localControlMcpEndpoint: endpoint },
  });
  await waitForOutput(output.stderr, /\[y\/N\]/u);
  output.stdin.write("\n");
  assert.equal(await cleaning, 7);
  assert.match(output.stderr(), /Ambassador left running/u);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep");
  assert.equal((await fetch(endpoint)).status, 400);
});

test("clean waits for the lock and leaves state untouched when shutdown does not finish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-stop-timeout-"));
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  const output = captureTerminal();
  let stops = 0;
  const server = new LocalMcpServer(
    { listTools: async () => [], callTool: async () => ({}) },
    {
      port: 0,
      control: {
        secret: await TEST_LOCAL_CONTROL_SECRET_STORE.load(),
        sessions: { list: () => [], show: () => [] },
        stop: () => {
          stops += 1;
        },
      },
    },
  );
  await server.listen();
  t.after(async () => {
    output.stdin.destroy();
    await server.close();
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "keep.txt"), "keep");
  const cleaning = runCli(["clean"], {
    io: output.io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      localControlMcpEndpoint: server.endpoint,
      processStopDeadlineMs: 40,
    },
  });
  await waitForOutput(output.stderr, /\[y\/N\]/u);
  output.stdin.write("y\n");
  assert.equal(await cleaning, 7);
  assert.equal(stops, 1);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep");
  assert.match(output.stderr(), /did not release its lock/u);
});

test("a confirmation for an old instance cannot stop its replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-stop-changed-instance-"));
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  const output = captureTerminal();
  let stops = 0;
  const control = {
    secret: await TEST_LOCAL_CONTROL_SECRET_STORE.load(),
    sessions: { list: () => [], show: () => [] },
    stop: () => {
      stops += 1;
    },
  };
  const router = { listTools: async () => [], callTool: async () => ({}) };
  let server = new LocalMcpServer(router, { port: 0, control });
  await server.listen();
  t.after(async () => {
    output.stdin.destroy();
    await server.close();
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "keep.txt"), "keep");
  const endpoint = server.endpoint;
  const cleaning = runCli(["clean"], {
    io: output.io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      localControlMcpEndpoint: endpoint,
    },
  });
  await waitForOutput(output.stderr, /\[y\/N\]/u);
  await server.close();
  server = new LocalMcpServer(router, { port: Number(new URL(endpoint).port), control });
  await server.listen();
  output.stdin.write("yes\n");
  assert.equal(await cleaning, 7);
  assert.equal(stops, 0);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep");
  assert.match(output.stderr(), /could not be stopped safely/u);
});

test("creates and prints one stable webhook secret without taking the gateway lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-webhook-secret-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [];
  const io = {
    stdout: {
      write(chunk: string | Uint8Array) {
        output.push(String(chunk));
        return true;
      },
    },
    stderr: { write: () => true },
  };
  const context = {
    io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
    },
  };

  assert.equal(await runCli(["webhook-secret"], context), 0);
  assert.equal(await runCli(["webhook-secret"], context), 0);
  assert.equal(output.length, 2);
  assert.match(output[0] ?? "", /^[a-f0-9]{48}\n$/u);
  assert.equal(output[1], output[0]);
});

test("starts and serves MCP with no options or environment variables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-zero-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  let stdout = "";
  let stderr = "";
  const running = runCli(["start"], {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localMcpPort: 0,
      localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
    },
  });

  let endpoint: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    endpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(stdout)?.[1];
    if (endpoint !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(endpoint !== undefined);
  assert.match(stdout, /Connect an agent in another terminal:/u);
  assert.match(stdout, /codex mcp add ambassador --url http:\/\/127\.0\.0\.1:\d+\/mcp/u);
  assert.match(
    stdout,
    /claude mcp add --transport http --scope user ambassador http:\/\/127\.0\.0\.1:\d+\/mcp/u,
  );
  assert.match(stdout, /hermes mcp add ambassador --url http:\/\/127\.0\.0\.1:\d+\/mcp/u);
  assert.match(stdout, /openclaw mcp set ambassador/u);
  assert.match(stdout, /Register me with Embassys using my email/u);
  const client = new TestMcpClient(endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    [
      "register_agent",
      "verify_email",
      "resend_verification",
      "list_action_types",
      "get_my_permissions",
      "message_box",
    ],
  );
  await assert.rejects(
    client.callTool("list_action_types", {}),
    (error: unknown) =>
      error instanceof McpCallError &&
      (error.data as { code?: unknown } | undefined)?.code === "not_enrolled",
  );

  controller.abort();
  assert.equal(await running, 0);
  assert.equal(stderr, "");
});

for (const verbose of [false, true])
  test(`starts with persistent redacted diagnostics, verbose=${verbose}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ambassador-verbose-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const central = await startFakeCentral(t);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const output = captureIo();
    const running = runCli(verbose ? ["start", "--verbose"] : ["start"], {
      io: output.io,
      env: {},
      cwd: root,
      signal: controller.signal,
      testOverrides: {
        centralOrigin: central.apiUrl,
        stateRoot: root,
        localMcpPort: 0,
        localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      },
    });

    let endpoint: string | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      endpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(output.stdout())?.[1];
      if (endpoint !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(endpoint !== undefined);
    const client = new TestMcpClient(endpoint);
    await client.initialize({ name: "codex-mcp-client", version: "qualification" });
    await client.callTool("register_agent", { email: "verbose@fixture.test" });
    await assert.rejects(
      client.callTool("register_agent", { email: "verbose+claude@fixture.test" }),
      (error: unknown) =>
        error instanceof McpCallError &&
        error.serverMessage.includes("does not accept '+' email aliases") &&
        (error.data as { code?: unknown; source?: unknown } | undefined)?.code ===
          "unsupported_email_format" &&
        (error.data as { code?: unknown; source?: unknown } | undefined)?.source ===
          "central_enrollment",
    );
    if (verbose) {
      assert.match(output.stderr(), /Verbose mode can print personal message, tool, and API data/u);
      assert.match(output.stderr(), /mcp\.tool\.request/u);
      assert.match(output.stderr(), /central\.request/u);
      assert.match(output.stderr(), /central\.response/u);
      assert.match(output.stderr(), /mcp\.tool\.error/u);
      assert.match(output.stderr(), /"source":"central_enrollment"/u);
      assert.match(output.stderr(), /"error_code":"unsupported_email_format"/u);
      assert.match(output.stderr(), /"status":422/u);
      assert.doesNotMatch(output.stderr(), /Bearer\s+(?!\[redacted\])/u);
    } else assert.equal(output.stderr(), "");
    assert.match(output.stdout(), /Development diagnostic logs:/u);
    controller.abort();
    assert.equal(await running, 0);
    const logs = await readFile(join(root, "diagnostics", "events.jsonl"), "utf8");
    assert.match(logs, /central\.request/u);
    assert.match(logs, /verbose@fixture.test/u);
    assert.match(logs, /gateway\.stopped/u);
  });

test("lists, shows, deletes, and forgets persisted ACP sessions while stopped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-sessions-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionPath = join(root, "acp-sessions.sqlite");
  const seed = new AcpSessionStore(sessionPath);
  for (const [sessionId, status, offset] of [
    ["session-show", "retired", 1],
    ["session-delete", "retired", 2],
    ["session-forget", "active", 3],
  ] as const) {
    seed.create({
      session_id: sessionId,
      agent_kind: "codex",
      working_directory: root,
      status: "active",
      created_at_ms: offset,
      last_used_at_ms: offset,
    });
    if (status === "retired") seed.retire(sessionId, offset + 10);
  }
  seed.close();
  const shown: Array<{ id: string; verbose: boolean }> = [];
  const deleted: string[] = [];
  const output = captureIo();
  const context = {
    io: output.io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      acpSessionControllerFactory: () => ({
        async show(record: { session_id: string }, verbose: boolean) {
          shown.push({ id: record.session_id, verbose });
          return verbose ? [JSON.stringify({ sessionUpdate: "tool_call" })] : ["agent: answer"];
        },
        async delete(record: { session_id: string }) {
          deleted.push(record.session_id);
          return "deleted" as const;
        },
      }),
    },
  };

  assert.equal(await runCli(["sessions", "list"], context), 0);
  assert.match(output.stdout(), /"session_id":"session-show"/u);
  assert.equal(await runCli(["sessions", "show", "session-show"], context), 0);
  assert.equal(await runCli(["sessions", "show", "session-show", "--verbose"], context), 0);
  assert.deepEqual(shown, [
    { id: "session-show", verbose: false },
    { id: "session-show", verbose: true },
  ]);
  assert.match(output.stdout(), /agent: answer/u);
  assert.match(output.stdout(), /sessionUpdate/u);
  assert.equal(await runCli(["sessions", "delete", "session-delete"], context), 0);
  assert.deepEqual(deleted, ["session-delete"]);
  assert.equal(await runCli(["sessions", "forget", "session-forget"], context), 0);

  const remaining = new AcpSessionStore(sessionPath);
  assert.equal(remaining.get("session-delete"), undefined);
  assert.equal(remaining.get("session-forget"), undefined);
  assert.ok(remaining.get("session-show") !== undefined);
  remaining.close();
  assert.equal(output.stderr(), "");
});

test("lists and shows sessions through the running Ambassador process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-sessions-live-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new AcpSessionStore(join(root, "acp-sessions.sqlite"));
  seed.create({
    session_id: "session-live-show",
    agent_kind: "codex",
    working_directory: root,
    status: "active",
    created_at_ms: 1,
    last_used_at_ms: 1,
  });
  seed.retire("session-live-show", 2);
  seed.close();

  const secret = "0123456789abcdef".repeat(4);
  const localControlSecretStore = {
    async load() {
      return secret;
    },
    async createOrLoad() {
      return secret;
    },
  };
  const shown: Array<{ id: string; verbose: boolean }> = [];
  const controller = new AbortController();
  const startOutput = captureIo();
  const running = runCli(["start"], {
    io: startOutput.io,
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localMcpPort: 0,
      localControlSecretStore,
      acpSessionControllerFactory: () => ({
        async show(record: { session_id: string }, verbose: boolean) {
          shown.push({ id: record.session_id, verbose });
          return verbose ? [JSON.stringify({ sessionUpdate: "tool_call" })] : ["agent: answer"];
        },
        async delete() {
          return "deleted" as const;
        },
      }),
    },
  });

  let endpoint: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    endpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(startOutput.stdout())?.[1];
    if (endpoint !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(endpoint !== undefined);
  assert.equal(startOutput.stdout().includes(secret), false);

  const commandOutput = captureIo();
  const commandContext = {
    io: commandOutput.io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localControlMcpEndpoint: endpoint,
      localControlSecretStore,
    },
  };
  assert.equal(await runCli(["sessions", "list"], commandContext), 0);
  assert.match(commandOutput.stdout(), /"session_id":"session-live-show"/u);
  assert.equal(await runCli(["sessions", "show", "session-live-show"], commandContext), 0);
  assert.equal(
    await runCli(["sessions", "show", "session-live-show", "--verbose"], commandContext),
    0,
  );
  assert.deepEqual(shown, [
    { id: "session-live-show", verbose: false },
    { id: "session-live-show", verbose: true },
  ]);
  assert.match(commandOutput.stdout(), /agent: answer/u);
  assert.match(commandOutput.stdout(), /sessionUpdate/u);
  assert.equal(await runCli(["sessions", "delete", "session-live-show"], commandContext), 7);
  assert.equal(commandOutput.stderr(), "Ambassador is already running\n");

  controller.abort();
  assert.equal(await running, 0);
});

test("session commands refuse to run while Ambassador owns the process lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-sessions-running-"));
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  t.after(async () => {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });
  const output = captureIo();
  assert.equal(
    await runCli(["sessions", "list"], {
      io: output.io,
      env: {},
      cwd: root,
      testOverrides: { centralOrigin: "http://127.0.0.1:1", stateRoot: root },
    }),
    7,
  );
  assert.equal(output.stderr(), "Ambassador is already running\n");
});

test("explains when the local MCP port is already in use", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-port-in-use-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address !== null && typeof address === "object");
  const output = captureIo();

  assert.equal(
    await runCli(["start"], {
      io: output.io,
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
        localMcpPort: address.port,
        localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      },
    }),
    7,
  );
  assert.match(output.stdout(), /Development diagnostic logs:/u);
  assert.equal(
    output.stderr(),
    `Ambassador could not bind its local MCP endpoint because 127.0.0.1:${address.port} is already in use\n`,
  );
});

test("explains invalid local state and gives the supported reset command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-invalid-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "central-credential.json"), "not an encrypted credential");
  const output = captureIo();

  assert.equal(
    await runCli(["start"], {
      io: output.io,
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
        localMcpPort: 0,
        localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      },
    }),
    7,
  );
  assert.match(output.stdout(), /Development diagnostic logs:/u);
  assert.equal(
    output.stderr(),
    "Ambassador could not open its local state. Check that its state directory is writable; if the state is partial, stop Ambassador and run `npx --yes @embassys/ambassador@latest clean`\n",
  );
});

test("keeps MCP running and explains an unavailable direct agent without leaking the child error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-direct-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  const email = "direct-unavailable@fixture.test";
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const codex = capabilityForKind("codex");
  assert.ok(codex !== undefined);
  const profile = await createDeliveryProfile(codex, { mode: "direct" }, root);
  await new DeliveryProfileStore(join(root, "delivery-profile.json")).save(profile);
  const serializedCredential = serializeCentralCredential(verified.credential);

  central.queueMessage(email, { type: "fixture_delivery" });
  const output = captureIo();
  let deliveryAttempts = 0;
  const controller = new AbortController();
  let settled = false;
  const running = runCli(["start"], {
    io: output.io,
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: central.apiUrl,
      stateRoot: root,
      credentialStore: {
        async load() {
          return serializedCredential;
        },
        async save() {
          throw new Error("fixture credential is already enrolled");
        },
      },
      localMcpPort: 0,
      localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      nowSeconds: () => NOW_SECONDS,
      deliveryTargetFactory: () => ({
        async deliver() {
          deliveryAttempts += 1;
          throw new DirectDeliveryError("agent_unavailable");
        },
        async close() {},
      }),
    },
  }).finally(() => {
    settled = true;
  });
  for (let attempt = 0; attempt < 100 && deliveryAttempts === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(deliveryAttempts, 1);
  assert.equal(settled, false);
  assert.match(
    output.stderr(),
    /Ambassador paused incoming delivery because Codex is unavailable\. Confirm Codex is installed and signed in, then restart Ambassador to resume delivery\n/u,
  );
  assert.doesNotMatch(output.stderr(), /ENOENT|spawn|node:events/iu);
  controller.abort();
  assert.equal(await running, 0);
});

test("keeps MCP running and explains a failed webhook without leaking transport details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-webhook-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  const email = "webhook-unavailable@fixture.test";
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const codex = capabilityForKind("codex");
  assert.ok(codex !== undefined);
  const profile = await createDeliveryProfile(codex, { mode: "direct" }, root);
  await new DeliveryProfileStore(join(root, "delivery-profile.json")).save(profile);
  const serializedCredential = serializeCentralCredential(verified.credential);

  central.queueMessage(email, { type: "fixture_delivery" });
  const output = captureIo();
  let deliveryAttempts = 0;
  const controller = new AbortController();
  let settled = false;
  const running = runCli(["start"], {
    io: output.io,
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: central.apiUrl,
      stateRoot: root,
      credentialStore: {
        async load() {
          return serializedCredential;
        },
        async save() {
          throw new Error("fixture credential is already enrolled");
        },
      },
      localMcpPort: 0,
      localControlSecretStore: TEST_LOCAL_CONTROL_SECRET_STORE,
      nowSeconds: () => NOW_SECONDS,
      deliveryTargetFactory: () => ({
        async deliver() {
          deliveryAttempts += 1;
          throw new WebhookDeliveryError("delivery_failed");
        },
        async close() {},
      }),
    },
  }).finally(() => {
    settled = true;
  });
  for (let attempt = 0; attempt < 100 && deliveryAttempts === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(deliveryAttempts, 1);
  assert.equal(settled, false);
  assert.equal(
    output.stderr(),
    "Ambassador paused incoming delivery because the configured webhook could not accept a message. Check the webhook and restart Ambassador to resume delivery\n",
  );
  assert.doesNotMatch(output.stderr(), /ECONNREFUSED|fetch|socket/iu);
  controller.abort();
  assert.equal(await running, 0);
});

test("cleans all local registration and delivery residue and leaves provider files alone", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ambassador-clean-cli-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "state", "ambassador");
  await mkdir(join(root, "stale-directory"), { recursive: true });
  for (const name of [
    "central-credential.json",
    "central-credential.key",
    "webhook-secret.json",
    "webhook-secret.key",
    "local-control-secret.json",
    "local-control-secret.key",
    "delivery-profile.json",
    "notifications.sqlite",
    "pending-actions.sqlite",
    "pending-actions.sqlite-wal",
    "pending-actions.sqlite-shm",
    "action-results.sqlite",
    "action-results.sqlite-wal",
    "action-results.sqlite-shm",
    "outbound-actions.sqlite",
    "outbound-actions.sqlite-wal",
    "outbound-actions.sqlite-shm",
    "acp-sessions.sqlite",
    "acp-sessions.sqlite-wal",
    "acp-sessions.sqlite-shm",
    "interrupted-write.tmp",
  ]) {
    await writeFile(join(root, name), `residue:${name}`);
  }
  await writeFile(join(root, "stale-directory", "artifact"), "nested residue");
  const providerFile = join(parent, "provider-config.json");
  await writeFile(providerFile, "provider state");
  if (process.platform !== "win32") {
    await symlink(providerFile, join(root, "provider-link"));
  }

  const output = captureIo();
  const context = {
    io: output.io,
    env: {},
    cwd: parent,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
    },
  };
  assert.equal(await runCli(["clean"], context), 0);
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);
  assert.equal(await readFile(providerFile, "utf8"), "provider state");
  assert.equal(output.stdout(), "Ambassador local state cleared\n");
  assert.equal(output.stderr(), "");

  assert.equal(await runCli(["clean"], context), 0);
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);
  assert.equal(output.stdout(), "Ambassador local state cleared\nAmbassador local state cleared\n");
});

test("clean refuses to touch state while Ambassador owns the process lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-clean-running-"));
  const residuePath = join(root, "delivery-profile.json");
  await writeFile(residuePath, "keep while running");
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  t.after(async () => {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });
  const output = captureIo();

  assert.equal(
    await runCli(["clean"], {
      io: output.io,
      env: {},
      cwd: root,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
      },
    }),
    7,
  );
  await access(residuePath);
  assert.equal(await readFile(residuePath, "utf8"), "keep while running");
  assert.equal(output.stdout(), "");
  assert.equal(output.stderr(), "Ambassador is already running\n");
});

test("clean rejects a linked state directory without touching its target", {
  skip: process.platform === "win32",
}, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ambassador-clean-linked-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, "provider-state");
  const root = join(parent, "ambassador-state");
  const targetFile = join(target, "provider-config.json");
  await mkdir(target);
  await writeFile(targetFile, "provider state");
  await symlink(target, root);
  const output = captureIo();

  assert.equal(
    await runCli(["clean"], {
      io: output.io,
      env: {},
      cwd: parent,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
      },
    }),
    7,
  );
  assert.equal(await readFile(targetFile, "utf8"), "provider state");
  assert.equal(output.stdout(), "");
  assert.equal(output.stderr(), "The Ambassador lock artifact is invalid\n");
});
