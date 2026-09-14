import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OwnerFeed } from "../src/desktop/owner-feed.js";
import type { OwnerCommand, OwnerReply, OwnerSnapshot } from "../src/desktop/owner-protocol.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const context = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const snapshot = { context, status: "signed_in", account: { owner_id: ownerId } } as OwnerSnapshot;
test("expired feed resnapshots every inbox page across restart before advancing the event cursor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-feed-pages-"));
  const options = { directory: root, key: Buffer.alloc(32, 9) };
  let feed = new OwnerFeed(options);
  t.after(async () => {
    feed.close();
    await rm(root, { recursive: true, force: true });
  });
  const reads: string[] = [],
    notices: string[] = [];
  const read = async (command: OwnerCommand): Promise<OwnerReply> => {
    reads.push(command.type + ("cursor" in command ? `:${command.cursor ?? ""}` : ""));
    if (command.type === "owner_events")
      return { state: "unavailable", snapshot, issue: "cursor_expired" };
    assert.equal(command.type, "owner_requests");
    const second = "cursor" in command && command.cursor === "page-two";
    return {
      state: "ready",
      snapshot,
      data: {
        kind: "requests",
        total: 1,
        unconfirmed: [],
        watermark: second ? 12 : 10,
        has_more: !second,
        next_cursor: second ? null : "page-two",
        permission_requests: [
          {
            id: second ? id : ownerId,
            revision: 1,
            decision_options: "accept_deny",
            scope: null,
            created_at: "2026-09-14T12:00:00Z",
            expires_at: null,
            action_type: "get_phone_number",
            action_description: null,
            requester_email: "peer@fixture.test",
            requester_name: null,
          },
        ],
        input_requests: [],
      },
    } as OwnerReply;
  };
  const deliver = async (_owner: string, items: { id: string }[]) => {
    notices.push(...items.map((item) => item.id));
  };
  assert.equal(await feed.tick(snapshot, read, deliver), 0);
  feed.close();
  feed = new OwnerFeed(options);
  await assert.rejects(
    feed.tick(snapshot, read, async () => {
      throw new Error("notification custody failed");
    }),
  );
  assert.equal(await feed.tick(snapshot, read, deliver), 10);
  assert.deepEqual(reads, [
    "owner_events:0",
    "owner_requests",
    "owner_requests:page-two",
    "owner_requests:page-two",
  ]);
  assert.deepEqual(notices, [`permission:${ownerId}:1`, `permission:${id}:1`]);
});
test("owner feed commits its cursor only after notification custody and resumes across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-feed-"));
  const options = { directory: root, key: Buffer.alloc(32, 8) };
  let feed = new OwnerFeed(options);
  t.after(async () => {
    feed.close();
    await rm(root, { recursive: true, force: true });
  });
  let reject = true;
  const cursors: number[] = [];
  const read = async (command: OwnerCommand) => {
    assert.equal(command.type, "owner_events");
    if (command.type !== "owner_events") throw new Error();
    cursors.push(command.cursor ?? -1);
    return {
      state: "ready",
      snapshot,
      data: {
        kind: "events",
        next_cursor: 1,
        watermark: 1,
        caught_up: true,
        events:
          command.cursor === 1
            ? []
            : [
                {
                  event_id: id,
                  cursor: 1,
                  event_type: "inbox_item_added",
                  kind: "permission",
                  request_id: id,
                  revision: 1,
                  payload: { private: "must not leave worker" },
                  created_at: "2026-09-14T12:00:00Z",
                },
              ],
      },
    } as OwnerReply;
  };
  const deliver = async (_owner: string, events: unknown[]) => {
    assert.doesNotMatch(JSON.stringify(events), /private|must not leave worker/);
    if (reject) throw new Error("IPC lost");
  };
  await assert.rejects(feed.tick(snapshot, read, deliver));
  feed.close();
  feed = new OwnerFeed(options);
  reject = false;
  assert.equal(await feed.tick(snapshot, read, deliver), 1);
  assert.equal(await feed.tick(snapshot, read, deliver), 1);
  assert.deepEqual(cursors, [0, 0, 1]);
});
