import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("package metadata exposes the approved public gateway", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(packageJson.name, "@a2adev/gateway");
  assert.equal(packageJson.version, "0.2.0");
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "MIT");
  assert.deepEqual(packageJson.bin, { "a2a-gateway": "dist/cli.js" });
  assert.deepEqual(packageJson.files, [
    "dist",
    "docs/hermes-webhook-bridge.mjs",
    "docs/getting-started-hermes.md",
    "docs/getting-started-openclaw.md",
  ]);
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/nikrooz/a2a.git",
  });
});
