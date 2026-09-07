import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  prepareSupportExport,
  readDiagnostics,
  saveSupportExport,
} from "../src/desktop/diagnostics.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-diagnostics-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "diagnostics");
  await mkdir(directory);
  return { root, directory };
}
const event = (n: number) => ({
  timestamp: `2026-09-07T12:00:${String(n).padStart(2, "0")}.000Z`,
  run_id: "run",
  event: n % 2 ? "central.response" : "central.request",
  data: {
    operation_id: "test-operation",
    body: { answer: `private-answer-${n}` },
    Authorization: "Bearer do-not-export",
    code: "123456",
  },
});

test("diagnostics page rotated files, filter time/operation and redact all output", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(
    join(directory, "events.1.jsonl"),
    `${[event(1), event(2)].map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  await writeFile(join(directory, "events.jsonl"), `${JSON.stringify(event(3))}\n{partial`);
  const page = await readDiagnostics(directory, { limit: 2 });
  assert.equal(page.records.length, 2);
  assert.equal(page.records[0]?.event, "central.response");
  assert.equal(page.hasMore, true);
  assert.equal((await readDiagnostics(directory, { cursor: page.nextCursor })).records.length, 1);
  const filtered = await readDiagnostics(directory, {
    search: "test-operation",
    from: "2026-09-07T12:00:02Z",
  });
  assert.equal(filtered.records.length, 2);
  assert.equal(JSON.stringify(page).includes("do-not-export"), false);
  assert.equal(JSON.stringify(page).includes("123456"), false);
  assert.ok(page.warnings.length > 0);
});

test("diagnostic cursors ignore appended events and reject rotation or changed filters", async (t) => {
  const { directory } = await fixture(t);
  const path = join(directory, "events.jsonl");
  await writeFile(
    path,
    `${[event(1), event(2)].map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  const first = await readDiagnostics(directory, { limit: 1 });
  assert.equal(first.records[0]?.timestamp, event(2).timestamp);
  await appendFile(path, `${JSON.stringify(event(3))}\n`);
  const next = await readDiagnostics(directory, { cursor: first.nextCursor });
  assert.equal(next.records[0]?.timestamp, event(1).timestamp);
  assert.equal(next.hasMore, false);
  await assert.rejects(readDiagnostics(directory, { cursor: first.nextCursor, search: "changed" }));
  await rename(path, join(directory, "events.1.jsonl"));
  await writeFile(path, `${JSON.stringify(event(4))}\n`);
  await assert.rejects(
    readDiagnostics(directory, { cursor: first.nextCursor }),
    /changed|expired/u,
  );
});

test("large logs use bounded scans with continuation even when no records match", async (t) => {
  const { directory } = await fixture(t);
  const line = `${JSON.stringify({ ...event(1), data: "é".repeat(25000) })}\n`;
  await writeFile(join(directory, "events.jsonl"), line.repeat(100));
  const first = await readDiagnostics(directory, { search: "not-present" });
  assert.equal(first.records.length, 0);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  let page = first;
  let pages = 1;
  while (page.hasMore && pages++ < 10)
    page = await readDiagnostics(directory, { search: "not-present", cursor: page.nextCursor });
  assert.equal(page.hasMore, false);
  const valid = await readDiagnostics(directory, { limit: 1 });
  assert.equal(valid.records[0]?.data, "é".repeat(25000));
});

test("export refuses selections beyond its separate memory allowance", async (t) => {
  const { directory } = await fixture(t);
  const line = `${JSON.stringify({ ...event(1), data: "x".repeat(60000) })}\n`;
  await writeFile(join(directory, "events.jsonl"), line.repeat(570));
  await assert.rejects(prepareSupportExport(directory, { includeBodies: true }), /32 MiB/u);
  const metadata = await prepareSupportExport(directory, {});
  assert.equal(metadata.recordCount, 570);
  assert.ok(metadata.bytes < 100000);
});

test("a huge malformed line is skipped across pages without losing the preceding record", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(
    join(directory, "events.jsonl"),
    `${JSON.stringify(event(1))}\n${"x".repeat(3 * 1024 * 1024)}\n`,
  );
  const first = await readDiagnostics(directory);
  assert.equal(first.records.length, 0);
  assert.equal(first.hasMore, true);
  const next = await readDiagnostics(directory, { cursor: first.nextCursor });
  assert.equal(next.records.length, 1);
  assert.equal(next.records[0]?.timestamp, event(1).timestamp);
});

test("oversized records ending exactly at the scan boundary preserve the preceding record", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(
    join(directory, "events.jsonl"),
    `${JSON.stringify(event(1))}\n${"x".repeat(2 * 1024 * 1024 - 1)}\n`,
  );
  const first = await readDiagnostics(directory);
  assert.equal(first.records.length, 0);
  const next = await readDiagnostics(directory, { cursor: first.nextCursor });
  assert.equal(next.records[0]?.timestamp, event(1).timestamp);
});

test("support export defaults to metadata, includes bodies only on request and never overwrites", async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, "events.jsonl"), `${JSON.stringify(event(1))}\n`);
  const basic = await prepareSupportExport(directory, {});
  assert.equal(basic.recordCount, 1);
  assert.equal(basic.contents.includes("private-answer"), false);
  const detailed = await prepareSupportExport(directory, { includeBodies: true });
  assert.ok(detailed.contents.includes("private-answer-1"));
  assert.equal(detailed.contents.includes("do-not-export"), false);
  const output = join(root, "support.jsonl");
  await saveSupportExport(output, detailed);
  assert.equal(await readFile(output, "utf8"), detailed.contents);
  await assert.rejects(saveSupportExport(output, basic));
  assert.equal(await readFile(output, "utf8"), detailed.contents);
});

test("diagnostics refuse symlink inputs and bound malformed or oversized records", async (t) => {
  const { root, directory } = await fixture(t);
  const external = join(root, "external");
  await writeFile(external, `${JSON.stringify(event(1))}\n`);
  if (process.platform !== "win32") {
    await symlink(external, join(directory, "events.jsonl"));
    await assert.rejects(readDiagnostics(directory, {}));
    await rm(join(directory, "events.jsonl"));
  }
  await writeFile(
    join(directory, "events.jsonl"),
    `${"x".repeat(70_000)}\n${JSON.stringify(event(2))}\n`,
  );
  const page = await readDiagnostics(directory, {});
  assert.equal(page.records.length, 1);
  assert.ok(page.warnings.length > 0);
  await assert.rejects(readDiagnostics(directory, { search: "x".repeat(129) }));
});
