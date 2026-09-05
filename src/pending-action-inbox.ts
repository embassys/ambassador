import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields, isCentralRecord } from "./central-json.js";
import type { CentralMessage } from "./central-rest.js";
import { EncryptedRecordStore, type RecordPage } from "./encrypted-record-store.js";

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTION_NAME = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface PendingActionCall {
  readonly source_message_id?: string;
  readonly action_type_id?: string | null;
  readonly call_id: string;
  readonly sender_agent_id: string;
  readonly action_type: string;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

export class PendingActionInboxError extends Error {
  constructor() {
    super("The pending action inbox is invalid");
    this.name = "PendingActionInboxError";
  }
}

function invalidInbox(): PendingActionInboxError {
  return new PendingActionInboxError();
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const names = Object.keys(value)
    .filter((key) => !optional.includes(key))
    .sort();
  const expected = [...required].sort();
  return names.length === expected.length && expected.every((name, index) => names[index] === name);
}

function pendingActionFromMessage(message: CentralMessage): PendingActionCall | undefined {
  if (message.payload.type !== "action_call") return undefined;
  if (
    !exactKeys(message.payload, ["type", "call_id", "action_type", "payload"]) ||
    typeof message.payload.call_id !== "string" ||
    !CALL_ID.test(message.payload.call_id) ||
    typeof message.payload.action_type !== "string" ||
    !ACTION_NAME.test(message.payload.action_type) ||
    !isCentralRecord(message.payload.payload) ||
    typeof message.sender_agent_id !== "string" ||
    message.sender_agent_id.length < 1 ||
    message.sender_agent_id.length > 256 ||
    typeof message.created_at !== "string" ||
    message.created_at.length < 1 ||
    message.created_at.length > 128 ||
    (message.id !== undefined &&
      (typeof message.id !== "string" || message.id.length < 1 || message.id.length > 256)) ||
    (message.action_type_id != null &&
      (typeof message.action_type_id !== "string" || message.action_type_id.length > 256))
  ) {
    throw invalidInbox();
  }
  try {
    assertNoCentralCredentialFields(message.payload.payload);
  } catch {
    throw invalidInbox();
  }
  return {
    ...(message.id === undefined ? {} : { source_message_id: message.id }),
    ...(message.action_type_id === undefined ? {} : { action_type_id: message.action_type_id }),
    call_id: message.payload.call_id,
    sender_agent_id: message.sender_agent_id,
    action_type: message.payload.action_type,
    payload: message.payload.payload,
    created_at: message.created_at,
  };
}

function parsePendingAction(plaintext: Buffer): PendingActionCall {
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw invalidInbox();
  }
  if (
    !isCentralRecord(value) ||
    !exactKeys(
      value,
      ["call_id", "sender_agent_id", "action_type", "payload", "created_at"],
      ["source_message_id", "action_type_id"],
    )
  ) {
    throw invalidInbox();
  }
  return pendingActionFromMessage({
    ...(value.source_message_id === undefined ? {} : { id: value.source_message_id as string }),
    ...(value.action_type_id === undefined
      ? {}
      : { action_type_id: value.action_type_id as string | null }),
    sender_agent_id: value.sender_agent_id as string,
    payload: {
      type: "action_call",
      call_id: value.call_id,
      action_type: value.action_type,
      payload: value.payload,
    },
    created_at: value.created_at as string,
  }) as PendingActionCall;
}

export class PendingActionInbox {
  readonly #store: EncryptedRecordStore<PendingActionCall>;

  constructor(
    path: string,
    credential: LoadedCentralCredential,
    options: { readonly maximumBytes?: number } = {},
  ) {
    this.#store = new EncryptedRecordStore(path, credential, {
      scope: "ambassador-pending-action",
      parse: parsePendingAction,
      identifier: (value) => value.call_id,
      error: invalidInbox,
      ...options,
    });
  }

  capture(message: CentralMessage): boolean {
    const value = pendingActionFromMessage(message);
    return value === undefined
      ? false
      : this.#store.put(
          value,
          value.source_message_id === undefined ? {} : { correlation: value.source_message_id },
        );
  }

  forMessage(messageId: string): PendingActionCall | undefined {
    return this.#store.find(messageId);
  }

  get(callId: string): PendingActionCall | undefined {
    return this.#store.get(callId);
  }

  page(after = 0, limit = 50): RecordPage<PendingActionCall> {
    return this.#store.page(after, limit);
  }

  // A bounded convenience view. Production inbox traversal uses page().
  list(): PendingActionCall[] {
    return this.page(0, 256)
      .items.map((item) => item.value)
      .sort((left, right) =>
        left.created_at === right.created_at
          ? left.call_id.localeCompare(right.call_id)
          : left.created_at.localeCompare(right.created_at),
      );
  }

  remove(callId: string): boolean {
    return this.#store.remove([callId]) === 1;
  }

  removeMany(callIds: readonly string[]): number {
    return this.#store.remove(callIds);
  }

  close(): void {
    this.#store.close();
  }
}
