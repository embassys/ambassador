import type { ChildProcess } from "node:child_process";

import type {
  ConnectorClock,
  ProviderPort,
} from "../../../packages/connector-core/src/runtime-types.js";
import type {
  ProviderCancelRequest,
  ProviderCancelResult,
  ProviderRecoverRequest,
  ProviderResumeRequest,
  ProviderStartRequest,
} from "../connector/index.js";
import type { ClaudeMonitorSpawnOptionsForTest } from "./fake-monitor.js";
import type {
  ClaudeAdapterProcessBarrier,
  ClaudeLifetimeMonitorBarrier,
  ClaudeProcessObservation,
} from "./types.js";
import { CLAUDE_FIXTURE_VERSION } from "./types.js";

export interface ClaudeAdapterForTestOptions {
  readonly workingDirectory: string;
  readonly policy: "read-only" | "workspace-write";
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly webhookTokenEnvironmentName: string;
  readonly connectorPackageVersion: string;
  readonly fixtureExecutablePath: string | null;
  readonly clock?: ConnectorClock;
  readonly afterVersionProbeForTest?: () => void | Promise<void>;
  readonly uuidForTest?: (kind: "session" | "input") => string;
  readonly spawnMonitorForTest?: ClaudeMonitorSpawnForTest;
  readonly processBarrierForTest?: (event: {
    readonly scope: "version" | "turn";
    readonly barrier: ClaudeAdapterProcessBarrier;
  }) => Promise<void>;
  readonly processObserverForTest?: (event: {
    readonly scope: "version" | "turn";
    readonly observation: ClaudeProcessObservation;
  }) => void;
  readonly processGroupProbeForTest?: (pgid: number) => "empty" | "accessible" | "denied";
}

export type ClaudeMonitorSpawnForTest = (
  executable: string,
  arguments_: readonly string[],
  options: ClaudeMonitorSpawnOptionsForTest,
) => ChildProcess;

export interface ClaudeAdapterPort
  extends Omit<ProviderPort, "start" | "resume" | "recover" | "cancel"> {
  start(request: ProviderStartRequest): AsyncIterable<unknown>;
  resume(request: ProviderResumeRequest): AsyncIterable<unknown>;
  recover(request: ProviderRecoverRequest): AsyncIterable<unknown>;
  cancel(request: ProviderCancelRequest): Promise<ProviderCancelResult>;
  close(deadlineUnixMs?: number): Promise<void>;
}

export interface Cl03AdapterModule {
  readonly CLAUDE_CODE_VERSION: typeof CLAUDE_FIXTURE_VERSION;
  createClaudeCodeAdapterForTest(options: ClaudeAdapterForTestOptions): Promise<ClaudeAdapterPort>;
}

export interface Cl03MonitorModule {
  readonly CLAUDE_LIFETIME_MONITOR_PROTOCOL: 1;
  runClaudeLifetimeMonitor(): Promise<never>;
  runClaudeLifetimeMonitorForTest(
    barrier: ClaudeLifetimeMonitorBarrier,
    beforeFaultForTest?: () => Promise<void>,
    faultAfterBarrierForTest?: boolean,
  ): Promise<never>;
}

export interface Cl03ProductionModule extends Cl03AdapterModule {
  readonly monitor: Cl03MonitorModule;
}

export function isExactMissingCl03Entry(error: unknown, moduleUrl: URL): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; url?: unknown };
  if (candidate.code !== "ERR_MODULE_NOT_FOUND") return false;
  if (candidate.url === moduleUrl.href) return true;
  if (typeof candidate.message !== "string") return false;
  return (
    candidate.message.startsWith(`Cannot find module '${moduleUrl.pathname}'`) ||
    candidate.message.startsWith(`Cannot find module '${moduleUrl.href}'`)
  );
}

export function validateCl03AdapterModule(loaded: unknown): Cl03AdapterModule {
  if (loaded === null || typeof loaded !== "object") {
    throw new TypeError("CL03 Claude adapter entry loaded a non-module value");
  }
  const module = loaded as Partial<Cl03AdapterModule>;
  if (
    module.CLAUDE_CODE_VERSION !== CLAUDE_FIXTURE_VERSION ||
    typeof module.createClaudeCodeAdapterForTest !== "function"
  ) {
    throw new TypeError("CL03 Claude adapter entry is missing its reviewed exports");
  }
  return module as Cl03AdapterModule;
}

export function validateCl03MonitorModule(loaded: unknown): Cl03MonitorModule {
  if (loaded === null || typeof loaded !== "object") {
    throw new TypeError("CL03 Claude lifetime monitor loaded a non-module value");
  }
  const module = loaded as Partial<Cl03MonitorModule>;
  if (
    module.CLAUDE_LIFETIME_MONITOR_PROTOCOL !== 1 ||
    typeof module.runClaudeLifetimeMonitor !== "function" ||
    typeof module.runClaudeLifetimeMonitorForTest !== "function"
  ) {
    throw new TypeError("CL03 Claude lifetime monitor is missing its reviewed exports");
  }
  return module as Cl03MonitorModule;
}

export async function loadCl03Production(caseId: string): Promise<Cl03ProductionModule> {
  const adapterUrl = new URL(
    "../../../packages/claude-connector/src/claude-code-adapter.js",
    import.meta.url,
  );
  let loadedAdapter: unknown;
  try {
    loadedAdapter = await import(adapterUrl.href);
  } catch (error) {
    if (!isExactMissingCl03Entry(error, adapterUrl)) throw error;
    throw new Error(`[${caseId}] CL03 Claude Code adapter production boundary is absent`);
  }
  const adapter = validateCl03AdapterModule(loadedAdapter);

  const monitorUrl = new URL(
    "../../../packages/claude-connector/src/claude-lifetime-monitor.js",
    import.meta.url,
  );
  const monitor = validateCl03MonitorModule(await import(monitorUrl.href));
  return { ...adapter, monitor };
}
