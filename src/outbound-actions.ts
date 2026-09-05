import { randomUUID } from "node:crypto";
import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields, isCentralRecord } from "./central-json.js";
import {
  type CentralMessage,
  type CentralRestClient,
  normalizePermissionRequest,
} from "./central-rest.js";
import { EncryptedRecordStore, type RecordPage } from "./encrypted-record-store.js";
import { McpContractError } from "./mcp-contract.js";

const NAME = /^[A-Za-z0-9._~-]{1,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const STATUSES = [
  "request_uncertain",
  "awaiting_permission",
  "ready",
  "dispatch_uncertain",
  "submitted",
  "denied",
] as const;
type Status = (typeof STATUSES)[number];

export interface OutboundAction {
  readonly operation_id: string;
  readonly target_email: string;
  readonly action_type: string;
  readonly payload: Record<string, unknown>;
  readonly status: Status;
  readonly created_at: string;
  readonly permission_id?: string;
  readonly call_id?: string;
}

export class OutboundActionError extends Error {
  constructor() {
    super("The outbound action store is invalid");
    this.name = "OutboundActionError";
  }
}

function identifier(value: Pick<OutboundAction, "target_email" | "action_type">): string {
  return JSON.stringify([value.target_email.toLowerCase(), value.action_type]);
}

function parse(plaintext: Buffer): OutboundAction {
  const value: unknown = JSON.parse(plaintext.toString("utf8"));
  if (
    !isCentralRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "operation_id",
          "target_email",
          "action_type",
          "payload",
          "status",
          "created_at",
          "permission_id",
          "call_id",
        ].includes(key),
    ) ||
    typeof value.operation_id !== "string" ||
    !UUID.test(value.operation_id) ||
    typeof value.target_email !== "string" ||
    value.target_email.length > 254 ||
    !EMAIL.test(value.target_email) ||
    typeof value.action_type !== "string" ||
    !NAME.test(value.action_type) ||
    !isCentralRecord(value.payload) ||
    !STATUSES.includes(value.status as Status) ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    (value.permission_id !== undefined &&
      (typeof value.permission_id !== "string" || !NAME.test(value.permission_id))) ||
    (value.call_id !== undefined &&
      (typeof value.call_id !== "string" || !UUID.test(value.call_id))) ||
    (value.status !== "request_uncertain" && value.permission_id === undefined) ||
    (value.status === "submitted" && value.call_id === undefined)
  )
    throw new OutboundActionError();
  assertNoCentralCredentialFields(value);
  return value as unknown as OutboundAction;
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

export class OutboundActions {
  readonly #store: EncryptedRecordStore<OutboundAction>;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    path: string,
    credential: LoadedCentralCredential,
    readonly transport: Pick<CentralRestClient, "requestPermission" | "callAction">,
  ) {
    this.#store = new EncryptedRecordStore(path, credential, {
      scope: "ambassador-outbound-action",
      parse,
      identifier,
      error: () => new OutboundActionError(),
    });
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #save(value: OutboundAction): void {
    this.#store.put(value, {
      replace: true,
      ...(value.call_id === undefined
        ? value.permission_id === undefined
          ? {}
          : { correlation: `permission:${value.permission_id}` }
        : { correlation: `call:${value.call_id}` }),
    });
  }

  #result(value: OutboundAction): Record<string, unknown> {
    return {
      outbound_action: {
        operation_id: value.operation_id,
        status: value.status,
        ...(value.permission_id === undefined ? {} : { permission_id: value.permission_id }),
        ...(value.call_id === undefined ? {} : { call_id: value.call_id }),
      },
    };
  }

  request(
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#run(async () => {
      const { action_payload: payload, ...permissionArguments } = arguments_;
      const normalized = normalizePermissionRequest(permissionArguments);
      if (!Object.hasOwn(arguments_, "action_payload"))
        return await this.transport.requestPermission(normalized, signal);
      // An explicit address is required: an inferred message target cannot identify saved intent.
      if (
        !isCentralRecord(payload) ||
        typeof normalized.target_email !== "string" ||
        normalized.message_id !== undefined
      )
        throw new McpContractError();
      const actionType = normalized.action_type ?? normalized.permission_type;
      if (typeof actionType !== "string" || !NAME.test(actionType)) throw new McpContractError();
      assertNoCentralCredentialFields(payload);
      signal?.throwIfAborted();
      const key = { target_email: normalized.target_email, action_type: actionType };
      const previous = this.#store.get(identifier(key));
      if (previous !== undefined && previous.status !== "denied") {
        if (canonical(previous.payload) !== canonical(payload)) throw new McpContractError();
        return this.#result(
          previous.status === "ready" ? await this.#dispatch(previous, signal) : previous,
        );
      }
      let value: OutboundAction = {
        ...key,
        operation_id: randomUUID(),
        payload,
        status: "request_uncertain",
        created_at: new Date().toISOString(),
      };
      this.#save(value);
      // A crash or lost response leaves a visible uncertainty marker, never an automatic retry.
      const response = await this.transport.requestPermission(normalized, signal);
      value = {
        ...value,
        permission_id: response.permission_id,
        status:
          response.status === "granted" || response.already_granted === true
            ? "ready"
            : response.status === "denied"
              ? "denied"
              : "awaiting_permission",
      };
      this.#save(value);
      if (value.status === "ready") value = await this.#dispatch(value, signal);
      return { ...response, ...this.#result(value) };
    });
  }

  async #dispatch(value: OutboundAction, signal?: AbortSignal): Promise<OutboundAction> {
    signal?.throwIfAborted();
    const uncertain: OutboundAction = { ...value, status: "dispatch_uncertain" };
    this.#save(uncertain);
    try {
      const response = await this.transport.callAction(
        {
          target_email: value.target_email,
          action_type: value.action_type,
          payload: value.payload,
        },
        signal,
      );
      const submitted: OutboundAction = {
        ...value,
        status: "submitted",
        call_id: String(response.call_id),
      };
      this.#save(submitted);
      return submitted;
    } catch {
      return uncertain;
    }
  }

  capture(message: CentralMessage, signal?: AbortSignal): Promise<void> {
    return this.#run(async () => {
      const payload = message.payload;
      if (payload.type === "action_response" && typeof payload.call_id === "string") {
        const value = this.#store.find(`call:${payload.call_id}`);
        if (
          value !== undefined &&
          value.call_id === payload.call_id &&
          value.action_type === payload.action_type
        )
          this.#store.remove([identifier(value)]);
        return;
      }
      if (payload.type !== "permission_outcome" || typeof payload.permission_id !== "string")
        return;
      const value = this.#store.find(`permission:${payload.permission_id}`);
      if (
        value === undefined ||
        value.permission_id !== payload.permission_id ||
        value.status !== "awaiting_permission" ||
        typeof payload.grantor_email !== "string" ||
        payload.grantor_email.toLowerCase() !== value.target_email.toLowerCase() ||
        payload.action_type !== value.action_type
      )
        return;
      if (payload.granted === false && payload.status === "denied") {
        this.#save({ ...value, status: "denied" });
      } else if (payload.granted === true && payload.status === "granted") {
        const ready: OutboundAction = { ...value, status: "ready" };
        this.#save(ready);
        await this.#dispatch(ready, signal);
      }
    });
  }

  page(after = 0, limit = 50): RecordPage<OutboundAction> {
    return this.#store.page(after, limit);
  }

  close(): void {
    this.#store.close();
  }
}
