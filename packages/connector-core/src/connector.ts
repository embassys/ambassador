import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  CONNECTOR_LIMITS,
  ConnectorError,
  type ConnectorPolicy,
  connectorError,
  type ProviderKind,
  URI_UNRESERVED_ID_PATTERN,
} from "./constants.js";
import { GatewayClient, GatewayObservation } from "./local-mcp-client.js";
import { buildProviderChildEnvironment } from "./provider-boundary.js";
import type { ConnectorClock, ConnectorFoundationOptions, ProviderPort } from "./runtime-types.js";
import { SYSTEM_CLOCK } from "./runtime-types.js";
import {
  type ConnectorState,
  type ConnectorStateReservation,
  openConnectorState,
  type StoredConversation,
  type StoredMessage,
} from "./state.js";
import { WebhookReceiver } from "./webhook.js";

interface GatewayMessage {
  id: string;
  conversation_id: string;
  sender_agent_id: string;
  message_type: "conversation_turn";
  in_reply_to_message_id: string | null;
  payload: { text: string };
  created_at: string;
}

interface Work {
  message: GatewayMessage;
  conversation: StoredConversation;
  stored: StoredMessage;
  executionId: string;
  sessionId: string | null;
  turnId: string | null;
  replyText: string | null;
  terminal: Terminal | null;
  deadlineTimer: unknown;
  iterator: AsyncIterator<unknown> | null;
  pullPending: boolean;
  sawStatefulProgress: boolean;
  approvalId: string | null;
  cancellationRequested: boolean;
  startupRecovery: boolean;
}

type Terminal =
  | { operation: "reply"; text: string }
  | { operation: "complete"; outcome: string; reason: string };

interface ManagedProviderPort extends ProviderPort {
  close(deadlineUnixMs: number): Promise<void>;
}

interface InternalProviderFactoryOptions {
  readonly workingDirectory: string;
  readonly policy: ConnectorPolicy;
}

type InternalProviderFactory = (
  options: InternalProviderFactoryOptions,
) => Promise<ManagedProviderPort>;

interface ConnectorHandle {
  readonly webhookUrl: string;
  close(): Promise<void>;
  shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void>;
  crash(): Promise<void>;
  waitForFatal(): Promise<never>;
  waitForIdle(): Promise<void>;
  inspectAdmissionStateForTest(): {
    queuedIds: readonly string[];
    activeIds: readonly string[];
    replayEntries: number;
  };
}

const COMPLETION_REASONS: Readonly<Record<string, readonly string[]>> = {
  completed_without_reply: ["no_reply_required"],
  unsupported: ["unsupported_message_type", "unsupported_payload"],
  failed: ["provider_start_failed", "provider_execution_failed", "provider_result_invalid"],
  cancelled: ["cancelled_before_execution", "cancelled_during_safe_wait"],
  uncertain: ["provider_outcome_unknown"],
};
const PERMANENT = new Set([
  "invalid_request",
  "recipient_unavailable",
  "message_not_found",
  "idempotency_conflict",
  "receive_in_progress",
  "protocol_mismatch",
  "request_too_large",
]);

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function scalarText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > maximumBytes) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function providerId(value: unknown): value is string {
  return scalarText(value, CONNECTOR_LIMITS.providerIdBytes);
}

function gatewayId(value: unknown): value is string {
  return typeof value === "string" && URI_UNRESERVED_ID_PATTERN.test(value);
}

function validateMessage(value: unknown): GatewayMessage | undefined {
  const keys = [
    "id",
    "conversation_id",
    "sender_agent_id",
    "message_type",
    "in_reply_to_message_id",
    "payload",
    "created_at",
  ];
  if (!exactObject(value, keys)) return undefined;
  if (
    !gatewayId(value.id) ||
    !gatewayId(value.conversation_id) ||
    !gatewayId(value.sender_agent_id)
  )
    return undefined;
  if (
    value.message_type !== "conversation_turn" ||
    !(value.in_reply_to_message_id === null || gatewayId(value.in_reply_to_message_id))
  )
    return undefined;
  if (
    !exactObject(value.payload, ["text"]) ||
    !scalarText(value.payload.text, CONNECTOR_LIMITS.finalReplyBytes)
  )
    return undefined;
  if (
    typeof value.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.created_at)
  )
    return undefined;
  return structuredClone(value) as unknown as GatewayMessage;
}

function sleep(clock: ConnectorClock, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimer(resolve, delayMs);
  });
}

function backoff(attempt: number): number {
  if (attempt <= 1) return 1_000;
  if (attempt === 2) return 2_000;
  if (attempt === 3) return 4_000;
  if (attempt === 4) return 8_000;
  if (attempt === 5) return 16_000;
  return 30_000;
}

class ConnectorRuntime implements ConnectorHandle {
  readonly #clock: ConnectorClock;
  readonly #state: ConnectorState;
  readonly #gateway: GatewayClient;
  readonly #receiver: WebhookReceiver;
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  readonly #starting = new Set<string>();
  readonly #active = new Map<string, Work>();
  readonly #startupRecoveryIds = new Set<string>();
  readonly #startupRecoveryWaiters = new Set<() => void>();
  readonly #idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  readonly #fatalSignal: Promise<never>;
  #rejectFatal: ((error: Error) => void) | undefined;
  #fatal: Error | undefined;
  #fatalCleanup: Promise<void> | undefined;
  #receiverClose: Promise<void> | undefined;
  #gatewayClose: Promise<void> | undefined;
  #transportClose: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #managedProvider: ManagedProviderPort | undefined;
  #stateClosed = false;
  #closed = false;
  #stopping = false;

