#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { startConnectorRuntime } from "../../../packages/connector-core/src/connector.js";
import { parseConnectorArguments } from "../../../packages/connector-core/src/public-cli.js";
import type { ProviderPort } from "../../../packages/connector-core/src/runtime-types.js";
import {
  createScriptedFakeProvider,
  type FakeProviderInvocation,
  type ScriptedFakeProvider,
} from "./fake-provider.js";
import type {
  FakeProviderRequest,
  FakeProviderSpawnRecord,
  FakeProviderStep,
  ProviderRecoverRequest,
  ProviderResumeRequest,
} from "./fake-provider-types.js";
import {
  K04_CONTENT_PREFIX,
  K04_EMAIL,
  K04_REPLY_TEXT,
  K04_USERNAME,
  K04_VERIFICATION_CODE,
  K04_WEBHOOK_TOKEN,
} from "./k04-constants.js";
import { parseK04IpcEnvelope } from "./k04-ipc.js";

type K04Plan = "reply" | "safe-wait";
type K04ProviderGate = "reply";
type K04CrashBarrier =
  | "binding_published"
  | "turn_published"
  | "provider_terminal_received"
  | "reply_accepted";

let resolveTermination: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
const termination = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
  resolveTermination = resolve;
  process.once("SIGINT", () => resolve("SIGINT"));
  process.once("SIGTERM", () => resolve("SIGTERM"));
});

interface K04ProviderRequestEvent {
  readonly channel: "k04";
  readonly event: "provider_request";
  readonly kind: FakeProviderRequest["kind"];
  readonly conversation_id: string;
  readonly message_id: string;
  readonly provider_session_id: string;
  readonly provider_turn_id: string | null;
}

interface K04Configuration {
  readonly stateDirectory: string;
  readonly plan: K04Plan;
  readonly providerGate: K04ProviderGate | undefined;
  readonly crashBarrier: K04CrashBarrier | undefined;
  readonly clockOffsetMs: number;
  readonly proveNoProviderDispatch: boolean;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function testConfiguration(): K04Configuration {
  const stateDirectory = process.env.K04_STATE_DIRECTORY;
  const plan = process.env.K04_PROVIDER_PLAN;
  const providerGate = process.env.K04_PROVIDER_GATE;
  const crashBarrier = process.env.K04_CRASH_BARRIER;
  const clockOffset = process.env.K04_CLOCK_OFFSET_MS ?? "0";
  const proveNoProviderDispatch = process.env.K04_PROVE_NO_PROVIDER_DISPATCH;
  if (
    stateDirectory === undefined ||
    (plan !== "reply" && plan !== "safe-wait") ||
    !(providerGate === undefined || providerGate === "reply") ||
    !(
      crashBarrier === undefined ||
      [
        "binding_published",
        "turn_published",
        "provider_terminal_received",
        "reply_accepted",
      ].includes(crashBarrier)
    ) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(clockOffset) ||
    !Number.isSafeInteger(Number(clockOffset)) ||
    !(proveNoProviderDispatch === undefined || proveNoProviderDispatch === "1")
  ) {
    throw new Error("K04 connector child configuration is invalid");
  }
  return {
    stateDirectory,
    plan,
    providerGate,
    crashBarrier: crashBarrier as K04CrashBarrier | undefined,
    clockOffsetMs: Number(clockOffset),
    proveNoProviderDispatch: proveNoProviderDispatch === "1",
  };
}

function sendProviderRequest(request: FakeProviderRequest, providerSessionId: string): void {
  if (process.send === undefined) return;
  const event: K04ProviderRequestEvent = {
    channel: "k04",
    event: "provider_request",
    kind: request.kind,
    conversation_id: request.conversation_id,
    message_id: request.message_id,
    provider_session_id: request.kind === "start" ? providerSessionId : request.provider_session_id,
    provider_turn_id: request.kind === "recover" ? request.provider_turn_id : null,
  };
  process.send(event);
}

function canonicalSpawnRecord(record: FakeProviderSpawnRecord): string {
  return JSON.stringify({
    executable: record.executable,
    arguments: [...record.arguments],
    environment: Object.fromEntries(
      Object.entries(record.environment).sort(([a], [b]) => a.localeCompare(b)),
    ),
    shell: record.shell,
  });
}

function validateAndReportSpawn(record: FakeProviderSpawnRecord): void {
  assert.deepEqual(Object.keys(record).sort(), ["arguments", "environment", "executable", "shell"]);
  assert.equal(record.executable, process.execPath);
  assert.equal(record.arguments.length, 1);
  assert.match(record.arguments[0] ?? "", /\/fake-provider-worker\.js$/u);
  assert.equal(record.shell, false);
  assert.ok(
    Object.keys(record.environment).every((key) => ["PATH", "SYSTEMROOT", "WINDIR"].includes(key)),
    "fake provider inherited a forbidden environment key",
  );
  assert.ok(
    Object.keys(record.environment).every(
      (key) => !/(?:TOKEN|SECRET|CREDENTIAL|AUTH|A2A|K04)/u.test(key),
    ),
    "fake provider inherited a credential-shaped environment key",
  );
  const serialized = canonicalSpawnRecord(record);
  for (const marker of [
    K04_WEBHOOK_TOKEN,
    K04_EMAIL,
    K04_USERNAME,
    K04_VERIFICATION_CODE,
    K04_CONTENT_PREFIX,
  ]) {
    assert.ok(
      !serialized.includes(marker),
      "fake provider spawn record contained a forbidden marker",
    );
  }
  process.send?.({
    channel: "k04",
    event: "provider_spawn",
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
  });
}

async function reportFatal(error: unknown): Promise<void> {
  const code =
    error instanceof Error && /^connector_[a-z_]+$/u.test(error.message)
      ? error.message
      : "unexpected";
  if (process.send === undefined || !process.connected) return;
  await new Promise<void>((resolve) => {
    process.send?.({ channel: "k04", event: "fatal", code }, () => resolve());
  });
}

class K04ProviderPort implements ProviderPort {
  containmentAttempts = 0;
  postTerminalDeliveries = 0;
  readonly #releaseWaiters: Array<() => void> = [];
  #releaseCredits = 0;
  #providerBarrierSequence = 0;

