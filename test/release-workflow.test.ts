import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("main publishes the Ambassador 0.2.9 candidate through npm OIDC after approval", async () => {
  const workflow = await readFile(join(process.cwd(), ".github", "workflows", "cli.yml"), "utf8");

  assert.match(workflow, /push:\n {4}branches: \[main\]/u);
  assert.match(
    workflow,
    /publish:\n {4}name: Publish npm package\n {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u,
  );
  assert.match(workflow, /needs: \[check, central-fixture, package\]/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /npm install --global npm@11\.19\.0/u);
  assert.match(workflow, /npm publish "\$\{\{ steps\.artifact\.outputs\.tarball \}\}"/u);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM/u);

  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(packageJson.name, "@embassys/ambassador");
  assert.equal(packageJson.version, "0.2.9");
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
});

test("every supported-agent guide uses latest Ambassador without pinning a provider release", async () => {
  const guides = ["codex", "claude", "gemini", "hermes", "openclaw"];
  for (const guide of guides) {
    const contents = await readFile(
      join(process.cwd(), "docs", `getting-started-${guide}.md`),
      "utf8",
    );

    assert.match(contents, /npx --yes @embassys\/ambassador@latest start/u, guide);
    assert.match(contents, /latest/iu, guide);
    assert.doesNotMatch(
      contents,
      /\blatest\s+(?:Codex|Claude|Gemini|Hermes|OpenClaw|`?@agentclientprotocol)/iu,
      guide,
    );
    assert.doesNotMatch(
      contents,
      /0\.149\.0|0\.152\.1|2\.1\.257|2\.1\.258|0\.58\.0|0\.20\.5|0\.21\.0|2026\.8\.1|1\.8\.0|0\.73\.0/u,
      guide,
    );
    assert.doesNotMatch(contents, /local-token|AMBASSADOR_LOCAL_TOKEN/u, guide);
    assert.match(contents, /register_agent/u, guide);
    if (guide === "hermes" || guide === "openclaw") {
      assert.match(contents, /delivery\.secret_env/u, guide);
    } else {
      assert.doesNotMatch(contents, /webhook|delivery\.secret_env/u, guide);
    }
    assert.doesNotMatch(contents, /@a2adev\/gateway|a2a-gateway/u, guide);
  }
});
