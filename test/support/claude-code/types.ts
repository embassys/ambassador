export const CLAUDE_FIXTURE_VERSION = "2.1.251";

export type ClaudeAdapterProcessBarrier =
  | "before_monitor_ready"
  | "before_start_write"
  | "during_start_record"
  | "before_claude_spawn"
  | "after_claude_spawn"
  | "before_child_started"
  | "after_child_started"
  | "before_init"
  | "after_session_bound"
  | "during_stdin_write"
  | "after_replay"
  | "during_tools"
  | "after_terminal_candidate"
  | "after_child_exited";

export type ClaudeLifetimeMonitorBarrier =
  | "before_monitor_ready"
  | "during_start_record"
  | "before_claude_spawn"
  | "after_claude_spawn"
  | "before_child_started";

export type ClaudeProcessObservation =
  | "monitor_pid_recorded"
  | "ready"
  | "start_written"
  | "child_started"
  | "child_exited"
  | "contain_written"
  | "sigterm_sent"
  | "sigkill_sent"
  | "monitor_reaped"
  | "group_empty_proved";

export type FakeClaudeWireWrite =
  | { readonly kind: "json"; readonly value: unknown; readonly gate?: string }
  | { readonly kind: "utf8"; readonly value: string; readonly gate?: string }
  | { readonly kind: "stderr_utf8"; readonly value: string; readonly gate?: string }
  | { readonly kind: "base64"; readonly value: string; readonly gate?: string };

export type FakeClaudeProcessPlan =
  | {
      readonly kind: "version";
      readonly stdout?: string;
      readonly stderr?: string;
      readonly stderrBytes?: number;
      readonly exitCode?: number;
      readonly exitSignal?: NodeJS.Signals;
      readonly hold?: boolean;
      readonly spawnDescendant?: boolean;
    }
  | {
      readonly kind: "turn";
      readonly writesBeforeInput?: readonly FakeClaudeWireWrite[];
      readonly writesAfterInput?: readonly FakeClaudeWireWrite[];
      readonly writesAfterStdinEnd?: readonly FakeClaudeWireWrite[];
      readonly exitBeforeInput?: {
        readonly exitCode?: number;
        readonly exitSignal?: NodeJS.Signals;
      };
      readonly stdinEndGate?: string;
      readonly onStdinEnd?: "exit" | "linger" | "resist";
      readonly lingerMs?: number;
      readonly exitCode?: number;
      readonly exitSignal?: NodeJS.Signals;
      readonly stderrBytes?: number;
      readonly stdoutBytesBeforeInput?: number;
      readonly stdoutBytesAfterInput?: number;
      readonly spawnDescendant?: boolean;
      readonly descendantStdoutAfterStdinEnd?: string;
      readonly resistTermination?: boolean;
      readonly exitOnInterrupt?: boolean;
    };

export interface FakeClaudeLaunchRecord {
  readonly executable: string;
  readonly mode: "version" | "turn";
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly pid: number;
  readonly stdinRecords: readonly string[];
  readonly stdinBase64: string;
  readonly stdinClosed: boolean;
  readonly signals: readonly NodeJS.Signals[];
  readonly descendantPid: number | undefined;
  readonly barriers: readonly string[];
}

export interface FakeMonitorPlan {
  readonly readyWrites?: readonly FakeClaudeWireWrite[];
  readonly afterStartWrites?: readonly FakeClaudeWireWrite[];
  readonly spawnClaude?: boolean;
  readonly holdBeforeReady?: boolean;
  readonly selfSealOnContain?: boolean;
  readonly startRecordGate?: string;
  readonly beforeSpawnGate?: string;
  readonly afterSpawnGate?: string;
  readonly beforeChildStartedGate?: string;
}

export interface FakeMonitorLaunchRecord {
  readonly requestedExecutable: string;
  readonly requestedArguments: readonly string[];
  readonly requestedCwd: string;
  readonly requestedEnvironment: Readonly<Record<string, string>>;
  readonly requestedDetached: true;
  readonly requestedShell: false;
  readonly requestedStdio: readonly ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"];
  readonly pid: number;
  readonly commands: readonly unknown[];
  readonly ownerClosed: boolean;
  readonly barriers: readonly string[];
  readonly signals: readonly NodeJS.Signals[];
  readonly seals: readonly string[];
}
