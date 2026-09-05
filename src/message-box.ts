import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionCatalog } from "./action-catalog.js";
import type { ActionResultInbox } from "./action-result-inbox.js";
import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields, isCentralRecord } from "./central-json.js";
import { type CentralMessage, type CentralRestClient, CentralRestError } from "./central-rest.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";
import { LocalInbox } from "./local-inbox.js";
import { serializeLocalToolResult } from "./local-tool-result.js";
import type { CentralToolDefinition } from "./mcp-contract.js";
import type { OutboundActions } from "./outbound-actions.js";
import { type OwnerQuestions, ownerAnswerSchema, ownerQuestionSchema } from "./owner-questions.js";
import type { PendingActionInbox } from "./pending-action-inbox.js";
import type { VerboseLogger } from "./verbose-log.js";

export const MESSAGE_BOX_WAIT_MS = 600_000;
const name = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/u);
const uuid = z.uuid();
const object = z.record(z.string(), z.unknown());
const wait_seconds = z
  .number()
  .int()
  .min(0)
  .max(600)
  .optional()
  .describe(
    "Omit to wait up to 600 seconds. Use a shorter value only when the user requests it or a known client timeout limit requires it. Do not shorten the wait merely because the request is pending. Zero is for nonblocking observers.",
  );
const permissionFields = {
  action_type: name,
  target_email: z.string().min(3).max(254).optional(),
  message_id: uuid.optional(),
  decision_options: z.enum(["accept_deny", "once_always"]).optional(),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Explain the permission request to the target person's human. Use the user's stated purpose, or a neutral restatement of the requested action. Do not invent a purpose. Ask the user only if the required purpose cannot be established from their request.",
    ),
  scope: object.nullable().optional(),
};
const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("request_action"),
    request_id: uuid,
    ...permissionFields,
    target_email: z.string().min(3).max(254),
    message_id: z.never().optional(),
    payload: object,
    wait_seconds,
  }),
  z.strictObject({
    type: z.literal("request_permission"),
    request_id: uuid,
    ...permissionFields,
    wait_seconds,
  }),
  z.strictObject({
    type: z.literal("submit_action_result"),
    request_id: uuid,
    call_id: uuid,
    status: z.enum(["success", "error"]),
    result: object.describe(
      "The requested data or evidence of completed work, or a definitive error. An owner's approval to execute is not the action result. Never guess missing data or report an unperformed action as successful.",
    ),
  }),
  z.strictObject({
    type: z.literal("check"),
    request_id: uuid,
    cursor: uuid.optional(),
    wait_seconds,
  }),
  z.strictObject({ type: z.literal("ask_owner"), ...ownerQuestionSchema.shape }),
  z.strictObject({ type: z.literal("answer_owner"), ...ownerAnswerSchema.shape }),
  z.strictObject({ type: z.literal("check_owner"), request_id: uuid }),
  z.strictObject({ type: z.literal("acknowledge"), request_id: uuid, cursor: uuid }),
  z.strictObject({
    type: z.literal("acknowledge_results"),
    call_ids: z.array(uuid).min(1).max(100),
  }),
  z.strictObject({
    type: z.literal("inbox"),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(128).optional(),
  }),
]);
type Input = z.infer<typeof inputSchema>;
type Submission = Extract<
  Input,
  { type: "request_action" | "request_permission" | "submit_action_result" }
>;

function publicSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(inputSchema) as Record<string, unknown>;
  const properties: Record<string, unknown> = {};
  const types: string[] = [];
  for (const branch of schema.oneOf as Array<{
    properties: Record<string, Record<string, unknown>>;
  }>) {
    for (const [key, value] of Object.entries(branch.properties))
      if (!("not" in value)) properties[key] = value;
    types.push(String(branch.properties.type?.const));
  }
  properties.type = { type: "string", enum: types };
  properties.cursor = { type: "string", maxLength: 128 };
  return { ...schema, type: "object", properties, required: ["type"], additionalProperties: false };
}