  constructor(
    private readonly provider: ScriptedFakeProvider,
    private readonly plan: K04Plan,
    private readonly providerGate: K04ProviderGate | undefined,
  ) {}

  get spawnRecord() {
    return this.provider.spawnRecord;
  }

  handleControl(message: Record<string, unknown>): boolean {
    if (
      hasExactKeys(message, ["channel", "command"]) &&
      message.channel === "k04_control" &&
      message.command === "release_provider_barrier"
    ) {
      const release = this.#releaseWaiters.shift();
      if (release === undefined) this.#releaseCredits += 1;
      else release();
      return true;
    }
    return false;
  }

  start(request: Record<string, unknown>): AsyncIterable<unknown> {
    const validated = request as unknown as FakeProviderRequest;
    const sessionId = `k04_session_${validated.conversation_id}`;
    sendProviderRequest(validated, sessionId);
    return this.#invoke(
      validated,
      this.plan === "safe-wait"
        ? [
            { kind: "session", provider_session_id: sessionId },
            { kind: "turn", provider_turn_id: this.#turnId(validated) },
            { kind: "wait_for_cancel" },
          ]
        : [
            { kind: "session", provider_session_id: sessionId },
            { kind: "turn", provider_turn_id: this.#turnId(validated) },
            { kind: "reply", text: K04_REPLY_TEXT },
          ],
    );
  }

  resume(request: Record<string, unknown>): AsyncIterable<unknown> {
    const validated = request as unknown as ProviderResumeRequest;
    sendProviderRequest(validated, validated.provider_session_id);
    return this.#invoke(validated, [
      { kind: "turn", provider_turn_id: this.#turnId(validated) },
      { kind: "reply", text: K04_REPLY_TEXT },
    ]);
  }

  recover(request: Record<string, unknown>): AsyncIterable<unknown> {
    const validated = request as unknown as ProviderRecoverRequest;
    if (
      validated.provider_session_id !== `k04_session_${validated.conversation_id}` ||
      validated.provider_turn_id !== this.#turnId(validated)
    ) {
      throw new Error("K04 recover requested a non-deterministic provider identity");
    }
    sendProviderRequest(validated, validated.provider_session_id);
    return this.#invoke(validated, [{ kind: "reply", text: K04_REPLY_TEXT }]);
  }

