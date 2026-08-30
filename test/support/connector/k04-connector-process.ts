#!/usr/bin/env node

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
  FakeProviderStep,
  ProviderRecoverRequest,
  ProviderResumeRequest,
} from "./fake-provider-types.js";
import { K04_REPLY_TEXT } from "./k04-constants.js";

type K04Plan = "reply" | "safe-wait";
type K04ProviderGate = "reply";
type K04CrashAfter =
  | "binding_published"
  | "turn_published"
  | "provider_terminal_received"
  | "reply_accepted";

const termination = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
  process.once("SIGINT", () => resolve("SIGINT"));
  process.once("SIGTERM", () => resolve("SIGTERM"));
  process.on("message", (message: unknown) => {
    if (
      message !== null &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { channel?: unknown }).channel === "k04_control" &&
      (message as { command?: unknown }).command === "shutdown"
    ) {
      resolve("SIGTERM");
    }
  });
});

interface K04ProviderRequestEvent {
  readonly channel: "k04";
  readonly event: "provider_request";
  readonly kind: FakeProviderRequest["kind"];
  readonly conversation_id: string;
  readonly message_id: string;
  readonly provider_session_id: string | null;
}

interface K04Configuration {
  readonly stateDirectory: string;
  readonly plan: K04Plan;
  readonly providerGate: K04ProviderGate | undefined;
  readonly crashAfter: K04CrashAfter | undefined;
  readonly clockOffsetMs: number;
  readonly proveNoProviderDispatch: boolean;
}

function testConfiguration(): K04Configuration {
  const stateDirectory = process.env.K04_STATE_DIRECTORY;
  const plan = process.env.K04_PROVIDER_PLAN;
  const providerGate = process.env.K04_PROVIDER_GATE;
  const crashAfter = process.env.K04_CRASH_AFTER;
  const clockOffset = process.env.K04_CLOCK_OFFSET_MS ?? "0";
  const proveNoProviderDispatch = process.env.K04_PROVE_NO_PROVIDER_DISPATCH;
  if (
    stateDirectory === undefined ||
    (plan !== "reply" && plan !== "safe-wait") ||
    !(providerGate === undefined || providerGate === "reply") ||
    !(
      crashAfter === undefined ||
      [
        "binding_published",
        "turn_published",
        "provider_terminal_received",
        "reply_accepted",
      ].includes(crashAfter)
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
    crashAfter: crashAfter as K04CrashAfter | undefined,
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
  };
  process.send(event);
}

class K04ProviderPort implements ProviderPort {
  containmentAttempts = 0;
  postTerminalDeliveries = 0;
  readonly #releaseWaiters: Array<() => void> = [];
  #releaseCredits = 0;

  constructor(
    private readonly provider: ScriptedFakeProvider,
    private readonly plan: K04Plan,
    private readonly providerGate: K04ProviderGate | undefined,
  ) {
    process.on("message", (message: unknown) => {
      if (
        message === null ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        (message as { channel?: unknown }).channel !== "k04_control" ||
        (message as { command?: unknown }).command !== "release_provider_barrier"
      ) {
        return;
      }
      const release = this.#releaseWaiters.shift();
      if (release === undefined) this.#releaseCredits += 1;
      else release();
    });
  }

  get spawnRecord() {
    return this.provider.spawnRecord;
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
        process.send?.({ channel: "k04", event: "provider_barrier", name: "reply" });
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
    provider: new K04ProviderPort(provider, configuration.plan, configuration.providerGate),
    clock,
    ...(configuration.crashAfter === undefined ? {} : { crashAfter: configuration.crashAfter }),
    ...(configuration.proveNoProviderDispatch ? { proveNoProviderDispatch: true } : {}),
  });
  process.stdout.write(`Connector webhook: ${connector.webhookUrl}\n`);

  const fatal = connector.waitForFatal().then(
    () => "fatal" as const,
    () => "fatal" as const,
  );
  const outcome = await Promise.race([termination, fatal]);
  if (outcome === "fatal") process.exit(86);
  await connector.shutdown(outcome);
  await provider.close();
  if (process.connected) process.disconnect();
}

await main();
