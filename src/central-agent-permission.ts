import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ACP_TOOL_HUMAN_INPUT_TYPE,
  type CentralHumanInputRequest,
  type CentralHumanInputRequestResult,
  type CentralMessage,
} from "./central-rest.js";
import type { AcpPermissionApproval, AcpPermissionRequest } from "./direct-delivery.js";
import type { VerboseLogger } from "./verbose-log.js";

const MAX_TOOL_LABEL_LENGTH = 160;
const APPROVAL_TIMEOUT_MS = 72 * 60 * 60 * 1000;

export interface CentralAgentPermissionTransport {
  requestHumanInput(
    arguments_: CentralHumanInputRequest,
    signal?: AbortSignal,
    requestKey?: string,
  ): Promise<CentralHumanInputRequestResult>;
  resumeMutation?(
    operation: "get_human_input",
    key: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined>;
}

export interface CentralAgentPermissionCoordinatorOptions {
  readonly transport: CentralAgentPermissionTransport;
  readonly nextInvocation: (provider: string) => { provider_key: string; generation: number };
  readonly approvalTimeoutMs?: number;
  readonly log?: VerboseLogger;
  readonly onQuestion?: (requestId: string) => void;
  readonly waitForResponse: (requestId: string, signal: AbortSignal) => Promise<CentralMessage>;
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

function humanInputArguments(
  request: AcpPermissionRequest,
): CentralHumanInputRequest & { options: NonNullable<CentralHumanInputRequest["options"]> } {
  const displayable = (value: string): boolean =>
    value.trim().length > 0 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) as number;
      return code >= 32 && code !== 127;
    });
  if (
    request.message.id === undefined ||
    request.options.length < 1 ||
    request.options.length > 10 ||
    request.options.some(
      ({ name, optionId }) =>
        name.length < 1 ||
        name.length > 64 ||
        optionId.length < 1 ||
        optionId.length > 64 ||
        !displayable(name) ||
        !displayable(optionId),
    ) ||
    new Set(request.options.map(({ optionId }) => optionId)).size !== request.options.length
  ) {
    throw new CentralAgentPermissionError("invalid_permission_request");
  }
  const title = boundedLabel(request.toolCall.title);
  const kind = boundedLabel(request.toolCall.kind);
  const agentName = `${request.agentKind.slice(0, 1).toUpperCase()}${request.agentKind.slice(1)}`;
  const tool = title ?? kind ?? "a local tool";
  return {
    message_id: request.message.id,
    permission_type: ACP_TOOL_HUMAN_INPUT_TYPE,
    request: `${agentName} wants to use the local tool “${tool}” while handling an Embassys request. Choose one of the options provided by the agent.`,
    input_type: "buttons",
    options: request.options.map(({ name, optionId }) => ({ label: name, value: optionId })),
  };
}

function outcomeDecision(
  message: CentralMessage,
  requestId: string,
  sourceMessageId: string,
  prompt: string,
  options: NonNullable<CentralHumanInputRequest["options"]>,
): string | undefined {
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
  if (typeof payload.value === "string" && options.some(({ value }) => value === payload.value))
    return payload.value;
  throw new CentralAgentPermissionError("invalid_permission_response");
}

export class CentralAgentPermissionCoordinator {
  readonly #options: CentralAgentPermissionCoordinatorOptions;
  readonly #log: VerboseLogger;
  #approvalTail: Promise<void> = Promise.resolve();
  constructor(options: CentralAgentPermissionCoordinatorOptions) {
    this.#options = options;
    this.#log = options.log ?? (() => undefined);
    const timeout = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > APPROVAL_TIMEOUT_MS)
      throw new CentralAgentPermissionError("invalid_permission_request");
  }
  readonly approve: AcpPermissionApproval = (request, signal) => {
    if (signal.aborted) return Promise.reject(new CentralAgentPermissionError("cancelled"));
    const operation = this.#approvalTail.then(() => this.#boundedApproval(request, signal));
    this.#approvalTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return this.#wait(operation, signal);
  };
  async #boundedApproval(request: AcpPermissionRequest, parent: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
    );
    try {
      return await this.#wait(this.#approve(request, signal), signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async #approve(request: AcpPermissionRequest, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new CentralAgentPermissionError("cancelled");
    const question = humanInputArguments(request);
    const expires = Math.ceil((this.#options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS) / 1000);
    const args = {
      ...question,
      request_kind: "provider_option" as const,
      provider: { ...this.#options.nextInvocation(request.agentKind), expires_in_seconds: expires },
      expires_in_seconds: expires,
    };
    const key = randomUUID();
    let result: CentralHumanInputRequestResult;
    try {
      result = await this.#options.transport.requestHumanInput(args, signal, key);
    } catch (error) {
      if (!this.#options.transport.resumeMutation || signal.aborted) throw error;
      // Resume only this live ACP invocation. A restarted provider prompt is never replayed.
      let recovered: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 3 && !recovered; attempt++) {
        await delay(1000 * (attempt + 1), undefined, { signal });
        recovered = await this.#options.transport
          .resumeMutation("get_human_input", key, signal)
          .catch(() => undefined);
      }
      if (
        !recovered ||
        typeof recovered.request_id !== "string" ||
        recovered.status !== "pending" ||
        recovered.input_type !== "buttons"
      )
        throw error;
      result = recovered as unknown as CentralHumanInputRequestResult;
    }
    try {
      this.#options.onQuestion?.(result.request_id);
    } catch {
      /* A desktop banner is separate from the pending provider decision. */
    }
    this.#log("acp.permission.email_requested", {
      request_id: result.request_id,
      status: result.status,
    });
    const message = await this.#options.waitForResponse(result.request_id, signal);
    if (signal.aborted) throw new CentralAgentPermissionError("cancelled");
    const choice = outcomeDecision(
      message,
      result.request_id,
      args.message_id,
      args.request,
      args.options,
    );
    if (choice === undefined) throw new CentralAgentPermissionError("invalid_permission_response");
    this.#log("acp.permission.email_decided", { request_id: result.request_id, decision: choice });
    return choice;
  }
  async #wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let remove = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const cancel = () => reject(new CentralAgentPermissionError("cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      remove = () => signal.removeEventListener("abort", cancel);
      if (signal.aborted) cancel();
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      remove();
    }
  }
}
