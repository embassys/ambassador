#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AcpSessionStore } from "./acp-session-store.js";
import { capabilityForKind, type DirectAgentCapability } from "./agent-capabilities.js";
import { AmbassadorOptionsError, parseAmbassadorCommand } from "./ambassador-options.js";
import type { CredentialStore } from "./credential-store.js";
import { DiagnosticLog } from "./diagnostic-log.js";
import { AcpSessionController, type AcpSessionDeleteResult } from "./direct-delivery.js";
import { GatewayError } from "./errors.js";
import {
  type DeliveryTargetContext,
  openGatewayApplication,
  type RunningGatewayApplication,
} from "./gateway-application.js";
import { defaultGatewayPaths, pathsForStateDirectory } from "./gateway-paths.js";
import {
  EncryptedFileLocalControlSecretStore,
  LocalControlClient,
  LocalControlClientError,
  type LocalControlSecretStore,
} from "./local-control.js";
import { clearLocalGatewayState } from "./local-state-cleaner.js";
import type { DeliveryTarget } from "./notification-relay.js";
import { ProcessLock } from "./process-lock.js";
import { createVerboseLogger, describeVerboseError, type VerboseLogger } from "./verbose-log.js";
import { EncryptedFileWebhookSecretStore } from "./webhook-secret-store.js";

export interface CliIo {
  readonly stdin?: Readable & { readonly isTTY?: boolean };
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write"> & Partial<Pick<NodeJS.WriteStream, "isTTY">>;
}

export interface CliTestOverrides {
  readonly centralOrigin: string;
  readonly stateRoot: string;
  readonly credentialStore?: CredentialStore;
  readonly centralFetch?: typeof fetch;
  readonly webhookFetch?: typeof fetch;
  readonly deliveryTargetFactory?: (context: DeliveryTargetContext) => DeliveryTarget;
  readonly localMcpPort?: number;
  readonly nowSeconds?: () => number;
  readonly acpSessionControllerFactory?: (
    capability: DirectAgentCapability,
  ) => Pick<AcpSessionController, "show" | "delete">;
  readonly localControlSecretStore?: LocalControlSecretStore;
  readonly localControlMcpEndpoint?: string;
  readonly processStopDeadlineMs?: number;
}

export interface CliContext {
  readonly io: CliIo;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly testOverrides?: CliTestOverrides;
}

interface ProcessSignal {
  readonly signal: AbortSignal;
  close(): void;
}

function processSignal(): ProcessSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    close() {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolveWait) =>
    signal.addEventListener("abort", () => resolveWait(), { once: true }),
  );
}

function interactive(io: CliIo): boolean {
  return io.stdin?.isTTY === true && io.stderr.isTTY === true;
}

export async function confirmStopRunning(
  command: "start" | "clean",
  io: CliIo,
  signal: AbortSignal,
): Promise<boolean> {
  const input = io.stdin;
  if (input === undefined || !interactive(io) || signal.aborted) return false;
  const terminal = createInterface({ input, terminal: false, crlfDelay: Infinity });
  return await new Promise<boolean>((resolveAnswer) => {
    let settled = false;
    const abort = (): void => finish(false);
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      input.off("error", abort);
      terminal.close();
      input.pause();
      io.stderr.write("\n");
      resolveAnswer(answer);
    };
    terminal.once("line", (answer) => finish(/^(y|yes)$/iu.test(answer.trim())));
    terminal.once("close", () => finish(false));
    input.once("error", abort);
    signal.addEventListener("abort", abort, { once: true });
    const next = command === "clean" ? "clear local Ambassador state" : "start a new instance";
    io.stderr.write(`Ambassador is already running. Stop it and ${next}? [y/N] `);
    if (signal.aborted) finish(false);
  });
}