  private constructor(
    private options: ConnectorFoundationOptions,
    state: ConnectorState,
  ) {
    this.#fatalSignal = new Promise<never>((_resolve, reject) => {
      this.#rejectFatal = reject;
    });
    void this.#fatalSignal.catch(() => undefined);
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#state = state;
    this.#gateway = new GatewayClient(options.gatewayEndpoint, options.webhookToken, this.#clock);
    this.#receiver = new WebhookReceiver(
      options.webhookPort,
      options.webhookToken,
      this.#clock,
      (id) => this.#admit(id),
      options.stallWebhookResponseAfterCommit ?? false,
    );
  }

  static async start(
    options: ConnectorFoundationOptions,
    providerFactory?: InternalProviderFactory,
  ): Promise<ConnectorRuntime> {
    let workingDirectory: string;
    try {
      workingDirectory = realpathSync.native(options.workingDirectory);
    } catch {
      connectorError("invalid_connector_arguments");
    }
    const canonicalOptions = { ...options, workingDirectory };
    const state = openConnectorState({
      stateDirectory: canonicalOptions.stateDirectory,
      webhookToken: canonicalOptions.webhookToken,
      providerKind: canonicalOptions.providerKind,
      workingDirectory: canonicalOptions.workingDirectory,
      nowMs: (canonicalOptions.clock ?? SYSTEM_CLOCK).nowMs(),
      ...(canonicalOptions.stateReservation === undefined
        ? {}
        : { reservation: canonicalOptions.stateReservation }),
      ...(canonicalOptions.stateActionObserverForTest === undefined
        ? {}
        : { stateActionObserverForTest: canonicalOptions.stateActionObserverForTest }),
    });
    const runtime = new ConnectorRuntime(canonicalOptions, state);
    let prepared: Work[];
    try {
      prepared = runtime.#prepareStartupRecovery();
    } catch (error) {
      state.close();
      throw error;
    }
    if (providerFactory !== undefined) {
      let managedProvider: ManagedProviderPort;
      try {
        managedProvider = await providerFactory({
          workingDirectory: canonicalOptions.workingDirectory,
          policy: canonicalOptions.policy,
        });
      } catch (error) {
        state.close();
        throw error;
      }
      runtime.options = { ...canonicalOptions, provider: managedProvider };
      runtime.#managedProvider = managedProvider;
    }
    try {
      await runtime.#receiver.listen();
    } catch {
      const cleanupDeadline = runtime.#clock.nowMs() + CONNECTOR_LIMITS.containmentCleanupMs;
      const providerClosed = await runtime.#closeManagedProvider(cleanupDeadline);
      let stateClosed = true;
      try {
        state.close();
      } catch {
        stateClosed = false;
      }
      if (!providerClosed || !stateClosed) connectorError("connector_shutdown_incomplete");
      connectorError("connector_listener_unavailable");
    }
    queueMicrotask(() => {
      for (const work of prepared) void runtime.#recoverPrepared(work);
      runtime.#pump();
    });
    return runtime;
  }

  get webhookUrl(): string {
    return this.#receiver.webhookUrl;
  }

  inspectAdmissionStateForTest(): {
    queuedIds: readonly string[];
    activeIds: readonly string[];
    replayEntries: number;
  } {
    return {
      queuedIds: [...this.#queue],
      activeIds: [...this.#starting, ...this.#active.keys()],
      replayEntries: this.#receiver.replayEntries,
    };
  }

  waitForIdle(): Promise<void> {
    if (this.#fatal !== undefined) return Promise.reject(this.#fatal);
    if (this.#queue.length === 0 && this.#starting.size === 0 && this.#active.size === 0)
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.#idleWaiters.add({ resolve, reject }));
  }

  waitForFatal(): Promise<never> {
    return this.#fatalSignal;
  }

  async close(): Promise<void> {
    const cleanupDeadline = this.#clock.nowMs() + CONNECTOR_LIMITS.containmentCleanupMs;
    if (this.#fatalCleanup !== undefined) {
      await this.#fatalCleanup;
      await this.#transportClose;
      return;
    }
    if (this.#closed) return;
    await this.#stop(false);
    if (!(await this.#closeManagedProvider(cleanupDeadline))) {
      throw new ConnectorError("connector_shutdown_incomplete");
    }
  }
  async crash(): Promise<void> {
    if (this.#fatalCleanup !== undefined) {
      await this.#fatalCleanup;
      await this.#transportClose;
      return;
    }
    if (this.#closed) return;
    this.#stopping = true;
    this.#closed = true;
    this.#clearActiveTimers();
    await this.#closeAdmissionAndGateway();
    this.#closeState();
  }

  shutdown(_signal: "SIGINT" | "SIGTERM"): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    if (this.#closed) return Promise.resolve();
    this.#shutdownPromise = this.#shutdown();
    void this.#shutdownPromise.catch(() => undefined);
    return this.#shutdownPromise;
  }

  async #shutdown(): Promise<void> {
    const startedAt = this.#clock.nowMs();
    const admissionDeadline = startedAt + 1_000;
    const containmentDeadline = startedAt + 14_000;
    const absoluteDeadline = startedAt + 15_000;
    this.#stopping = true;
    this.#clearActiveTimers();
    this.#queue.length = 0;
    this.#queued.clear();
    this.#starting.clear();
    const active = [...this.#active.values()];
    const transportClose = this.#closeAdmissionAndGateway();
    const admissionClosed = await this.#settlesBy(
      this.#receiverClose as Promise<void>,
      admissionDeadline,
    );
    const cleanup = await Promise.all(
      active.map(async (work) => await this.#shutdownExecution(work, containmentDeadline)),
    );
    const transportClosed = await this.#settlesBy(transportClose, absoluteDeadline);
    const providerClosed = await this.#closeManagedProvider(absoluteDeadline);
    this.#closed = true;
    this.#active.clear();
    let stateClosed = true;
    try {
      this.#closeState();
    } catch {
      stateClosed = false;
    }
    if (
      !transportClosed ||
      !admissionClosed ||
      !providerClosed ||
      !stateClosed ||
      cleanup.some((contained) => !contained) ||
      this.#clock.nowMs() > absoluteDeadline
    ) {
      throw new ConnectorError("connector_shutdown_incomplete");
    }
  }

  async #stop(cancel: boolean): Promise<void> {
    this.#stopping = true;
    this.#closed = true;
    this.#clearActiveTimers();
    await this.#closeAdmissionAndGateway();
    if (cancel) {
      await Promise.all(
        [...this.#active.values()].map(async (work) => {
          try {
            await this.options.provider.cancel({
              kind: "cancel",
              execution_id: work.executionId,
              provider_session_id: work.sessionId,
              provider_turn_id: work.turnId,
              reason: "shutdown",
            });
          } catch {}
        }),
      );
    }
    this.#closeState();
  }

  async #closeManagedProvider(deadlineUnixMs: number): Promise<boolean> {
    const provider = this.#managedProvider;
    if (provider === undefined) return true;
    this.#managedProvider = undefined;
    try {
      await provider.close(deadlineUnixMs);
      return this.#clock.nowMs() <= deadlineUnixMs;
    } catch {
      return false;
    }
  }

  async #shutdownExecution(work: Work, shutdownProviderDeadline: number): Promise<boolean> {
    const cancellationStartedAt = this.#clock.nowMs();
    const durableDeadline = work.stored.turnDeadlineMs;
    const graceEnd = Math.min(
      cancellationStartedAt + CONNECTOR_LIMITS.cancellationGraceMs,
      (durableDeadline ?? cancellationStartedAt) + CONNECTOR_LIMITS.cancellationGraceMs,
      shutdownProviderDeadline - CONNECTOR_LIMITS.containmentCleanupMs,
    );
    try {
      void this.options.provider
        .cancel({
          kind: "cancel",
          execution_id: work.executionId,
          provider_session_id: work.sessionId,
          provider_turn_id: work.turnId,
          reason: "shutdown",
        })
        .catch(() => undefined);
    } catch {}
    await this.#sleepUntil(graceEnd);
    const cleanupDeadline = Math.min(
      graceEnd + CONNECTOR_LIMITS.containmentCleanupMs,
      shutdownProviderDeadline,
    );
    let containment: Promise<boolean>;
    try {
      containment = this.options.provider.contain(work.executionId).catch(() => false);
    } catch {
      return false;
    }
    return await this.#settlesBy(containment, cleanupDeadline, (result) => result === true);
  }

  async #sleepUntil(deadline: number): Promise<void> {
    const remaining = deadline - this.#clock.nowMs();
    if (remaining > 0) await sleep(this.#clock, remaining);
  }

  async #settlesBy<T>(
    operation: Promise<T>,
    deadline: number,
    accepts: (result: T) => boolean = () => true,
  ): Promise<boolean> {
    let settled = false;
    const observed = operation.then(
      (result) => {
        settled = true;
        return accepts(result);
      },
      () => {
        settled = true;
        return false;
      },
    );
    await Promise.resolve();
    if (settled) return await observed;
    const remaining = deadline - this.#clock.nowMs();
    if (remaining <= 0) return false;
    let timeout: unknown;
    const expired = new Promise<false>((resolve) => {
      timeout = this.#clock.setTimer(() => resolve(false), remaining);
    });
    try {
      return await Promise.race([observed, expired]);
    } finally {
      this.#clock.clearTimer(timeout);
    }
  }

  #closeAdmissionAndGateway(): Promise<void> {
    if (this.#transportClose === undefined) {
      this.#receiverClose = this.#receiver.close();
      this.#gatewayClose = this.#gateway.close();
      this.#transportClose = Promise.allSettled([this.#receiverClose, this.#gatewayClose]).then(
        () => undefined,
      );
    }
    return this.#transportClose;
  }

  #closeState(): void {
    if (this.#stateClosed) return;
    this.#stateClosed = true;
    this.#state.close();
  }

  #clearActiveTimers(): void {
    for (const work of this.#active.values()) this.#clock.clearTimer(work.deadlineTimer);
  }

  #admit(id: string): "accepted" | "coalesced" | "full" {
    if (this.#stopping || this.#closed || this.#fatal !== undefined) return "full";
    if (this.#queued.has(id) || this.#starting.has(id) || this.#active.has(id)) return "coalesced";
    try {
      this.#state.beforeExternalEffect();
    } catch (error) {
      this.#fail(error);
      return "full";
    }
    if (this.#queue.length >= CONNECTOR_LIMITS.waitingWakeIds) return "full";
    this.#queue.push(id);
    this.#queued.add(id);
    setImmediate(() => this.#pump());
    return "accepted";
  }

  #pump(): void {
    if (this.#closed || this.#stopping || this.#fatal !== undefined) return;
    while (
      this.#active.size + this.#starting.size < CONNECTOR_LIMITS.activeTurnsGlobal &&
      this.#queue.length > 0
    ) {
      const id = this.#queue.shift();
      if (id === undefined) break;
      this.#queued.delete(id);
      this.#starting.add(id);
      void this.#startId(id);
    }
    this.#settleIdle();
  }

  async #startId(id: string): Promise<void> {
    try {
      this.#state.beforeExternalEffect();
      const result = await this.#gateway.call("poll_messages", { timeout: 0 });
      if (
        !exactObject(result, ["messages"]) ||
        !Array.isArray(result.messages) ||
        result.messages.length > 100
      )
        throw new GatewayObservation("contract");
      const messages = result.messages.map(validateMessage);
      if (messages.some((message) => message === undefined))
        throw new GatewayObservation("contract");
      const matching = (messages as GatewayMessage[]).filter((message) => message.id === id);
      if (matching.length === 0) {
        this.#starting.delete(id);
        this.#pump();
        return;
      }
      if (matching.length !== 1) throw new GatewayObservation("contract");
      await this.#waitForStartupRecovery();
      if (this.#fatal !== undefined) throw this.#fatal;
      await this.#admitMessage(matching[0] as GatewayMessage);
    } catch (error) {
      this.#starting.delete(id);
      if (this.#stopping || this.#closed) return;
      if (error instanceof ConnectorError && error.code === "connector_state_capacity") {
        process.stderr.write("a2a connector: connector_state_capacity\n");
        this.#pump();
        return;
      }
      this.#fail(
        error instanceof GatewayObservation
          ? new ConnectorError("connector_gateway_operation_failed")
          : error,
      );
    }
  }

  async #admitMessage(message: GatewayMessage): Promise<void> {
    const now = this.#clock.nowMs();
    let conversation = this.#state.readConversation(message.conversation_id);
    let stored = this.#state.readMessage(message.id);
    if (stored === undefined) {
      if (conversation === undefined) {
        if (message.in_reply_to_message_id !== null)
          throw new ConnectorError("connector_conversation_unavailable");
        const capacity = this.#state.database
          .prepare<[], unknown>("SELECT 1 FROM conversations ORDER BY rowid LIMIT 1 OFFSET 99999")
          .get();
        if (capacity !== undefined) throw new ConnectorError("connector_state_capacity");
        ({ conversation, message: stored } = this.#state.insertConversationAndMessage(
          message.conversation_id,
          message.id,
          now,
        ));
      } else {
        if (conversation.lifecycle !== "active" || message.in_reply_to_message_id === null)
          throw new ConnectorError("connector_conversation_unavailable");
        stored = this.#state.insertContinuation(message.conversation_id, message.id, now);
      }
    } else {
      conversation = this.#state.readConversationByHmac(stored.conversationHmac);
      if (conversation === undefined || conversation.conversationId !== message.conversation_id)
        throw new ConnectorError("connector_state_unavailable");
    }
    const executionId = randomUUID();
    const work: Work = {
      message,
      conversation,
      stored,
      executionId,
      sessionId: conversation.sessionId,
      turnId: stored.turnId,
      replyText: null,
      terminal: null,
      deadlineTimer: undefined,
      iterator: null,
      pullPending: false,
      sawStatefulProgress: false,
      approvalId: null,
      cancellationRequested: false,
      startupRecovery: false,
    };
    this.#starting.delete(message.id);
    this.#active.set(message.id, work);
    if (this.options.crashAfterReceived) throw new Error("connector_test_crash");
    await this.#dispatch(work);
  }

  async #dispatch(work: Work): Promise<void> {
    const continuation = work.conversation.lifecycle === "active";
    const now = this.#clock.nowMs();
    work.stored = this.#state.dispatch(work.message.id, continuation, now);
    if (this.options.processBarrierForTest !== undefined)
      await this.options.processBarrierForTest("binding_published");
    if (
      this.options.crashAfter === "binding_published" ||
      (continuation && this.options.crashAfterTurnStarting)
    )
      throw new Error("connector_test_crash");
    if (this.options.providerDispatchDelayMsForTest !== undefined)
      await sleep(this.#clock, this.options.providerDispatchDelayMsForTest);
    const deadline = work.stored.turnDeadlineMs;
    if (deadline === null) throw new ConnectorError("connector_state_unavailable");
    const request = continuation
      ? {
          kind: "resume",
          execution_id: work.executionId,
          conversation_id: work.message.conversation_id,
          message_id: work.message.id,
          provider_session_id: work.sessionId,
          input_text: work.message.payload.text,
          deadline_unix_ms: deadline,
        }
      : {
          kind: "start",
          execution_id: work.executionId,
          conversation_id: work.message.conversation_id,
          message_id: work.message.id,
          input_text: work.message.payload.text,
          deadline_unix_ms: deadline,
        };
    this.#state.beforeExternalEffect();
    this.#observeSpawn();
    const stream = continuation
      ? this.options.provider.resume(request)
      : this.options.provider.start(request);
    work.iterator = stream[Symbol.asyncIterator]();
    work.deadlineTimer = this.#clock.setTimer(
      () => {
        void this.#deadline(work);
      },
      Math.max(0, deadline - this.#clock.nowMs()),
    );
    await this.#consume(work, continuation ? "turn_unbound" : "start_unbound", false);
  }

  #observeSpawn(): void {
    const observer = this.options.providerProcessObserver;
    if (observer === undefined) return;
    observer.observe({
      executable: observer.executable,
      arguments: [...observer.arguments],
      environment: buildProviderChildEnvironment(
        process.platform === "darwin" ? "darwin" : "linux",
        observer.inheritedEnvironment,
        observer.webhookTokenEnvironmentName,
      ),
      shell: false,
      stdin: "ignore",
    });
  }

  async #consume(work: Work, initialPhase: string, recovery: boolean): Promise<void> {
    let phase = initialPhase;
    let events = 0;
    try {
      while (work.iterator !== null) {
        let pulled: IteratorResult<unknown>;
        work.pullPending = true;
        try {
          pulled = await work.iterator.next();
        } finally {
          work.pullPending = false;
        }
        if (this.#stopping || this.#closed) return;
        if (pulled.done) {
          if (!recovery && work.turnId !== null) {
            await this.#recover(work, "running_bound");
            return;
          }
          await this.#contractFailure(work);
          return;
        }
        events += 1;
        if (events > CONNECTOR_LIMITS.normalizedEvents) {
          await this.#cancelUncertain(work, "output_limit", false);
          return;
        }
        const event = pulled.value;
        if (
          event !== null &&
          typeof event === "object" &&
          !Array.isArray(event) &&
          ((event as { event?: unknown }).event === "progress" ||
            (event as { event?: unknown }).event === "reply") &&
          typeof (event as { text?: unknown }).text === "string" &&
          Buffer.byteLength((event as { text: string }).text, "utf8") >
            CONNECTOR_LIMITS.finalReplyBytes
        ) {
          await this.#cancelUncertain(work, "output_limit", false);
          return;
        }
        if (
          !exactObject(event, this.#eventKeys(event)) ||
          event.execution_id !== work.executionId
        ) {
          await this.#contractFailure(work);
          return;
        }
        const kind = event.event;
        if (kind === "session_bound") {
          if (phase !== "start_unbound" || !providerId(event.provider_session_id)) {
            await this.#contractFailure(work);
            return;
          }
          if (this.options.failStateAfter === "session_bound") {
            await this.#stateFailure(work);
            return;
          }
          work.sessionId = event.provider_session_id;
          this.#state.bindSession(
            work.message.conversation_id,
            work.message.id,
            work.sessionId,
            this.#clock.nowMs(),
            this.options.failPairedStateWriteAfter === "conversation_update",
          );
          phase = "turn_unbound";
          if (this.options.crashForRecoveryState === "session_binding")
            throw new Error("connector_test_crash");
          continue;
        }
        if (kind === "turn_bound") {
          if (
            (phase !== "turn_unbound" && phase !== "recover_unbound") ||
            !providerId(event.provider_turn_id) ||
            work.sessionId === null
          ) {
            await this.#contractFailure(work);
            return;
          }
          if (this.options.failStateAfter === "turn_bound") {
            await this.#stateFailure(work);
            return;
          }
          work.turnId = event.provider_turn_id;
          this.#state.bindTurn(work.message.id, work.sessionId, work.turnId, this.#clock.nowMs());
          phase = "running_bound";
          if (this.options.processBarrierForTest !== undefined)
            await this.options.processBarrierForTest("turn_published");
          if (this.options.crashAfter === "turn_published") throw new Error("connector_test_crash");
          continue;
        }
        if (kind === "progress") {
          if (
            !scalarText(event.text, CONNECTOR_LIMITS.finalReplyBytes) ||
            ![
              "turn_unbound",
              "running_bound",
              "running_unbound",
              "recover_terminal_only",
              "recover_reply_only",
            ].includes(phase)
          ) {
            await this.#contractFailure(work);
            return;
          }
          if (phase === "turn_unbound") {
            if (this.options.failStateAfter === "first_progress") {
              await this.#stateFailure(work);
              return;
            }
            this.#state.transitionMessage(
              work.message.id,
              "turn_starting",
              "turn_running",
              this.#clock.nowMs(),
            );
            phase = "running_unbound";
            if (this.options.crashAtUnboundState === "turn_running")
              throw new Error("connector_test_crash");
          }
          work.sawStatefulProgress = true;
          continue;
        }
        if (kind === "approval_required") {
          if (
            !providerId(event.approval_request_id) ||
            ![
              "turn_unbound",
              "running_bound",
              "running_unbound",
              "recover_waiting_bound",
              "recover_terminal_only",
            ].includes(phase)
          ) {
            await this.#contractFailure(work);
            return;
          }
          if (this.options.failStateAfter === "approval_required") {
            await this.#stateFailure(work);
            return;
          }
          if (phase === "turn_unbound")
            this.#state.transitionMessage(
              work.message.id,
              "turn_starting",
              "waiting_for_approval",
              this.#clock.nowMs(),
            );
          else if (phase === "running_bound" || phase === "running_unbound")
            this.#state.transitionMessage(
              work.message.id,
              "turn_running",
              "waiting_for_approval",
              this.#clock.nowMs(),
            );
          work.approvalId = event.approval_request_id;
          phase = work.turnId === null ? "waiting_unbound" : "waiting_bound";
          if (
            this.options.crashAtUnboundState === "waiting_for_approval" ||
            this.options.crashForRecoveryState === "approval_wait"
          )
            throw new Error("connector_test_crash");
          continue;
        }
        if (kind === "approval_resolved") {
          if (
            (phase !== "waiting_bound" &&
              phase !== "waiting_unbound" &&
              phase !== "recover_waiting_bound") ||
            event.approval_request_id !== work.approvalId ||
            (event.decision !== "approved" && event.decision !== "denied")
          ) {
            await this.#contractFailure(work);
            return;
          }
          this.#state.transitionMessage(
            work.message.id,
            "waiting_for_approval",
            "turn_running",
            this.#clock.nowMs(),
          );
          work.approvalId = null;
          phase = work.turnId === null ? "running_unbound" : "running_bound";
          continue;
        }
        const terminal = this.#terminal(event, phase, work);
        if (terminal === undefined) {
          await this.#contractFailure(work);
          return;
        }
        if (this.options.processBarrierForTest !== undefined)
          await this.options.processBarrierForTest("provider_terminal_received");
        if (this.options.crashAfter === "provider_terminal_received")
          throw new Error("connector_test_crash");
        if (this.options.failStateAfter === "terminal_plan") {
          await this.#stateFailure(work);
          return;
        }
        await work.iterator.return?.();
        await this.#publishAndDeliver(work, terminal);
        return;
      }
    } catch (error) {
      if (this.#stopping || this.#closed) return;
      if (error instanceof Error && error.message === "connector_test_crash") {
        this.#fail(error);
        return;
      }
      if (error instanceof ConnectorError && error.code === "connector_state_unavailable") {
        await this.#stateFailure(work);
        return;
      }
      await this.#cancelUncertain(work, "contract_failure", false);
    }
  }

  #eventKeys(value: unknown): readonly string[] {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
    const event = (value as Record<string, unknown>).event;
    if (event === "session_bound") return ["event", "execution_id", "provider_session_id"];
    if (event === "turn_bound") return ["event", "execution_id", "provider_turn_id"];
    if (event === "progress" || event === "reply") return ["event", "execution_id", "text"];
    if (event === "approval_required") return ["event", "execution_id", "approval_request_id"];
    if (event === "approval_resolved")
      return ["event", "execution_id", "approval_request_id", "decision"];
    if (event === "completed_without_reply") return ["event", "execution_id"];
    if (["unsupported", "failed", "cancelled", "uncertain"].includes(String(event)))
      return ["event", "execution_id", "reason_code"];
    return [];
  }

  #terminal(event: Record<string, unknown>, phase: string, work: Work): Terminal | undefined {
    const kind = event.event;
    const preDispatch = phase === "start_unbound" || phase === "turn_unbound";
    if ((phase === "waiting_bound" || phase === "waiting_unbound") && !work.cancellationRequested)
      return undefined;
    if (phase === "recover_unbound" && kind !== "uncertain") return undefined;
    if (phase === "recover_reply_only" && kind !== "reply") return undefined;
    if (
      phase === "start_unbound" &&
      (kind === "reply" ||
        kind === "completed_without_reply" ||
        (kind === "failed" && event.reason_code !== "provider_start_failed"))
    )
      return undefined;
    if (kind === "reply") {
      if (!scalarText(event.text, CONNECTOR_LIMITS.finalReplyBytes)) return undefined;
      return { operation: "reply", text: event.text };
    }
    if (kind === "completed_without_reply")
      return {
        operation: "complete",
        outcome: "completed_without_reply",
        reason: "no_reply_required",
      };
    if (
      kind === "unsupported" &&
      typeof event.reason_code === "string" &&
      COMPLETION_REASONS.unsupported?.includes(event.reason_code)
    ) {
      return preDispatch
        ? { operation: "complete", outcome: "unsupported", reason: event.reason_code }
        : undefined;
    }
    if (
      kind === "failed" &&
      typeof event.reason_code === "string" &&
      COMPLETION_REASONS.failed?.includes(event.reason_code)
    ) {
      if (event.reason_code === "provider_start_failed" && !preDispatch) return undefined;
      return { operation: "complete", outcome: "failed", reason: event.reason_code };
    }
    if (
      kind === "cancelled" &&
      typeof event.reason_code === "string" &&
      COMPLETION_REASONS.cancelled?.includes(event.reason_code)
    ) {
      if (event.reason_code === "cancelled_before_execution" && !preDispatch) return undefined;
      if (event.reason_code === "cancelled_during_safe_wait") {
        if (
          work.sawStatefulProgress ||
          !["turn_unbound", "waiting_unbound", "waiting_bound"].includes(phase)
        )
          return undefined;
      } else if (workPhaseExecuted(phase)) return undefined;
      return { operation: "complete", outcome: "cancelled", reason: event.reason_code };
    }
    if (kind === "uncertain" && event.reason_code === "provider_outcome_unknown")
      return { operation: "complete", outcome: "uncertain", reason: "provider_outcome_unknown" };
    return undefined;
  }

  async #publishAndDeliver(work: Work, terminal: Terminal): Promise<void> {
    this.#clock.clearTimer(work.deadlineTimer);
    work.terminal = terminal;
    work.replyText = terminal.operation === "reply" ? terminal.text : null;
    const row = this.#state.readMessage(work.message.id) as StoredMessage;
    if (
      terminal.operation === "complete" &&
      terminal.outcome === "uncertain" &&
      row.lifecycle !== "uncertain"
    ) {
      if (
        ["binding", "turn_starting", "turn_running", "waiting_for_approval"].includes(row.lifecycle)
      ) {
        this.#state.transitionPair({
          conversationId: work.message.conversation_id,
          messageId: work.message.id,
          fromConversation: ["binding", "active"],
          fromMessage: row.lifecycle,
          toConversation: "uncertain",
          toMessage: "uncertain",
          nowMs: this.#clock.nowMs(),
          ...(this.options.failPairedStateWriteAfter === "uncertain_after_message_update"
            ? { failAfter: "uncertain_after_message_update" as const }
            : {}),
        });
        work.conversation = this.#state.readConversation(
          work.message.conversation_id,
        ) as StoredConversation;
      }
      if (this.options.crashForRecoveryState === "uncertain")
        throw new Error("connector_test_crash");
    }
    const current = this.#state.readMessage(work.message.id) as StoredMessage;
    const values =
      terminal.operation === "reply"
        ? {
            terminal_operation: "reply",
            retry_kind: null,
            retry_not_before_ms: null,
          }
        : {
            terminal_operation: "complete",
            completion_outcome: terminal.outcome,
            completion_reason: terminal.reason,
            retry_kind: null,
            retry_not_before_ms: null,
          };
    const conversation = this.#state.readConversation(work.message.conversation_id);
    if (conversation === undefined) throw new ConnectorError("connector_state_unavailable");
    this.#state.transitionPair({
      conversationId: work.message.conversation_id,
      messageId: work.message.id,
      fromConversation: conversation.lifecycle,
      fromMessage: current.lifecycle,
      toConversation: conversation.lifecycle,
      toMessage: "central_pending",
      nowMs: this.#clock.nowMs(),
      messageValues: values,
    });
    await this.#centralLoop(work);
  }

  async #centralLoop(work: Work): Promise<void> {
    while (!this.#closed) {
      let row = this.#state.readMessage(work.message.id) as StoredMessage;
      if (row.retryNotBeforeMs !== null && this.#clock.nowMs() < row.retryNotBeforeMs)
        await sleep(this.#clock, row.retryNotBeforeMs - this.#clock.nowMs());
      row = this.#state.readMessage(work.message.id) as StoredMessage;
      const kind =
        row.lifecycle === "ack_pending" ? "ack" : (row.retryKind ?? row.terminalOperation);
      if (kind === null) throw new ConnectorError("connector_state_unavailable");
      const attempt = Math.min(row.retryAttemptCount + 1, 255);
      this.#state.transitionMessage(
        work.message.id,
        row.lifecycle,
        row.lifecycle,
        this.#clock.nowMs(),
        { retry_kind: kind, retry_not_before_ms: null, retry_attempt_count: attempt },
      );
      try {
        if (kind === "reply") {
          if (work.replyText === null) {
            await this.#moveLostReplyToUncertain(work);
            continue;
          }
          this.#state.beforeExternalEffect();
          const result = await this.#gateway.call("reply_message", {
            message_id: work.message.id,
            payload: { text: work.replyText },
          });
          if (
            !exactObject(result, ["message_id", "conversation_id", "status"]) ||
            result.status !== "accepted" ||
            !gatewayId(result.message_id) ||
            !gatewayId(result.conversation_id) ||
            result.conversation_id !== work.message.conversation_id
          )
            throw new GatewayObservation("contract");
          if (this.options.crashAfter === "reply_accepted") {
            this.#state.transitionMessage(
              work.message.id,
              "central_pending",
              "central_pending",
              this.#clock.nowMs(),
              {
                retry_kind: "outcome_lookup",
                retry_not_before_ms: null,
                retry_attempt_count: attempt,
              },
            );
            throw new Error("connector_test_crash");
          }
          const conversation = this.#state.readConversation(work.message.conversation_id);
          if (conversation === undefined) throw new ConnectorError("connector_state_unavailable");
          this.#state.transitionPair({
            conversationId: work.message.conversation_id,
            messageId: work.message.id,
            fromConversation: conversation.lifecycle,
            fromMessage: "central_pending",
            toConversation: conversation.lifecycle,
            toMessage: "ack_pending",
            nowMs: this.#clock.nowMs(),
            messageValues: { retry_kind: null, retry_not_before_ms: null },
          });
          if (this.options.processBarrierForTest !== undefined)
            await this.options.processBarrierForTest("reply_accepted");
          continue;
        }
        if (kind === "complete") {
          const terminal = work.terminal;
          if (terminal?.operation !== "complete")
            throw new ConnectorError("connector_state_unavailable");
          this.#state.beforeExternalEffect();
          const result = await this.#gateway.call("complete_message", {
            message_id: work.message.id,
            outcome: terminal.outcome,
            reason_code: terminal.reason,
          });
          if (
            !exactObject(result, ["message_id", "outcome", "status"]) ||
            !gatewayId(result.message_id) ||
            result.message_id !== work.message.id ||
            result.outcome !== terminal.outcome ||
            result.status !== "recorded"
          )
            throw new GatewayObservation("contract");
          if (this.options.crashAfter === "completion_accepted") {
            this.#state.transitionMessage(
              work.message.id,
              "central_pending",
              "central_pending",
              this.#clock.nowMs(),
              {
                retry_kind: "outcome_lookup",
                retry_not_before_ms: null,
                retry_attempt_count: attempt,
              },
            );
            throw new Error("connector_test_crash");
          }
          this.#state.transitionPair({
            conversationId: work.message.conversation_id,
            messageId: work.message.id,
            fromConversation: ["binding", "active", "uncertain"],
            fromMessage: "central_pending",
            toConversation: "closed",
            toMessage: "ack_pending",
            nowMs: this.#clock.nowMs(),
            messageValues: { retry_kind: null, retry_not_before_ms: null },
            ...(this.options.failPairedStateWriteAfter === "completion_after_conversation_update"
              ? { failAfter: "completion_after_conversation_update" as const }
              : {}),
          });
          continue;
        }
        if (kind === "outcome_lookup") {
          this.#state.beforeExternalEffect();
          const result = await this.#gateway.call("get_message_outcome", {
            message_id: work.message.id,
          });
          if (
            !exactObject(result, [
              "message_id",
              "conversation_id",
              "status",
              "outcome",
              "reply_message_id",
            ]) ||
            !gatewayId(result.message_id) ||
            !gatewayId(result.conversation_id) ||
            result.message_id !== work.message.id ||
            result.conversation_id !== work.message.conversation_id
          )
            throw new GatewayObservation("contract");
          if (this.options.crashAfter === "outcome_observed")
            throw new Error("connector_test_crash");
          if (result.status === "terminal") {
            const replyPlan = row.terminalOperation === "reply";
            if (
              replyPlan
                ? result.outcome !== "replied" || !gatewayId(result.reply_message_id)
                : result.outcome !== row.completionOutcome || result.reply_message_id !== null
            )
              throw new GatewayObservation("contract");
            const conversation = this.#state.readConversation(work.message.conversation_id);
            if (conversation === undefined) throw new ConnectorError("connector_state_unavailable");
            this.#state.transitionPair({
              conversationId: work.message.conversation_id,
              messageId: work.message.id,
              fromConversation: conversation.lifecycle,
              fromMessage: "central_pending",
              toConversation: replyPlan ? conversation.lifecycle : "closed",
              toMessage: "ack_pending",
              nowMs: this.#clock.nowMs(),
              messageValues: { retry_kind: null, retry_not_before_ms: null },
            });
            continue;
          }
          if (
            result.status !== "open" ||
            result.outcome !== null ||
            result.reply_message_id !== null
          )
            throw new GatewayObservation("contract");
          if (this.options.crashForRecoveryState === "outcome_open")
            throw new Error("connector_test_crash");
          if (row.terminalOperation === "reply" && work.replyText === null) {
            if (work.turnId === null) {
              await this.#moveLostReplyToUncertain(work);
              continue;
            }
            await this.#recover(work, "recover_reply_only");
            return;
          }
          this.#state.transitionMessage(
            work.message.id,
            "central_pending",
            "central_pending",
            this.#clock.nowMs(),
            {
              retry_kind: row.terminalOperation,
              retry_not_before_ms: null,
              retry_attempt_count: attempt,
            },
          );
          continue;
        }
        this.#state.beforeExternalEffect();
        const result = await this.#gateway.call("ack_message", { message_id: work.message.id });
        if (
          !exactObject(result, ["message_id", "status"]) ||
          !gatewayId(result.message_id) ||
          result.message_id !== work.message.id ||
          result.status !== "acked"
        )
          throw new GatewayObservation("contract");
        if (this.options.crashAfter === "ack_accepted") throw new Error("connector_test_crash");
        const conversation = this.#state.readConversation(work.message.conversation_id);
        if (conversation === undefined) throw new ConnectorError("connector_state_unavailable");
        const reply = row.terminalOperation === "reply";
        this.#state.transitionPair({
          conversationId: work.message.conversation_id,
          messageId: work.message.id,
          fromConversation: conversation.lifecycle,
          fromMessage: "ack_pending",
          toConversation: reply ? "active" : "closed",
          toMessage: "closed",
          nowMs: this.#clock.nowMs(),
          messageValues: { retry_kind: null, retry_not_before_ms: null },
          ...(this.options.failPairedStateWriteAfter ===
          (reply
            ? "reply_ack_after_conversation_update"
            : "completion_ack_after_conversation_update")
            ? { failAfter: this.options.failPairedStateWriteAfter }
            : {}),
        });
        this.#state.deleteClosedMessage(work.message.id);
        this.#finish(work);
        return;
      } catch (error) {
        if (this.#stopping || this.#closed) return;
        if (error instanceof Error && error.message === "connector_test_crash") {
          this.#fail(error);
          return;
        }
        if (error instanceof GatewayObservation) {
          if (error.kind === "uncertain" || error.kind === "timeout") {
            if (kind === "reply" || kind === "complete") {
              if (kind === "reply") work.replyText = null;
              if (kind === "reply" && this.options.crashAfter === "reply_committed_unobserved") {
                this.#state.transitionMessage(
                  work.message.id,
                  "central_pending",
                  "central_pending",
                  this.#clock.nowMs(),
                  {
                    retry_kind: "outcome_lookup",
                    retry_not_before_ms: null,
                    retry_attempt_count: attempt,
                  },
                );
                throw new Error("connector_test_crash");
              }
              this.#schedule(work, "outcome_lookup", Math.max(30_000, backoff(attempt)), attempt);
            } else
              this.#schedule(
                work,
                kind,
                kind === "outcome_lookup" ? 30_000 : backoff(attempt),
                attempt,
              );
            continue;
          }
          if (error.kind === "application") {
            if (error.code === "temporarily_unavailable") {
              this.#schedule(
                work,
                kind,
                Math.max(kind === "outcome_lookup" ? 30_000 : 0, backoff(attempt)),
                attempt,
              );
              continue;
            }
            if (error.code === "rate_limited") {
              if (
                !Number.isSafeInteger(error.retryAfterMs) ||
                (error.retryAfterMs as number) < 1 ||
                (error.retryAfterMs as number) > 60_000
              ) {
                this.#blockAndFail(work, "contract");
                return;
              }
              this.#schedule(
                work,
                kind,
                Math.max(
                  kind === "outcome_lookup" ? 30_000 : 0,
                  backoff(attempt),
                  error.retryAfterMs as number,
                ),
                attempt,
              );
              continue;
            }
            if (error.code === "mailbox_full" && kind === "reply") {
              this.#schedule(work, "reply", 30_000, attempt);
              continue;
            }
            if (
              error.code === "message_already_terminal" &&
              (kind === "reply" || kind === "complete")
            ) {
              this.#schedule(work, "outcome_lookup", 30_000, attempt);
              continue;
            }
            this.#blockAndFail(
              work,
              error.code === "authentication_failed"
                ? "authentication"
                : PERMANENT.has(error.code ?? "")
                  ? "permanent_application"
                  : "contract",
            );
            return;
          }
          this.#blockAndFail(work, "contract");
          return;
        }
        this.#fail(error);
        return;
      }
    }
  }

  #schedule(work: Work, kind: string, delay: number, attempt: number): void {
    const row = this.#state.readMessage(work.message.id) as StoredMessage;
    this.#state.transitionMessage(
      work.message.id,
      row.lifecycle,
      row.lifecycle,
      this.#clock.nowMs(),
      {
        retry_kind: kind,
        retry_not_before_ms: this.#clock.nowMs() + delay,
        retry_attempt_count: attempt,
      },
    );
  }

  #blockAndFail(work: Work, blockedClass: string): void {
    const row = this.#state.readMessage(work.message.id) as StoredMessage;
    this.#state.transitionMessage(work.message.id, row.lifecycle, "blocked", this.#clock.nowMs(), {
      blocked_class: blockedClass,
      retry_kind: null,
      retry_not_before_ms: null,
    });
    this.#fail(new ConnectorError("connector_gateway_operation_failed"));
  }

  async #moveLostReplyToUncertain(work: Work): Promise<void> {
    const row = this.#state.readMessage(work.message.id) as StoredMessage;
    const conversation = this.#state.readConversation(work.message.conversation_id);
    if (conversation === undefined) throw new ConnectorError("connector_state_unavailable");
    this.#state.transitionPair({
      conversationId: work.message.conversation_id,
      messageId: work.message.id,
      fromConversation: ["active", "uncertain"],
      fromMessage: row.lifecycle,
      toConversation: "uncertain",
      toMessage: "uncertain",
      nowMs: this.#clock.nowMs(),
      messageValues: {
        terminal_operation: null,
        completion_outcome: null,
        completion_reason: null,
        retry_kind: null,
        retry_not_before_ms: null,
      },
      ...(this.options.failPairedStateWriteAfter === "lost_reply_after_message_update"
        ? { failAfter: "lost_reply_after_message_update" as const }
        : {}),
    });
    if (this.options.crashAfterLostReplyUncertain) throw new Error("connector_test_crash");
    work.replyText = null;
    work.terminal = {
      operation: "complete",
      outcome: "uncertain",
      reason: "provider_outcome_unknown",
    };
    this.#state.transitionPair({
      conversationId: work.message.conversation_id,
      messageId: work.message.id,
      fromConversation: "uncertain",
      fromMessage: "uncertain",
      toConversation: "uncertain",
      toMessage: "central_pending",
      nowMs: this.#clock.nowMs(),
      messageValues: {
        terminal_operation: "complete",
        completion_outcome: "uncertain",
        completion_reason: "provider_outcome_unknown",
        retry_kind: null,
        retry_not_before_ms: null,
      },
    });
  }

  async #contractFailure(work: Work): Promise<void> {
    await this.#cancelUncertain(work, "contract_failure", false);
  }
  async #stateFailure(work: Work): Promise<void> {
    try {
      this.#state.beforeExternalEffect();
      await this.options.provider.cancel({
        kind: "cancel",
        execution_id: work.executionId,
        provider_session_id: work.sessionId,
        provider_turn_id: work.turnId,
        reason: "state_failure",
      });
    } catch {}
    try {
      this.#state.beforeExternalEffect();
      await this.options.provider.contain(work.executionId).catch(() => false);
    } catch {}
    this.#fail(new ConnectorError("connector_state_unavailable"));
  }

  async #cancelUncertain(
    work: Work,
    reason: string,
    deadline: boolean,
    issueCancel = true,
  ): Promise<void> {
    if (issueCancel) {
      try {
        this.#state.beforeExternalEffect();
        await this.options.provider.cancel({
          kind: "cancel",
          execution_id: work.executionId,
          provider_session_id: work.sessionId,
          provider_turn_id: work.turnId,
          reason,
        });
      } catch {}
    }
    if (deadline) await sleep(this.#clock, CONNECTOR_LIMITS.cancellationGraceMs);
    const contained = await this.#containWithinBound(work);
    if (!contained) {
      const row = this.#state.readMessage(work.message.id);
      if (row !== undefined)
        this.#state.transitionMessage(
          work.message.id,
          row.lifecycle,
          "blocked",
          this.#clock.nowMs(),
          { blocked_class: "cleanup", retry_kind: null, retry_not_before_ms: null },
        );
      this.#fail(new ConnectorError("connector_provider_cleanup_incomplete"));
      return;
    }
    if (!work.pullPending) {
      try {
        await work.iterator?.next();
      } catch {}
    }
    const current = this.#state.readMessage(work.message.id);
    if (
      current?.lifecycle === "central_pending" &&
      current.terminalOperation === "reply" &&
      work.replyText === null
    ) {
      await this.#moveLostReplyToUncertain(work);
      await this.#centralLoop(work);
      return;
    }
    await this.#publishAndDeliver(work, {
      operation: "complete",
      outcome: "uncertain",
      reason: "provider_outcome_unknown",
    });
  }

  async #containWithinBound(work: Work): Promise<boolean> {
    let timedOut = false;
    let timeoutTimer: unknown;
    const timeout = new Promise<false>((resolve) => {
      timeoutTimer = this.#clock.setTimer(() => {
        timedOut = true;
        resolve(false);
      }, CONNECTOR_LIMITS.containmentCleanupMs);
    });
    this.#state.beforeExternalEffect();
    try {
      const result = await Promise.race([
        this.options.provider.contain(work.executionId).catch(() => false),
        timeout,
      ]);
      return result === true && !timedOut;
    } finally {
      this.#clock.clearTimer(timeoutTimer);
    }
  }

  async #deadline(work: Work): Promise<void> {
    if (this.#stopping || this.#closed || !this.#active.has(work.message.id)) return;
    const storedDeadline = this.#state.readMessage(work.message.id)?.turnDeadlineMs;
    const cleanupAt =
      (storedDeadline ?? this.#clock.nowMs()) + CONNECTOR_LIMITS.cancellationGraceMs;
    const grace =
      this.#clock.nowMs() < cleanupAt
        ? new Promise<void>((resolve) => {
            work.deadlineTimer = this.#clock.setTimer(resolve, cleanupAt - this.#clock.nowMs());
          })
        : Promise.resolve();
    work.cancellationRequested = true;
    try {
      this.#state.beforeExternalEffect();
      void this.options.provider
        .cancel({
          kind: "cancel",
          execution_id: work.executionId,
          provider_session_id: work.sessionId,
          provider_turn_id: work.turnId,
          reason: "deadline",
        })
        .then((result) => {
          if (
            !exactObject(result, ["status"]) ||
            !["cancel_requested", "already_terminal", "not_found"].includes(String(result.status))
          )
            return;
          if (this.options.crashAfterCancellation) this.#fail(new Error("connector_test_crash"));
        })
        .catch(() => {});
    } catch {}
    await grace;
    if (!this.#active.has(work.message.id) || this.#fatal !== undefined) return;
    await this.#cancelUncertain(work, "deadline", false, false);
  }

  #prepareStartupRecovery(): Work[] {
    const prepared: Work[] = [];
    for (const stored of this.#state.allOpenMessages()) {
      const conversation = this.#state.readConversationByHmac(stored.conversationHmac);
      if (conversation === undefined) connectorError("connector_state_unavailable");
      if (stored.lifecycle === "blocked") connectorError("connector_message_blocked");
      if (stored.lifecycle === "received") {
        continue;
      }
      const work: Work = {
        message: {
          id: stored.messageId,
          conversation_id: conversation.conversationId,
          sender_agent_id: "recovery",
          message_type: "conversation_turn",
          in_reply_to_message_id: null,
          payload: { text: "recovery" },
          created_at: "1970-01-01T00:00:00.000Z",
        },
        conversation,
        stored,
        executionId: randomUUID(),
        sessionId: conversation.sessionId,
        turnId: stored.turnId,
        replyText: null,
        terminal:
          stored.terminalOperation === "complete"
            ? {
                operation: "complete",
                outcome: stored.completionOutcome as string,
                reason: stored.completionReason as string,
              }
            : null,
        deadlineTimer: undefined,
        iterator: null,
        pullPending: false,
        sawStatefulProgress: false,
        approvalId: null,
        cancellationRequested: false,
        startupRecovery: true,
      };
      this.#active.set(stored.messageId, work);
      this.#startupRecoveryIds.add(stored.messageId);
      prepared.push(work);
    }
    return prepared;
  }

  async #waitForStartupRecovery(): Promise<void> {
    if (this.#startupRecoveryIds.size === 0) return;
    await new Promise<void>((resolve) => this.#startupRecoveryWaiters.add(resolve));
  }

  #releaseStartupRecovery(work: Work): void {
    if (!work.startupRecovery || !this.#startupRecoveryIds.delete(work.message.id)) return;
    work.startupRecovery = false;
    if (this.#startupRecoveryIds.size !== 0) return;
    for (const resolve of this.#startupRecoveryWaiters) resolve();
    this.#startupRecoveryWaiters.clear();
  }

  async #recoverPrepared(work: Work): Promise<void> {
    try {
      const { stored } = work;
      if (stored.lifecycle === "binding") {
        await this.#publishAndDeliver(
          work,
          this.options.proveNoProviderDispatch
            ? { operation: "complete", outcome: "failed", reason: "provider_start_failed" }
            : {
                operation: "complete",
                outcome: "uncertain",
                reason: "provider_outcome_unknown",
              },
        );
        return;
      }
      if (stored.lifecycle === "turn_starting" && this.options.proveNoProviderDispatch) {
        await this.#publishAndDeliver(work, {
          operation: "complete",
          outcome: "failed",
          reason: "provider_start_failed",
        });
        return;
      }
      if (stored.lifecycle === "central_pending") {
        this.#state.transitionPair({
          conversationId: work.message.conversation_id,
          messageId: work.message.id,
          fromConversation: work.conversation.lifecycle,
          fromMessage: "central_pending",
          toConversation: work.conversation.lifecycle,
          toMessage: "central_pending",
          nowMs: this.#clock.nowMs(),
          messageValues: {
            retry_kind: "outcome_lookup",
            retry_not_before_ms: stored.retryNotBeforeMs,
          },
        });
        work.stored = this.#state.readMessage(work.message.id) as StoredMessage;
        await this.#centralLoop(work);
        return;
      }
      if (stored.lifecycle === "ack_pending") {
        await this.#centralLoop(work);
        return;
      }
      if (
        stored.lifecycle === "uncertain" &&
        stored.terminalOperation === null &&
        stored.retryAttemptCount > 0
      ) {
        await this.#publishAndDeliver(work, {
          operation: "complete",
          outcome: "uncertain",
          reason: "provider_outcome_unknown",
        });
        return;
      }
      if (
        stored.turnDeadlineMs !== null &&
        this.#clock.nowMs() >= stored.turnDeadlineMs &&
        ["turn_starting", "turn_running", "waiting_for_approval"].includes(stored.lifecycle)
      ) {
        const cleanupAt = stored.turnDeadlineMs + CONNECTOR_LIMITS.cancellationGraceMs;
        if (this.#clock.nowMs() < cleanupAt && work.sessionId !== null && work.turnId !== null) {
          this.#attachExpiredTurnForCancellation(work);
          return;
        }
        if (this.#clock.nowMs() < cleanupAt)
          await sleep(this.#clock, cleanupAt - this.#clock.nowMs());
        await this.#cancelUncertain(work, "deadline", false, false);
        return;
      }
      if (
        (stored.lifecycle === "turn_running" || stored.lifecycle === "waiting_for_approval") &&
        stored.turnId === null
      ) {
        await this.#publishAndDeliver(work, {
          operation: "complete",
          outcome: "uncertain",
          reason: "provider_outcome_unknown",
        });
        return;
      }
      if (
        work.conversation.sessionId !== null &&
        (stored.lifecycle === "turn_starting" || stored.turnId !== null)
      ) {
        await this.#recover(
          work,
          stored.lifecycle === "turn_starting"
            ? "recover_unbound"
            : stored.lifecycle === "waiting_for_approval"
              ? "recover_waiting_bound"
              : stored.lifecycle === "uncertain"
                ? "recover_terminal_only"
                : "running_bound",
        );
        return;
      }
      await this.#publishAndDeliver(work, {
        operation: "complete",
        outcome: "uncertain",
        reason: "provider_outcome_unknown",
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  #attachExpiredTurnForCancellation(work: Work): void {
    if (work.sessionId === null || work.turnId === null || work.stored.turnDeadlineMs === null)
      throw new ConnectorError("connector_state_unavailable");
    const request = {
      kind: "recover" as const,
      execution_id: work.executionId,
      conversation_id: work.message.conversation_id,
      message_id: work.message.id,
      provider_session_id: work.sessionId,
      provider_turn_id: work.turnId,
      deadline_unix_ms: work.stored.turnDeadlineMs,
    };
    work.deadlineTimer = this.#clock.setTimer(() => {
      void this.#deadline(work);
    }, 0);
    this.#state.beforeExternalEffect();
    this.#observeSpawn();
    this.options.provider.recover(request);
  }

  async #recover(work: Work, phase: string): Promise<void> {
    if (work.sessionId === null) {
      await this.#publishAndDeliver(work, {
        operation: "complete",
        outcome: "uncertain",
        reason: "provider_outcome_unknown",
      });
      return;
    }
    const request = {
      kind: "recover",
      execution_id: work.executionId,
      conversation_id: work.message.conversation_id,
      message_id: work.message.id,
      provider_session_id: work.sessionId,
      provider_turn_id: work.turnId,
      deadline_unix_ms: work.stored.turnDeadlineMs ?? this.#clock.nowMs(),
    };
    const deadline = work.stored.turnDeadlineMs;
    if (deadline === null) throw new ConnectorError("connector_state_unavailable");
    this.#clock.clearTimer(work.deadlineTimer);
    work.deadlineTimer = this.#clock.setTimer(
      () => {
        void this.#deadline(work);
      },
      Math.max(0, deadline - this.#clock.nowMs()),
    );
    this.#state.beforeExternalEffect();
    this.#observeSpawn();
    work.iterator = this.options.provider.recover(request)[Symbol.asyncIterator]();
    await this.#consume(work, phase, true);
  }

  #finish(work: Work): void {
    this.#clock.clearTimer(work.deadlineTimer);
    this.#active.delete(work.message.id);
    this.#releaseStartupRecovery(work);
    this.#pump();
  }
  #fail(error: unknown): void {
    if (this.#fatal !== undefined || this.#stopping || this.#closed) return;
    const normalized =
      error instanceof ConnectorError || error instanceof Error
        ? error
        : new ConnectorError("connector_internal_error");
    this.#fatal = normalized;
    for (const resolve of this.#startupRecoveryWaiters) resolve();
    this.#startupRecoveryWaiters.clear();
    this.#stopping = true;
    this.#closed = true;
    this.#clearActiveTimers();
    this.#queue.length = 0;
    this.#queued.clear();
    this.#starting.clear();
    try {
      this.#closeState();
    } catch {}
    const publicError =
      normalized instanceof ConnectorError
        ? normalized
        : new ConnectorError("connector_internal_error");
    const cleanupDeadline = this.#clock.nowMs() + 1_000;
    this.#closeAdmissionAndGateway();
    this.#fatalCleanup = this.#settlesBy(
      this.#receiverClose as Promise<void>,
      cleanupDeadline,
    ).then(async () => {
      await this.#closeManagedProvider(cleanupDeadline);
      this.#rejectFatal?.(publicError);
      this.#rejectFatal = undefined;
    });
    for (const waiter of this.#idleWaiters) waiter.reject(normalized);
    this.#idleWaiters.clear();
  }
  #settleIdle(): void {
    if (this.#fatal !== undefined) {
      for (const waiter of this.#idleWaiters) waiter.reject(this.#fatal);
      this.#idleWaiters.clear();
      return;
    }
    if (this.#queue.length === 0 && this.#starting.size === 0 && this.#active.size === 0) {
      for (const waiter of this.#idleWaiters) waiter.resolve();
      this.#idleWaiters.clear();
    }
  }
}

function workPhaseExecuted(phase: string): boolean {
  return [
    "running_bound",
    "running_unbound",
    "waiting_bound",
    "recover_terminal_only",
    "recover_reply_only",
  ].includes(phase);
}

function dormantProvider(provider: ProviderKind): ProviderPort {
  const unavailable = (): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          connectorError("connector_provider_unavailable");
        },
      };
    },
  });
  return {
    spawnRecord: {
      executable: provider,
      arguments: [],
      environment: {},
      shell: false,
    },
    containmentAttempts: 0,
    postTerminalDeliveries: 0,
    start: unavailable,
    resume: unavailable,
    recover: unavailable,
    async cancel() {
      return { accepted: false };
    },
    async contain() {
      return false;
    },
  };
}

export async function startConnector(options: {
  providerKind: ProviderKind;
  webhookPort: number;
  webhookToken: string;
  workingDirectory: string;
  policy: ConnectorPolicy;
  stateReservation: ConnectorStateReservation;
  providerFactory?: InternalProviderFactory;
}): Promise<ConnectorHandle> {
  const { providerFactory, ...foundation } = options;
  return await ConnectorRuntime.start(
    {
      ...foundation,
      gatewayEndpoint: "http://127.0.0.1:8787/mcp",
      stateDirectory: options.stateReservation.stateDirectory,
      provider: dormantProvider(options.providerKind),
    },
    providerFactory,
  );
}

export async function startConnectorRuntime(
  options: ConnectorFoundationOptions,
): Promise<ConnectorHandle> {
  return await ConnectorRuntime.start(options);
}