export const MESSAGE_BOX_TOOL: CentralToolDefinition = {
  name: "message_box",
  description:
    "Send or check an Embassys business message. Use request_action with one exact catalog action_type and the user's exact payload; Ambassador requests that action's permission and dispatches once after a matching grant. Broad-sounding permission names do not authorize other actions. Supply a new UUID request_id for new work, and reuse it only with identical input. The initial call stays open up to ten minutes for a related update. Do not schedule a background check unless the user asks. On wait_timeout, tell the user no update has arrived and they can ask again; use the supplied check continuation for another ten-minute wait, never resubmit the action. Use inbox for pending incoming calls and unread results, submit_action_result to answer a known call after the user supplies missing information, and acknowledge returned event cursors or result IDs after processing them. Permissions are decided by the human email flow; there is no Ambassador UI or local permission decision. Request cancellation ends waiting, not an accepted action. Keep uncertain operations for inspection.",
  inputSchema: publicSchema(),
};

const eventSchema = z.strictObject({
  cursor: uuid,
  type: z.enum([
    "permission_status",
    "action_result",
    "action_result_submitted",
    "operation_status",
    "rejected",
    "uncertain",
  ]),
  data: object,
});
const operationSchema = z.strictObject({
  request_id: uuid,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  type: z.enum(["request_action", "request_permission", "submit_action_result"]),
  status: z.enum(["submitting", "pending", "completed", "rejected", "uncertain"]),
  created_at: z.string().max(64),
  action_type: name.optional(),
  action_type_id: z.string().max(256).optional(),
  target_email: z.string().max(254).optional(),
  permission_id: z.string().max(128).optional(),
  call_id: uuid.optional(),
  acknowledged_cursor: uuid.optional(),
  received_result_acknowledged: z.boolean().optional(),
  events: z.array(eventSchema).max(32),
});
type Operation = z.infer<typeof operationSchema>;

export class MessageBoxError extends Error {
  constructor(
    readonly code:
      | "invalid_arguments"
      | "request_id_conflict"
      | "operation_not_found"
      | "operation_already_pending"
      | "cursor_invalid"
      | "action_call_not_pending"
      | "message_box_capacity"
      | "message_box_invalid",
  ) {
    super("The message box operation could not be completed");
    this.name = "MessageBoxError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isCentralRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export interface MessageBoxOptions {
  readonly path: string;
  readonly credential: LoadedCentralCredential;
  readonly transport: Pick<
    CentralRestClient,
    "listActionTypes" | "requestPermission" | "submitActionResult"
  >;
  readonly outbound: OutboundActions;
  readonly pending: PendingActionInbox;
  readonly results: ActionResultInbox;
  readonly owners?: OwnerQuestions;
  readonly waitMs?: number;
  readonly completeAction?: (callId: string) => void;
  readonly expired?: () => boolean;
  readonly log?: VerboseLogger;
}

export class MessageBox {
  readonly #store: EncryptedRecordStore<Operation>;
  readonly #catalog: ActionCatalog;
  readonly #waitMs: number;
  readonly #lifetime = new AbortController();
  readonly #waiters = new Map<string, Set<() => void>>();
  #tail: Promise<void> = Promise.resolve();
  #waiting = 0;

