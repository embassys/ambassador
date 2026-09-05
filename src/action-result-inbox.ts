import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields, isCentralRecord } from "./central-json.js";
import type { CentralMessage } from "./central-rest.js";
import { EncryptedRecordStore, type RecordPage } from "./encrypted-record-store.js";

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTION_NAME = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface ReceivedActionResult {
  readonly call_id: string;
  readonly sender_agent_id: string;
  readonly action_type: string;
  readonly status: "success" | "error";
  readonly result: Record<string, unknown>;
  readonly created_at: string;
}

export class ActionResultInboxError extends Error {
  constructor() {
    super("The action result inbox is invalid");
    this.name = "ActionResultInboxError";
  }
}

function invalidInbox(): ActionResultInboxError {
  return new ActionResultInboxError();
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const names = Object.keys(value).sort();
  const expected = [...required].sort();
  return names.length === expected.length && expected.every((name, index) => names[index] === name);
}

function resultFromMessage(message: CentralMessage): ReceivedActionResult | undefined {
  if (message.payload.type !== "action_response") return undefined;
  if (
    !exactKeys(message.payload, ["type", "call_id", "action_type", "status", "result"]) ||
    typeof message.payload.call_id !== "string" ||
    !CALL_ID.test(message.payload.call_id) ||
    typeof message.payload.action_type !== "string" ||
    !ACTION_NAME.test(message.payload.action_type) ||
    (message.payload.status !== "success" && message.payload.status !== "error") ||
    !isCentralRecord(message.payload.result) ||
    typeof message.sender_agent_id !== "string" ||
    message.sender_agent_id.length < 1 ||
    message.sender_agent_id.length > 256 ||
    typeof message.created_at !== "string" ||
    message.created_at.length < 1 ||
    message.created_at.length > 128
  ) {
    throw invalidInbox();
  }
  try {
    assertNoCentralCredentialFields(message.payload.result);
  } catch {
    throw invalidInbox();
  }
  return {
    call_id: message.payload.call_id,
    sender_agent_id: message.sender_agent_id,
    action_type: message.payload.action_type,
    status: message.payload.status,
    result: message.payload.result,
    created_at: message.created_at,
  };
}

function parseActionResult(plaintext: Buffer): ReceivedActionResult {
  let value: unknown;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw invalidInbox();
  }
  if (
    !isCentralRecord(value) ||
    !exactKeys(value, [
      "call_id",
      "sender_agent_id",
      "action_type",
      "status",
      "result",
      "created_at",
    ])
  ) {
    throw invalidInbox();
  }
  return resultFromMessage({
    sender_agent_id: value.sender_agent_id as string,
    payload: {
      type: "action_response",
      call_id: value.call_id,
      action_type: value.action_type,
      status: value.status,
      result: value.result,
    },
    created_at: value.created_at as string,
  }) as ReceivedActionResult;
}

export class ActionResultInbox {
  readonly #store: EncryptedRecordStore<ReceivedActionResult>;

  constructor(
    path: string,
    credential: LoadedCentralCredential,
    options: { readonly maximumBytes?: number } = {},
  ) {
    this.#store = new EncryptedRecordStore(path, credential, {
      scope: "ambassador-action-result",
      parse: parseActionResult,
      identifier: (value) => value.call_id,
      error: invalidInbox,
      ...options,
    });
  }

  capture(message: CentralMessage): boolean {
    const value = resultFromMessage(message);
    return value === undefined ? false : this.#store.put(value);
  }

  get(callId: string): ReceivedActionResult | undefined {
    return this.#store.get(callId);
  }

  page(after = 0, limit = 50): RecordPage<ReceivedActionResult> {
    return this.#store.page(after, limit);
  }

  // A bounded convenience view. Production inbox traversal uses page().
  list(): ReceivedActionResult[] {
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
