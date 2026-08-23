import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runCli } from "../src/cli.js";
import type { AgentConfig, SidecarConfig } from "../src/config.js";

interface Invocation {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface InvokeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

function memoryWriter(): {
  writer: Pick<NodeJS.WriteStream, "write">;
  read: () => string;
} {
  let output = "";

  return {
    writer: {
      write(chunk: string | Uint8Array): boolean {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    },
    read: () => output,
  };
}

async function invoke(args: string[], options: InvokeOptions): Promise<Invocation> {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = await runCli(args, {
    cwd: options.cwd,
    env: options.env ?? {},
    io: { stdout: stdout.writer, stderr: stderr.writer },
  });

  return { exitCode, stdout: stdout.read(), stderr: stderr.read() };
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a2a-cli-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function configWithAgents(agents: AgentConfig[] = []): SidecarConfig {
  return {
    version: 1,
    controller: {
      base_url: "https://controller.example",
      token: { source: "env", name: "A2A_CONTROLLER_TOKEN" },
      poll_wait_seconds: 30,
      max_notifications: 50,
      queue_capacity: 1000,
    },
    agents,
  };
}

async function writeConfig(path: string, config: SidecarConfig): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function genericAgent(baseUrl = "http://127.0.0.1:8644"): AgentConfig {
  return {
    binding_id: "binding_local",
    adapter: {
      type: "generic",
      url: `${baseUrl}/wake`,
      health_url: `${baseUrl}/health`,
      secret: { source: "env", name: "A2A_RUNTIME_SECRET" },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function parseJsonObject(output: string): Record<string, unknown> {
  assert.notEqual(output.trim(), "", "expected JSON output");
  const parsed: unknown = JSON.parse(output);
  return record(parsed);
}

function assertJsonSuccess(result: Invocation): Record<string, unknown> {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");

  const envelope = parseJsonObject(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ["data", "ok"]);
  assert.equal(envelope.ok, true);
  return record(envelope.data);
}

function assertJsonError(result: Invocation, exitCode: number): Record<string, unknown> {
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.stderr, "");

  const envelope = parseJsonObject(result.stdout);
  assert.deepEqual(Object.keys(envelope).sort(), ["error", "ok"]);
  assert.equal(envelope.ok, false);

  const error = record(envelope.error);
  assert.equal(typeof error.code, "string");
  assert.notEqual(error.code, "");
  assert.equal(typeof error.message, "string");
  assert.notEqual(error.message, "");
  return error;
}

async function listen(
  t: TestContext,
  response: { status: number; body?: string },
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, serverResponse) => {
    requests.push(request.url ?? "");
    serverResponse.statusCode = response.status;
    serverResponse.setHeader("content-type", "text/plain");
    serverResponse.end(response.body ?? "");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

test("setup writes strict configuration from unattended flags", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "explicit", "config.json");
  const envConfigPath = join(directory, "environment-config.json");
  const controllerSecret = "controller-secret-must-not-be-persisted";

  const result = await invoke(
    [
      "setup",
      "--controller-url",
      "https://controller.example",
      "--controller-token-env",
      "A2A_CONTROLLER_TOKEN",
      "--poll-wait-seconds",
      "15",
      "--max-notifications",
      "25",
      "--queue-capacity",
      "80",
      "--config",
      configPath,
      "--json",
    ],
    {
      cwd: directory,
      env: {
        A2A_CONFIG_PATH: envConfigPath,
        A2A_CONTROLLER_TOKEN: controllerSecret,
      },
    },
  );

  assertJsonSuccess(result);
  const serialized = await readFile(configPath, "utf8");
  const parsed: unknown = JSON.parse(serialized);
  assert.deepEqual(parsed, {
    version: 1,
    controller: {
      base_url: "https://controller.example",
      token: { source: "env", name: "A2A_CONTROLLER_TOKEN" },
      poll_wait_seconds: 15,
      max_notifications: 25,
      queue_capacity: 80,
    },
    agents: [],
  });
  assert.ok(!serialized.includes(controllerSecret));
  await assert.rejects(access(envConfigPath), { code: "ENOENT" });
});

test("agent add stores a generic adapter with an environment secret reference", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "config.json");
  await writeConfig(configPath, configWithAgents());

  const result = await invoke(
    [
      "agent",
      "add",
      "binding_local",
      "--adapter",
      "generic",
      "--url",
      "http://127.0.0.1:8644/wake",
      "--health-url",
      "http://127.0.0.1:8644/health",
      "--secret-env",
      "A2A_RUNTIME_SECRET",
      "--config",
      configPath,
      "--json",
    ],
    { cwd: directory },
  );

  assertJsonSuccess(result);
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(parsed, configWithAgents([genericAgent()]));
});

test("agent list has human output and a JSON data envelope", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "config.json");
  const agent = genericAgent();
  await writeConfig(configPath, configWithAgents([agent]));

  const human = await invoke(["agent", "list", "--config", configPath], { cwd: directory });
  assert.equal(human.exitCode, 0);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /binding_local/);
  assert.ok(!human.stdout.trimStart().startsWith("{"));

  const json = await invoke(["agent", "list", "--config", configPath, "--json"], {
    cwd: directory,
  });
  assert.deepEqual(assertJsonSuccess(json), { agents: [agent] });
});

