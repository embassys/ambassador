import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PRODUCTION_AGENT_CAPABILITIES } from "../src/agent-capabilities.js";
import {
  createDeliveryProfile,
  DeliveryProfileError,
  DeliveryProfileStore,
  validateStoredDeliveryProfile,
} from "../src/delivery-profile.js";

const SECRET = "webhook-secret-with-at-least-32-bytes";

test("atomically stores only the registry-derived nonsecret webhook profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "delivery-profile.json");
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const profile = await createDeliveryProfile(
    capability,
    {
      mode: "webhook",
      url: "https://agent.example.test/embassys",
      secret_env: "EMBASSYS_WEBHOOK_SECRET",
    },
    root,
    { EMBASSYS_WEBHOOK_SECRET: SECRET },
  );
  const store = new DeliveryProfileStore(path);
  await store.save(profile);
  assert.deepEqual(await store.load(), profile);
  const bytes = await readFile(path, "utf8");
  assert.equal(bytes.includes(SECRET), false);
  assert.equal(bytes.includes("payload"), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("stores the canonical direct directory and rejects a conflicting restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-direct-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = PRODUCTION_AGENT_CAPABILITIES[1];
  assert.ok(capability);
  const profile = await createDeliveryProfile(capability, { mode: "direct" }, root, {});
  assert.deepEqual(profile, {
    version: 1,
    mode: "direct",
    agent_kind: "hermes",
    working_directory: await realpath(root),
  });
  await assert.rejects(
    validateStoredDeliveryProfile(profile, `${root}-other`),
    (error: unknown) =>
      error instanceof DeliveryProfileError && error.code === "incompatible_profile",
  );
});

test("fails closed on missing secrets, conflicting state, and obsolete records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-invalid-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  await assert.rejects(
    createDeliveryProfile(
      capability,
      {
        mode: "webhook",
        url: "https://agent.example.test/embassys",
        secret_env: "MISSING_SECRET",
      },
      root,
      {},
    ),
    (error: unknown) => error instanceof DeliveryProfileError && error.code === "missing_secret",
  );

  const store = new DeliveryProfileStore(join(root, "delivery-profile.json"));
  const direct = await createDeliveryProfile(capability, { mode: "direct" }, root, {});
  await store.save(direct);
  await assert.rejects(
    store.save({
      version: 1,
      mode: "webhook",
      agent_kind: "openclaw",
      url: "https://agent.example.test/embassys",
      secret_env: "MISSING_SECRET",
    }),
    (error: unknown) => error instanceof DeliveryProfileError && error.code === "profile_conflict",
  );
});

test("concurrent writers cannot replace the first committed profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const direct = await createDeliveryProfile(capability, { mode: "direct" }, root, {});
  const webhook = await createDeliveryProfile(
    capability,
    {
      mode: "webhook",
      url: "https://agent.example.test/embassys",
      secret_env: "EMBASSYS_WEBHOOK_SECRET",
    },
    root,
    { EMBASSYS_WEBHOOK_SECRET: SECRET },
  );
  const path = join(root, "state", "delivery-profile.json");
  const results = await Promise.allSettled([
    new DeliveryProfileStore(path).save(direct),
    new DeliveryProfileStore(path).save(webhook),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(
    rejected?.status === "rejected" &&
      rejected.reason instanceof DeliveryProfileError &&
      rejected.reason.code === "profile_conflict",
    true,
  );
  const stored = await new DeliveryProfileStore(path).load();
  assert.equal(
    JSON.stringify(stored) === JSON.stringify(direct) ||
      JSON.stringify(stored) === JSON.stringify(webhook),
    true,
  );
});
