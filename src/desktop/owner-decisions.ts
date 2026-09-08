import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { EncryptedRecordStore } from "../encrypted-record-store.js";
import { permissionChoices } from "./owner-choices.js";
import { mutationSchema, type OwnerMutation, type OwnerReview } from "./owner-protocol.js";
import type { OwnerStore } from "./owner-store.js";
export function reviewable(target: OwnerReview["target"], now: number): boolean {
  if (target.kind === "permission")
    return (
      permissionChoices(target.item.decision_options).length > 0 &&
      (!target.item.expires_at || Date.parse(target.item.expires_at) > now)
    );
  if (target.kind === "revoke")
    return (
      target.item.direction === "granted_by_me" &&
      target.item.status === "granted" &&
      target.item.uses_remaining !== 0 &&
      (!target.item.expires_at || Date.parse(target.item.expires_at) > now)
    );
  if (target.item.input_type === "text") return true;
  if (target.item.input_type !== "buttons" || !target.item.options?.length) return false;
  const values = new Set<string>();
  for (const option of target.item.options) {
    if (!option.label.trim() || !option.value?.trim() || values.has(option.value)) return false;
    values.add(option.value);
  }
  return true;
}
const recordSchema = mutationSchema.extend({
  agentId: z.uuid(),
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Record = z.infer<typeof recordSchema>;
const identifier = (value: Pick<Record, "agentId" | "kind" | "id">) =>
  `${value.agentId}:${value.kind}:${value.id}`;
export class OwnerDecisions {
  readonly records: EncryptedRecordStore<Record>;
  readonly reviews = new Map<string, { context: string; review: OwnerReview }>();
  constructor(store: OwnerStore) {
    this.records = new EncryptedRecordStore(
      join(store.directory, "mutations.sqlite"),
      { storageSecret: store.key, salt: "embassys-owner-mutations:v1" },
      {
        scope: "embassys-owner-mutations",
        indexedGroups: true,
        identifier,
        parse: (bytes) => recordSchema.parse(JSON.parse(bytes.toString("utf8"))),
        error: () => new Error("Owner decision storage is unavailable."),
      },
    );
  }
  get(agentId: string, kind: OwnerMutation["kind"], id: string): OwnerMutation | undefined {
    const record = this.records.get(identifier({ agentId, kind, id }));
    if (!record) return undefined;
    return mutationSchema.parse(record);
  }
  matches(
    agentId: string,
    kind: OwnerMutation["kind"],
    id: string,
    submissionHash: string,
  ): boolean {
    return this.records.get(identifier({ agentId, kind, id }))?.submissionHash === submissionHash;
  }
  save(agentId: string, mutation: OwnerMutation, submissionHash?: string): void {
    this.records.put(
      {
        agentId,
        ...mutation,
        submissionHash:
          submissionHash ??
          this.records.get(identifier({ agentId, ...mutation }))?.submissionHash ??
          "",
      },
      { replace: true, groups: mutation.status === "unconfirmed" ? [agentId] : [] },
    );
  }
  remove(agentId: string, kind: OwnerMutation["kind"], id: string): void {
    this.records.remove([identifier({ agentId, kind, id })]);
  }
  unconfirmed(agentId: string) {
    const page = this.records.pageGroup(agentId, 0, 100);
    return {
      unconfirmed: page.items.map(({ value }) => mutationSchema.parse(value)),
      unconfirmedMore: page.hasMore,
    };
  }
  review(context: string, target: OwnerReview["target"], now: number): OwnerReview {
    for (const [id, entry] of this.reviews)
      if (Date.parse(entry.review.expires_at) <= now || entry.context !== context)
        this.reviews.delete(id);
    if (this.reviews.size >= 64) this.reviews.delete(this.reviews.keys().next().value ?? "");
    const review: OwnerReview = {
      kind: "review",
      review_id: randomUUID(),
      expires_at: new Date(now + 300000).toISOString(),
      target,
    };
    this.reviews.set(review.review_id, { context, review });
    return review;
  }
  close(): void {
    this.reviews.clear();
    this.records.close();
  }
}
