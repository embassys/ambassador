import { setTimeout as delay } from "node:timers/promises";

import {
  ACP_TOOL_HUMAN_INPUT_TYPE,
  type CentralHumanInputRequest,
  type CentralHumanInputRequestResult,
  type CentralMessage,
  CentralRestError,
} from "./central-rest.js";
import type { AcpPermissionApproval, AcpPermissionRequest } from "./direct-delivery.js";
import type { VerboseLogger } from "./verbose-log.js";

const MAX_BUFFERED_MESSAGES = 256;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_TOOL_LABEL_LENGTH = 160;

export interface CentralAgentPermissionTransport {
  requestHumanInput(
    arguments_: CentralHumanInputRequest,
    signal?: AbortSignal,
  ): Promise<CentralHumanInputRequestResult>;
  pollRemoteMessages(
    timeout: number,
    signal?: AbortSignal,
  ): Promise<{ readonly messages: CentralMessage[] }>;
}

export interface CentralAgentPermissionCoordinatorOptions {
  readonly transport: CentralAgentPermissionTransport;
  readonly pollIntervalMs?: number;
  readonly log?: VerboseLogger;
}

export class CentralAgentPermissionError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "invalid_permission_request"
      | "invalid_permission_response"
      | "message_buffer_full",
  ) {
    super("Central agent permission failed");
    this.name = "CentralAgentPermissionError";
  }
}

function boundedLabel(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, MAX_TOOL_LABEL_LENGTH);
}

function humanInputArguments(request: AcpPermissionRequest): CentralHumanInputRequest {
  if (request.message.id === undefined) {
    throw new CentralAgentPermissionError("invalid_permission_request");
  }
  const title = boundedLabel(request.toolCall.title);
  const kind = boundedLabel(request.toolCall.kind);
  const agentName = `${request.agentKind.slice(0, 1).toUpperCase()}${request.agentKind.slice(1)}`;
  const tool = title ?? kind ?? "a local tool";
  return {
    message_id: request.message.id,
    permission_type: ACP_TOOL_HUMAN_INPUT_TYPE,
    request: `${agentName} wants to use the local tool “${tool}” while handling an Embassys request. Allow this once?`,
    input_type: "buttons",
    options: [
      { label: "Allow once", value: "allow_once" },
      { label: "Deny", value: "deny" },
    ],
  };
}

function outcomeDecision(
  message: CentralMessage,
  requestId: string,
  sourceMessageId: string,
  prompt: string,
): "allow" | "deny" | undefined {
  const payload = message.payload;
  if (payload.type !== "human_input_response" || payload.request_id !== requestId) {
    return undefined;
  }
  if (
    message.id === undefined ||
    payload.action_type !== ACP_TOOL_HUMAN_INPUT_TYPE ||
    payload.input_type !== "buttons" ||
    payload.prompt !== prompt ||
    payload.message_id !== sourceMessageId ||
    payload.text !== null
  ) {
    throw new CentralAgentPermissionError("invalid_permission_response");
  }
  if (payload.value === "deny") return "deny";
  if (payload.value === "allow_once") return "allow";
  throw new CentralAgentPermissionError("invalid_permission_response");
}

function retryablePollError(error: unknown): boolean {
  return (
    error instanceof CentralRestError &&
    (error.code === "central_request_failed" || error.code === "central_request_rejected")
  );
}

export class CentralAgentPermissionCoordinator {
  readonly #transport: CentralAgentPermissionTransport;
  readonly #pollIntervalMs: number;
  readonly #log: VerboseLogger;
  readonly #bufferedMessages: CentralMessage[] = [];
  readonly #internalMessageIds = new Set<string>();
  #approvalTail: Promise<void> = Promise.resolve();

  constructor(options: CentralAgentPermissionCoordinatorOptions) {
    this.#transport = options.transport;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#log = options.log ?? (() => undefined);
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 1) {
      throw new CentralAgentPermissionError("invalid_permission_request");
    }
  }

  readonly approve: AcpPermissionApproval = (request, signal) => {
    const operation = this.#approvalTail.then(async () => await this.#approve(request, signal));
    this.#approvalTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return this.#wait(operation, signal);
  };

  takeBufferedMessages(): readonly CentralMessage[] {
    return this.#bufferedMessages.splice(0, this.#bufferedMessages.length);
  }

  consumeInternalMessage(message: CentralMessage): boolean {
    if (message.id === undefined || !this.#internalMessageIds.delete(message.id)) return false;
    return true;
  }

  async #approve(request: AcpPermissionRequest, signal: AbortSignal): Promise<"allow" | "deny"> {
    if (signal.aborted) throw new CentralAgentPermissionError("cancelled");
    const arguments_ = humanInputArguments(request);
    const result = await this.#transport.requestHumanInput(arguments_, signal);
    this.#log("acp.permission.email_requested", {
      request_id: result.request_id,
      status: result.status,
    });

    while (!signal.aborted) {
      let messages: CentralMessage[];
      try {
        messages = (await this.#transport.pollRemoteMessages(0, signal)).messages;
      } catch (error) {
        if (signal.aborted) throw new CentralAgentPermissionError("cancelled");
        if (!retryablePollError(error)) throw error;
        await delay(this.#pollIntervalMs, undefined, { signal }).catch(() => undefined);
        continue;
      }
      if (this.#bufferedMessages.length + messages.length > MAX_BUFFERED_MESSAGES) {
        throw new CentralAgentPermissionError("message_buffer_full");
      }
      this.#bufferedMessages.push(...messages);
      let decision: "allow" | "deny" | undefined;
      for (const message of messages) {
        const candidate = outcomeDecision(
          message,
          result.request_id,
          arguments_.message_id,
          arguments_.request,
        );
        if (candidate === undefined) continue;
        if (decision !== undefined && decision !== candidate) {
          throw new CentralAgentPermissionError("invalid_permission_response");
        }
        decision = candidate;
        this.#internalMessageIds.add(message.id as string);
      }
      if (decision !== undefined) {
        this.#log("acp.permission.email_decided", {
          request_id: result.request_id,
          decision,
        });
        return decision;
      }
      await delay(this.#pollIntervalMs, undefined, { signal }).catch(() => undefined);
    }
    throw new CentralAgentPermissionError("cancelled");
  }

  async #wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new CentralAgentPermissionError("cancelled");
    let remove = (): void => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new CentralAgentPermissionError("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      remove = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      remove();
    }
  }
}
