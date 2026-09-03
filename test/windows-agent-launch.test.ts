import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { resolveWindowsNodePackageEntrypoint } from "../src/direct-delivery.js";

async function fixture(
  t: TestContext,
  version = "1.8.0",
  packageName = "@agentclientprotocol/codex-acp",
) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-windows-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  const binDirectory = join(modules, ".bin");
  const packageRoot = join(modules, "@agentclientprotocol", "codex-acp");
  const entrypoint = join(packageRoot, "dist", "index.js");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      bin: { "codex-acp": "dist/index.js" },
    }),
  );
  await writeFile(entrypoint, "process.exitCode = 0;\n");
  await writeFile(join(binDirectory, "codex-acp.cmd"), "@echo off\r\n");
  return { root, binDirectory, entrypoint };
}

const CONTRACT = {
  packageName: "@agentclientprotocol/codex-acp",
  binName: "codex-acp",
  entrypoint: "dist/index.js",
} as const;

test("resolves a fixed Windows Node agent package without gating on its version", async (t) => {
  const item = await fixture(t, "1.8.1");
  assert.equal(
    await resolveWindowsNodePackageEntrypoint(CONTRACT, { PATH: item.binDirectory }),
    await realpath(item.entrypoint),
  );
});

test("rejects missing, mismatched, and path-escaping Windows Node agent packages", async (t) => {
  const mismatch = await fixture(t, "1.8.0", "@agentclientprotocol/not-codex-acp");
  await assert.rejects(
    resolveWindowsNodePackageEntrypoint(CONTRACT, { PATH: mismatch.binDirectory }),
  );
  await assert.rejects(resolveWindowsNodePackageEntrypoint(CONTRACT, {}));
  await assert.rejects(
    resolveWindowsNodePackageEntrypoint(
      { ...CONTRACT, entrypoint: "../outside.js" },
      { PATH: mismatch.binDirectory },
    ),
  );
});

test("rejects unbounded Windows Node package version metadata", async (t) => {
  const item = await fixture(t, "x".repeat(129));
  await assert.rejects(resolveWindowsNodePackageEntrypoint(CONTRACT, { PATH: item.binDirectory }));
});
