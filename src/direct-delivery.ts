import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";

import { boundedAcpOutput, OutputLimitExceeded } from "./acp-output.js";
import type { AcpSessionRecord, AcpSessionStore } from "./acp-session-store.js";
import type {
  DirectAgentCapability,
  DirectAgentEnvironment,
  NodePackageEntrypoint,
  WindowsNodePackageEntrypoint,
} from "./agent-capabilities.js";
import type { CentralMessage } from "./central-rest.js";
import { buildDeliveryPrompt } from "./delivery-prompt.js";
import { redactVerboseValue, type VerboseLogger } from "./verbose-log.js";

const DEFAULT_INITIALIZATION_DEADLINE_MS = 15_000;
const DEFAULT_SESSION_DEADLINE_MS = 15_000;
const DEFAULT_PROMPT_DEADLINE_MS = 15 * 60 * 1_000;
const DEFAULT_CANCELLATION_GRACE_MS = 10_000;
const DEFAULT_CLEANUP_DEADLINE_MS = 5_000;
const DEFAULT_OUTER_DEADLINE_MS = 15 * 60 * 1_000 + 30_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_STARTUP_ATTEMPTS = 2;
const MAXIMUM_PATH_ENTRIES = 128;
const MAXIMUM_PACKAGE_MANIFEST_BYTES = 128 * 1024;
const MAXIMUM_ENVIRONMENT_ENTRIES = 512;
const MAXIMUM_ENVIRONMENT_BYTES = 1024 * 1024;
const MAXIMUM_ENVIRONMENT_VALUE_BYTES = 32 * 1024;
const BOUNDED_PACKAGE_VERSION = /^[\x20-\x7e]{1,128}$/u;

type ManagedChild = ChildProcess;
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions & { readonly stdio: readonly ["pipe", "pipe", "ignore"] },
) => ManagedChild;

export type DirectDeliveryErrorCode =
  | "agent_unavailable"
  | "cancelled"
  | "invalid_configuration"
  | "startup_failed"
  | "uncertain_outcome";

