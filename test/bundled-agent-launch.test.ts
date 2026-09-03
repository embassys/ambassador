import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { PRODUCTION_AGENT_CAPABILITIES } from "../src/agent-capabilities.js";
import {
  resolveBuiltInAgentEntrypoint,
  resolveBundledNodePackageEntrypoint,
} from "../src/direct-delivery.js";

const CONTRACT = {
  packageName: "@agentclientprotocol/codex-acp",
  binName: "codex-acp",
  entrypoint: "dist/index.js",
} as const;

async function fixture(
  t: TestContext,
  values: {
    packageName?: string;
    version?: string;
    entrypoint?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-bundled-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "node_modules", "@agentclientprotocol", "codex-acp");
  const entrypoint = join(packageRoot, "dist", "index.js");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  const manifestPath = join(packageRoot, "package.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: values.packageName ?? CONTRACT.packageName,
      version: values.version ?? "1.8.0",
      bin: { [CONTRACT.binName]: values.entrypoint ?? CONTRACT.entrypoint },
    }),
  );
  await writeFile(entrypoint, "process.exitCode = 0;\n");
  return { entrypoint, manifestPath };
}

test("resolves and validates the fixed entrypoint from a bundled Node agent package", async (t) => {
  const item = await fixture(t);
  assert.equal(
    await resolveBundledNodePackageEntrypoint(CONTRACT, () => item.manifestPath),
    await realpath(item.entrypoint),
  );
});

test("the installed Ambassador provides the Codex dependency and its own Claude bridge", async () => {
  const codex = PRODUCTION_AGENT_CAPABILITIES.find((item) => item.kind === "codex")?.direct;
  assert.ok(codex?.bundledNodePackage !== undefined);
  assert.match(
    await resolveBundledNodePackageEntrypoint(codex.bundledNodePackage),
    /[/\\]dist[/\\]index\.js$/u,
  );

  const claude = PRODUCTION_AGENT_CAPABILITIES.find((item) => item.kind === "claude")?.direct;
  assert.equal(claude?.builtInAdapter, "claude-cli");
  assert.match(await resolveBuiltInAgentEntrypoint("claude-cli"), /claude-cli-acp\.js$/u);
});

test("rejects a missing, mismatched, or escaping bundled Node agent package", async (t) => {
  const mismatch = await fixture(t, { packageName: "@agentclientprotocol/not-codex-acp" });
  await assert.rejects(resolveBundledNodePackageEntrypoint(CONTRACT, () => mismatch.manifestPath));

  const pathEscape = await fixture(t, { entrypoint: "../outside.js" });
  await assert.rejects(
    resolveBundledNodePackageEntrypoint(CONTRACT, () => pathEscape.manifestPath),
  );

  await assert.rejects(
    resolveBundledNodePackageEntrypoint(CONTRACT, () => join(mismatch.manifestPath, "missing")),
  );
});
