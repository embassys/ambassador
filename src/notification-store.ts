import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LoadedCentralCredential } from "./central-credential.js";
import type { CentralMessage } from "./central-rest.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";
import { validateNotificationId } from "./notification-journal.js";

export const storedCentralMessageSchema = z
  .object({
    id: z.string().optional(),
    sender_agent_id: z.string(),
    action_type_id: z.string().nullable().optional(),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .strict()
  .transform((value) => value as CentralMessage);
const recordSchema = z
  .object({
    id: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    message: storedCentralMessageSchema.optional(),
    processed: z.boolean(),
    delivery: z.enum(["pending", "dispatching", "completed", "uncertain", "skipped"]),
    acknowledgement: z.enum(["pending", "sending", "acked", "uncertain"]),
  })
  .strict();
export type StoredNotification = z.infer<typeof recordSchema>;
type Queue = "process" | "deliver" | "ack";
const deliveries = ["pending", "dispatching", "completed", "uncertain", "skipped"] as const;
const acknowledgements = ["pending", "sending", "acked", "uncertain"] as const;

export class NotificationStoreError extends Error {
  constructor() {
    super("Durable notification state is unavailable or invalid");
    this.name = "NotificationStoreError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function state(
  record: Pick<StoredNotification, "processed" | "delivery" | "acknowledgement">,
): number {
  return (
    (record.processed ? 32 : 0) +
    deliveries.indexOf(record.delivery) * 4 +
    acknowledgements.indexOf(record.acknowledgement)
  );
}
function statesFor(predicate: (record: StoredNotification) => boolean): number[] {
  const result: number[] = [];
  for (const processed of [false, true])
    for (const delivery of deliveries)
      for (const acknowledgement of acknowledgements) {
        const record = { id: "", fingerprint: "", processed, delivery, acknowledgement };
        if (predicate(record)) result.push(state(record));
      }
  return result;
}
const queues = {
  process: statesFor((r) => !r.processed),
  deliver: statesFor((r) => r.processed && r.delivery === "pending"),
  ack: statesFor((r) => r.acknowledgement === "pending"),
};
const interrupted = statesFor(
  (r) => r.delivery === "dispatching" || r.acknowledgement === "sending",
);

export class NotificationStore {
  readonly #records: EncryptedRecordStore<StoredNotification>;
  constructor(path: string, credential: LoadedCentralCredential, maximumBytes?: number) {
    this.#records = new EncryptedRecordStore(path, credential, {
      scope: "ambassador-notification-custody",
      indexedStates: true,
      ...(maximumBytes === undefined ? {} : { maximumBytes }),
      parse: (bytes) => recordSchema.parse(JSON.parse(bytes.toString("utf8"))),
      identifier: (record) => record.id,
      error: () => new NotificationStoreError(),
    });
  }
  ingest(messages: readonly CentralMessage[]): void {
    if (messages.length > 256 || Buffer.byteLength(JSON.stringify({ messages })) > 512 * 1024)
      throw new NotificationStoreError();
    const records = messages.map((value): StoredNotification => {
      const message = storedCentralMessageSchema.parse(value);
      if (message.id !== undefined) validateNotificationId(message.id);
      return {
        id: message.id ?? `local-${randomUUID()}`,
        message,
        fingerprint: createHash("sha256").update(canonical(message)).digest("hex"),
        processed: false,
        delivery: "pending",
        acknowledgement: message.id === undefined ? "acked" : "pending",
      };
    });
    this.#records.transaction(() => {
      for (const record of records) {
        const prior = this.get(record.id);
        if (prior !== undefined) {
          if (prior.fingerprint !== record.fingerprint) throw new NotificationStoreError();
          continue;
        }
        this.#save(record);
      }
    });
  }
  /** Internal owner continuations use durable delivery without a central receipt. */
  enqueueLocal(value: CentralMessage): void {
    const message = storedCentralMessageSchema.parse(value);
    if (
      message.id === undefined ||
      message.payload.type !== "owner_input" ||
      Buffer.byteLength(JSON.stringify(message)) > 512 * 1024
    )
      throw new NotificationStoreError();
    validateNotificationId(message.id);
    const record: StoredNotification = {
      id: `local-owner-${message.id}`,
      message,
      fingerprint: createHash("sha256").update(canonical(message)).digest("hex"),
      processed: true,
      delivery: "pending",
      acknowledgement: "acked",
    };
    const prior = this.get(record.id);
    if (prior !== undefined) {
      if (prior.fingerprint !== record.fingerprint) throw new NotificationStoreError();
      return;
    }
    this.#save(record);
  }
  get(id: string): StoredNotification | undefined {
    return this.#records.get(id);
  }
  next(queue: Queue): StoredNotification | undefined {
    return this.#records.nextInStates(queues[queue]);
  }
  #save(record: StoredNotification): void {
    if (
      record.processed &&
      ["completed", "skipped"].includes(record.delivery) &&
      record.acknowledgement !== "pending" &&
      record.acknowledgement !== "sending"
    ) {
      delete record.message;
    }
    this.#records.put(record, { replace: true, state: state(record) });
  }
  #update(id: string, mutate: (record: StoredNotification) => void): void {
    const record = this.get(id);
    if (record === undefined) throw new NotificationStoreError();
    mutate(record);
    this.#save(record);
  }
  processed(id: string, deliver: boolean): void {
    this.#update(id, (r) => {
      r.processed = true;
      if (!deliver && r.delivery === "pending") r.delivery = "skipped";
    });
  }
  beginDelivery(id: string): void {
    this.#update(id, (r) => {
      if (!r.processed || r.delivery !== "pending") throw new NotificationStoreError();
      r.delivery = "dispatching";
    });
  }
  delivered(id: string): void {
    this.#update(id, (r) => {
      if (r.delivery !== "dispatching") throw new NotificationStoreError();
      r.delivery = "completed";
    });
  }
  deliveryUncertain(id: string): void {
    this.#update(id, (r) => {
      r.delivery = "uncertain";
    });
  }
  beginAcknowledgement(id: string): void {
    this.#update(id, (r) => {
      if (r.acknowledgement !== "pending") throw new NotificationStoreError();
      r.acknowledgement = "sending";
    });
  }
  acknowledged(id: string): void {
    this.#update(id, (r) => {
      if (r.acknowledgement !== "sending") throw new NotificationStoreError();
      r.acknowledgement = "acked";
    });
  }
  acknowledgementUncertain(id: string): void {
    this.#update(id, (r) => {
      r.acknowledgement = "uncertain";
    });
  }
  recover(limit = 100): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new NotificationStoreError();
    for (let i = 0; i < limit; i++) {
      const record = this.#records.nextInStates(interrupted);
      if (record === undefined) return false;
      if (record.delivery === "dispatching") record.delivery = "uncertain";
      if (record.acknowledgement === "sending") record.acknowledgement = "uncertain";
      this.#save(record);
    }
    return this.#records.nextInStates(interrupted) !== undefined;
  }
  close(): void {
    this.#records.close();
  }
}
