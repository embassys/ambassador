import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LoadedCentralCredential } from "./central-credential.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";

const stateSchema = z.strictObject({
  id: z.literal("provider-generations"),
  namespace: z.uuid(),
  generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
});
type State = z.infer<typeof stateSchema>;

/** Durable invocation identity; never derive monotonic generations from a clock. */
export class ProviderInvocations {
  readonly #store: EncryptedRecordStore<State>;
  constructor(path: string, credential: LoadedCentralCredential) {
    this.#store = new EncryptedRecordStore(path, credential, {
      scope: "embassys-provider-invocations",
      identifier: (value) => value.id,
      parse: (bytes) => stateSchema.parse(JSON.parse(bytes.toString("utf8"))),
      error: () => new Error("Provider invocation state is unavailable"),
    });
  }
  next(provider: string): { provider_key: string; generation: number } {
    if (!/^[a-z0-9_-]{1,32}$/u.test(provider)) throw new Error("Invalid provider");
    const state = this.#store.get("provider-generations") ?? {
      id: "provider-generations" as const,
      namespace: randomUUID(),
      generation: 0,
    };
    const next = stateSchema.parse({ ...state, generation: state.generation + 1 });
    this.#store.put(next, { replace: true });
    return {
      provider_key: `embassys-acp:${next.namespace}:${provider}`,
      generation: next.generation,
    };
  }
  close(): void {
    this.#store.close();
  }
}
