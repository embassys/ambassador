import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const executorContextSchema = z.strictObject({
  agent: z.enum(["claude", "codex", "openclaw", "hermes"]),
  workingDirectory: z.string().min(1).max(4096).refine(isAbsolute),
});
export type ExecutorContext = z.infer<typeof executorContextSchema>;
export const executorCheckSchema = z.strictObject({
  protocol: z.literal(1),
  type: z.literal("executor_check"),
  requestId: z.uuid(),
  context: executorContextSchema,
});
const replySchema = z.strictObject({
  protocol: z.literal(1),
  type: z.literal("executor_check_result"),
  requestId: z.uuid(),
  allowed: z.boolean(),
});

/** One read-only host check, correlated over the existing private process channel. */
export class ExecutorGuard {
  #pending: { id: string; finish(allowed: boolean): void } | undefined;
  #closed = false;
  constructor(
    readonly send: (request: z.infer<typeof executorCheckSchema>) => void,
    readonly timeoutMs = 5000,
  ) {}
  async check(context: ExecutorContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#closed || this.#pending) throw new Error("Executor connection check unavailable.");
    const parsed = executorContextSchema.parse(context);
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const finish = (allowed: boolean) => {
        if (this.#pending?.id !== id) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#pending = undefined;
        if (allowed && !signal.aborted) resolve();
        else reject(new Error("Executor connection could not be verified."));
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, this.timeoutMs);
      this.#pending = { id, finish };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.send({ protocol: 1, type: "executor_check", requestId: id, context: parsed });
      } catch {
        finish(false);
      }
    });
  }
  receive(value: unknown): boolean {
    const reply = replySchema.safeParse(value);
    if (!reply.success) return false;
    if (reply.data.requestId === this.#pending?.id) this.#pending.finish(reply.data.allowed);
    return true;
  }
  close(): void {
    this.#closed = true;
    this.#pending?.finish(false);
  }
}
