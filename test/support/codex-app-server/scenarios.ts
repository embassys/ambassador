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
import type { CodexAdapterPort } from "./cx03-production.js";
import { loadCx03Production } from "./cx03-production.js";
import { type FakeCodexAppServer, startFakeCodexAppServer } from "./fake-app-server.js";
import type { FakeCodexExchange, FakeCodexProcessPlan } from "./types.js";

export const CX02_THREAD_ID = "019c0000-0000-7000-8000-000000000001";
export const CX02_TURN_ID = "019c0000-0000-7000-8000-000000000002";
export const CX02_EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
export const CX02_DEADLINE_MS = 1_788_000_900_000;

export function syntheticCx02Environment(
  home = joinSyntheticHome("default"),
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

function joinSyntheticHome(name: string): string {
  return `${tmpdir()}/a2a-cx02-synthetic-home-${name}`;
}

export function initializeRequest(id = 1): Readonly<Record<string, unknown>> {
  return {
    id,
    method: "initialize",
    params: {
      clientInfo: {
        name: "a2a_codex_connector",
        title: "A2A Codex Connector",
        version: "0.0.0-private",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: ["configWarning"],
        extensions: null,
      },
    },
  };
}

export function validThread(
  cwd: string,
  id = CX02_THREAD_ID,
  turns: readonly Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>> {
  return {
    id,
    preview: "",
    modelProvider: "openai",
    createdAt: 1_788_000_000,
    updatedAt: 1_788_000_000,
    status: { type: "idle" },
    cwd,
    cliVersion: "0.149.0",
    source: "appServer",
    sessionId: id,
    turns,
    ephemeral: false,
    projectId: null,
  };
}

export function validTurn(
  id = CX02_TURN_ID,
  status: "completed" | "interrupted" | "failed" | "inProgress" = "inProgress",
  items: readonly Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>> {
  return { id, items, itemsView: "full", status };
}

export function threadSettingsResponse(
  cwd: string,
  id = CX02_THREAD_ID,
  turns: readonly Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>> {
  return {
    thread: validThread(cwd, id, turns),
    model: "gpt-5.6-codex",
    modelProvider: "openai",
    cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

export function handshakeExchanges(): FakeCodexExchange[] {
  return [
    { expectMethod: "initialize", expectRequest: initializeRequest(), result: {} },
    { expectMethod: "initialized", expectRequest: { method: "initialized" } },
  ];
}

export function startRequest(text = "CX02 untrusted input"): ProviderStartRequest {
  return {
    kind: "start",
    execution_id: CX02_EXECUTION_ID,
    conversation_id: "cx02_conversation_1",
    message_id: "cx02_message_1",
    input_text: text,
    deadline_unix_ms: CX02_DEADLINE_MS,
  };
}

export function resumeRequest(text = "CX02 continuation"): ProviderResumeRequest {
  return {
    kind: "resume",
    execution_id: CX02_EXECUTION_ID,
    conversation_id: "cx02_conversation_1",
    message_id: "cx02_message_2",
    provider_session_id: CX02_THREAD_ID,
    input_text: text,
    deadline_unix_ms: CX02_DEADLINE_MS,
  };
}

export function recoverRequest(turnId: string | null = CX02_TURN_ID): ProviderRecoverRequest {
  return {
    kind: "recover",
    execution_id: CX02_EXECUTION_ID,
    conversation_id: "cx02_conversation_1",
    message_id: "cx02_message_1",
    provider_session_id: CX02_THREAD_ID,
    provider_turn_id: turnId,
    deadline_unix_ms: CX02_DEADLINE_MS,
  };
}

export function cancelRequest(turnId: string | null = CX02_TURN_ID): ProviderCancelRequest {
  return {
    kind: "cancel",
    execution_id: CX02_EXECUTION_ID,
    provider_session_id: CX02_THREAD_ID,
    provider_turn_id: turnId,
    reason: "deadline",
  };
}

export async function collectEvents(invocation: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of invocation) events.push(event);
  return events;
}

export async function createCx02Adapter(
  t: TestContext,
  caseId: string,
  options: {
    readonly appPlan: Extract<FakeCodexProcessPlan, { kind: "app-server" }>;
    readonly workingDirectory?: string;
    readonly versionPlan?: Extract<FakeCodexProcessPlan, { kind: "version" }>;
    readonly policy?: "read-only" | "workspace-write";
    readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
    readonly fixtureExecutablePath?: string | null;
    readonly clock?: ConnectorClock;
    readonly afterVersionProbeForTest?: () => void | Promise<void>;
    readonly containmentForTest?: {
      contain(executionId: string): Promise<boolean>;
      isEmpty(executionId: string): boolean;
    };
  },
): Promise<{ fake: FakeCodexAppServer; adapter: CodexAdapterPort }> {
  const fake = await startFakeCodexAppServer(t, [
    options.versionPlan ?? { kind: "version", stdout: "codex-cli 0.149.0\n" },
    options.appPlan,
  ]);
  const module = await loadCx03Production(caseId);
  const adapter = await module.createCodexAppServerAdapterForTest({
    workingDirectory: options.workingDirectory ?? process.cwd(),
    policy: options.policy ?? "read-only",
    inheritedEnvironment: options.inheritedEnvironment ?? syntheticCx02Environment(caseId),
    webhookTokenEnvironmentName: "CX02_WEBHOOK_TOKEN",
    connectorPackageVersion: "0.0.0-private",
    fixtureExecutablePath: options.fixtureExecutablePath ?? fake.executablePath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.afterVersionProbeForTest === undefined
      ? {}
      : { afterVersionProbeForTest: options.afterVersionProbeForTest }),
    ...(options.containmentForTest === undefined
      ? {}
      : { containmentForTest: options.containmentForTest }),
  });
  t.after(async () => await adapter.close());
  return { fake, adapter };
}
