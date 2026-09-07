import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopNotifications } from "../src/desktop/notifications.js";

test("local notifications coalesce, survive restart, isolate identities and never store message bodies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-notifications-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shown: unknown[] = [];
  const options = {
    path: join(root, "notifications.json"),
    show: (value: unknown) => {
      shown.push(value);
    },
  };
  let notifications = await DesktopNotifications.open(options);
  const event = { id: "message.1", enrollmentId: "agent.1", kind: "result" as const };
  await notifications.receive("instance.1", event);
  await notifications.flush();
  assert.equal(shown.length, 0);
  await notifications.setEnabled(true);
  await notifications.receive("instance.1", event);
  await notifications.receive("instance.1", { ...event, id: "message.2" });
  await notifications.receive("instance.1", { ...event, id: "message.3", kind: "question" });
  await notifications.flush();
  assert.equal(shown.length, 1);
  notifications = await DesktopNotifications.open(options);
  await notifications.receive("instance.1", { ...event, id: "message.3", kind: "question" });
  await notifications.flush();
  assert.equal(shown.length, 1);
  await notifications.receive("instance.2", event);
  await notifications.receive("instance.1", { ...event, enrollmentId: "agent.2" });
  await notifications.flush();
  assert.equal(shown.length, 3);
  const saved = await readFile(options.path, "utf8");
  assert.doesNotMatch(saved, /message\.1|agent\.1|body|result/);
});

test("banners route to the relevant permission, result or incoming-work view", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-notify-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const banners: unknown[] = [];
  const notifications = await DesktopNotifications.open({
    path: join(root, "notifications.json"),
    show: (banner) => {
      banners.push(banner);
    },
  });
  await notifications.setEnabled(true);
  await notifications.receive("one", { id: "a", enrollmentId: "agent", kind: "permission" });
  await notifications.receive("two", { id: "b", enrollmentId: "agent", kind: "permission" });
  await notifications.receive("two", { id: "c", enrollmentId: "agent", kind: "question" });
  await notifications.receive("three", { id: "d", enrollmentId: "agent", kind: "result" });
  await notifications.flush();
  assert.deepEqual(banners, [
    { instanceId: "one", count: 1, page: "permissions", activity: "incoming" },
    { instanceId: "two", count: 2, page: "attention", activity: "incoming" },
    { instanceId: "three", count: 1, page: "attention", activity: "results" },
  ]);
  await assert.rejects(
    notifications.receive("one", {
      id: "bad",
      enrollmentId: "agent",
      kind: "incoming",
      body: "untrusted",
    } as never),
  );
  assert.equal(banners.length, 3);
});

test("failed preference persistence does not enable notifications", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-notify-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "notifications.json");
  const notifications = await DesktopNotifications.open({
    path,
    show: () => {
      assert.fail("Display requires persisted opt-in");
    },
  });
  await mkdir(path);
  await assert.rejects(notifications.setEnabled(true));
  assert.equal(notifications.enabled, false);
});

test("failed display is not replayed; disabling drops queued banners", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-notify-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let attempts = 0;
  const options = {
    path: join(root, "notifications.json"),
    show: () => {
      attempts++;
      throw new Error("OS unavailable");
    },
  };
  let notifications = await DesktopNotifications.open(options);
  await notifications.setEnabled(true);
  const event = { id: "one", enrollmentId: "agent", kind: "incoming" as const };
  await notifications.receive("instance", event);
  await notifications.flush();
  notifications = await DesktopNotifications.open(options);
  await notifications.receive("instance", event);
  await notifications.flush();
  assert.equal(attempts, 1);
  await notifications.receive("instance", { ...event, id: "two" });
  await notifications.setEnabled(false);
  await notifications.flush();
  assert.equal(attempts, 1);
});