test("agent remove deletes only the selected binding", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "config.json");
  const retained: AgentConfig = {
    ...genericAgent(),
    binding_id: "binding_retained",
  };
  await writeConfig(configPath, configWithAgents([genericAgent(), retained]));

  const result = await invoke(
    ["agent", "remove", "binding_local", "--config", configPath, "--json"],
    { cwd: directory },
  );

  assertJsonSuccess(result);
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(parsed, configWithAgents([retained]));
});

test("agent test probes the configured health endpoint", async (t) => {
  const directory = await temporaryDirectory(t);
  const runtime = await listen(t, { status: 204 });
  const configPath = join(directory, "config.json");
  await writeConfig(configPath, configWithAgents([genericAgent(runtime.baseUrl)]));

  const result = await invoke(
    ["agent", "test", "binding_local", "--config", configPath, "--json"],
    {
      cwd: directory,
      env: { A2A_RUNTIME_SECRET: "runtime-secret" },
    },
  );

  const data = assertJsonSuccess(result);
  assert.equal(data.binding_id, "binding_local");
  assert.equal(data.healthy, true);
  assert.deepEqual(runtime.requests, ["/health"]);
});

test("A2A_CONFIG_PATH overrides the platform default", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "config-from-env.json");
  const agent = genericAgent();
  await writeConfig(configPath, configWithAgents([agent]));

  const result = await invoke(["agent", "list", "--json"], {
    cwd: directory,
    env: { A2A_CONFIG_PATH: configPath },
  });

  assert.deepEqual(assertJsonSuccess(result), { agents: [agent] });
});

test("version supports human and JSON output", async (t) => {
  const directory = await temporaryDirectory(t);
  const packageJson: unknown = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  );
  const version = record(packageJson).version;
  assert.ok(typeof version === "string");

  const human = await invoke(["version"], { cwd: directory });
  assert.equal(human.exitCode, 0);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, new RegExp(`\\b${version.replaceAll(".", "\\.")}\\b`));
  assert.ok(!human.stdout.trimStart().startsWith("{"));

  const json = await invoke(["version", "--json"], { cwd: directory });
  assert.deepEqual(assertJsonSuccess(json), { version });
});

test("an unknown command exits 2 with a JSON error envelope", async (t) => {
  const directory = await temporaryDirectory(t);
  const result = await invoke(["unknown-command", "--json"], { cwd: directory });

  assertJsonError(result, 2);
});

test("invalid configuration exits 3 with the stable config error", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "invalid.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ ...configWithAgents(), unexpected: true })}\n`,
    "utf8",
  );

  const result = await invoke(["agent", "list", "--config", configPath, "--json"], {
    cwd: directory,
  });

  assert.deepEqual(assertJsonError(result, 3), {
    code: "config_invalid",
    message: "Configuration is invalid",
  });
});

test("setup rejects a literal controller token without echoing it", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "config.json");
  const literal = "literal-controller-token";

  const result = await invoke(
    [
      "setup",
      "--controller-url",
      "https://controller.example",
      "--controller-token",
      literal,
      "--config",
      configPath,
      "--json",
    ],
    { cwd: directory },
  );

  assertJsonError(result, 2);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(literal));
  await assert.rejects(access(configPath), { code: "ENOENT" });
});

test("agent add rejects a literal runtime secret without changing configuration", async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, "config.json");
  const original = configWithAgents();
  const literal = "literal-runtime-secret";
  await writeConfig(configPath, original);

  const result = await invoke(
    [
      "agent",
      "add",
      "binding_local",
      "--adapter",
      "generic",
      "--url",
      "http://127.0.0.1:8644/wake",
      "--secret",
      literal,
      "--config",
      configPath,
      "--json",
    ],
    { cwd: directory },
  );

  assertJsonError(result, 2);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(literal));
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(parsed, original);
});

test("runtime failures do not leak environment secrets or remote response bodies", async (t) => {
  const directory = await temporaryDirectory(t);
  const controllerSecret = "controller-env-secret";
  const runtimeSecret = "runtime-env-secret";
  const remoteBody = `upstream diagnostic ${controllerSecret} ${runtimeSecret}`;
  const runtime = await listen(t, { status: 503, body: remoteBody });
  const configPath = join(directory, "config.json");
  await writeConfig(configPath, configWithAgents([genericAgent(runtime.baseUrl)]));
  const env = {
    A2A_CONTROLLER_TOKEN: controllerSecret,
    A2A_RUNTIME_SECRET: runtimeSecret,
  };

  const json = await invoke(["agent", "test", "binding_local", "--config", configPath, "--json"], {
    cwd: directory,
    env,
  });
  assertJsonError(json, 6);

  const human = await invoke(["agent", "test", "binding_local", "--config", configPath], {
    cwd: directory,
    env,
  });
  assert.equal(human.exitCode, 6);
  assert.equal(human.stdout, "");
  assert.notEqual(human.stderr.trim(), "");

  const output = `${json.stdout}${json.stderr}${human.stdout}${human.stderr}`;
  assert.ok(!output.includes(controllerSecret));
  assert.ok(!output.includes(runtimeSecret));
  assert.ok(!output.includes(remoteBody));
  assert.deepEqual(runtime.requests, ["/health", "/health"]);
});
