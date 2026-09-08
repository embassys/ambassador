import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import { EncryptedRecordStore } from "../src/encrypted-record-store.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

test("encrypted groups provide isolated bounded pages and cascade deletion without plaintext IDs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-encrypted-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "archive.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const options = {
    scope: "group-test",
    indexedGroups: true,
    indexedStates: true,
    identifier: (value: { id: string }) => value.id,
    parse: (bytes: Buffer) => JSON.parse(bytes.toString()) as { id: string },
    error: () => new Error("invalid"),
  };
  let store = new EncryptedRecordStore(path, credential, options);
  store.put({ id: "first" }, { groups: ["private-session", "turn-a"], state: 1 });
  store.put({ id: "other" }, { groups: ["other-session"], state: 0 });
  store.put({ id: "second" }, { groups: ["private-session", "turn-b"], state: 1 });
  const page = store.pageGroup("private-session", 0, 1);
  assert.equal(page.items[0]?.value.id, "first");
  assert.equal(page.hasMore, true);
  assert.equal(
    store.pageGroup("private-session", page.items[0]?.sequence, 1).items[0]?.value.id,
    "second",
  );
  assert.equal(store.pageStates([1], 0, 1).items[0]?.value.id, "first");
  assert.equal(store.countInStates([1]), 2);
  assert.equal(store.count(), 3);
  assert.equal(store.remove(["first"]), 1);
  assert.equal(store.pageGroup("turn-a").items.length, 0);
  store.close();
  store = new EncryptedRecordStore(path, credential, options);
  assert.deepEqual(
    store.pageGroup("private-session").items.map((item) => item.value.id),
    ["second"],
  );
  assert.equal(store.countInStates([1]), 1);
  assert.throws(() => store.pageGroup("private-session", -1));
  store.close();
  assert.doesNotMatch((await readFile(path)).toString(), /private-session|turn-a|turn-b/u);
  assert.throws(
    () => new EncryptedRecordStore(path, credential, { ...options, indexedGroups: false }),
  );
});

test("owner record secrets remain separate from agent keys and other scopes", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "embassys-owner-records-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const original = Buffer.from(key);
  const path = join(root, "records.sqlite");
  const options = {
    scope: "owner-record-test",
    identifier: (value: { id: string }) => value.id,
    parse: (bytes: Buffer) => JSON.parse(bytes.toString()) as { id: string },
    error: () => new Error("invalid"),
  };
  let store = new EncryptedRecordStore(path, { storageSecret: key, salt: "owner-test" }, options);
  store.put({ id: "private-owner-id" });
  store.close();
  assert.deepEqual(key, original);
  store = new EncryptedRecordStore(path, { storageSecret: key, salt: "owner-test" }, options);
  assert.equal(store.get("private-owner-id")?.id, "private-owner-id");
  store.close();
  assert.throws(
    () =>
      new EncryptedRecordStore(
        path,
        { storageSecret: randomBytes(32), salt: "owner-test" },
        options,
      ),
  );
  assert.throws(
    () => new EncryptedRecordStore(path, { storageSecret: key, salt: "another-owner" }, options),
  );
  assert.throws(
    () =>
      new EncryptedRecordStore(
        path,
        { storageSecret: key, salt: "owner-test" },
        { ...options, scope: "different-scope" },
      ),
  );
  assert.throws(
    () =>
      new EncryptedRecordStore(
        path,
        { storageSecret: Buffer.alloc(0), salt: "owner-test" },
        options,
      ),
  );
  assert.doesNotMatch((await readFile(path)).toString(), /private-owner-id/);
});
