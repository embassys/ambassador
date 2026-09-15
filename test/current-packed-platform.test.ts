import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type Database from "better-sqlite3";

const cli = process.env.AMBASSADOR_PACKED_CLI;

test("installed package loads native SQLite and rejects an invalid command through its installed entrypoint", {
  skip: cli === undefined ? "requires a clean-installed package" : false,
  timeout: 30_000,
}, async (t) => {
  assert.ok(cli);
  const root = await mkdtemp(join(tmpdir(), "ambassador-installed-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const InstalledDatabase = createRequire(await realpath(cli))("better-sqlite3") as typeof Database;
  const database = new InstalledDatabase(join(root, "native.sqlite3"));
  try {
    database.exec("CREATE TABLE probe (value INTEGER) STRICT");
    database.prepare("INSERT INTO probe VALUES (?)").run(42);
    assert.deepEqual(database.prepare("SELECT value FROM probe").get(), { value: 42 });
  } finally {
    database.close();
  }
  // Windows's .cmd entrypoint is exercised by the dedicated PowerShell CI step.
  const command =
    process.platform === "win32"
      ? process.execPath
      : join(dirname(cli), "..", "..", ".bin", "embassys");
  const args = process.platform === "win32" ? [cli, "invalid"] : ["invalid"];
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd: root, timeout: 20_000 }, (error, stdout, stderr) => {
      try {
        assert.equal(error?.code, 2);
        assert.equal(stdout, "");
        assert.equal(stderr.replaceAll("\r\n", "\n"), "Invalid command or arguments\n");
        resolve();
      } catch (failure) {
        reject(failure);
      }
    });
  });
});