async function acquireCommandLock(
  command: "start" | "clean",
  context: CliContext,
  paths: ReturnType<typeof pathsForStateDirectory>,
  signal: AbortSignal,
): Promise<ProcessLock> {
  try {
    return await ProcessLock.acquire(paths.lockPath);
  } catch (error) {
    if (!(error instanceof GatewayError) || error.code !== "daemon_running") throw error;
    if (!interactive(context.io)) throw error;
  }

  let client: LocalControlClient;
  let instanceId: string;
  try {
    const store =
      context.testOverrides?.localControlSecretStore ??
      new EncryptedFileLocalControlSecretStore(
        paths.localControlSecretPath,
        paths.localControlSecretKeyPath,
      );
    const secret = await store.load();
    if (secret === undefined) throw new Error("Local control unavailable");
    client = new LocalControlClient(
      context.testOverrides?.localControlMcpEndpoint ?? "http://127.0.0.1:8787/mcp",
      secret,
    );
    instanceId = await client.getProcessInstance(signal);
  } catch {
    throw new GatewayError(
      "process_stop_unavailable",
      "Ambassador is running but could not be reached. Stop it in its terminal and try again",
      7,
    );
  }
  if (!(await confirmStopRunning(command, context.io, signal))) {
    throw new GatewayError("daemon_running", "Ambassador left running", 7);
  }
  signal.throwIfAborted();
  context.io.stderr.write("Stopping Ambassador...\n");
  try {
    await client.stopProcess(instanceId, signal);
  } catch {
    throw new GatewayError(
      "process_stop_failed",
      "Ambassador could not be stopped safely. Stop it in its terminal and try again",
      7,
    );
  }

  const deadline = performance.now() + (context.testOverrides?.processStopDeadlineMs ?? 30_000);
  while (true) {
    signal.throwIfAborted();
    try {
      return await ProcessLock.acquire(paths.lockPath);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "daemon_running") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new GatewayError(
          "process_stop_timeout",
          "Ambassador did not release its lock in time. Wait for it to stop and try again",
          7,
        );
      }
      await delay(Math.min(100, remaining), undefined, { signal });
    }
  }
}

export function startupGuide(endpoint: string): string {
  const openClaw = JSON.stringify({ url: endpoint, transport: "streamable-http", enabled: true });
  return [
    `MCP endpoint: ${endpoint}`,
    "",
    "Connect an agent in another terminal:",
    `  Codex:      codex mcp add ambassador --url ${endpoint}`,
    `  Claude Code: claude mcp add --transport http --scope user ambassador ${endpoint}`,
    `  Hermes:     hermes mcp add ambassador --url ${endpoint}`,
    `  OpenClaw:   openclaw mcp set ambassador '${openClaw}'`,
    "",
    "Then restart or reload the agent and say: Register me with Embassys using my email.",
    "Keep this Ambassador process running.",
    "",
  ].join("\n");
}

function verboseWarning(): string {
  return "Verbose mode can print personal message, tool, and API data. Credentials remain redacted.\n";
}

function homeDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.HOME || environment.USERPROFILE || homedir();
}

function writeSessionList(io: CliIo, sessions: ReturnType<AcpSessionStore["list"]>): void {
  if (sessions.length === 0) {
    io.stdout.write("No Ambassador sessions\n");
    return;
  }
  for (const session of sessions) io.stdout.write(`${JSON.stringify(session)}\n`);
}

function writeSessionHistory(io: CliIo, lines: readonly string[]): void {
  if (lines.length === 0) io.stdout.write("No session messages\n");
  else io.stdout.write(`${lines.join("\n")}\n`);
}

