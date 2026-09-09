import { randomUUID } from "node:crypto";
import { z } from "zod";

export const setupPermissionSchema = z.strictObject({
  title: z.string().max(512),
  detail: z.string().max(8192),
  options: z
    .array(
      z.strictObject({
        optionId: z.string().min(1).max(512),
        name: z.string().min(1).max(512),
        kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
      }),
    )
    .min(1)
    .max(8),
});
export type SetupPermission = z.infer<typeof setupPermissionSchema>;
export const setupApprovalSchema = z.strictObject({
  protocol: z.literal(1),
  type: z.literal("setup_approval"),
  requestId: z.uuid(),
  permission: setupPermissionSchema,
});
export const setupApprovalCancelledSchema = z.strictObject({
  protocol: z.literal(1),
  type: z.literal("setup_approval_cancelled"),
  requestId: z.uuid(),
});
const replySchema = z.strictObject({
  protocol: z.literal(1),
  type: z.literal("setup_approval_result"),
  requestId: z.uuid(),
  optionId: z.string().max(512).nullable(),
});

export class SetupApprovalGuard {
  #pending: { id: string; finish(value?: string): void } | undefined;
  #closed = false;
  constructor(
    readonly send: (
      value: z.infer<typeof setupApprovalSchema> | z.infer<typeof setupApprovalCancelledSchema>,
    ) => void,
    readonly timeoutMs = 180000,
  ) {}
  async ask(permission: SetupPermission, signal: AbortSignal): Promise<string | undefined> {
    if (this.#closed || this.#pending || signal.aborted) return undefined;
    const parsed = setupPermissionSchema.safeParse(permission);
    if (
      !parsed.success ||
      new Set(permission.options.map((o) => o.optionId)).size !== permission.options.length
    )
      return undefined;
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (value?: string) => {
        if (this.#pending?.id !== id) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#pending = undefined;
        try {
          this.send({ protocol: 1, type: "setup_approval_cancelled", requestId: id });
        } catch {
          /* The owner process may already be gone. */
        }
        resolve(
          !signal.aborted && permission.options.some((o) => o.optionId === value)
            ? value
            : undefined,
        );
      };
      const abort = () => finish();
      const timer = setTimeout(abort, this.timeoutMs);
      this.#pending = { id, finish };
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.send({ protocol: 1, type: "setup_approval", requestId: id, permission: parsed.data });
      } catch {
        finish();
      }
    });
  }
  receive(value: unknown): boolean {
    const reply = replySchema.safeParse(value);
    if (!reply.success) return false;
    if (reply.data.requestId === this.#pending?.id)
      this.#pending.finish(reply.data.optionId ?? undefined);
    return true;
  }
  close(): void {
    this.#closed = true;
    this.#pending?.finish();
  }
}
