import { join } from "node:path";
import { z } from "zod";
import { EncryptedRecordStore } from "../encrypted-record-store.js";
import { eventsPage } from "./owner-contract.js";
import type { OwnerCommand, OwnerReply, OwnerSnapshot } from "./owner-protocol.js";

export const ownerNoticeSchema = z.strictObject({
  id: z.string().min(1).max(256),
  kind: z.enum(["permission", "question"]),
});
export type OwnerNotice = z.infer<typeof ownerNoticeSchema>;
const savedSchema = z.strictObject({
  ownerId: z.uuid(),
  cursor: z.number().int().nonnegative(),
  resnapshot: z
    .strictObject({
      cursor: z.string().min(1).max(2048),
      watermark: z.number().int().nonnegative(),
    })
    .optional(),
});
export class OwnerFeed {
  readonly #store: EncryptedRecordStore<z.infer<typeof savedSchema>>;
  constructor(store: { directory: string; key: Buffer }) {
    this.#store = new EncryptedRecordStore(
      join(store.directory, "events.sqlite"),
      { storageSecret: store.key, salt: "owner-events-v1" },
      {
        scope: "owner-event-cursors",
        identifier: (row) => row.ownerId,
        parse: (bytes) => savedSchema.parse(JSON.parse(bytes.toString("utf8"))),
        error: () => new Error("Account event storage unavailable"),
      },
    );
  }
  async tick(
    snapshot: OwnerSnapshot,
    read: (command: OwnerCommand) => Promise<OwnerReply>,
    deliver: (ownerId: string, events: OwnerNotice[]) => Promise<void>,
  ): Promise<number | undefined> {
    if (snapshot.status !== "signed_in" || !snapshot.account) return;
    const ownerId = snapshot.account.owner_id;
    const saved = this.#store.get(ownerId);
    const cursor = saved?.cursor ?? 0;
    const response = saved?.resnapshot
      ? ({ snapshot, issue: "cursor_expired" } as OwnerReply)
      : await read({ type: "owner_events", context: snapshot.context, cursor });
    if (response.snapshot.context !== snapshot.context || response.snapshot.status !== "signed_in")
      return;
    let next: number;
    let notices: OwnerNotice[];
    if (response.issue === "cursor_expired") {
      const refreshed = await read({
        type: "owner_requests",
        context: snapshot.context,
        ...(saved?.resnapshot ? { cursor: saved.resnapshot.cursor } : {}),
      });
      if (
        refreshed.snapshot.context !== snapshot.context ||
        refreshed.snapshot.status !== "signed_in" ||
        refreshed.data?.kind !== "requests" ||
        refreshed.state !== "ready"
      )
        return;
      next =
        saved?.resnapshot?.watermark ??
        z.number().int().nonnegative().parse(refreshed.data.watermark);
      notices = [
        ...refreshed.data.permission_requests.map((item) => ({
          id: `permission:${item.id}:${item.revision}`,
          kind: "permission" as const,
        })),
        ...refreshed.data.input_requests.map((item) => ({
          id: `human_input:${item.id}:${item.revision}`,
          kind: "question" as const,
        })),
      ];
      if (refreshed.data.has_more) {
        const nextPage = z.string().min(1).max(2048).parse(refreshed.data.next_cursor);
        if (nextPage === saved?.resnapshot?.cursor) throw new Error("Invalid request cursor");
        if (notices.length) await deliver(ownerId, notices);
        this.#store.put(
          { ownerId, cursor, resnapshot: { cursor: nextPage, watermark: next } },
          { replace: true },
        );
        return cursor;
      }
    } else {
      if (response.state !== "ready" || response.data?.kind !== "events") return;
      const page = eventsPage.parse(response.data);
      let previous = cursor;
      for (const event of page.events) {
        if (event.cursor <= previous || event.cursor > page.watermark)
          throw new Error("Invalid event cursor");
        previous = event.cursor;
      }
      if (page.next_cursor !== previous || page.caught_up !== previous >= page.watermark)
        throw new Error("Invalid event page");
      next = page.next_cursor;
      notices = page.events
        .filter(
          (event) =>
            event.event_type === "inbox_item_added" &&
            ["permission", "human_input"].includes(event.kind),
        )
        .map((event) => ({
          id: `${event.kind}:${event.request_id}:${event.revision}`,
          kind: event.kind === "permission" ? "permission" : "question",
        }));
    }
    // The main process persists notification deduplication before acknowledging.
    // A disconnect leaves this cursor unchanged, so the server page is read again.
    if (notices.length) await deliver(ownerId, notices);
    this.#store.put({ ownerId, cursor: next }, { replace: true });
    return next;
  }
  close(): void {
    this.#store.close();
  }
}
