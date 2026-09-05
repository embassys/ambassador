import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { NotificationStore } from "../src/notification-store.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

const MESSAGE: CentralMessage = {
  id: "control-1",
  sender_agent_id: "peer",
  created_at: "2026-09-05T00:00:00Z",
  payload: { type: "human_input_response", text: "private owner answer" },
};

function fixture(t: TestContext, maximumBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "ambassador-custody-"));
  const path = join(root, "events.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let store = new NotificationStore(path, credential, maximumBytes);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    path,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new NotificationStore(path, credential, maximumBytes);
      store.recover();
    },
  };
}

test("local owner continuations are durable, deduplicated and never acknowledged to central", (t) => {
  const f = fixture(t);
  const message = {
    ...MESSAGE,
    id: "owner-answer-1",
    payload: { type: "owner_input", text: "private owner answer" },
  };
  f.store.enqueueLocal(message);
  f.store.enqueueLocal(message);
  f.restart();
  assert.equal(f.store.next("ack"), undefined);
  assert.equal(f.store.next("process"), undefined);
  const queued = f.store.next("deliver");
  assert.ok(queued);
  assert.deepEqual(queued.message, message);
  f.store.beginDelivery(queued.id);
  f.restart();
  assert.equal(f.store.next("deliver"), undefined);
  f.store.enqueueLocal(message);
  assert.equal(f.store.next("deliver"), undefined);
  assert.throws(() =>
    f.store.enqueueLocal({ ...message, payload: { type: "owner_input", text: "different" } }),
  );
});

test("control messages survive restart; duplicate identity cannot change its contents", (t) => {
  const f = fixture(t);
  f.store.ingest([MESSAGE, MESSAGE]);
  f.restart();
  assert.deepEqual(f.store.next("process")?.message, MESSAGE);
  assert.throws(() => f.store.ingest([{ ...MESSAGE, payload: { text: "changed" } }]));
  assert.equal(readFileSync(f.path).includes(Buffer.from("private owner answer")), false);
});

test("a conflicting or oversized batch is rejected before any member is accepted", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.ingest([MESSAGE, { ...MESSAGE, payload: {} }]));
  assert.equal(f.store.next("process"), undefined);
  assert.throws(() =>
    f.store.ingest(Array.from({ length: 257 }, (_, i) => ({ ...MESSAGE, id: `event-${i}` }))),
  );
  assert.equal(f.store.next("ack"), undefined);
});

test("prepared delivery resumes but dispatched work and acknowledgements never replay", (t) => {
  const f = fixture(t);
  f.store.ingest([MESSAGE, { ...MESSAGE, id: "prepared" }]);
  f.store.processed("control-1", true);
  f.store.processed("prepared", true);
  f.store.beginDelivery("control-1");
  f.store.beginAcknowledgement("control-1");
  f.restart();
  assert.equal(f.store.get("control-1")?.delivery, "uncertain");
  assert.equal(f.store.get("control-1")?.acknowledgement, "uncertain");
  assert.equal(f.store.next("deliver")?.id, "prepared");
  assert.equal(f.store.next("ack")?.id, "prepared");
});

test("restart recovery processes a bounded batch and leaves remaining work discoverable", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    const id = `recover-${i}`;
    f.store.ingest([{ ...MESSAGE, id }]);
    f.store.beginAcknowledgement(id);
  }
  assert.equal(f.store.recover(2), true);
  assert.equal(f.store.get("recover-2")?.acknowledgement, "sending");
  assert.equal(f.store.recover(2), false);
  assert.equal(f.store.get("recover-2")?.acknowledgement, "uncertain");
});

test("settled messages compact to deduplication records and remain distinct from client receipt", (t) => {
  const f = fixture(t);
  f.store.ingest([MESSAGE]);
  f.store.processed("control-1", false);
  f.store.beginAcknowledgement("control-1");
  f.store.acknowledged("control-1");
  f.restart();
  assert.equal(f.store.get("control-1")?.message, undefined);
  f.store.ingest([MESSAGE]);
  assert.equal(f.store.next("process"), undefined);
  assert.equal(f.store.next("deliver"), undefined);
  assert.equal(f.store.next("ack"), undefined);
});

test("quota failures preserve existing custody and do not admit new work", (t) => {
  const f = fixture(t, 800);
  f.store.ingest([MESSAGE]);
  assert.throws(() =>
    f.store.ingest([{ ...MESSAGE, id: "second", payload: { text: "x".repeat(900) } }]),
  );
  assert.equal(f.store.get("second"), undefined);
  assert.deepEqual(f.store.get("control-1")?.message, MESSAGE);
});
