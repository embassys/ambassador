import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { TestContext } from "node:test";

import type { ConnectorClock } from "../../../packages/connector-core/src/runtime-types.js";
import type {
  ProviderCancelRequest,
  ProviderRecoverRequest,
  ProviderResumeRequest,
  ProviderStartRequest,
} from "../connector/index.js";
import { ManualK02Clock } from "../connector/k02-production.js";
import type { ClaudeAdapterPort, ClaudeMonitorSpawnForTest } from "./cl03-production.js";
import { loadCl03Production } from "./cl03-production.js";
import { type FakeClaudeCli, startFakeClaudeCli } from "./fake-cli.js";
import type {
  ClaudeAdapterProcessBarrier,
  ClaudeProcessObservation,
  FakeClaudeProcessPlan,
} from "./types.js";

export const CL02_SESSION_ID = "00000000-0000-4000-8000-000000000101";
export const CL02_INPUT_UUID = "00000000-0000-4000-8000-000000000102";
export const CL02_EXECUTION_ID = "00000000-0000-4000-8000-000000000103";
export const CL02_DEADLINE_MS = 1_788_000_900_000;

export const READ_ONLY_TOOLS = "Read,Glob,Grep";
export const WORKSPACE_WRITE_TOOLS = "Read,Glob,Grep,Edit,Write";

export function createCl02Clock(): ManualK02Clock {
  return new ManualK02Clock(CL02_DEADLINE_MS - 100_000);
}

function syntheticHome(name: string): string {
  return `${tmpdir()}/a2a-cl02-synthetic-home-${name}`;
}

export function syntheticCl02Environment(
  home = syntheticHome("default"),
): Readonly<Record<string, string>> {
  return {
    HOME: home,
    PATH: [
      dirname(process.execPath),
      "/Users/agent/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    LANG: "C.UTF-8",
    TMPDIR: tmpdir(),
  };
}

export function exactClaudeArguments(
  kind: "start" | "resume",
  policy: "read-only" | "workspace-write" = "read-only",
  sessionId = CL02_SESSION_ID,
): readonly string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--safe-mode",
    "--restricted",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools",
    policy === "read-only" ? READ_ONLY_TOOLS : WORKSPACE_WRITE_TOOLS,
    "--disallowedTools",
    "mcp__*",
    kind === "start" ? "--session-id" : "--resume",
    sessionId,
  ];
}

export function initRecord(
  cwd: string,
  options: {
    readonly sessionId?: string;
    readonly policy?: "read-only" | "workspace-write";
  } = {},
): Readonly<Record<string, unknown>> {
  const policy = options.policy ?? "read-only";
  return {
    type: "system",
    subtype: "init",
    session_id: options.sessionId ?? CL02_SESSION_ID,
    cwd,
    tools: (policy === "read-only" ? READ_ONLY_TOOLS : WORKSPACE_WRITE_TOOLS).split(","),
    mcp_servers: [],
    plugins: [],
    permissionMode: "dontAsk",
    claude_code_version: "2.1.251",
  };
}

