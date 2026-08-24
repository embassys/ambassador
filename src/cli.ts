#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import packageJson from "../package.json" with { type: "json" };
import { createWakeAdapter } from "./adapters/factory.js";
import { SidecarApplication } from "./application.js";
import { type AgentConfig, parseConfig, resolveSecret, type SidecarConfig } from "./config.js";
import { SidecarError } from "./errors.js";
import { Journal } from "./journal.js";
import { defaultPaths } from "./paths.js";
import { UserServiceManager } from "./service-manager.js";

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CliContext {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal?: AbortSignal;
  serviceManager?: CliServiceManager;
}

export interface CliServiceManager {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<{ installed: boolean; running: boolean }>;
}

type OptionDefinition = { type: "boolean" | "string" };

interface ParsedCommand {
  values: Record<string, boolean | string | undefined>;
  positionals: string[];
}

interface CommandResult {
  data: Record<string, unknown>;
  human: string;
  json: boolean;
}

const commonOptions = {
  config: { type: "string" },
  json: { type: "boolean" },
} satisfies Record<string, OptionDefinition>;

const invalidArguments = new SidecarError("invalid_arguments", "Invalid command or arguments", 2);
const invalidConfig = new SidecarError("config_invalid", "Configuration is invalid", 3);
const authenticationFailure = new SidecarError("authentication_failed", "Authentication failed", 4);
const runtimeFailure = new SidecarError("runtime_unavailable", "Local runtime is unavailable", 6);
const stateFailure = new SidecarError("local_state_error", "Local state operation failed", 7);
const internalError = new SidecarError("internal_error", "Unexpected internal error", 70);

const bindingIdPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const literalSecretOptions = new Set([
  "--controller-token",
  "--runtime-secret",
  "--secret",
  "--token",
]);

function parseCommand(
  args: string[],
  options: Record<string, OptionDefinition>,
  positionalCount: number,
): ParsedCommand {
  try {
    const parsed = parseArgs({
      args,
      allowPositionals: true,
      options,
      strict: true,
      tokens: true,
    });
    const seenOptions = new Set<string>();

    for (const token of parsed.tokens) {
      if (token.kind !== "option") {
        continue;
      }
      if (seenOptions.has(token.name)) {
        throw invalidArguments;
      }
      seenOptions.add(token.name);
    }

    if (parsed.positionals.length !== positionalCount) {
      throw invalidArguments;
    }

    return {
      values: parsed.values,
      positionals: parsed.positionals,
    };
  } catch {
    throw invalidArguments;
  }
}

function stringOption(values: ParsedCommand["values"], name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArguments;
  }
  return value;
}

function optionalStringOption(values: ParsedCommand["values"], name: string): string | undefined {
  const value = values[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalidArguments;
  }
  return value;
}

function integerOption(
  values: ParsedCommand["values"],
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = values[name];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalidArguments;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalidArguments;
  }
  return parsed;
}

function jsonRequested(values: ParsedCommand["values"]): boolean {
  return values.json === true;
}

function hasLiteralSecretOption(args: string[]): boolean {
  return args.some((argument) => literalSecretOptions.has(argument.split("=", 1)[0] ?? ""));
}

function configPath(values: ParsedCommand["values"], context: CliContext): string {
  const selected = optionalStringOption(values, "config") ?? context.env.A2A_CONFIG_PATH;
  if (selected !== undefined) {
    if (selected.length === 0) {
      throw invalidArguments;
    }
    return resolve(context.cwd, selected);
  }

  const home = context.env.HOME ?? context.env.USERPROFILE ?? homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "a2a-sidecar", "config.json");
  }
  if (process.platform === "win32") {
    const root = context.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(root, "a2a-sidecar", "config.json");
  }

  const root = context.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(root, "a2a-sidecar", "config.json");
}

function homeDirectory(context: CliContext): string {
  return context.env.HOME ?? context.env.USERPROFILE ?? homedir();
}

async function loadConfig(path: string): Promise<SidecarConfig> {
  try {
    const serialized = await readFile(path, "utf8");
    return parseConfig(JSON.parse(serialized) as unknown);
  } catch {
    throw invalidConfig;
  }
}

