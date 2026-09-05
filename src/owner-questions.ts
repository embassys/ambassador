import { createHash } from "node:crypto";
import { z } from "zod";
import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields, isCentralRecord } from "./central-json.js";
import { type CentralMessage, type CentralRestClient, CentralRestError } from "./central-rest.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";
import type { PendingActionInbox } from "./pending-action-inbox.js";
import { workflowUuid } from "./workflow-uuid.js";

const button = z.strictObject({
  label: z.string().min(1).max(64),
  value: z.string().min(1).max(64),
});
export const ownerQuestionSchema = z
  .strictObject({
    request_id: workflowUuid,
    call_id: workflowUuid,
    question: z.string().min(1).max(2_000),
    input_type: z.enum(["text", "buttons"]),
    options: z.array(button).min(1).max(10).optional(),
  })
  .refine((input) =>
    input.input_type === "text"
      ? input.options === undefined
      : input.options !== undefined &&
        new Set(input.options.map((option) => option.value)).size === input.options.length,
  );
export const ownerAnswerSchema = z
  .strictObject({
    request_id: workflowUuid,
    question_id: workflowUuid,
    call_id: workflowUuid,
    text: z.string().min(1).max(4_000).optional(),
    value: z.string().min(1).max(64).optional(),
  })
  .refine((input) => (input.text === undefined) !== (input.value === undefined));
