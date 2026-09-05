import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
