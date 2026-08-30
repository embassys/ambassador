export const CODEX_FIXTURE_VERSION = "0.149.0";
export const CODEX_FIXTURE_SCHEMA_SHA256 =
  "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9";

export type FakeCodexWireWrite =
  | { readonly kind: "json"; readonly value: unknown; readonly gate?: string }
  | { readonly kind: "utf8"; readonly value: string; readonly gate?: string }
  | { readonly kind: "stderr_utf8"; readonly value: string; readonly gate?: string }
  | { readonly kind: "base64"; readonly value: string; readonly gate?: string };

export interface FakeCodexExchange {
  readonly expectMethod: string;
  readonly expectRequest?: Readonly<Record<string, unknown>>;
  readonly beforeResponse?: readonly FakeCodexWireWrite[];
  readonly result?: unknown;
  readonly error?: unknown;
  readonly afterResponse?: readonly FakeCodexWireWrite[];
  readonly allowConcurrentAfterResponse?: boolean;
  readonly exitCodeAfter?: number;
}

export type FakeCodexProcessPlan =
  | {
      readonly kind: "version";
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number;
      readonly hold?: boolean;
    }
  | {
      readonly kind: "app-server";
      readonly exchanges: readonly FakeCodexExchange[];
      readonly onStdinEnd?: "exit" | "linger" | "resist";
      readonly lingerMs?: number;
      readonly writesAfterStdinEnd?: readonly FakeCodexWireWrite[];
      readonly spawnDescendant?: boolean;
      readonly killDescendantOnStdinEnd?: boolean;
      readonly containmentForTest?: "kill" | "fail";
      readonly stderrBytes?: number;
    };

export interface FakeCodexLaunchRecord {
  readonly executable: string;
  readonly mode: "version" | "app-server" | "invalid";
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly pid: number;
  readonly requests: readonly Readonly<Record<string, unknown>>[];
  readonly stdinClosed: boolean;
  readonly descendantPid: number | undefined;
}
