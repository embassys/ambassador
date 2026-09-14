import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { EncryptedRecordStore } from "../src/encrypted-record-store.js";
import { GatewayIdentity } from "../src/identity.js";
import {
  currentCredential,
  currentCredentialRecord,
  FIXTURE_NOW_SECONDS,
} from "./support/current-credential.js";

test("execution-key replacement preserves encrypted records across restart and rejects another identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-executor-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore(
    join(root, "credential.enc"),
    join(root, "key"),
    "fixture",
  );
  await store.save(currentCredential());
  let identity = await GatewayIdentity.open(store, () => FIXTURE_NOW_SECONDS);
  const old = identity.localCredential();
  const records = () =>
    new EncryptedRecordStore<{ id: string; text: string }>(
      join(root, "history.sqlite"),
      identity.storageCredential(),
      {
        scope: "fixture",
        identifier: (value) => value.id,
        parse: (bytes) => JSON.parse(bytes.toString()),
        error: () => new Error("records"),
      },
    );
  const first = records();
  first.put({ id: "one", text: "Keep my conversation" });
  first.close();
  const replacement = currentCredentialRecord();
  await identity.replaceExecution(replacement);
  identity = await GatewayIdentity.open(store, () => FIXTURE_NOW_SECONDS);
  assert.notEqual(identity.localCredential().keyThumbprint, old.keyThumbprint);
  assert.equal(identity.storageCredential().keyThumbprint, old.keyThumbprint);
  const reopened = records();
  assert.equal(reopened.get("one")?.text, "Keep my conversation");
  reopened.close();
  await assert.rejects(identity.replaceExecution(currentCredentialRecord("wrong@fixture.test")));
});

test("execution-token claims bind both device and epoch", async () => {
  const { parseCentralCredential } = await import("../src/central-credential.js");
  const original = currentCredentialRecord();
  const pieces = original.access_token.split(".");
  const claims = JSON.parse(Buffer.from(pieces[1] ?? "", "base64url").toString());
  const withClaims = (extra: object) => ({
    ...original,
    access_token: `${pieces[0]}.${Buffer.from(JSON.stringify({ ...claims, ...extra })).toString("base64url")}.${pieces[2]}`,
  });
  const dev = "00000000-0000-4000-8000-000000000022";
  const parsed = parseCentralCredential(withClaims({ dev, fence: 4 }), () => FIXTURE_NOW_SECONDS);
  assert.equal(parsed.token.executionDeviceId, dev);
  assert.equal(parsed.token.executorEpoch, 4);
  assert.throws(() =>
    parseCentralCredential(
      withClaims({ dev: "-".repeat(36), fence: 1 }),
      () => FIXTURE_NOW_SECONDS,
    ),
  );
  assert.throws(() => parseCentralCredential(withClaims({ dev }), () => FIXTURE_NOW_SECONDS));
  assert.throws(() =>
    parseCentralCredential(withClaims({ dev, fence: -1 }), () => FIXTURE_NOW_SECONDS),
  );
});