async function runLiveSessionRead(
  command: Extract<ReturnType<typeof parseAmbassadorCommand>, { command: "sessions" }>,
  context: CliContext,
  paths: ReturnType<typeof pathsForStateDirectory>,
  runningError: GatewayError,
): Promise<number> {
  if (command.action !== "list" && command.action !== "show") throw runningError;
  const secretStore =
    context.testOverrides?.localControlSecretStore ??
    new EncryptedFileLocalControlSecretStore(
      paths.localControlSecretPath,
      paths.localControlSecretKeyPath,
    );
  const secret = await secretStore.load();
  if (secret === undefined) throw runningError;
  const client = new LocalControlClient(
    context.testOverrides?.localControlMcpEndpoint ?? "http://127.0.0.1:8787/mcp",
    secret,
  );
  try {
    if (command.action === "list") {
      writeSessionList(context.io, [...(await client.listSessions(context.signal))]);
    } else {
      writeSessionHistory(
        context.io,
        await client.showSession(command.sessionId, command.verbose, context.signal),
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof LocalControlClientError) {
      if (error.code === "session_not_found") {
        context.io.stderr.write("Ambassador session not found\n");
        return 4;
      }
      if (error.code === "agent_unsupported") {
        context.io.stderr.write("Ambassador session agent is no longer supported\n");
        return 5;
      }
    }
    context.io.stderr.write("Ambassador session command failed\n");
    return 7;
  }
}

export async function runCli(args: string[], context: CliContext): Promise<number> {
  let command: ReturnType<typeof parseAmbassadorCommand>;
  try {
    command = parseAmbassadorCommand(args);
  } catch (error) {
    context.io.stderr.write(
      `${error instanceof AmbassadorOptionsError ? error.message : "Invalid command or arguments"}\n`,
    );
    return error instanceof AmbassadorOptionsError ? error.exitCode : 2;
  }

  const paths =
    context.testOverrides === undefined
      ? defaultGatewayPaths(process.platform, context.env, homeDirectory(context.env))
      : pathsForStateDirectory(context.testOverrides.stateRoot, join);
  if (command.command === "sessions") {
    let lock: ProcessLock | undefined;
    let store: AcpSessionStore | undefined;
    try {
      try {
        lock = await ProcessLock.acquire(paths.lockPath);
      } catch (error) {
        if (error instanceof GatewayError && error.code === "daemon_running") {
          return await runLiveSessionRead(command, context, paths, error);
        }
        throw error;
      }
      store = new AcpSessionStore(paths.acpSessionPath);
      if (command.action === "list") {
        writeSessionList(context.io, store.list());
        return 0;
      }
      const record = store.get(command.sessionId);
      if (record === undefined) {
        context.io.stderr.write("Ambassador session not found\n");
        return 4;
      }
      if (command.action === "forget") {
        if (!store.forget(record.session_id)) throw new Error("Session disappeared");
        context.io.stdout.write(`Ambassador forgot session ${JSON.stringify(record.session_id)}\n`);
        return 0;
      }
      const capability = capabilityForKind(record.agent_kind)?.direct;
      if (capability === undefined) {
        context.io.stderr.write("Ambassador session agent is no longer supported\n");
        return 5;
      }
      const controller =
        context.testOverrides?.acpSessionControllerFactory?.(capability) ??
        new AcpSessionController({ capability, environment: context.env });
      if (command.action === "show") {
        const lines = await controller.show(record, command.verbose, new AbortController().signal);
        writeSessionHistory(context.io, lines);
        return 0;
      }
      const deleted: AcpSessionDeleteResult = await controller.delete(
        record,
        new AbortController().signal,
      );
      if (deleted === "unsupported") {
        context.io.stderr.write(
          "This agent cannot delete provider sessions; use `ambassador sessions forget` to remove only Ambassador metadata\n",
        );
        return 5;
      }
      if (!store.forget(record.session_id)) throw new Error("Session disappeared");
      context.io.stdout.write(`Ambassador deleted session ${JSON.stringify(record.session_id)}\n`);
      return 0;
    } catch (error) {
      if (error instanceof GatewayError) {
        context.io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      context.io.stderr.write("Ambassador session command failed\n");
      return 7;
    } finally {
      store?.close();
      await lock?.release().catch(() => undefined);
    }
  }
  if (command.command === "webhook-secret") {
    try {
      const store = new EncryptedFileWebhookSecretStore(
        paths.webhookSecretPath,
        paths.webhookSecretKeyPath,
      );
      context.io.stdout.write(`${await store.createOrLoad()}\n`);
      return 0;
    } catch {
      context.io.stderr.write("Ambassador webhook secret failed\n");
      return 7;
    }
  }
  if (command.command === "clean") {
    let lock: ProcessLock | undefined;
    const ownedSignal = context.signal === undefined ? processSignal() : undefined;
    const signal = context.signal ?? ownedSignal?.signal;
    if (signal === undefined) throw new Error("Ambassador signal is unavailable");
    try {
      lock = await acquireCommandLock("clean", context, paths, signal);
      signal.throwIfAborted();
      await clearLocalGatewayState(paths.stateDirectory, paths.lockPath);
      context.io.stdout.write("Ambassador local state cleared\n");
      return 0;
    } catch (error) {
      if (signal.aborted) return 0;
      if (error instanceof GatewayError) {
        context.io.stderr.write(`${error.message}\n`);
        return error.exitCode;
      }
      context.io.stderr.write("Ambassador local state cleanup failed\n");
      return 7;
    } finally {
      await lock?.release().catch(() => undefined);
      ownedSignal?.close();
    }
  }
  if (command.command !== "start") throw new AmbassadorOptionsError();
  let lock: ProcessLock | undefined;
  let application: RunningGatewayApplication | undefined;
  const ownedSignal = context.signal === undefined ? processSignal() : undefined;
  const externalSignal = context.signal ?? ownedSignal?.signal;
  if (externalSignal === undefined) throw new Error("Ambassador signal is unavailable");
  const stopController = new AbortController();
  const signal = AbortSignal.any([externalSignal, stopController.signal]);
  let diagnostics: DiagnosticLog | undefined;
  const consoleLog = command.verbose
    ? createVerboseLogger((value) => context.io.stderr.write(value))
    : undefined;
  const log: VerboseLogger = (event, data) => {
    diagnostics?.log(event, data);
    consoleLog?.(event, data);
  };

  try {
    lock = await acquireCommandLock("start", context, paths, signal);
    signal.throwIfAborted();
    diagnostics = new DiagnosticLog(join(paths.stateDirectory, "diagnostics"), {
      onNotice: (notice) => context.io.stderr.write(`${notice}\n`),
    });
    log("gateway.starting");
    context.io.stdout.write(
      `Development diagnostic logs: ${diagnostics.directory}\nRequest and response bodies are retained with credentials redacted.\n`,
    );
    if (command.verbose) context.io.stderr.write(verboseWarning());
    application = await openGatewayApplication({
      journalPath: paths.journalPath,
      credentialPath: paths.credentialPath,
      credentialKeyPath: paths.credentialKeyPath,
      webhookSecretPath: paths.webhookSecretPath,
      webhookSecretKeyPath: paths.webhookSecretKeyPath,
      localControlSecretPath: paths.localControlSecretPath,
      localControlSecretKeyPath: paths.localControlSecretKeyPath,
      pendingActionPath: paths.pendingActionPath,
      actionResultPath: paths.actionResultPath,
      outboundActionPath: paths.outboundActionPath,
      acpSessionPath: paths.acpSessionPath,
      profilePath: paths.profilePath,
      workingDirectory: context.cwd,
      environment: context.env,
      signal,
      onStopRequested: () => stopController.abort(),
      onRuntimeNotice: (notice) => {
        log("gateway.notice", { message: notice.message });
        context.io.stderr.write(`${notice.message}\n`);
      },
      log,
      ...(context.testOverrides === undefined
        ? {}
        : {
            centralOrigin: context.testOverrides.centralOrigin,
            ...(context.testOverrides.credentialStore === undefined
              ? {}
              : { credentialStore: context.testOverrides.credentialStore }),
            ...(context.testOverrides.centralFetch === undefined
              ? {}
              : { centralFetch: context.testOverrides.centralFetch }),
            ...(context.testOverrides.webhookFetch === undefined
              ? {}
              : { webhookFetch: context.testOverrides.webhookFetch }),
            ...(context.testOverrides.deliveryTargetFactory === undefined
              ? {}
              : { deliveryTargetFactory: context.testOverrides.deliveryTargetFactory }),
            ...(context.testOverrides.localMcpPort === undefined
              ? {}
              : { localMcpPort: context.testOverrides.localMcpPort }),
            ...(context.testOverrides.nowSeconds === undefined
              ? {}
              : { nowSeconds: context.testOverrides.nowSeconds }),
            ...(context.testOverrides.localControlSecretStore === undefined
              ? {}
              : { localControlSecretStore: context.testOverrides.localControlSecretStore }),
            ...(context.testOverrides.acpSessionControllerFactory === undefined
              ? {}
              : {
                  acpSessionControllerFactory: context.testOverrides.acpSessionControllerFactory,
                }),
          }),
    });
    context.io.stdout.write(startupGuide(application.endpoint));
    log("gateway.started", { endpoint: application.endpoint });
    const failure = await Promise.race([
      waitForAbort(signal).then(() => undefined),
      application.failure,
    ]);
    if (failure !== undefined) throw failure;
    return 0;
  } catch (error) {
    log("gateway.error", { error: describeVerboseError(error), interrupted: signal.aborted });
    if (signal.aborted) return 0;
    if (error instanceof AmbassadorOptionsError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof GatewayError) {
      context.io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    context.io.stderr.write(
      "Ambassador could not start. Check that its state directory is writable and that this Node platform is supported\n",
    );
    return 7;
  } finally {
    await application?.close().catch(() => undefined);
    log("gateway.stopped");
    await diagnostics?.close();
    await lock?.release().catch(() => undefined);
    ownedSignal?.close();
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2), {
    io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    env: process.env,
    cwd: process.cwd(),
  });
}
