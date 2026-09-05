import { z } from "zod";
import type { LoadedCentralCredential } from "./central-credential.js";
import type { CentralMessage } from "./central-rest.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";
import { storedCentralMessageSchema } from "./notification-store.js";

const schema = z
  .object({ request_id: z.string().min(1).max(256), message: storedCentralMessageSchema })
  .strict();
type Answer = z.infer<typeof schema>;
export class HumanInputMailbox {
  readonly #records: EncryptedRecordStore<Answer>;
  readonly #waiting = new Map<string, Set<() => void>>();
  readonly #lifetime = new AbortController();
  #waitCount = 0;
  constructor(path: string, credential: LoadedCentralCredential) {
    this.#records = new EncryptedRecordStore(path, credential, {
      scope: "ambassador-human-input-responses",
      parse: (bytes) => schema.parse(JSON.parse(bytes.toString("utf8"))),
      identifier: (record) => record.request_id,
      error: () => new Error("Human input state is invalid"),
    });
  }
  capture(message: CentralMessage): boolean {
    if (message.payload.type !== "human_input_response") return false;
    const record = schema.parse({ request_id: message.payload.request_id, message });
    this.#records.put(record);
    for (const resume of [...(this.#waiting.get(record.request_id) ?? [])]) resume();
    return true;
  }
  get(requestId: string): CentralMessage | undefined {
    return this.#records.get(requestId)?.message;
  }
  async wait(requestId: string, signal: AbortSignal): Promise<CentralMessage> {
    const combined = AbortSignal.any([signal, this.#lifetime.signal]);
    combined.throwIfAborted();
    const existing = this.get(requestId);
    if (existing !== undefined) return existing;
    if (this.#waitCount >= 32) throw new Error("Human input wait capacity reached");
    this.#waitCount++;
    try {
      return await new Promise<CentralMessage>((resolve, reject) => {
        const cleanup = () => {
          combined.removeEventListener("abort", cancelled);
          const set = this.#waiting.get(requestId);
          set?.delete(resume);
          if (set?.size === 0) this.#waiting.delete(requestId);
        };
        const cancelled = () => {
          cleanup();
          reject(new Error("Human input wait cancelled"));
        };
        const resume = () => {
          try {
            const answer = this.get(requestId);
            if (answer !== undefined) {
              cleanup();
              resolve(answer);
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        };
        const set = this.#waiting.get(requestId) ?? new Set<() => void>();
        set.add(resume);
        this.#waiting.set(requestId, set);
        combined.addEventListener("abort", cancelled, { once: true });
        if (combined.aborted) cancelled();
        else resume();
      });
    } finally {
      this.#waitCount--;
    }
  }
  close(): void {
    this.#lifetime.abort();
    this.#records.close();
  }
}
