import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { PRODUCTION_AGENT_CAPABILITIES } from "../src/agent-capabilities.js";
import {
  createDeliveryProfile,
  DeliveryProfileError,
  DeliveryProfileStore,
  validateStoredDeliveryProfile,
} from "../src/delivery-profile.js";
import { assertNativeWindowsAcl } from "./support/windows-acl.js";

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
    },
    root,
  );
  const store = new DeliveryProfileStore(path);
  await store.save(profile);
  assert.deepEqual(await store.load(), profile);
  const bytes = await readFile(path, "utf8");
  assert.equal(bytes.includes("secret"), false);
  assert.equal(bytes.includes("payload"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("stores the canonical direct directory and rejects a conflicting restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-direct-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = PRODUCTION_AGENT_CAPABILITIES[1];
  assert.ok(capability);
  const profile = await createDeliveryProfile(capability, { mode: "direct" }, root);
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

test("loads every enabled registry-derived direct profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-all-direct-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const capability of PRODUCTION_AGENT_CAPABILITIES) {
    const workingDirectory = join(root, capability.kind);
    await mkdir(workingDirectory, { recursive: true });
    const profile = await createDeliveryProfile(capability, { mode: "direct" }, workingDirectory);
    assert.equal(profile.agent_kind, capability.kind);
    assert.deepEqual(await validateStoredDeliveryProfile(profile, workingDirectory), {
      profile,
      capability,
    });
  }
});

test("fails closed on conflicting state and obsolete webhook records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-invalid-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const store = new DeliveryProfileStore(join(root, "delivery-profile.json"));
  const direct = await createDeliveryProfile(capability, { mode: "direct" }, root);
  await store.save(direct);
  await assert.rejects(
    store.save({
      version: 1,
      mode: "webhook",
      agent_kind: "openclaw",
      url: "https://agent.example.test/embassys",
    }),
    (error: unknown) => error instanceof DeliveryProfileError && error.code === "profile_conflict",
  );

  const legacyPath = join(root, "legacy-profile.json");
  await writeFile(
    legacyPath,
    JSON.stringify({
      version: 1,
      mode: "webhook",
      agent_kind: "openclaw",
      url: "https://agent.example.test/embassys",
      secret_env: "AMBASSADOR_WEBHOOK_SECRET",
    }),
  );
  if (process.platform !== "win32") await chmod(legacyPath, 0o600);
  await assert.rejects(
    new DeliveryProfileStore(legacyPath).load(),
    (error: unknown) => error instanceof DeliveryProfileError && error.code === "invalid_profile",
  );
});

test("concurrent writers cannot replace the first committed profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const direct = await createDeliveryProfile(capability, { mode: "direct" }, root);
  const webhook = await createDeliveryProfile(
    capability,
    {
      mode: "webhook",
      url: "https://agent.example.test/embassys",
    },
    root,
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

test("profile readers wait for atomic link cleanup but reject a persistent extra link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "profile.json");
  const store = new DeliveryProfileStore(path);
  const profile = {
    version: 1 as const,
    mode: "webhook" as const,
    agent_kind: "openclaw",
    url: "https://agent.example.test/embassys",
  };
  await store.save(profile);
  const temporary = join(root, "profile.tmp");
  await link(path, temporary);
  const cleanup = delay(10).then(() => unlink(temporary));
  assert.deepEqual(await store.load(), profile);
  await cleanup;
  await link(path, temporary);
  await assert.rejects(store.load(), { code: "profile_store_failed" });
});

test("enforces native Windows DACLs on the profile and state directory", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-native-windows-;[]$()-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "delivery-profile.json");
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const profile = await createDeliveryProfile(capability, { mode: "direct" }, root);
  const store = new DeliveryProfileStore(path);

  await store.save(profile);
  assert.deepEqual(await store.load(), profile);
  await assertNativeWindowsAcl(join(root, "state"), "directory");
  await assertNativeWindowsAcl(path, "file");
});

test("fails closed when Windows profile DACL enforcement fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-profile-windows-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "delivery-profile.json");
  const capability = PRODUCTION_AGENT_CAPABILITIES[0];
  assert.ok(capability);
  const profile = await createDeliveryProfile(capability, { mode: "direct" }, root);
  const store = new DeliveryProfileStore(path, {
    platform: "win32",
    windowsAccessControl: {
      async secure() {
        throw new Error("injected Windows ACL failure");
      },
    },
  });

  await assert.rejects(
    store.save(profile),
    (error: unknown) =>
      error instanceof DeliveryProfileError && error.code === "profile_store_failed",
  );
  await assert.rejects(readFile(path), {
    code: "ENOENT",
  });
});
