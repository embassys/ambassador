import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import { ProviderInvocations } from "../src/provider-invocations.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

test("provider generations survive restart without depending on the wall clock", (t) => {
  const root = mkdtempSync(join(tmpdir(), "embassys-provider-invocations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "invocations.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let store = new ProviderInvocations(path, credential);
  const first = store.next("codex");
  assert.equal(first.generation, 1);
  const second = store.next("codex");
  assert.equal(second.provider_key, first.provider_key);
  assert.equal(second.generation, 2);
  store.close();
  store = new ProviderInvocations(path, credential);
  const third = store.next("codex");
  assert.equal(third.provider_key, first.provider_key);
  assert.equal(third.generation, 3);
  assert.notEqual(store.next("claude").provider_key, first.provider_key);
  store.close();
  assert.equal(readFileSync(path).includes(Buffer.from(first.provider_key)), false);
});
