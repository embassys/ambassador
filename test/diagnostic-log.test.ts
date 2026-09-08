import assert from "node:assert/strict";
import { mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopDiagnosticOptions } from "../src/desktop/diagnostic-policy.js";
import { DiagnosticLog } from "../src/diagnostic-log.js";
import { clearLocalGatewayState } from "../src/local-state-cleaner.js";

test("persistent diagnostics retain request bodies, redact credentials, and survive clean", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new DiagnosticLog(join(root, "diagnostics"));
  log.log("central.request", {
    request_id: "request-one",
    body: {
      email: "diagnostic@example.test",
      payload: { title: "Calendar lookup" },
      code: "private-code",
    },
    headers: {
      authorization: "Bearer private-token",
      "x-webhook-signature-v2": "private-signature",
    },
    apiKey: "private-api-key",
    privateKey: "private-key",
  });
  await log.close();
  await clearLocalGatewayState(root, join(root, "ambassador.lock"));
  const text = await readFile(join(root, "diagnostics", "events.jsonl"), "utf8");
  assert.match(text, /Calendar lookup/u);
  assert.match(text, /diagnostic@example.test/u);
  assert.doesNotMatch(
    text,
    /private-code|private-token|private-signature|private-api-key|private-key/u,
  );
  const record = JSON.parse(text);
  assert.equal(record.event, "central.request");
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  assert.equal(typeof record.run_id, "string");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(root, "diagnostics"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "diagnostics", "events.jsonl"))).mode & 0o777, 0o600);
  }
});

test("diagnostics rotate within the retention bound and flush a bounded queue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new DiagnosticLog(join(root, "diagnostics"), {
    maximumFileBytes: 1024,
    maximumFiles: 3,
  });
  for (let i = 0; i < 25; i += 1) log.log("event", { index: i, value: "a".repeat(300) });
  await log.close();
  const files = await readdir(log.directory);
  assert.equal(files.length, 3);
  for (const file of files) {
    const content = await readFile(join(log.directory, file), "utf8");
    assert.ok(Buffer.byteLength(content) <= 1024);
    for (const line of content.trim().split("\n")) assert.equal(JSON.parse(line).event, "event");
  }
  assert.match(await readFile(join(log.directory, "events.jsonl"), "utf8"), /"index":24/u);
});

test("diagnostic overflow is reported without throwing into business operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notices: string[] = [];
  const log = new DiagnosticLog(join(root, "diagnostics"), {
    maximumQueueBytes: 1024,
    onNotice: (notice) => notices.push(notice),
  });
  for (let i = 0; i < 100; i += 1) log.log("event", { value: "x".repeat(500) });
  await log.close();
  assert.ok(notices.some((notice) => notice.includes("dropped")));
  assert.match(await readFile(join(log.directory, "events.jsonl"), "utf8"), /diagnostic\.dropped/u);
});

test("diagnostics refuse a linked file without modifying its target", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(root, join(root, "diagnostics"));
  assert.throws(() => new DiagnosticLog(join(root, "diagnostics")));
});

test("desktop policies cap logs at 1 GiB and production excludes arbitrary text and bodies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-log-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = desktopDiagnosticOptions("production");
  assert.equal(options.maximumFiles * options.maximumFileBytes, 1024 ** 3);
  assert.equal(options.maximumAgeMs, 7 * 86400000);
  const log = new DiagnosticLog(root, options);
  log.log("central.response", {
    method: "POST",
    status: 403,
    duration_ms: 124,
    operation_id: "00000000-0000-4000-8000-000000000001",
    body: { title: "private-body" },
    headers: { other: "private-header" },
    error: "private-error",
    message: "private-message",
    result: "private-result",
    status_text: "private-status",
    url: "https://server.test/api/call?email=private-email",
  });
  await log.close();
  const contents = await readFile(join(root, "events.jsonl"), "utf8");
  assert.doesNotMatch(contents, /private-/u);
  assert.deepEqual(JSON.parse(contents).data, {
    method: "POST",
    status: 403,
    duration_ms: 124,
    operation_id: "00000000-0000-4000-8000-000000000001",
  });
});

test("desktop rotation enforces the real 1 GiB allowance using sparse files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-log-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = desktopDiagnosticOptions("development");
  for (let index = 0; index < policy.maximumFiles; index++) {
    const file = await open(
      join(root, index ? `events.${index}.jsonl` : "events.jsonl"),
      "wx",
      0o600,
    );
    await file.writeFile(
      `${JSON.stringify({ timestamp: new Date().toISOString(), event: "old", data: { segment: index } })}\n`,
    );
    await file.truncate(policy.maximumFileBytes);
    await file.close();
  }
  const log = new DiagnosticLog(root, policy);
  log.log("new");
  await log.close();
  const files = await readdir(root);
  assert.equal(files.length, 16);
  const sizes = await Promise.all(files.map(async (name) => (await stat(join(root, name))).size));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 1024 ** 3);
  assert.match(await readFile(join(root, "events.jsonl"), "utf8"), /"new"/u);
});

test("desktop retention expires old segments on restart and maintenance, and rotates by day", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-log-age-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-09-01T10:00:00Z");
  const options = { ...desktopDiagnosticOptions("development"), now: () => now };
  const log = new DiagnosticLog(root, options);
  log.log("old");
  await log.maintain();
  now += 86400000;
  log.log("recent");
  await log.maintain();
  assert.ok((await readdir(root)).includes("events.1.jsonl"));
  now += 6 * 86400000;
  await log.maintain();
  assert.equal((await readdir(root)).includes("events.1.jsonl"), false);
  await log.close();
  now += 86400000;
  const restarted = new DiagnosticLog(root, options);
  await restarted.close();
  assert.equal(await readFile(join(root, "events.jsonl"), "utf8"), "");
});

test("clear drains earlier writes, preserves unrelated files and permits later logging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-log-clear-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "keep.txt"), "unrelated");
  const log = new DiagnosticLog(root, desktopDiagnosticOptions("development"));
  log.log("before");
  const clearing = log.clear();
  log.log("after");
  await clearing;
  await log.close();
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "unrelated");
  const contents = await readFile(join(root, "events.jsonl"), "utf8");
  assert.doesNotMatch(contents, /before/u);
  assert.match(contents, /after/u);
});

test("clear validates every archive before deleting any", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-log-clear-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = new DiagnosticLog(root);
  log.log("keep");
  await log.maintain();
  await writeFile(join(root, "outside"), "untouched");
  await symlink(join(root, "outside"), join(root, "events.3.jsonl"));
  await assert.rejects(log.clear());
  await log.close();
  assert.match(await readFile(join(root, "events.jsonl"), "utf8"), /keep/u);
  assert.equal(await readFile(join(root, "outside"), "utf8"), "untouched");
});