export function inputRecord(
  text: string,
  sessionId = CL02_SESSION_ID,
  uuid = CL02_INPUT_UUID,
): Readonly<Record<string, unknown>> {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

export function replayRecord(text: string): Readonly<Record<string, unknown>> {
  return inputRecord(text);
}

export function resultRecord(
  text: string,
  options: { readonly subtype?: "success" | "error"; readonly sessionId?: string } = {},
): Readonly<Record<string, unknown>> {
  return {
    type: "result",
    subtype: options.subtype ?? "success",
    session_id: options.sessionId ?? CL02_SESSION_ID,
    is_error: options.subtype === "error",
    result: text,
  };
}

export function validTurnPlan(
  cwd: string,
  text = "CL02 untrusted input",
  policy: "read-only" | "workspace-write" = "read-only",
): Extract<FakeClaudeProcessPlan, { kind: "turn" }> {
  return {
    kind: "turn",
    writesBeforeInput: [{ kind: "json", value: initRecord(cwd, { policy }) }],
    writesAfterInput: [
      { kind: "json", value: replayRecord(text) },
      { kind: "json", value: resultRecord("CL02 exact reply") },
    ],
  };
}

export function startRequest(text = "CL02 untrusted input"): ProviderStartRequest {
  return {
    kind: "start",
    execution_id: CL02_EXECUTION_ID,
    conversation_id: "cl02_conversation_1",
    message_id: "cl02_message_1",
    input_text: text,
    deadline_unix_ms: CL02_DEADLINE_MS,
  };
}

export function resumeRequest(text = "CL02 continuation"): ProviderResumeRequest {
  return {
    kind: "resume",
    execution_id: CL02_EXECUTION_ID,
    conversation_id: "cl02_conversation_1",
    message_id: "cl02_message_2",
    provider_session_id: CL02_SESSION_ID,
    input_text: text,
    deadline_unix_ms: CL02_DEADLINE_MS,
  };
}

export function recoverRequest(turnId: string | null = null): ProviderRecoverRequest {
  return {
    kind: "recover",
    execution_id: CL02_EXECUTION_ID,
    conversation_id: "cl02_conversation_1",
    message_id: "cl02_message_1",
    provider_session_id: CL02_SESSION_ID,
    provider_turn_id: turnId,
    deadline_unix_ms: CL02_DEADLINE_MS,
  };
}

export function cancelRequest(): ProviderCancelRequest {
  return {
    kind: "cancel",
    execution_id: CL02_EXECUTION_ID,
    provider_session_id: CL02_SESSION_ID,
    provider_turn_id: null,
    reason: "deadline",
  };
}

export async function collectEvents(invocation: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of invocation) events.push(event);
  return events;
}

export async function createCl02Adapter(
  t: TestContext,
  caseId: string,
  options: {
    readonly turnPlan: Extract<FakeClaudeProcessPlan, { kind: "turn" }>;
    readonly versionPlan?: Extract<FakeClaudeProcessPlan, { kind: "version" }>;
    readonly workingDirectory?: string;
    readonly policy?: "read-only" | "workspace-write";
    readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly fixtureExecutablePath?: string | null;
    readonly clock?: ConnectorClock;
    readonly afterVersionProbeForTest?: () => void | Promise<void>;
    readonly spawnMonitorForTest?: ClaudeMonitorSpawnForTest;
    readonly uuidForTest?: (kind: "session" | "input") => string;
    readonly processBarrierForTest?: (event: {
      readonly scope: "version" | "turn";
      readonly barrier: ClaudeAdapterProcessBarrier;
    }) => Promise<void>;
    readonly processObserverForTest?: (event: {
      readonly scope: "version" | "turn";
      readonly observation: ClaudeProcessObservation;
    }) => void;
  },
): Promise<{ fake: FakeClaudeCli; adapter: ClaudeAdapterPort }> {
  const fake = await startFakeClaudeCli(t, [
    options.versionPlan ?? { kind: "version", stdout: "2.1.251 (Claude Code)\n" },
    options.turnPlan,
  ]);
  const module = await loadCl03Production(caseId);
  const adapter = await module.createClaudeCodeAdapterForTest({
    workingDirectory: options.workingDirectory ?? process.cwd(),
    policy: options.policy ?? "read-only",
    inheritedEnvironment: options.inheritedEnvironment ?? syntheticCl02Environment(caseId),
    webhookTokenEnvironmentName: "CL02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    clock: options.clock ?? createCl02Clock(),
    fixtureExecutablePath:
      options.fixtureExecutablePath === undefined
        ? fake.executablePath
        : options.fixtureExecutablePath,
    uuidForTest:
      options.uuidForTest ?? ((kind) => (kind === "session" ? CL02_SESSION_ID : CL02_INPUT_UUID)),
    ...(options.afterVersionProbeForTest === undefined
      ? {}
      : { afterVersionProbeForTest: options.afterVersionProbeForTest }),
    ...(options.spawnMonitorForTest === undefined
      ? {}
      : { spawnMonitorForTest: options.spawnMonitorForTest }),
    ...(options.processBarrierForTest === undefined
      ? {}
      : { processBarrierForTest: options.processBarrierForTest }),
    ...(options.processObserverForTest === undefined
      ? {}
      : { processObserverForTest: options.processObserverForTest }),
  });
  t.after(async () => await adapter.close());
  return { fake, adapter };
}
