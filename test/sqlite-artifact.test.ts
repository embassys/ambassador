import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { preparePrivateSqliteArtifact } from "../src/sqlite-artifact.js";

function fixture(t: TestContext): { directory: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "ambassador-sqlite-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "state");
  mkdirSync(directory);
  return { directory, path: join(directory, "artifact.sqlite") };
}

test("applies Windows access control to a SQLite directory and database", (t) => {
  const item = fixture(t);
  const secured: Array<{ path: string; kind: "directory" | "file" }> = [];
  const artifact = preparePrivateSqliteArtifact(item.path, () => new Error("invalid"), {
    platform: "win32",
    windowsAccessControl: {
      secure(path, kind) {
        secured.push({ path, kind });
      },
    },
  });
  try {
    assert.deepEqual(secured, [
      { path: item.directory, kind: "directory" },
      { path: item.path, kind: "file" },
    ]);
    artifact.validate();
  } finally {
    artifact.close();
  }
});

test("fails closed when Windows SQLite access control fails", (t) => {
  const item = fixture(t);
  assert.throws(
    () =>
      preparePrivateSqliteArtifact(item.path, () => new Error("invalid"), {
        platform: "win32",
        windowsAccessControl: {
          secure() {
            throw new Error("injected Windows ACL failure");
          },
        },
      }),
    /Windows ACL failure/u,
  );
});
