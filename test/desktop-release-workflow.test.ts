import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("desktop packaging clears removed compiled sources before compiling the gateway", async () => {
  const build = await readFile("desktop/scripts/build.mjs", "utf8");
  const clean = build.indexOf(
    'await run(process.execPath, [join(repository, "scripts/clean.mjs"), "dist"])',
  );
  const compile = build.indexOf('await run(process.execPath, [packageManager, "run", "build"])');
  assert.ok(clean >= 0 && clean < compile, "old dist files must not enter the engine inventory");
});

test("desktop downloads are retained only after archive, host and handoff checks pass", async () => {
  const workflow = await readFile(".github/workflows/desktop.yml", "utf8");
  const upload = workflow.indexOf("name: desktop-downloads-");
  assert.ok(upload > 0, "retain the verified application downloads");
  for (const gate of [
    "run verify:portable",
    "run verify:distribution",
    "run verify:package",
    "run verify:shared",
  ])
    assert.ok(workflow.lastIndexOf(gate) < upload && workflow.includes(gate), gate);
  const downloadStep = workflow.slice(workflow.lastIndexOf("      - uses:", upload));
  assert.match(downloadStep, /if-no-files-found: error/u);
  assert.match(downloadStep, /compression-level: 0/u);
  assert.match(downloadStep, /retention-days: 7/u);
  for (const extension of ["dmg", "zip", "tar.gz", "manifest.json", "cdx.json", "sha256"])
    assert.ok(downloadStep.includes(`.build/desktop/distribution/*.${extension}`), extension);
  assert.match(workflow, /os: \[macos-latest, windows-latest, ubuntu-latest\]/u);
  assert.match(workflow, /permissions:\n {2}contents: read/u);
  assert.doesNotMatch(workflow, /continue-on-error:|if: always\(\)|gh release|contents: write/u);
});
