import { z } from "zod";
import type { LoadedCentralCredential } from "./central-credential.js";
import { assertNoCentralCredentialFields } from "./central-json.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";
import { workflowUuid } from "./workflow-uuid.js";

const operationSchema = z.enum([
  "call_action",
  "request_permission",
  "submit_action_result",
  "get_human_input",
]);
export type CentralMutation = z.infer<typeof operationSchema>;
const receiptSchema = z.strictObject({
  status: z.number().int().min(200).max(599),
  body: z.record(z.string(), z.unknown()),
});
export type MutationReceipt = z.infer<typeof receiptSchema>;
const recordSchema = z.strictObject({
  operation: operationSchema,
  key: workflowUuid,
  body: z.record(z.string(), z.unknown()),
  createdAt: z.number().int().nonnegative(),
  receipt: receiptSchema.optional(),
});
type Mutation = z.infer<typeof recordSchema>;
const identifier = (operation: CentralMutation, key: string) => `${operation}:${key}`;
// The reviewed service retains keys for 24 hours. Leave an hour for clock skew and transit.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export class CentralMutationError extends Error {
  constructor() {
    super("The saved central submission cannot safely be resumed");
    this.name = "CentralMutationError";
  }
}
export class CentralMutations {
  readonly #records: EncryptedRecordStore<Mutation>;
  readonly #running = new Map<string, Promise<MutationReceipt>>();
  constructor(
    path: string,
    credential: LoadedCentralCredential | { storageSecret: Buffer; salt: string },
    readonly now = Date.now,
  ) {
    this.#records = new EncryptedRecordStore(path, credential, {
      scope: "central-submissions-v1",
      identifier: (row) => identifier(row.operation, row.key),
      parse: (buffer) => {
        const row = recordSchema.parse(JSON.parse(buffer.toString("utf8")));
        assertNoCentralCredentialFields(row);
        return row;
      },
      error: () => new CentralMutationError(),
    });
  }
  body(operation: CentralMutation, key: string): Record<string, unknown> | undefined {
    return this.#records.get(identifier(operation, workflowUuid.parse(key)))?.body;
  }
  async execute(
    operation: CentralMutation,
    key: string,
    body: Record<string, unknown>,
    send: () => Promise<MutationReceipt>,
    lookup: () => Promise<MutationReceipt | undefined>,
  ): Promise<MutationReceipt> {
    key = workflowUuid.parse(key);
    const id = identifier(operation, key);
    // Serialize each key without blocking unrelated calls or a long poll.
    const task = (this.#running.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#execute(operation, key, body, send, lookup));
    this.#running.set(id, task);
    try {
      return await task;
    } finally {
      if (this.#running.get(id) === task) this.#running.delete(id);
    }
  }
  async #execute(
    operation: CentralMutation,
    key: string,
    body: Record<string, unknown>,
    send: () => Promise<MutationReceipt>,
    lookup: () => Promise<MutationReceipt | undefined>,
  ): Promise<MutationReceipt> {
    const id = identifier(operation, key);
    const previous = this.#records.get(id);
    const value = recordSchema.parse(previous ?? { operation, key, body, createdAt: this.now() });
    assertNoCentralCredentialFields(value);
    if (canonical(value.body) !== canonical(body)) throw new CentralMutationError();
    if (value.receipt) return value.receipt;
    const age = this.now() - value.createdAt;
    if (age < 0 || age >= RETRY_WINDOW_MS) throw new CentralMutationError();
    if (!previous) this.#records.put(value);
    const recovered = previous ? await lookup() : undefined;
    const receipt = receiptSchema.parse(recovered ?? (await send()));
    assertNoCentralCredentialFields(receipt);
    // Only a success or the authoritative status lookup proves a terminal outcome.
    if (recovered || receipt.status < 300)
      this.#records.put({ ...value, receipt }, { replace: true });
    return receipt;
  }
  close(): void {
    this.#records.close();
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