  async cancel(request: Record<string, unknown>): Promise<unknown> {
    return await this.provider.cancel(request as never);
  }

  async contain(_executionId: string): Promise<boolean> {
    this.containmentAttempts += 1;
    return true;
  }

  #turnId(request: FakeProviderRequest): string {
    return `k04_turn_${request.message_id}`;
  }

  #invoke(
    request: FakeProviderRequest,
    script: readonly FakeProviderStep[],
  ): AsyncIterable<unknown> {
    return this.#gated(this.provider.invoke(request, script));
  }

  async *#gated(invocation: FakeProviderInvocation): AsyncIterableIterator<unknown> {
    for await (const event of invocation) {
      if (
        this.providerGate === "reply" &&
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as { event?: unknown }).event === "reply"
      ) {
        this.#providerBarrierSequence += 1;
        process.send?.({
          channel: "k04",
          event: "provider_barrier",
          name: "reply",
          sequence: this.#providerBarrierSequence,
        });
        if (this.#releaseCredits > 0) this.#releaseCredits -= 1;
        else
          await new Promise<void>((resolve) => {
            this.#releaseWaiters.push(resolve);
          });
      }
      yield event;
    }
  }
}

async function main(): Promise<void> {
  const parsed = parseConnectorArguments(process.argv.slice(2));
  if (parsed.command !== "start") throw new Error("K04 connector child requires start");
  const configuration = testConfiguration();
  const token = process.env[parsed.webhookTokenEnvironmentName];
  if (token === undefined) throw new Error("K04 connector child token is unavailable");
  const provider = createScriptedFakeProvider();
  validateAndReportSpawn(provider.spawnRecord);
  const providerPort = new K04ProviderPort(
    provider,
    configuration.plan,
    configuration.providerGate,
  );
  const clock = {
    nowMs: () => Date.now() + configuration.clockOffsetMs,
    setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
  };
  const connector = await startConnectorRuntime({
    providerKind: "codex",
    webhookPort: parsed.webhookPort,
    webhookToken: token,
    workingDirectory: parsed.workingDirectory,
    policy: parsed.policy,
    gatewayEndpoint: "http://127.0.0.1:8787/mcp",
    stateDirectory: configuration.stateDirectory,
    provider: providerPort,
    clock,
    ...(configuration.crashBarrier === undefined
      ? {}
      : {
          processBarrierForTest: async (event: K04CrashBarrier) => {
            if (event !== configuration.crashBarrier) return;
            process.send?.({
              channel: "k04",
              event: "crash_barrier",
              name: event,
              sequence: 1,
            });
            await new Promise<never>((_resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("K04 process crash barrier timed out")),
                30_000,
              );
              timer.unref();
            });
          },
        }),
    ...(configuration.proveNoProviderDispatch ? { proveNoProviderDispatch: true } : {}),
  });
  process.stdout.write(`Connector webhook: ${connector.webhookUrl}\n`);

  let idleSequence = 0;
  process.on("message", (value: unknown) => {
    const envelope = parseK04IpcEnvelope("connector_child", value);
    if (envelope.kind === "shared") return;
    const { message } = envelope;
    if (providerPort.handleControl(message)) return;
    if (hasExactKeys(message, ["channel", "command"]) && message.command === "shutdown") {
      resolveTermination?.("SIGTERM");
      return;
    }
    if (
      hasExactKeys(message, ["channel", "command", "sequence"]) &&
      message.command === "wait_for_idle" &&
      Number.isSafeInteger(message.sequence) &&
      (message.sequence as number) === idleSequence + 1
    ) {
      idleSequence += 1;
      void connector.waitForIdle().then(() => {
        process.send?.({
          channel: "k04",
          event: "idle",
          sequence: idleSequence,
        });
      });
      return;
    }
    throw new Error("K04 connector child received invalid control IPC");
  });

  const fatal = connector.waitForFatal().then(
    () => "fatal" as const,
    async (error: unknown) => {
      await reportFatal(error);
      return "fatal" as const;
    },
  );
  const outcome = await Promise.race([termination, fatal]);
  if (outcome === "fatal") process.exit(86);
  await connector.shutdown(outcome);
  await provider.close();
  if (process.connected) process.disconnect();
}

await main();
