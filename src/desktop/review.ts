import { randomUUID } from "node:crypto";
import { z } from "zod";
import { setupPermissionSchema } from "./setup-approval.js";

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("permission"),
    instanceName: z.string().min(1).max(80),
    permission: setupPermissionSchema,
  }),
  z.strictObject({
    kind: z.literal("connection"),
    instanceName: z.string().min(1).max(80),
    providerName: z.string().min(1).max(80),
    action: z.enum(["Connect", "Repair", "Disconnect"]),
    endpoint: z
      .string()
      .max(128)
      .regex(/^http:\/\/127\.0\.0\.1:\d{2,5}\/mcp$/u),
    configurationPath: z.string().min(1).max(4096),
    skillPath: z.string().min(1).max(4096),
  }),
]);
export type ReviewRequest = z.infer<typeof requestSchema>;
export type DesktopReview = ReviewRequest & { id: string };

/** Host-owned, ephemeral reviews. A renderer can answer only the visible request. */
export class DesktopReviews {
  #queue: { review: DesktopReview; finish(choice?: string): void }[] = [];
  #closed = false;
  #cancelling = false;
  constructor(
    readonly changed: () => void,
    readonly timeoutMs = 180000,
  ) {}
  current(): DesktopReview | undefined {
    const review = this.#queue[0]?.review;
    return review ? structuredClone(review) : undefined;
  }
  async ask(request: ReviewRequest, signal?: AbortSignal): Promise<string | undefined> {
    if (this.#closed || signal?.aborted || this.#queue.length >= 8) return undefined;
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) return undefined;
    if (
      parsed.data.kind === "permission" &&
      new Set(parsed.data.permission.options.map((option) => option.optionId)).size !==
        parsed.data.permission.options.length
    )
      return undefined;
    return new Promise((resolve) => {
      const review = { ...parsed.data, id: randomUUID() };
      const finish = (choice?: string) => {
        const index = this.#queue.findIndex((entry) => entry.review.id === review.id);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        resolve(signal?.aborted ? undefined : choice);
        if (!this.#cancelling) this.changed();
      };
      const cancel = () => finish();
      const timer = setTimeout(cancel, this.timeoutMs);
      this.#queue.push({ review, finish });
      signal?.addEventListener("abort", cancel, { once: true });
      this.changed();
    });
  }
  answer(id: string, choice: string | null): boolean {
    const current = this.#queue[0];
    if (!current || current.review.id !== id) return false;
    const valid =
      current.review.kind === "connection"
        ? choice === "confirm"
        : current.review.permission.options.some((option) => option.optionId === choice);
    if (choice !== null && !valid) return false;
    current.finish(choice ?? undefined);
    return true;
  }
  cancelAll(): void {
    this.#cancelling = true;
    try {
      for (const item of [...this.#queue]) item.finish();
    } finally {
      this.#cancelling = false;
      this.changed();
    }
  }
  close(): void {
    this.#closed = true;
    this.cancelAll();
  }
}
