import { randomUUID } from "node:crypto";
import { z } from "zod";
import { devicesResponse, ownedAgent } from "./owner-contract.js";

const device = devicesResponse.shape.devices.element;
export const deviceReview = z.object({
  kind: z.literal("device_review"),
  review_id: z.uuid(),
  expires_at: z.iso.datetime(),
  operation: z.enum(["revoke", "execute"]),
  device,
  agent: ownedAgent.optional(),
});
export type DeviceReview = z.infer<typeof deviceReview>;
export const deviceResult = z.object({
  kind: z.literal("device_result"),
  operation: z.enum(["revoke", "execute"]),
  device_id: z.uuid(),
  agent_id: z.uuid().optional(),
  confirmed: z.boolean(),
  executes_here: z.boolean(),
  local_ready: z.boolean().optional(),
});
export class OwnerDeviceReviews {
  readonly #reviews = new Map<string, { context: string; review: DeviceReview }>();
  create(
    context: string,
    input: Pick<DeviceReview, "operation" | "device" | "agent">,
    now: number,
  ): DeviceReview {
    for (const [key, value] of this.#reviews)
      if (value.context !== context || Date.parse(value.review.expires_at) <= now)
        this.#reviews.delete(key);
    if (this.#reviews.size >= 64) throw new Error("Too many device reviews");
    const review = deviceReview.parse({
      kind: "device_review",
      review_id: randomUUID(),
      expires_at: new Date(now + 300000).toISOString(),
      ...input,
    });
    this.#reviews.set(review.review_id, { context, review });
    return review;
  }
  get(context: string, id: string, now: number): DeviceReview | undefined {
    const value = this.#reviews.get(id);
    return value?.context === context && Date.parse(value.review.expires_at) > now
      ? value.review
      : undefined;
  }
  consume(context: string, id: string, now: number): DeviceReview | undefined {
    const review = this.get(context, id, now);
    this.#reviews.delete(id);
    return review;
  }
}