const questionSchema = z.strictObject({
  request_id: workflowUuid,
  fingerprint: z.string().length(64),
  input: ownerQuestionSchema,
  source_message_id: workflowUuid,
  sender_agent_id: z.string().min(1).max(256),
  action_type: z.string().max(128),
  action_type_id: z.string().max(256).nullable().optional(),
  status: z.enum(["submitting", "waiting_for_owner", "answered", "uncertain", "rejected"]),
  remote_request_id: workflowUuid.optional(),
  answer_request_id: workflowUuid.optional(),
  answer_fingerprint: z.string().length(64).optional(),
  answer_created_at: z.iso.datetime().optional(),
  continuation_enqueued: z.boolean().optional(),
  answer_message_id: z.string().min(1).max(256).optional(),
  text: z.string().max(4_000).optional(),
  value: z.string().max(64).optional(),
});
type Question = z.infer<typeof questionSchema>;
export class OwnerQuestionError extends Error {
  constructor(
    readonly code:
      | "invalid_arguments"
      | "request_id_conflict"
      | "owner_question_pending"
      | "owner_question_not_found"
      | "invalid_owner_answer"
      | "action_call_not_pending"
      | "owner_question_invalid",
  ) {
    super("The owner question could not be completed");
    this.name = "OwnerQuestionError";
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
function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export class OwnerQuestions {
  readonly #store: EncryptedRecordStore<Question>;
  constructor(
    readonly options: {
      path: string;
      credential: LoadedCentralCredential;
      pending: PendingActionInbox;
      transport: Pick<CentralRestClient, "requestHumanInput">;
      enqueueContinuation: (message: CentralMessage) => void;
    },
  ) {
    this.#store = new EncryptedRecordStore(options.path, options.credential, {
      scope: "ambassador-owner-questions",
      indexedStates: true,
      identifier: (record) => record.request_id,
      parse: (bytes) => {
        const record = questionSchema.parse(JSON.parse(bytes.toString("utf8")));
        assertNoCentralCredentialFields(record);
        return record;
      },
      error: () => new OwnerQuestionError("owner_question_invalid"),
    });
  }
  #load(id: string): Question {
    const record = this.#store.get(id);
    if (record === undefined) throw new OwnerQuestionError("owner_question_not_found");
    return record;
  }
  #save(record: Question): void {
    this.#store.put(record, {
      replace: true,
      correlation: record.input.call_id,
      state:
        record.answer_request_id !== undefined && record.continuation_enqueued !== true ? 1 : 0,
    });
  }
  #response(record: Question): Record<string, unknown> {
    return {
      request_id: record.request_id,
      call_id: record.input.call_id,
      status: record.status === "submitting" ? "uncertain" : record.status,
      question: record.input.question,
      input_type: record.input.input_type,
      ...(record.input.options === undefined ? {} : { options: record.input.options }),
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(record.value === undefined ? {} : { value: record.value }),
      ...(record.status === "waiting_for_owner"
        ? {
            message:
              "The question was emailed to your owner. Keep this call pending; its matching answer will resume it. You may finish this turn.",
          }
        : {}),
      continuation: {
        tool: "message_box",
        arguments: { type: "check_owner", request_id: record.request_id },
      },
    };
  }
  get(id: string): Record<string, unknown> {
    return this.#response(this.#load(id));
  }
  forCall(callId: string): Record<string, unknown> | undefined {
    const record = this.#store.find(callId);
    return record === undefined
      ? undefined
      : {
          ...this.#response(record),
          answer: {
            tool: "message_box",
            required: {
              type: "answer_owner",
              request_id: { type: "string", format: "uuid" },
              question_id: record.request_id,
              call_id: callId,
              ...(record.input.input_type === "text"
                ? { text: { type: "string", minLength: 1, maxLength: 4_000 } }
                : { value: record.input.options?.map((option) => option.value) }),
            },
          },
        };
  }
  async ask(arguments_: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const parsed = ownerQuestionSchema.safeParse(arguments_);
    if (!parsed.success) throw new OwnerQuestionError("invalid_arguments");
    const input = parsed.data;
    assertNoCentralCredentialFields(input);
    signal.throwIfAborted();
    const hash = fingerprint(input);
    const prior = this.#store.get(input.request_id);
    if (prior !== undefined) {
      if (prior.fingerprint !== hash) throw new OwnerQuestionError("request_id_conflict");
      return this.#response(prior);
    }
    const call = this.options.pending.get(input.call_id);
    if (call === undefined || !workflowUuid.safeParse(call.source_message_id).success)
      throw new OwnerQuestionError("action_call_not_pending");
    const active = this.#store.find(input.call_id);
    if (active !== undefined && active.status !== "answered" && active.status !== "rejected")
      throw new OwnerQuestionError("owner_question_pending");
    let record: Question = {
      request_id: input.request_id,
      fingerprint: hash,
      input,
      source_message_id: call.source_message_id as string,
      sender_agent_id: call.sender_agent_id,
      action_type: call.action_type,
      ...(call.action_type_id === undefined ? {} : { action_type_id: call.action_type_id }),
      status: "submitting",
    };
    this.#store.transaction(() => {
      if (active !== undefined) this.#store.put(active, { replace: true });
      this.#save(record);
    });
    try {
      const result = await this.options.transport.requestHumanInput(
        {
          permission_type: call.action_type,
          request: input.question,
          input_type: input.input_type,
          ...(input.options === undefined ? {} : { options: input.options }),
          message_id: record.source_message_id,
        },
        signal,
      );
      record = { ...record, status: "waiting_for_owner", remote_request_id: result.request_id };
      this.#save(record);
    } catch (error) {
      record = {
        ...record,
        status:
          error instanceof CentralRestError && error.response?.notAccepted === true
            ? "rejected"
            : "uncertain",
      };
      this.#save(record);
      if (signal.aborted) throw error;
    }
    return this.#response(record);
  }
  #validAnswer(record: Question, answer: { text?: unknown; value?: unknown }): boolean {
    return record.input.input_type === "text"
      ? typeof answer.text === "string" &&
          answer.text.length > 0 &&
          answer.text.length <= 4_000 &&
          answer.value == null
      : answer.text == null &&
          typeof answer.value === "string" &&
          record.input.options?.some((option) => option.value === answer.value) === true;
  }
  answer(arguments_: unknown): Record<string, unknown> {
    const parsed = ownerAnswerSchema.safeParse(arguments_);
    if (!parsed.success) throw new OwnerQuestionError("invalid_owner_answer");
    const input = parsed.data;
    assertNoCentralCredentialFields(input);
    const record = this.#load(input.question_id);
    const hash = fingerprint(input);
    if (record.answer_request_id === input.request_id) {
      if (record.answer_fingerprint !== hash) throw new OwnerQuestionError("request_id_conflict");
      this.#enqueueAnswer(record);
      return this.#response(record);
    }
    if (
      record.input.call_id !== input.call_id ||
      this.options.pending.get(input.call_id) === undefined ||
      record.status !== "waiting_for_owner" ||
      !this.#validAnswer(record, input)
    )
      throw new OwnerQuestionError("invalid_owner_answer");
    const answered: Question = {
      ...record,
      status: "answered",
      answer_request_id: input.request_id,
      answer_fingerprint: hash,
      answer_created_at: new Date().toISOString(),
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.value === undefined ? {} : { value: input.value }),
    };
    this.#save(answered);
    this.#enqueueAnswer(answered);
    return this.#response(answered);
  }
  #enqueueAnswer(record: Question): void {
    if (record.continuation_enqueued === true) return;
    if (record.answer_request_id === undefined || record.answer_created_at === undefined)
      throw new OwnerQuestionError("owner_question_invalid");
    if (this.#store.find(record.input.call_id)?.request_id !== record.request_id) {
      // An older retry must not reclaim the active call/question correlation.
      this.#store.put({ ...record, continuation_enqueued: true }, { replace: true, state: 0 });
      return;
    }
    // A reply may have completed while this local handoff was interrupted.
    if (this.options.pending.get(record.input.call_id) !== undefined) {
      this.options.enqueueContinuation({
        id: record.answer_request_id,
        sender_agent_id: record.sender_agent_id,
        ...(record.action_type_id === undefined ? {} : { action_type_id: record.action_type_id }),
        created_at: record.answer_created_at,
        payload: this.#answerPayload(record),
      });
    }
    this.#save({ ...record, continuation_enqueued: true });
  }
  recoverLocalContinuations(limit = 100): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new OwnerQuestionError("owner_question_invalid");
    for (let i = 0; i < limit; i++) {
      const record = this.#store.nextInStates([1]);
      if (record === undefined) return false;
      this.#enqueueAnswer(record);
    }
    return this.#store.nextInStates([1]) !== undefined;
  }
  isPendingLocalContinuation(message: CentralMessage): boolean {
    const questionId = message.payload.question_id;
    if (typeof questionId !== "string") return false;
    const record = this.#store.get(questionId);
    return (
      record !== undefined &&
      record.answer_request_id === message.id &&
      record.status === "answered" &&
      this.options.pending.get(record.input.call_id) !== undefined &&
      this.#store.find(record.input.call_id)?.request_id === record.request_id &&
      fingerprint(message.payload) === fingerprint(this.#answerPayload(record))
    );
  }
  permissionMessage(message: CentralMessage): CentralMessage {
    if (!this.isPendingLocalContinuation(message)) return message;
    const record = this.#load(message.payload.question_id as string);
    // The local delivery UUID is unknown to central. Provider approval still
    // refers to the original central-issued action-call notification.
    return { ...message, id: record.source_message_id };
  }
  #answerPayload(record: Question): Record<string, unknown> {
    return {
      type: "owner_input",
      call_id: record.input.call_id,
      question_id: record.request_id,
      action_type: record.action_type,
      question: record.input.question,
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(record.value === undefined ? {} : { value: record.value }),
    };
  }
  #forResponse(message: CentralMessage): Question | undefined {
    const payload = message.payload;
    if (payload.type !== "human_input_response" || typeof payload.message_id !== "string")
      return undefined;
    const call = this.options.pending.forMessage(payload.message_id);
    if (call === undefined) return undefined;
    const record = this.#store.find(call.call_id);
    if (
      record === undefined ||
      record.remote_request_id !== payload.request_id ||
      record.action_type !== payload.action_type ||
      record.input.question !== payload.prompt ||
      record.input.input_type !== payload.input_type ||
      !this.#validAnswer(record, payload)
    )
      return undefined;
    return record;
  }
  capture(message: CentralMessage): boolean {
    const record = this.#forResponse(message);
    if (record === undefined) return false;
    if (record.status === "answered")
      return (
        record.text === (message.payload.text ?? undefined) &&
        record.value === (message.payload.value ?? undefined)
      );
    if (record.status !== "waiting_for_owner" || message.id === undefined) return false;
    this.#save({
      ...record,
      status: "answered",
      answer_message_id: message.id,
      ...(typeof message.payload.text === "string"
        ? { text: message.payload.text }
        : { value: message.payload.value as string }),
    });
    return true;
  }
  deliveryMessage(message: CentralMessage): CentralMessage | undefined {
    const record = this.#forResponse(message);
    if (
      record === undefined ||
      record.status !== "answered" ||
      record.answer_message_id === undefined ||
      record.answer_message_id !== message.id
    )
      return undefined;
    return {
      ...message,
      sender_agent_id: record.sender_agent_id,
      ...(record.action_type_id === undefined ? {} : { action_type_id: record.action_type_id }),
      payload: this.#answerPayload(record),
    };
  }
  close(): void {
    this.#store.close();
  }
}
