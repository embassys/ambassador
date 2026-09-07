import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    [event(1), event(2)].map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  await writeFile(join(directory, "events.jsonl"), JSON.stringify(event(3)) + "\n{partial");
  const page = await readDiagnostics(directory, { limit: 2 });
  assert.equal(page.records.length, 2);
  assert.equal(page.records[0]?.event, "central.response");
  assert.equal(page.hasMore, true);
  assert.equal((await readDiagnostics(directory, { offset: page.nextOffset })).records.length, 1);
  const filtered = await readDiagnostics(directory, {
    search: "test-operation",
    from: "2026-09-07T12:00:02Z",
  });
  assert.equal(filtered.total, 2);
  assert.equal(JSON.stringify(page).includes("do-not-export"), false);
  assert.equal(JSON.stringify(page).includes("123456"), false);
  assert.ok(page.warnings.length > 0);
});

test("support export defaults to metadata, includes bodies only on request and never overwrites", async (t) => {
  const { root, directory } = await fixture(t);
  await writeFile(join(directory, "events.jsonl"), JSON.stringify(event(1)) + "\n");
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
  await writeFile(external, JSON.stringify(event(1)) + "\n");
  if (process.platform !== "win32") {
    await symlink(external, join(directory, "events.jsonl"));
    await assert.rejects(readDiagnostics(directory, {}));
    await rm(join(directory, "events.jsonl"));
  }
  await writeFile(
    join(directory, "events.jsonl"),
    "x".repeat(70_000) + "\n" + JSON.stringify(event(2)) + "\n",
  );
  const page = await readDiagnostics(directory, {});
  assert.equal(page.records.length, 1);
  assert.ok(page.warnings.length > 0);
  await assert.rejects(readDiagnostics(directory, { search: "x".repeat(129) }));
});
