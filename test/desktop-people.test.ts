import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseContactFile } from "../src/desktop/contact-file.js";
import { OwnerPeople } from "../src/desktop/owner-people.js";
import { OwnerStore } from "../src/desktop/owner-store.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";

test("contact import supports folded UTF-8 vCards, escaped names and multiple emails, without importing other fields", () => {
  const result = parseContactFile(
    "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alex\\, Jo\r\n nes\r\nEMAIL;TYPE=HOME:Alex@Example.test\r\nitem1.EMAIL:second@example.test\r\nNOTE:private notes\r\nPHOTO:https://example.test/private\r\nEND:VCARD\r\nBEGIN:VCARD\nVERSION:4.0\nFN:Duplicate\nEMAIL:alex@example.test\nEND:VCARD",
  );
  assert.deepEqual(result.contacts, [
    { name: "Alex, Jones", email: "alex@example.test" },
    { name: "Alex, Jones", email: "second@example.test" },
  ]);
  assert.equal(result.skipped, 0);
  assert.equal(result.duplicates, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|https/);
});

test("import rejects malformed and oversized files and skips unsupported encodings and invalid email fields", () => {
  for (const value of [
    "",
    "just text",
    "BEGIN:VCARD\nVERSION:4.0",
    "x".repeat(1048577),
    "BEGIN:VCARD\nBEGIN:VCARD\nEND:VCARD",
    "BEGIN:VCARD\nVERSION:4.0\nEND:VCARD\nextra",
  ])
    assert.throws(() => parseContactFile(value));
  const result = parseContactFile(
    "BEGIN:VCARD\nVERSION:3.0\nFN;ENCODING=QUOTED-PRINTABLE:Alex=20Jones\nEMAIL:alex@example.test\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nFN:Sam\nEMAIL:mailto:sam@example.test\nEMAIL:ok@example.test\nEND:VCARD",
  );
  assert.deepEqual(result.contacts, [{ name: "Sam", email: "ok@example.test" }]);
  assert.equal(result.skipped, 1);
  assert.equal(
    parseContactFile(
      "BEGIN:VCARD\nVERSION:4.0\nN:Jones;Alex;;;\nEMAIL:alex@example.test\nEND:VCARD",
    ).contacts[0]?.name,
    "Alex Jones",
  );
});

test("People storage is encrypted, account-scoped, atomic, deduplicated and persistent", async () => {
  const root = await mkdtemp(join(tmpdir(), "embassys-people-test-"));
  let store = await OwnerStore.open(root);
  let people = new OwnerPeople(store);
  const a = randomUUID(),
    b = randomUUID();
  try {
    people.save(a, [{ name: "Alex", email: "Alex@Example.test" }]);
    assert.equal(people.list(a)[0]?.email, "alex@example.test");
    assert.deepEqual(people.list(b), []);
    people.save(a, [{ name: "Import duplicate", email: "alex@example.test" }]);
    assert.equal(people.list(a)[0]?.name, "Alex");
    people.save(a, [{ name: "Alex Jones", email: "alex@example.test" }], true);
    assert.equal(people.list(a)[0]?.name, "Alex Jones");
    assert.throws(() =>
      people.save(a, [
        { name: "Good", email: "good@example.test" },
        { name: "Bad", email: "invalid" },
      ]),
    );
    assert.equal(people.list(a).length, 1);
    people.remove(b, "alex@example.test");
    assert.equal(people.list(a).length, 1);
    people.close();
    await store.close();
    assert.equal(
      (await readFile(join(root, "people.sqlite"))).includes(Buffer.from("alex@example.test")),
      false,
    );
    store = await OwnerStore.open(root);
    people = new OwnerPeople(store);
    assert.equal(people.list(a).length, 1);
    people.remove(a, "alex@example.test");
    assert.deepEqual(people.list(a), []);
    for (let batch = 0; batch < 10; batch++)
      people.save(
        a,
        Array.from({ length: 50 }, (_, i) => ({
          name: "Person",
          email: `person${batch * 50 + i}@example.test`,
        })),
      );
    assert.throws(() => people.save(a, [{ name: "Extra", email: "extra@example.test" }]));
    assert.equal(people.list(a).length, 500);
  } finally {
    people.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("People commands require account context and bound each import before IPC", () => {
  const context = randomUUID();
  assert.equal(parseDesktopCommand({ type: "owner_people", context }).type, "owner_people");
  assert.throws(() =>
    parseDesktopCommand({
      type: "owner_people_save",
      context,
      contacts: Array.from({ length: 51 }, () => ({ name: "A", email: "a@b.test" })),
    }),
  );
  assert.throws(() =>
    parseDesktopCommand({
      type: "owner_people_save",
      context,
      contacts: [{ name: "A", email: "a@b.test", notes: "not supported" }],
    }),
  );
  assert.throws(() => parseDesktopCommand({ type: "owner_people", agentId: randomUUID() }));
});

test("missing encryption material beside saved people never creates a new key", async () => {
  const root = await mkdtemp(join(tmpdir(), "embassys-people-key-test-"));
  const store = await OwnerStore.open(root);
  const people = new OwnerPeople(store);
  people.save(randomUUID(), [{ name: "Alex", email: "alex@example.test" }]);
  people.close();
  await store.close();
  try {
    await rm(join(root, "key.enc"));
    await rm(join(root, "key.wrap"));
    await assert.rejects(OwnerStore.open(root), /key is missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
