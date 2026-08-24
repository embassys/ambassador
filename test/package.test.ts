import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

test("package metadata exposes the approved public gateway", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(packageJson.name, "@a2adev/gateway");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "MIT");
  assert.deepEqual(packageJson.bin, { "a2a-gateway": "dist/cli.js" });
  assert.deepEqual(packageJson.files, ["dist"]);
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/nikrooz/a2a.git",
  });
});

test("the packaged CLI runs through an npm-style executable link", {
  skip: process.platform === "win32",
}, async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-package-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const executable = join(directory, "a2a-gateway");
  await symlink(join(process.cwd(), ".test-dist", "src", "cli.js"), executable);

  const result = await executeFile(process.execPath, [executable, "version"]);

  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "a2a-gateway 0.1.0\n");
});
