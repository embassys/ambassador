import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { preparePrivateSqliteArtifact } from "../../src/sqlite-artifact.js";
import { assertPrivateArtifact } from "../support/private-artifact.js";

const invalid = () => new Error("invalid private SQLite artifact");

test("native SQLite main and recovery sidecars receive private permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private.sqlite3");
  const suffixes = ["", "-wal", "-shm", "-journal"];
  for (const suffix of suffixes) await writeFile(`${path}${suffix}`, "fixture", { mode: 0o644 });
  const artifact = preparePrivateSqliteArtifact(path, invalid);
  try {
    artifact.validate();
    await assertPrivateArtifact(root, "directory");
    for (const suffix of suffixes) {
      await assertPrivateArtifact(`${path}${suffix}`, "file");
      assert.equal(await readFile(`${path}${suffix}`, "utf8"), "fixture");
    }
  } finally {
    artifact.close();
  }
});

test("native SQLite refuses linked recovery files and directory aliases without changing their targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-native-sqlite-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target");
  await mkdir(target);
  const alias = join(root, "alias");
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => preparePrivateSqliteArtifact(join(alias, "private.sqlite3"), invalid),
    /invalid private/,
  );
  const protectedFile = join(root, "target.txt");
  await writeFile(protectedFile, "do not change");
  const path = join(root, "private.sqlite3");
  await link(protectedFile, `${path}-wal`);
  assert.throws(() => preparePrivateSqliteArtifact(path, invalid), /invalid private/);
  assert.equal(await readFile(protectedFile, "utf8"), "do not change");
});