  constructor(readonly options: MessageBoxOptions) {
    this.#waitMs = options.waitMs ?? MESSAGE_BOX_WAIT_MS;
    if (
      !Number.isSafeInteger(this.#waitMs) ||
      this.#waitMs < 1 ||
      this.#waitMs > MESSAGE_BOX_WAIT_MS
    )
      throw new MessageBoxError("invalid_arguments");
    this.#store = new EncryptedRecordStore(options.path, options.credential, {
      scope: "ambassador-message-box",
      identifier: (value) => value.request_id,
      parse: (plaintext) => {
        const value = operationSchema.parse(JSON.parse(plaintext.toString("utf8")));
        assertNoCentralCredentialFields(value);
        if (Buffer.byteLength(JSON.stringify(value.events)) > 32 * 1024)
          throw new MessageBoxError("message_box_capacity");
        return value;
      },
      error: () => new MessageBoxError("message_box_invalid"),
    });
    this.#catalog = new ActionCatalog(options.transport);
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #get(id: string): Operation {
    let operation = this.#store.get(id);
    if (operation === undefined) throw new MessageBoxError("operation_not_found");
    if (
      operation.type === "request_action" &&
      ["submitting", "uncertain"].includes(operation.status) &&
      operation.target_email !== undefined &&
      operation.action_type !== undefined
    ) {
      const outbound = this.options.outbound.get(operation.target_email, operation.action_type);
      if (
        outbound?.operation_id === id &&
        (outbound.permission_id !== undefined || outbound.call_id !== undefined)
      ) {
        operation = {
          ...operation,
          permission_id: outbound.permission_id,
          call_id: outbound.call_id,
          status: ["awaiting_permission", "submitted"].includes(outbound.status)
            ? "pending"
            : outbound.status.includes("rejected") || outbound.status === "denied"
              ? "rejected"
              : "uncertain",
        };
        if (operation.status === "pending")
          operation = this.#event(operation, "operation_status", {
            status: "pending",
            reason: "recovered_saved_submission",
          });
        this.#save(operation);
      }
    }
    if (
      operation.type === "submit_action_result" &&
      operation.status === "completed" &&
      operation.call_id !== undefined
    ) {
      this.options.pending.remove(operation.call_id);
      this.options.completeAction?.(operation.call_id);
    }
    if (operation.received_result_acknowledged && operation.call_id !== undefined)
      this.options.results.remove(operation.call_id);
    return operation;
  }

  #save(operation: Operation): void {
    const correlation =
      operation.call_id === undefined
        ? operation.permission_id === undefined ||
          (operation.type === "request_permission" && operation.status !== "pending")
          ? undefined
          : `permission:${operation.permission_id}`
        : `${operation.type === "submit_action_result" ? "reply" : "call"}:${operation.call_id}`;
    this.#store.put(operation, {
      replace: true,
      ...(correlation === undefined ? {} : { correlation }),
    });
    this.options.log?.("message_box.state", {
      request_id: operation.request_id,
      status: operation.status,
      permission_id: operation.permission_id,
      call_id: operation.call_id,
    });
    for (const wake of this.#waiters.get(operation.request_id) ?? []) wake();
  }

  async #recover(id: string, signal: AbortSignal): Promise<Operation> {
    const operation = this.#get(id);
    if (
      operation.type === "request_action" &&
      operation.target_email !== undefined &&
      operation.action_type !== undefined &&
      this.options.expired?.() !== true
    ) {
      await this.options.outbound.continuePrepared(
        operation.target_email,
        operation.action_type,
        id,
        signal,
      );
      return this.#get(id);
    }
    return operation;
  }

  #event(
    operation: Operation,
    type: z.infer<typeof eventSchema>["type"],
    data: Record<string, unknown>,
  ): Operation {
    return { ...operation, events: [...operation.events, { cursor: randomUUID(), type, data }] };
  }

  async call(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const parsed = inputSchema.safeParse(arguments_);
    if (!parsed.success) throw new MessageBoxError("invalid_arguments");
    const input = parsed.data;
    assertNoCentralCredentialFields(input);
    const combined = AbortSignal.any([signal, this.#lifetime.signal]);
    combined.throwIfAborted();
    const deadline =
      performance.now() +
      Math.min(
        this.#waitMs,
        "wait_seconds" in input && input.wait_seconds !== undefined
          ? input.wait_seconds * 1_000
          : this.#waitMs,
      );
    if (
      input.type === "ask_owner" ||
      input.type === "answer_owner" ||
      input.type === "check_owner"
    ) {
      const { type, ...arguments_ } = input;
      return await this.#run(async () => {
        combined.throwIfAborted();
        if (this.options.owners === undefined) throw new MessageBoxError("message_box_invalid");
        if (type === "check_owner") return this.options.owners.get(input.request_id);
        if (type === "answer_owner") return this.options.owners.answer(arguments_);
        return await this.options.owners.ask(arguments_, combined);
      });
    }
    if (input.type === "inbox") {
      const { type: _type, ...page } = input;
      return await this.#run(async () => {
        combined.throwIfAborted();
        const result = new LocalInbox(
          this.options.pending,
          this.options.results,
          this.options.outbound,
          this.options.owners,
        ).get(page, { signal: combined });
        // Reconcile only this bounded page after a crash between the operation
        // commit and its inbox cleanup. Preserve its cursor even for an empty page.
        const items = result.items.filter((item) => {
          if (typeof item.call_id !== "string") return true;
          const operation = this.#store.find(
            `${item.kind === "action_call" ? "reply" : "call"}:${item.call_id}`,
          );
          if (operation === undefined) return true;
          const reconciled = this.#get(operation.request_id);
          return item.kind === "action_call"
            ? reconciled.status !== "completed"
            : item.kind !== "action_result" || !reconciled.received_result_acknowledged;
        });
        return { ...result, count: items.length, items };
      });
    }
    if (input.type === "acknowledge_results")
      return await this.#run(async () => {
        combined.throwIfAborted();
        for (const callId of input.call_ids) {
          const operation = this.#store.find(`call:${callId}`);
          const last = operation?.events.at(-1);
          if (operation !== undefined && last !== undefined) this.#ack(operation, last.cursor);
          this.options.results.remove(callId);
        }
        return { status: "acknowledged" };
      });
    if (input.type === "check" || input.type === "acknowledge") {
      await this.#run(async () => {
        combined.throwIfAborted();
        const operation =
          input.type === "check"
            ? await this.#recover(input.request_id, combined)
            : this.#get(input.request_id);
        if (input.cursor !== undefined) this.#ack(operation, input.cursor);
      });
      if (input.type === "acknowledge")
        return { status: "acknowledged", request_id: input.request_id };
    } else {
      await this.#run(async () => await this.#submit(input, combined));
    }
    return await this.#wait(input.request_id, deadline, combined);
  }

  async #submit(input: Submission, signal: AbortSignal): Promise<void> {
    const { wait_seconds: _wait, ...stableInput } = input as Submission & { wait_seconds?: number };
    const fingerprint = createHash("sha256").update(canonical(stableInput)).digest("hex");
    const prior = this.#store.get(input.request_id);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) throw new MessageBoxError("request_id_conflict");
      await this.#recover(input.request_id, signal);
      return;
    }
    signal.throwIfAborted();
    let operation: Operation = {
      request_id: input.request_id,
      fingerprint,
      type: input.type,
      status: "submitting",
      created_at: new Date().toISOString(),
      events: [],
    };
    if (input.type !== "submit_action_result") {
      if (input.target_email === undefined && input.message_id === undefined)
        throw new MessageBoxError("invalid_arguments");
      const action = await this.#catalog.require(
        input.action_type,
        input.type === "request_action" ? input.payload : undefined,
        signal,
      );
      operation = {
        ...operation,
        action_type: action.name,
        action_type_id: action.id,
        ...(input.target_email === undefined ? {} : { target_email: input.target_email }),
      };
      if (input.type === "request_action") {
        const existing = this.options.outbound.get(input.target_email, input.action_type);
        if (
          existing !== undefined &&
          !["denied", "request_rejected", "dispatch_rejected"].includes(existing.status)
        )
          throw new MessageBoxError("operation_already_pending");
      }
    } else {
      if (this.options.pending.get(input.call_id) === undefined)
        throw new MessageBoxError("action_call_not_pending");
      if (this.#store.find(`reply:${input.call_id}`) !== undefined)
        throw new MessageBoxError("operation_already_pending");
      operation = { ...operation, call_id: input.call_id };
    }
    signal.throwIfAborted();
    this.#save(operation);
    try {
      const { type: _type, request_id: _requestId, ...arguments_ } = stableInput;
      if (input.type === "submit_action_result") {
        const result = await this.options.transport.submitActionResult(arguments_, signal);
        operation = this.#event(
          { ...operation, status: "completed" },
          "action_result_submitted",
          result,
        );
        this.#save(operation);
        this.options.pending.remove(input.call_id);
        this.options.completeAction?.(input.call_id);
        return;
      }
      if (input.type === "request_permission") {
        const result = await this.options.transport.requestPermission(arguments_, signal);
        operation = {
          ...operation,
          permission_id: result.permission_id,
          status:
            result.status === "pending"
              ? "pending"
              : result.status === "granted"
                ? "completed"
                : "rejected",
        };
        if (result.status !== "pending")
          operation = this.#event(operation, "permission_status", {
            permission_id: result.permission_id,
            action_type: input.action_type,
            status: result.status,
          });
      } else {
        const { payload, ...permissionArguments } = arguments_ as Record<string, unknown>;
        const response = await this.options.outbound.request(
          { ...permissionArguments, action_payload: payload },
          signal,
          input.request_id,
        );
        const outbound = this.options.outbound.get(input.target_email, input.action_type);
        if (outbound === undefined || !isCentralRecord(response.outbound_action))
          throw new MessageBoxError("message_box_invalid");
        operation = {
          ...operation,
          permission_id: outbound.permission_id,
          call_id: outbound.call_id,
          status: outbound.status.includes("uncertain")
            ? "uncertain"
            : outbound.status.includes("rejected") || outbound.status === "denied"
              ? "rejected"
              : "pending",
        };
        if (operation.status !== "pending")
          operation = this.#event(
            operation,
            operation.status === "uncertain" ? "uncertain" : "rejected",
            { reason: outbound.rejection?.reason ?? outbound.status },
          );
      }
      this.#save(operation);
    } catch (error) {
      if (
        input.type === "submit_action_result" &&
        this.#store.get(input.request_id)?.status === "completed"
      ) {
        // The server accepted this reply and completion is durable. A local
        // cleanup failure must not turn that known success into uncertainty.
        throw error;
      }
      const rejected =
        error instanceof CentralRestError &&
        (error.response?.notAccepted === true ||
          ["invalid_arguments", "credential_expired", "central_authentication_failed"].includes(
            error.code,
          ));
      const status = rejected ? "rejected" : "uncertain";
      this.#save(
        this.#event({ ...operation, status }, status, {
          error_code: error instanceof CentralRestError ? error.code : "submission_uncertain",
        }),
      );
      if (signal.aborted) throw error;
    }
  }

  #ack(operation: Operation, cursor: string): void {
    if (operation.acknowledged_cursor === cursor) {
      if (operation.received_result_acknowledged && operation.call_id !== undefined)
        this.options.results.remove(operation.call_id);
      return;
    }
    const index = operation.events.findIndex((event) => event.cursor === cursor);
    if (index < 0) throw new MessageBoxError("cursor_invalid");
    const acknowledged = operation.events.slice(0, index + 1);
    this.#save({
      ...operation,
      acknowledged_cursor: cursor,
      received_result_acknowledged:
        operation.received_result_acknowledged === true ||
        acknowledged.some((event) => event.type === "action_result"),
      events: operation.events.slice(index + 1),
    });
    for (const event of acknowledged) {
      if (event.type === "action_result" && typeof event.data.call_id === "string")
        this.options.results.remove(event.data.call_id);
    }
  }

  #response(operation: Operation, timedOut = false): Record<string, unknown> {
    const events = operation.events.map((event) => {
      if (event.type !== "action_result" || typeof event.data.call_id !== "string") return event;
      const result = this.options.results.get(event.data.call_id);
      return { ...event, data: result ?? { call_id: event.data.call_id, status: "acknowledged" } };
    });
    const cursor = events.at(-1)?.cursor ?? operation.acknowledged_cursor;
    const request_id = operation.request_id;
    const result = {
      request_id,
      operation_id: request_id,
      status: operation.status === "submitting" ? "uncertain" : operation.status,
      ...(operation.permission_id === undefined ? {} : { permission_id: operation.permission_id }),
      ...(operation.call_id === undefined ? {} : { call_id: operation.call_id }),
      events,
      ...(cursor === undefined ? {} : { cursor }),
      ...(timedOut
        ? {
            reason: "wait_timeout",
            message: "No update yet. Ask me to check this request again when you are ready.",
          }
        : {}),
      ...(operation.status === "submitting"
        ? {
            reason: "submission_uncertain",
            message: "The submission outcome is unknown. Do not send the action again.",
          }
        : {}),
      continuation: {
        tool: "message_box",
        arguments: { type: "check", request_id, ...(cursor === undefined ? {} : { cursor }) },
      },
      ...(events.length === 0
        ? {}
        : {
            receipt: {
              tool: "message_box",
              arguments: { type: "acknowledge", request_id, cursor },
            },
          }),
    };
    serializeLocalToolResult(result);
    return result;
  }

  async #wait(id: string, deadline: number, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#waiting >= 32) throw new MessageBoxError("message_box_capacity");
    this.#waiting += 1;
    try {
      while (true) {
        signal.throwIfAborted();
        const operation = this.#get(id);
        if (operation.events.length > 0 || operation.status !== "pending")
          return this.#response(operation);
        if (this.options.expired?.() === true)
          return {
            ...this.#response(operation),
            reason: "credential_expired",
            message:
              "Central delivery is paused because the credential expired. Preserve local enrollment.",
          };
        const remaining = deadline - performance.now();
        if (remaining <= 0) return this.#response(operation, true);
        await new Promise<void>((resolve) => {
          const callbacks = this.#waiters.get(id) ?? new Set<() => void>();
          const wake = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", wake);
            callbacks.delete(wake);
            if (callbacks.size === 0) this.#waiters.delete(id);
            resolve();
          };
          const timer = setTimeout(wake, remaining);
          callbacks.add(wake);
          this.#waiters.set(id, callbacks);
          signal.addEventListener("abort", wake, { once: true });
          if (signal.aborted) wake();
        });
      }
    } finally {
      this.#waiting -= 1;
    }
  }

  capture(message: CentralMessage): Promise<boolean> {
    return this.#run(async () => {
      if (message.payload.type === "human_input_response")
        return this.options.owners?.capture(message) ?? false;
      const saved = this.options.outbound.forMessage(message);
      if (saved !== undefined && this.#store.get(saved.operation_id) !== undefined)
        this.#get(saved.operation_id);
      if (
        message.payload.type === "action_response" &&
        typeof message.payload.call_id === "string"
      ) {
        const prior = this.#store.find(`call:${message.payload.call_id}`);
        if (prior?.status === "completed" && prior.action_type === message.payload.action_type) {
          if (prior.received_result_acknowledged)
            this.options.results.remove(message.payload.call_id);
          return true;
        }
      }
      this.options.pending.capture(message);
      this.options.results.capture(message);
      await this.options.outbound.capture(message, this.#lifetime.signal);
      const payload = message.payload;
      const correlation =
        payload.type === "permission_outcome" && typeof payload.permission_id === "string"
          ? `permission:${payload.permission_id}`
          : payload.type === "action_response" && typeof payload.call_id === "string"
            ? `call:${payload.call_id}`
            : undefined;
      if (correlation === undefined) return false;
      let operation = this.#store.find(correlation);
      if (
        operation === undefined ||
        operation.action_type !== payload.action_type ||
        (message.action_type_id != null && operation.action_type_id !== message.action_type_id)
      )
        return false;
      if (payload.type === "permission_outcome") {
        if (
          operation.target_email !== undefined &&
          (typeof payload.grantor_email !== "string" ||
            payload.grantor_email.toLowerCase() !== operation.target_email.toLowerCase())
        )
          return false;
        if (
          !["granted", "denied"].includes(String(payload.status)) ||
          payload.granted !== (payload.status === "granted")
        )
          return false;
        if (operation.status !== "pending") return true;
        operation = this.#event(operation, "permission_status", {
          permission_id: payload.permission_id,
          action_type: payload.action_type,
          status: payload.status,
        });
        if (operation.type === "request_permission")
          operation.status = payload.granted === true ? "completed" : "rejected";
        else {
          const outbound =
            operation.target_email === undefined || operation.action_type === undefined
              ? undefined
              : this.options.outbound.get(operation.target_email, operation.action_type);
          if (outbound === undefined || outbound.permission_id !== operation.permission_id)
            throw new MessageBoxError("message_box_invalid");
          operation = {
            ...operation,
            call_id: outbound.call_id,
            status: outbound.status.includes("uncertain")
              ? "uncertain"
              : outbound.status.includes("rejected") || outbound.status === "denied"
                ? "rejected"
                : "pending",
          };
          if (operation.status !== "pending")
            operation = this.#event(
              operation,
              operation.status === "uncertain" ? "uncertain" : "rejected",
              { reason: outbound.rejection?.reason ?? outbound.status },
            );
        }
      } else {
        if (operation.status === "completed") return true;
        if (this.options.results.get(String(payload.call_id)) === undefined)
          throw new MessageBoxError("message_box_invalid");
        operation = this.#event({ ...operation, status: "completed" }, "action_result", {
          call_id: payload.call_id,
        });
      }
      this.#save(operation);
      return true;
    });
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    await this.#tail;
    this.#store.close();
  }
}