export class DirectDeliveryError extends Error {
  constructor(readonly code: DirectDeliveryErrorCode) {
    super("Direct delivery failed");
    this.name = "DirectDeliveryError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

function pathWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function validNodePackageContract(value: NodePackageEntrypoint): boolean {
  return (
    value.packageName.length > 0 &&
    value.packageName.length <= 128 &&
    value.binName.length > 0 &&
    value.binName.length <= 128 &&
    value.entrypoint.length > 0 &&
    value.entrypoint.length <= 128 &&
    !value.packageName.includes("\\") &&
    !value.entrypoint.includes("\\") &&
    value.packageName
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    value.entrypoint
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

async function validatedNodePackageEntrypoint(
  contract: NodePackageEntrypoint,
  manifestPath: string,
): Promise<string> {
  if (!validNodePackageContract(contract) || !isAbsolute(manifestPath)) {
    throw new DirectDeliveryError("agent_unavailable");
  }
  try {
    const canonicalManifestPath = await realpath(manifestPath);
    const packageRoot = dirname(canonicalManifestPath);
    const manifestStats = await lstat(canonicalManifestPath);
    if (
      !manifestStats.isFile() ||
      manifestStats.size < 1 ||
      manifestStats.size > MAXIMUM_PACKAGE_MANIFEST_BYTES
    ) {
      throw new DirectDeliveryError("agent_unavailable");
    }
    const manifest = JSON.parse(await readFile(canonicalManifestPath, "utf8")) as unknown;
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new DirectDeliveryError("agent_unavailable");
    }
    const record = manifest as Record<string, unknown>;
    const bin = record.bin;
    const declaredEntrypoint =
      typeof bin === "string"
        ? bin
        : bin !== null && typeof bin === "object" && !Array.isArray(bin)
          ? (bin as Record<string, unknown>)[contract.binName]
          : undefined;
    if (
      record.name !== contract.packageName ||
      typeof record.version !== "string" ||
      !BOUNDED_PACKAGE_VERSION.test(record.version) ||
      declaredEntrypoint !== contract.entrypoint
    ) {
      throw new DirectDeliveryError("agent_unavailable");
    }
    const entrypoint = await realpath(resolve(packageRoot, contract.entrypoint));
    if (!pathWithin(packageRoot, entrypoint)) {
      throw new DirectDeliveryError("agent_unavailable");
    }
    const entrypointStats = await lstat(entrypoint);
    if (!entrypointStats.isFile() || entrypointStats.size < 1) {
      throw new DirectDeliveryError("agent_unavailable");
    }
    return entrypoint;
  } catch (error) {
    if (error instanceof DirectDeliveryError) throw error;
    throw new DirectDeliveryError("agent_unavailable");
  }
}

const requireFromAmbassador = createRequire(import.meta.url);

export async function resolveBundledNodePackageEntrypoint(
  contract: NodePackageEntrypoint,
  resolveManifest: (packageName: string) => string = (packageName) =>
    requireFromAmbassador.resolve(`${packageName}/package.json`),
): Promise<string> {
  let manifestPath: string;
  try {
    manifestPath = resolveManifest(contract.packageName);
  } catch {
    throw new DirectDeliveryError("agent_unavailable");
  }
  return await validatedNodePackageEntrypoint(contract, manifestPath);
}

export async function resolveWindowsNodePackageEntrypoint(
  contract: WindowsNodePackageEntrypoint,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const pathValue = environment.PATH;
  if (
    !validNodePackageContract(contract) ||
    pathValue === undefined ||
    pathValue.length < 1 ||
    pathValue.length > 32_768 ||
    pathValue.includes("\u0000")
  ) {
    throw new DirectDeliveryError("startup_failed");
  }
  const entries = pathValue.split(delimiter).filter((entry) => entry.length > 0);
  if (entries.length > MAXIMUM_PATH_ENTRIES) throw new DirectDeliveryError("startup_failed");
  const packageSegments = contract.packageName.split("/");

  for (const entry of entries) {
    if (!isAbsolute(entry)) continue;
    const packageRootCandidate =
      basename(entry).toLowerCase() === ".bin"
        ? join(dirname(entry), ...packageSegments)
        : join(entry, "node_modules", ...packageSegments);
    try {
      const shim = await lstat(join(entry, `${contract.binName}.cmd`));
      if (!shim.isFile() && !shim.isSymbolicLink()) continue;
      return await validatedNodePackageEntrypoint(
        contract,
        join(packageRootCandidate, "package.json"),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT" || error instanceof DirectDeliveryError) continue;
    }
  }
  throw new DirectDeliveryError("startup_failed");
}

export interface DirectDeliveryTargetOptions {
  readonly agentKind: string;
  readonly identityScope: string;
  readonly capability: DirectAgentCapability;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionStore: AcpSessionStore;
  readonly approvePermission: AcpPermissionApproval;
  readonly nowMs?: () => number;
  readonly log?: VerboseLogger;
  readonly initializationDeadlineMs?: number;
  readonly sessionDeadlineMs?: number;
  readonly promptDeadlineMs?: number;
  readonly cancellationGraceMs?: number;
  readonly cleanupDeadlineMs?: number;
  readonly outerDeadlineMs?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumStartupAttempts?: number;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnProcess;
}

export interface AcpPermissionRequest {
  readonly agentKind: string;
  readonly message: CentralMessage;
  readonly sessionId: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly name: string;
    readonly kind: string;
  }[];
  readonly toolCall: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: string | null | undefined;
    readonly status?: string | null | undefined;
    readonly rawInput?: unknown | undefined;
  };
}

export type AcpPermissionApproval = (
  request: AcpPermissionRequest,
  signal: AbortSignal,
) => Promise<string>;

class StageExpired extends Error {}

class PausableDeadline {
  readonly #controller = new AbortController();
  readonly #nowMs: () => number;
  #remainingMs: number;
  #startedAtMs = 0;
  #pauseDepth = 0;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  readonly signal: AbortSignal;

  constructor(parent: AbortSignal, durationMs: number, nowMs: () => number = Date.now) {
    this.#remainingMs = durationMs;
    this.#nowMs = nowMs;
    this.signal = AbortSignal.any([parent, this.#controller.signal]);
    this.#start();
  }

  pause(): () => void {
    if (this.#closed || this.signal.aborted) return () => undefined;
    this.#pauseDepth += 1;
    if (this.#pauseDepth === 1) {
      this.#remainingMs = Math.max(0, this.#remainingMs - (this.#nowMs() - this.#startedAtMs));
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    let resumed = false;
    return () => {
      if (resumed || this.#closed) return;
      resumed = true;
      this.#pauseDepth -= 1;
      if (this.#pauseDepth === 0) this.#start();
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #start(): void {
    if (this.#closed || this.#pauseDepth > 0 || this.signal.aborted) return;
    if (this.#remainingMs <= 0) {
      this.#controller.abort();
      return;
    }
    this.#startedAtMs = this.#nowMs();
    this.#timer = setTimeout(() => this.#controller.abort(), this.#remainingMs);
    this.#timer.unref();
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function stageSignal(parent: AbortSignal, milliseconds: number): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(milliseconds)]);
}

async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Callers may have created a request immediately before cancellation. Observe its
    // later connection-close rejection even when there is no remaining wait budget.
    void promise.catch(() => undefined);
    throw new StageExpired();
  }
  let remove = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new StageExpired());
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
  }
}

function childExited(child: ManagedChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChild(child: ManagedChild, milliseconds: number): Promise<boolean> {
  if (childExited(child)) return true;
  return await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(milliseconds).then(() => false),
  ]);
}

function signalChild(child: ManagedChild, signal: NodeJS.Signals, platform: NodeJS.Platform): void {
  if (childExited(child)) return;
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have exited between the state check and the signal.
    }
  }
  child.kill(signal);
}

async function cleanupChild(
  child: ManagedChild,
  milliseconds: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (childExited(child)) return true;
  child.stdin?.end();
  if (platform === "win32" && child.pid !== undefined) {
    const startedAt = Date.now();
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      await Promise.race([
        new Promise<void>((resolve) => {
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        }),
        delay(Math.max(1, Math.floor(milliseconds / 2))),
      ]);
    } catch {
      // Fall through to the direct child termination below.
    }
    if (!childExited(child)) child.kill("SIGKILL");
    return await waitForChild(child, Math.max(1, milliseconds - (Date.now() - startedAt)));
  }
  signalChild(child, "SIGTERM", platform);
  const graceful = Math.max(1, Math.floor(milliseconds / 2));
  if (await waitForChild(child, graceful)) return true;
  signalChild(child, "SIGKILL", platform);
  return await waitForChild(child, Math.max(1, milliseconds - graceful));
}

function safeEnvironment(
  source: NodeJS.ProcessEnv,
  policy: DirectAgentEnvironment,
): Record<string, string> {
  const names = policy === "inherit" ? Object.keys(source) : policy;
  if (names.length > MAXIMUM_ENVIRONMENT_ENTRIES) {
    throw new DirectDeliveryError("invalid_configuration");
  }
  const entries: [string, string][] = [];
  let bytes = 0;
  for (const name of names) {
    const value = source[name];
    if (value === undefined) continue;
    const valueBytes = Buffer.byteLength(value, "utf8");
    bytes += Buffer.byteLength(name, "utf8") + valueBytes + 2;
    if (
      name.length === 0 ||
      name.includes("=") ||
      name.includes("\u0000") ||
      valueBytes > MAXIMUM_ENVIRONMENT_VALUE_BYTES ||
      value.includes("\u0000") ||
      bytes > MAXIMUM_ENVIRONMENT_BYTES
    ) {
      throw new DirectDeliveryError("invalid_configuration");
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

export function buildDirectPrompt(message: CentralMessage): string {
  return buildDeliveryPrompt(message);
}

function actionCallId(message: CentralMessage): string | undefined {
  return message.payload.type === "action_call" && typeof message.payload.call_id === "string"
    ? message.payload.call_id
    : undefined;
}

function supportsPersistentSession(response: acp.InitializeResponse): boolean {
  return (
    response.agentCapabilities?.loadSession === true ||
    response.agentCapabilities?.sessionCapabilities?.resume !== undefined
  );
}

export class DirectDeliveryTarget {
  readonly #agentKind: string;
  readonly #peerScope: string;
  readonly #capability: DirectAgentCapability;
  readonly #workingDirectory: string;
  readonly #environment: Record<string, string>;
  readonly #sessionStore: AcpSessionStore;
  readonly #approvePermission: AcpPermissionApproval;
  readonly #nowMs: () => number;
  readonly #log: VerboseLogger;
  readonly #initializationDeadlineMs: number;
  readonly #sessionDeadlineMs: number;
  readonly #promptDeadlineMs: number;
  readonly #cancellationGraceMs: number;
  readonly #cleanupDeadlineMs: number;
  readonly #outerDeadlineMs: number;
  readonly #maximumOutputBytes: number;
  readonly #maximumStartupAttempts: number;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: SpawnProcess;
  readonly #lifetime = new AbortController();
  readonly #activeChildren = new Set<ManagedChild>();
  #closed = false;

  constructor(options: DirectDeliveryTargetOptions) {
    this.#agentKind = options.agentKind;
    this.#peerScope = createHash("sha256")
      .update(JSON.stringify([options.identityScope, options.agentKind, options.workingDirectory]))
      .digest("base64url");
    this.#capability = options.capability;
    this.#workingDirectory = options.workingDirectory;
    this.#sessionStore = options.sessionStore;
    this.#approvePermission = options.approvePermission;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#log = options.log ?? (() => undefined);
    this.#initializationDeadlineMs =
      options.initializationDeadlineMs ?? DEFAULT_INITIALIZATION_DEADLINE_MS;
    this.#sessionDeadlineMs = options.sessionDeadlineMs ?? DEFAULT_SESSION_DEADLINE_MS;
    this.#promptDeadlineMs = options.promptDeadlineMs ?? DEFAULT_PROMPT_DEADLINE_MS;
    this.#cancellationGraceMs = options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS;
    this.#cleanupDeadlineMs = options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS;
    this.#outerDeadlineMs = options.outerDeadlineMs ?? DEFAULT_OUTER_DEADLINE_MS;
    this.#maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
    this.#maximumStartupAttempts =
      options.maximumStartupAttempts ?? DEFAULT_MAXIMUM_STARTUP_ATTEMPTS;
    this.#platform = options.platform ?? process.platform;
    this.#spawn = options.spawnProcess ?? (spawn as SpawnProcess);

    if (
      this.#capability.command.length === 0 ||
      this.#agentKind.length === 0 ||
      typeof options.identityScope !== "string" ||
      options.identityScope.length === 0 ||
      this.#capability.args.length > 16 ||
      this.#capability.agentInfo.name.length === 0 ||
      typeof this.#approvePermission !== "function" ||
      ![
        this.#initializationDeadlineMs,
        this.#sessionDeadlineMs,
        this.#promptDeadlineMs,
        this.#cancellationGraceMs,
        this.#cleanupDeadlineMs,
        this.#outerDeadlineMs,
        this.#maximumOutputBytes,
        this.#maximumStartupAttempts,
      ].every(positiveInteger)
    ) {
      throw new DirectDeliveryError("invalid_configuration");
    }
    this.#environment = safeEnvironment(options.environment, this.#capability.environment);
  }

  async deliver(
    message: CentralMessage,
    signal: AbortSignal,
  ): Promise<{ readonly status: "completed" }> {
    if (this.#closed) throw new DirectDeliveryError("cancelled");
    const messageId = message.id ?? `local:${randomUUID()}`;
    const state = this.#sessionStore.messageState(messageId);
    if (state !== undefined && state !== "prepared")
      throw new DirectDeliveryError("uncertain_outcome");
    const outerDeadline = new PausableDeadline(
      AbortSignal.any([signal, this.#lifetime.signal]),
      this.#outerDeadlineMs,
    );
    try {
      let lastFailure: DirectDeliveryError | undefined;
      for (let attempt = 1; attempt <= this.#maximumStartupAttempts; attempt += 1) {
        if (outerDeadline.signal.aborted) throw new DirectDeliveryError("cancelled");
        try {
          await this.#attempt(message, messageId, outerDeadline.signal, () =>
            outerDeadline.pause(),
          );
          return { status: "completed" };
        } catch (error) {
          const failure =
            error instanceof DirectDeliveryError
              ? error
              : new DirectDeliveryError("startup_failed");
          if (
            failure.code === "uncertain_outcome" ||
            failure.code === "cancelled" ||
            failure.code === "agent_unavailable"
          ) {
            throw failure;
          }
          lastFailure = failure;
        }
      }
      throw lastFailure ?? new DirectDeliveryError("startup_failed");
    } finally {
      outerDeadline.close();
    }
  }

  async #attempt(
    message: CentralMessage,
    messageId: string,
    outerSignal: AbortSignal,
    pauseOuterDeadline: () => () => void,
  ): Promise<void> {
    let child: ManagedChild;
    try {
      let command = this.#capability.command;
      let args = this.#capability.args;
      if (this.#capability.bundledNodePackage !== undefined) {
        command = process.execPath;
        args = [
          await resolveBundledNodePackageEntrypoint(this.#capability.bundledNodePackage),
          ...args,
        ];
      } else if (this.#platform === "win32" && this.#capability.windowsNodePackage !== undefined) {
        command = process.execPath;
        args = [
          await resolveWindowsNodePackageEntrypoint(
            this.#capability.windowsNodePackage,
            this.#environment,
          ),
          ...args,
        ];
      }
      this.#log("acp.spawn", {
        agent: this.#agentKind,
        command,
        args,
        cwd: this.#workingDirectory,
      });
      child = this.#spawn(command, args, {
        cwd: this.#workingDirectory,
        env: this.#environment,
        shell: false,
        detached: this.#platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"] as const,
      });
    } catch {
      throw new DirectDeliveryError("startup_failed");
    }
    this.#activeChildren.add(child);
    const childFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new DirectDeliveryError(
            errorCode(error) === "ENOENT" ? "agent_unavailable" : "startup_failed",
          ),
        );
      });
    });
    const withChildFailure = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, childFailure]);
    let promptDispatched = false;
    let connection: acp.ClientConnection | undefined;
    let currentSessionId: string | undefined;
    let promptDeadline: PausableDeadline | undefined;
    let observedBytes = 0;
    let replayingHistory = false;
    let attemptFailure: unknown;
    let cleanupSucceeded = false;
    try {
      if (child.stdin === null || child.stdout === null) {
        throw new DirectDeliveryError("startup_failed");
      }
      const input = Writable.toWeb(child.stdin);
      const rawOutput = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const boundedOutput = rawOutput.pipeThrough(
        boundedAcpOutput(this.#maximumOutputBytes, () => !replayingHistory),
      );
      const stream = acp.ndJsonStream(input, boundedOutput);
      const client = acp
        .client({ name: "ambassador" })
        .onRequest(acp.methods.client.session.requestPermission, async (context) => {
          const resumeOuterDeadline = pauseOuterDeadline();
          const resumePromptDeadline = promptDeadline?.pause() ?? (() => undefined);
          const options = context.params.options.map(({ optionId, name, kind }) => ({
            optionId,
            name,
            kind,
          }));
          let approval: string;
          try {
            approval = await this.#approvePermission(
              {
                agentKind: this.#agentKind,
                message,
                sessionId: context.params.sessionId,
                toolCall: context.params.toolCall,
                options,
              },
              outerSignal,
            );
          } finally {
            resumePromptDeadline();
            resumeOuterDeadline();
          }
          const selected = outerSignal.aborted
            ? undefined
            : options.find((option) => option.optionId === approval);
          this.#log("acp.permission", {
            agent: this.#agentKind,
            session_id: context.params.sessionId,
            tool_call: context.params.toolCall,
            offered: context.params.options,
            approval,
            selected: selected?.optionId,
          });
          return selected === undefined
            ? { outcome: { outcome: "cancelled" as const } }
            : { outcome: { outcome: "selected" as const, optionId: selected.optionId } };
        })
        .onNotification(acp.methods.client.session.update, (context) => {
          if (replayingHistory) return;
          observedBytes += Buffer.byteLength(JSON.stringify(context.params), "utf8");
          if (observedBytes > this.#maximumOutputBytes) throw new OutputLimitExceeded();
          const commandCount = availableCommandCount(context.params.update);
          if (commandCount !== undefined) {
            this.#log("acp.commands.available", {
              session_id: context.params.sessionId,
              count: commandCount,
            });
          } else {
            this.#log("acp.update", context.params);
          }
        });
      connection = client.connect(stream);
      const initializeSignal = stageSignal(outerSignal, this.#initializationDeadlineMs);
      const initialized = await raceSignal(
        withChildFailure(
          connection.agent.request(
            acp.methods.agent.initialize,
            {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
              clientInfo: { name: "ambassador", version: "1" },
            },
            { cancellationSignal: initializeSignal },
          ),
        ),
        initializeSignal,
      );
      if (
        initialized.protocolVersion !== acp.PROTOCOL_VERSION ||
        initialized.agentInfo?.name !== this.#capability.agentInfo.name ||
        !supportsPersistentSession(initialized) ||
        (this.#capability.sessionRestore === "load" &&
          initialized.agentCapabilities?.loadSession !== true)
      ) {
        throw new DirectDeliveryError("startup_failed");
      }
      this.#log("acp.initialized", {
        agent: this.#agentKind,
        agent_info: initialized.agentInfo,
        capabilities: initialized.agentCapabilities,
      });

      const mcpServers: acp.McpServer[] = [];
      const sessionSignal = stageSignal(outerSignal, this.#sessionDeadlineMs);
      const existing =
        this.#sessionStore.findActiveByMessage(messageId) ??
        this.#sessionStore.findPeer(this.#peerScope, message.sender_agent_id);
      if (
        existing !== undefined &&
        (existing.agent_kind !== this.#agentKind ||
          existing.working_directory !== this.#workingDirectory)
      ) {
        throw new DirectDeliveryError("invalid_configuration");
      }
      if (existing !== undefined) {
        currentSessionId = existing.session_id;
        replayingHistory = true;
        if (
          this.#capability.sessionRestore !== "load" &&
          initialized.agentCapabilities?.sessionCapabilities?.resume !== undefined
        ) {
          await raceSignal(
            withChildFailure(
              connection.agent.request(
                acp.methods.agent.session.resume,
                {
                  sessionId: currentSessionId,
                  cwd: this.#workingDirectory,
                  mcpServers,
                },
                { cancellationSignal: sessionSignal },
              ),
            ),
            sessionSignal,
          );
        } else {
          await raceSignal(
            withChildFailure(
              connection.agent.request(
                acp.methods.agent.session.load,
                {
                  sessionId: currentSessionId,
                  cwd: this.#workingDirectory,
                  mcpServers,
                },
                { cancellationSignal: sessionSignal },
              ),
            ),
            sessionSignal,
          );
        }
        replayingHistory = false;
        observedBytes = 0;
        this.#sessionStore.touch(currentSessionId, this.#nowMs());
        this.#log("acp.session.resumed", { session_id: currentSessionId });
      } else {
        const created = await raceSignal(
          withChildFailure(
            connection.agent.request(
              acp.methods.agent.session.new,
              { cwd: this.#workingDirectory, mcpServers },
              { cancellationSignal: sessionSignal },
            ),
          ),
          sessionSignal,
        );
        currentSessionId = created.sessionId;
        const now = this.#nowMs();
        const callId = actionCallId(message);
        this.#sessionStore.create(
          {
            session_id: currentSessionId,
            agent_kind: this.#agentKind,
            working_directory: this.#workingDirectory,
            central_message_id: messageId,
            ...(callId === undefined ? {} : { call_id: callId }),
            status: "active",
            created_at_ms: now,
            last_used_at_ms: now,
          },
          { scope: this.#peerScope, agentId: message.sender_agent_id },
        );
        this.#log("acp.session.created", { session_id: currentSessionId });
      }

      this.#sessionStore.trackMessage(currentSessionId, messageId, actionCallId(message));
      promptDeadline = new PausableDeadline(outerSignal, this.#promptDeadlineMs);
      const correlatedCallId = actionCallId(message);
      const alreadyAnswered =
        correlatedCallId !== undefined && this.#sessionStore.actionCompleted(correlatedCallId);
      let result: acp.PromptResponse = { stopReason: "end_turn" };
      if (!alreadyAnswered) {
        this.#sessionStore.markMessage(messageId, "dispatched", this.#nowMs());
        const promptSignal = promptDeadline.signal;
        promptDispatched = true;
        this.#log("acp.prompt", { session_id: currentSessionId, message });
        result = await raceSignal(
          withChildFailure(
            connection.agent.request(
              acp.methods.agent.session.prompt,
              {
                sessionId: currentSessionId,
                prompt: [{ type: "text", text: buildDirectPrompt(message) }],
              },
              { cancellationSignal: promptSignal },
            ),
          ),
          promptSignal,
        );
      } else {
        this.#log("acp.action.already_answered", {
          session_id: currentSessionId,
          call_id: correlatedCallId,
        });
      }
      if (!["end_turn", "max_tokens", "max_turn_requests"].includes(result.stopReason)) {
        throw new DirectDeliveryError("uncertain_outcome");
      }
      const completedAt = this.#nowMs();
      this.#sessionStore.touch(currentSessionId, completedAt);
      this.#sessionStore.markMessage(messageId, "completed", completedAt);
      this.#log("acp.prompt.completed", {
        session_id: currentSessionId,
        stop_reason: result.stopReason,
      });
      promptDeadline.close();
      promptDeadline = undefined;
      if (initialized.agentCapabilities?.sessionCapabilities?.close !== undefined) {
        const closeSignal = stageSignal(outerSignal, this.#sessionDeadlineMs);
        await raceSignal(
          withChildFailure(
            connection.agent.request(
              acp.methods.agent.session.close,
              { sessionId: currentSessionId },
              { cancellationSignal: closeSignal },
            ),
          ),
          closeSignal,
        );
      }
      currentSessionId = undefined;
    } catch (error) {
      if (promptDispatched && this.#sessionStore.messageState(messageId) === "dispatched") {
        this.#sessionStore.markMessage(messageId, "uncertain", this.#nowMs());
      }
      promptDeadline?.close();
      if (promptDispatched && currentSessionId !== undefined && connection !== undefined) {
        await Promise.all([
          raceSignal(
            connection.agent.notify(acp.methods.agent.session.cancel, {
              sessionId: currentSessionId,
            }),
            AbortSignal.timeout(this.#cancellationGraceMs),
          ).catch(() => undefined),
          delay(this.#cancellationGraceMs),
        ]);
      }
      if (promptDispatched || error instanceof OutputLimitExceeded) {
        attemptFailure = new DirectDeliveryError("uncertain_outcome");
      } else if (outerSignal.aborted) {
        attemptFailure = new DirectDeliveryError("cancelled");
      } else {
        attemptFailure =
          error instanceof DirectDeliveryError ? error : new DirectDeliveryError("startup_failed");
      }
    } finally {
      promptDeadline?.close();
      try {
        connection?.close();
      } catch {
        attemptFailure = new DirectDeliveryError("uncertain_outcome");
      } finally {
        cleanupSucceeded = await cleanupChild(child, this.#cleanupDeadlineMs, this.#platform);
        this.#activeChildren.delete(child);
      }
    }
    if (!cleanupSucceeded) throw new DirectDeliveryError("uncertain_outcome");
    if (attemptFailure !== undefined) throw attemptFailure;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort();
    await Promise.all(
      [...this.#activeChildren].map(async (child) => {
        await cleanupChild(child, this.#cleanupDeadlineMs, this.#platform);
        this.#activeChildren.delete(child);
      }),
    );
  }
}

export type AcpSessionDeleteResult = "deleted" | "unsupported";

export interface AcpSessionControllerOptions {
  readonly capability: DirectAgentCapability;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnProcess;
  readonly deadlineMs?: number;
  readonly cleanupDeadlineMs?: number;
  readonly maximumOutputBytes?: number;
  readonly log?: VerboseLogger;
}

function historyText(
  update: acp.SessionUpdate,
): { readonly role: string; readonly text: string } | undefined {
  if (
    (update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk") &&
    update.content.type === "text"
  ) {
    return {
      role: update.sessionUpdate === "user_message_chunk" ? "user" : "agent",
      text: update.content.text,
    };
  }
  return undefined;
}

function availableCommandCount(update: acp.SessionUpdate): number | undefined {
  return "availableCommands" in update ? update.availableCommands.length : undefined;
}

export class AcpSessionController {
  readonly #capability: DirectAgentCapability;
  readonly #environment: Record<string, string>;
  readonly #platform: NodeJS.Platform;
  readonly #spawn: SpawnProcess;
  readonly #deadlineMs: number;
  readonly #cleanupDeadlineMs: number;
  readonly #maximumOutputBytes: number;
  readonly #log: VerboseLogger;

  constructor(options: AcpSessionControllerOptions) {
    this.#capability = options.capability;
    this.#environment = safeEnvironment(options.environment, options.capability.environment);
    this.#platform = options.platform ?? process.platform;
    this.#spawn = options.spawnProcess ?? (spawn as SpawnProcess);
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_INITIALIZATION_DEADLINE_MS;
    this.#cleanupDeadlineMs = options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS;
    this.#maximumOutputBytes = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
    this.#log = options.log ?? (() => undefined);
  }

  async show(
    record: AcpSessionRecord,
    verbose: boolean,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const history: { text: string; bytes: number }[] = [];
    let historyBytes = 0;
    let truncated = false;
    const maximumHistoryBytes = Math.min(512 * 1024, Math.floor(this.#maximumOutputBytes / 2));
    await this.#run(
      record,
      (client) =>
        client.onNotification(acp.methods.client.session.update, (context) => {
          if (
            context.params.sessionId === record.session_id &&
            availableCommandCount(context.params.update) === undefined
          ) {
            const update = context.params.update;
            const content = historyText(update);
            const text = verbose
              ? JSON.stringify(redactVerboseValue(update))
              : content === undefined
                ? undefined
                : `${content.role}: ${String(redactVerboseValue(content.text))}`;
            if (text === undefined) return;
            const bytes = Buffer.byteLength(JSON.stringify(text), "utf8") + 1;
            if (bytes > maximumHistoryBytes) {
              truncated = true;
              return;
            }
            history.push({ text, bytes });
            historyBytes += bytes;
            while (historyBytes > maximumHistoryBytes && history.length > 0) {
              historyBytes -= history.shift()?.bytes ?? 0;
              truncated = true;
            }
          }
        }),
      async (connection, initialized, operationSignal) => {
        if (initialized.agentCapabilities?.loadSession !== true) {
          throw new DirectDeliveryError("startup_failed");
        }
        await connection.agent.request(
          acp.methods.agent.session.load,
          {
            sessionId: record.session_id,
            cwd: record.working_directory,
            mcpServers: [],
          },
          { cancellationSignal: operationSignal },
        );
      },
      signal,
    );
    return [
      ...(truncated ? ["[earlier history omitted; showing a bounded recent preview]"] : []),
      ...history.map((line) => line.text),
    ];
  }

  async delete(record: AcpSessionRecord, signal: AbortSignal): Promise<AcpSessionDeleteResult> {
    let supported = false;
    await this.#run(
      record,
      (client) => client,
      async (connection, initialized, operationSignal) => {
        supported = initialized.agentCapabilities?.sessionCapabilities?.delete !== undefined;
        if (!supported) return;
        await connection.agent.request(
          acp.methods.agent.session.delete,
          { sessionId: record.session_id },
          { cancellationSignal: operationSignal },
        );
      },
      signal,
    );
    return supported ? "deleted" : "unsupported";
  }

  async #run(
    record: AcpSessionRecord,
    configure: (client: ReturnType<typeof acp.client>) => ReturnType<typeof acp.client>,
    operation: (
      connection: acp.ClientConnection,
      initialized: acp.InitializeResponse,
      signal: AbortSignal,
    ) => Promise<void>,
    parentSignal: AbortSignal,
  ): Promise<void> {
    let command = this.#capability.command;
    let args = this.#capability.args;
    if (this.#capability.bundledNodePackage !== undefined) {
      command = process.execPath;
      args = [
        await resolveBundledNodePackageEntrypoint(this.#capability.bundledNodePackage),
        ...args,
      ];
    } else if (this.#platform === "win32" && this.#capability.windowsNodePackage !== undefined) {
      command = process.execPath;
      args = [
        await resolveWindowsNodePackageEntrypoint(
          this.#capability.windowsNodePackage,
          this.#environment,
        ),
        ...args,
      ];
    }
    this.#log("acp.session.command.spawn", {
      command,
      args,
      session_id: record.session_id,
    });
    const child = this.#spawn(command, args, {
      cwd: record.working_directory,
      env: this.#environment,
      shell: false,
      detached: this.#platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"] as const,
    });
    const childFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new DirectDeliveryError(
            errorCode(error) === "ENOENT" ? "agent_unavailable" : "startup_failed",
          ),
        );
      });
      child.once("exit", (code) => {
        if (code !== 0) reject(new DirectDeliveryError("startup_failed"));
      });
    });
    let connection: acp.ClientConnection | undefined;
    try {
      if (child.stdin === null || child.stdout === null) {
        throw new DirectDeliveryError("startup_failed");
      }
      const signal = stageSignal(parentSignal, this.#deadlineMs);
      const output = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
        boundedAcpOutput(this.#maximumOutputBytes),
      );
      const client = configure(acp.client({ name: "ambassador" }));
      connection = client.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), output));
      const initialized = await raceSignal(
        Promise.race([
          connection.agent.request(
            acp.methods.agent.initialize,
            {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
              clientInfo: { name: "ambassador", version: "1" },
            },
            { cancellationSignal: signal },
          ),
          childFailure,
        ]),
        signal,
      );
      if (
        initialized.protocolVersion !== acp.PROTOCOL_VERSION ||
        initialized.agentInfo?.name !== this.#capability.agentInfo.name
      ) {
        throw new DirectDeliveryError("startup_failed");
      }
      const operationSignal = stageSignal(parentSignal, this.#deadlineMs);
      await raceSignal(
        Promise.race([operation(connection, initialized, operationSignal), childFailure]),
        operationSignal,
      );
    } catch (error) {
      throw error instanceof DirectDeliveryError
        ? error
        : new DirectDeliveryError("startup_failed");
    } finally {
      connection?.close();
      await cleanupChild(child, this.#cleanupDeadlineMs, this.#platform);
    }
  }
}