async function writeConfig(path: string, config: SidecarConfig): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.config.${process.pid}.${randomUUID()}.tmp`);

  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw stateFailure;
  }
}

function validatedConfig(input: unknown, error: SidecarError): SidecarConfig {
  try {
    return parseConfig(input);
  } catch {
    throw error;
  }
}

async function setup(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(
    args,
    {
      ...commonOptions,
      "controller-url": { type: "string" },
      "controller-token-env": { type: "string" },
      "max-notifications": { type: "string" },
      "poll-wait-seconds": { type: "string" },
      "queue-capacity": { type: "string" },
    },
    0,
  );
  const tokenEnvironment = stringOption(parsed.values, "controller-token-env");
  if (!environmentNamePattern.test(tokenEnvironment)) {
    throw invalidArguments;
  }

  const config = validatedConfig(
    {
      version: 1,
      controller: {
        base_url: stringOption(parsed.values, "controller-url"),
        token: { source: "env", name: tokenEnvironment },
        poll_wait_seconds: integerOption(parsed.values, "poll-wait-seconds", 30, 1, 300),
        max_notifications: integerOption(parsed.values, "max-notifications", 50, 1, 1_000),
        queue_capacity: integerOption(parsed.values, "queue-capacity", 1_000, 1, 1_000_000),
      },
      agents: [],
    },
    invalidArguments,
  );
  const path = configPath(parsed.values, context);
  await writeConfig(path, config);

  return {
    data: { config_path: path },
    human: `Configuration written to ${path}\n`,
    json: jsonRequested(parsed.values),
  };
}

async function agentAdd(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(
    args,
    {
      ...commonOptions,
      adapter: { type: "string" },
      "agent-id": { type: "string" },
      "health-url": { type: "string" },
      "secret-env": { type: "string" },
      "token-env": { type: "string" },
      url: { type: "string" },
    },
    1,
  );
  const bindingId = parsed.positionals[0];
  const adapterType = stringOption(parsed.values, "adapter");
  if (bindingId === undefined || !bindingIdPattern.test(bindingId)) {
    throw invalidArguments;
  }

  const path = configPath(parsed.values, context);
  const config = await loadConfig(path);
  if (config.agents.some((agent) => agent.binding_id === bindingId)) {
    throw invalidArguments;
  }

  const healthUrl = optionalStringOption(parsed.values, "health-url");
  const url = stringOption(parsed.values, "url");
  const secretEnvironment = optionalStringOption(parsed.values, "secret-env");
  const tokenEnvironment = optionalStringOption(parsed.values, "token-env");
  const agentId = optionalStringOption(parsed.values, "agent-id");
  let adapter: AgentConfig["adapter"];

  if (adapterType === "generic" || adapterType === "hermes") {
    if (
      secretEnvironment === undefined ||
      !environmentNamePattern.test(secretEnvironment) ||
      tokenEnvironment !== undefined ||
      agentId !== undefined
    ) {
      throw invalidArguments;
    }
    adapter = {
      type: adapterType,
      url,
      secret: { source: "env", name: secretEnvironment },
      ...(healthUrl === undefined ? {} : { health_url: healthUrl }),
    };
  } else if (adapterType === "openclaw") {
    if (
      tokenEnvironment === undefined ||
      !environmentNamePattern.test(tokenEnvironment) ||
      agentId === undefined ||
      secretEnvironment !== undefined
    ) {
      throw invalidArguments;
    }
    adapter = {
      type: "openclaw",
      url,
      agent_id: agentId,
      token: { source: "env", name: tokenEnvironment },
      ...(healthUrl === undefined ? {} : { health_url: healthUrl }),
    };
  } else {
    throw invalidArguments;
  }

  const agent: AgentConfig = {
    binding_id: bindingId,
    adapter,
  };
  const updated = validatedConfig(
    { ...config, agents: [...config.agents, agent] },
    invalidArguments,
  );
  await writeConfig(path, updated);

  return {
    data: { binding_id: bindingId },
    human: `Added agent ${bindingId}\n`,
    json: jsonRequested(parsed.values),
  };
}

async function agentList(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 0);
  const config = await loadConfig(configPath(parsed.values, context));
  const human =
    config.agents.length === 0
      ? "No agents configured.\n"
      : `${config.agents
          .map((agent) => `${agent.binding_id}\t${agent.adapter.type}`)
          .join("\n")}\n`;

  return {
    data: { agents: config.agents },
    human,
    json: jsonRequested(parsed.values),
  };
}

async function agentRemove(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 1);
  const bindingId = parsed.positionals[0];
  if (bindingId === undefined || !bindingIdPattern.test(bindingId)) {
    throw invalidArguments;
  }

  const path = configPath(parsed.values, context);
  const config = await loadConfig(path);
  const agents = config.agents.filter((agent) => agent.binding_id !== bindingId);
  if (agents.length === config.agents.length) {
    throw invalidConfig;
  }

  await writeConfig(path, { ...config, agents });
  return {
    data: { binding_id: bindingId },
    human: `Removed agent ${bindingId}\n`,
    json: jsonRequested(parsed.values),
  };
}

async function agentTest(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 1);
  const bindingId = parsed.positionals[0];
  if (bindingId === undefined || !bindingIdPattern.test(bindingId)) {
    throw invalidArguments;
  }

  const config = await loadConfig(configPath(parsed.values, context));
  const agent = config.agents.find((candidate) => candidate.binding_id === bindingId);
  if (agent === undefined) {
    throw invalidConfig;
  }
  try {
    const adapter = createWakeAdapter(agent, { env: context.env });
    const result = await adapter.health(AbortSignal.timeout(5_000));
    if (!result.healthy) {
      throw runtimeFailure;
    }
  } catch {
    throw runtimeFailure;
  }

  return {
    data: { binding_id: bindingId, healthy: true },
    human: `Agent ${bindingId} is healthy\n`,
    json: jsonRequested(parsed.values),
  };
}

function daemonSignal(context: CliContext): { signal: AbortSignal; cleanup: () => void } {
  if (context.signal !== undefined) return { signal: context.signal, cleanup: () => undefined };

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

async function run(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 0);
  const config = await loadConfig(configPath(parsed.values, context));
  try {
    resolveSecret(config.controller.token, context.env);
  } catch {
    throw authenticationFailure;
  }

  const paths = defaultPaths(process.platform, context.env, homeDirectory(context));
  const { signal, cleanup } = daemonSignal(context);
  let application: SidecarApplication | undefined;
  try {
    application = await SidecarApplication.open({
      config,
      journalPath: paths.journalPath,
      lockPath: paths.lockPath,
      env: context.env,
    });
    await application.run(signal);
  } catch (error) {
    if (error instanceof SidecarError) throw error;
    throw stateFailure;
  } finally {
    await application?.close().catch(() => undefined);
    cleanup();
  }

  return {
    data: { stopped: true },
    human: "Sidecar stopped\n",
    json: jsonRequested(parsed.values),
  };
}

function nativeServiceManager(context: CliContext, path: string): CliServiceManager {
  if (context.serviceManager !== undefined) return context.serviceManager;
  return new UserServiceManager({
    platform: process.platform,
    env: context.env,
    homeDirectory: homeDirectory(context),
    command: {
      executable: process.execPath,
      arguments: [fileURLToPath(import.meta.url), "run", "--config", path],
    },
  });
}

async function lifecycle(
  action: "start" | "stop" | "restart",
  args: string[],
  context: CliContext,
): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 0);
  const path = configPath(parsed.values, context);
  if (action !== "stop") await loadConfig(path);
  const manager = nativeServiceManager(context, path);
  const serviceStatus = await manager.status();

  if (action === "stop") {
    if (serviceStatus.running) await manager.stop();
  } else {
    if (serviceStatus.running) await manager.stop();
    await manager.install();
    await manager.start();
  }

  return {
    data: { action },
    human: `Gateway ${action} completed\n`,
    json: jsonRequested(parsed.values),
  };
}

async function status(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 0);
  const path = configPath(parsed.values, context);
  const config = await loadConfig(path);
  const serviceStatus = await nativeServiceManager(context, path).status();
  return {
    data: { configured_agents: config.agents.length, service: serviceStatus },
    human: `Configured agents: ${config.agents.length}\nService: ${serviceStatus.running ? "running" : serviceStatus.installed ? "stopped" : "not installed"}\n`,
    json: jsonRequested(parsed.values),
  };
}

async function doctor(args: string[], context: CliContext): Promise<CommandResult> {
  const parsed = parseCommand(args, commonOptions, 0);
  const config = await loadConfig(configPath(parsed.values, context));
  try {
    resolveSecret(config.controller.token, context.env);
  } catch {
    throw authenticationFailure;
  }

  const agents: Array<{ binding_id: string; adapter: string; healthy: boolean }> = [];
  for (const agent of config.agents) {
    let healthy = false;
    try {
      const adapter = createWakeAdapter(agent, { env: context.env });
      healthy = (await adapter.health(AbortSignal.timeout(5_000))).healthy;
    } catch {
      throw runtimeFailure;
    }
    agents.push({ binding_id: agent.binding_id, adapter: agent.adapter.type, healthy });
  }
  if (agents.some((agent) => !agent.healthy)) throw runtimeFailure;

  const paths = defaultPaths(process.platform, context.env, homeDirectory(context));
  let clockSkewMs: number | undefined;
  try {
    await access(paths.journalPath);
    const journal = new Journal(paths.journalPath);
    try {
      clockSkewMs = journal.getControllerClockOffsetMs();
    } finally {
      journal.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw stateFailure;
    }
  }
  const clockSkewSafe = clockSkewMs === undefined ? undefined : Math.abs(clockSkewMs) <= 300_000;

  return {
    data: {
      config_valid: true,
      controller_credential: true,
      ...(clockSkewMs === undefined
        ? {}
        : { clock_skew_ms: clockSkewMs, clock_skew_safe: clockSkewSafe }),
      agents,
    },
    human: `Configuration is valid\nController credential is available\n${
      clockSkewMs === undefined
        ? ""
        : `Controller clock skew: ${clockSkewMs} ms (${clockSkewSafe ? "safe" : "unsafe"})\n`
    }${agents.map((agent) => `${agent.binding_id}: healthy`).join("\n")}${agents.length === 0 ? "" : "\n"}`,
    json: jsonRequested(parsed.values),
  };
}

function version(args: string[]): CommandResult {
  const parsed = parseCommand(args, commonOptions, 0);
  return {
    data: { version: packageJson.version },
    human: `a2a-gateway ${packageJson.version}\n`,
    json: jsonRequested(parsed.values),
  };
}

async function dispatch(args: string[], context: CliContext): Promise<CommandResult> {
  const command = args[0];
  if (command === "setup") {
    return setup(args.slice(1), context);
  }
  if (command === "version") {
    return version(args.slice(1));
  }
  if (command === "agent") {
    const action = args[1];
    if (action === "add") {
      return agentAdd(args.slice(2), context);
    }
    if (action === "list") {
      return agentList(args.slice(2), context);
    }
    if (action === "remove") {
      return agentRemove(args.slice(2), context);
    }
    if (action === "test") {
      return agentTest(args.slice(2), context);
    }
    throw invalidArguments;
  }
  if (command === "run") {
    return run(args.slice(1), context);
  }
  if (command === "start" || command === "stop" || command === "restart") {
    return lifecycle(command, args.slice(1), context);
  }
  if (command === "status") {
    return status(args.slice(1), context);
  }
  if (command === "doctor") {
    return doctor(args.slice(1), context);
  }
  throw invalidArguments;
}

function writeSuccess(result: CommandResult, io: CliIo): void {
  if (result.json) {
    io.stdout.write(`${JSON.stringify({ ok: true, data: result.data })}\n`);
  } else {
    io.stdout.write(result.human);
  }
}

function writeError(error: SidecarError, json: boolean, io: CliIo): void {
  if (json) {
    io.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: { code: error.code, message: error.message },
      })}\n`,
    );
  } else {
    io.stderr.write(`${error.message}\n`);
  }
}

export async function runCli(args: string[], context: CliContext): Promise<number> {
  const json = args.includes("--json");

  try {
    if (hasLiteralSecretOption(args)) {
      throw invalidArguments;
    }
    const result = await dispatch(args, context);
    writeSuccess(result, context.io);
    return 0;
  } catch (error) {
    const safeError = error instanceof SidecarError ? error : internalError;
    writeError(safeError, json, context.io);
    return safeError.exitCode;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const exitCode = await runCli(process.argv.slice(2), {
    io: { stdout: process.stdout, stderr: process.stderr },
    env: process.env,
    cwd: process.cwd(),
  });
  process.exitCode = exitCode;
}
