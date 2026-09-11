import assert from "node:assert/strict";
import { test } from "node:test";
import { createViewReader } from "../src/desktop/view-reader.js";

test("view refresh serializes reads and drops replies after the view closes", async () => {
  let resolve!: (value: number) => void;
  let reads = 0;
  const seen: number[] = [];
  const reader = createViewReader({
    read: () => {
      reads++;
      return new Promise<number>((done) => {
        resolve = done;
      });
    },
    publish: (value) => seen.push(value),
    failed: () => assert.fail("Unexpected failure"),
  });
  const first = reader.refresh();
  await reader.refresh();
  assert.equal(reads, 1);
  resolve(1);
  await first;
  assert.deepEqual(seen, [1]);
  const second = reader.refresh();
  reader.close();
  resolve(2);
  await second;
  await reader.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(seen, [1]);
});

test("failed refresh keeps saved content and permits a later retry", async () => {
  let attempt = 0;
  let failures = 0;
  const seen: number[] = [7];
  const reader = createViewReader({
    read: async () => {
      if (++attempt === 1) throw new Error("Unavailable");
      return 8;
    },
    publish: (value) => seen.push(value),
    failed: () => {
      failures++;
    },
  });
  await reader.refresh();
  assert.deepEqual(seen, [7]);
  assert.equal(failures, 1);
  await reader.refresh();
  assert.deepEqual(seen, [7, 8]);
});

test("a failure from a closed instance cannot affect the next view", async () => {
  let reject!: (error: Error) => void;
  const reader = createViewReader({
    read: () =>
      new Promise<never>((_resolve, fail) => {
        reject = fail;
      }),
    publish: () => assert.fail("No data expected"),
    failed: () => assert.fail("Stale error reached the view"),
  });
  const pending = reader.refresh();
  reader.close();
  reject(new Error("Old instance stopped"));
  await pending;
});

test("a post-decision refresh replaces an in-flight snapshot without concurrent reads", async () => {
  let finish: ((value: number) => void) | undefined;
  let reads = 0;
  const seen: number[] = [];
  const reader = createViewReader({
    queueRefresh: true,
    read: () => {
      reads++;
      return new Promise<number>((done) => {
        finish = done;
      });
    },
    publish: (value) => seen.push(value),
    failed: () => assert.fail("Unexpected failure"),
  });
  const work = reader.refresh();
  await reader.refresh();
  await reader.refresh();
  assert.equal(reads, 1);
  assert.ok(finish);
  finish(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.deepEqual(seen, []);
  finish(2);
  await work;
  assert.deepEqual(seen, [2]);
  const last = reader.refresh();
  await reader.refresh();
  reader.close();
  finish(3);
  await last;
  assert.equal(reads, 3);
  assert.deepEqual(seen, [2]);
});
