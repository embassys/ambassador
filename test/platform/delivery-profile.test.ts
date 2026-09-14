import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PRODUCTION_AGENT_CAPABILITIES } from "../../src/agent-capabilities.js";
import { createDeliveryProfile, DeliveryProfileStore } from "../../src/delivery-profile.js";
import { assertPrivateArtifact } from "../support/private-artifact.js";

test("enforces native private permissions on the profile and state directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-native-windows-;[]$()-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "delivery-profile.json");
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const profile = await createDeliveryProfile(capability, { mode: "direct" }, root);
  const store = new DeliveryProfileStore(path);

  await store.save(profile);
  assert.deepEqual(await store.load(), profile);
  await assertPrivateArtifact(join(root, "state"), "directory");
  await assertPrivateArtifact(path, "file");
});
