import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("main publishes the Ambassador 0.2.16 candidate through npm OIDC after approval", async () => {
  const workflow = await readFile(join(process.cwd(), ".github", "workflows", "cli.yml"), "utf8");

  assert.match(workflow, /push:\n {4}branches: \[main\]/u);
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/u);
  assert.match(workflow, /name: Qualify native Windows state ACLs/u);
  assert.match(workflow, /name: Launch installed Windows command shim/u);
  assert.match(workflow, /\$PSNativeCommandUseErrorActionPreference = \$false/u);
  assert.match(workflow, /\[IO\.File\]::ReadAllText\(\$stderrPath\)/u);
  assert.match(workflow, /Remove-Item -Force -ErrorAction SilentlyContinue/u);
  assert.match(workflow, /\n {10}exit 0\n/u);
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
  assert.equal(packageJson.version, "0.2.16");
  assert.deepEqual(packageJson.engines, { node: ">=24.19.0" });
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
});

test("the Windows test runner serializes files that exercise native ACLs", async () => {
  const runner = await readFile(join(process.cwd(), "scripts", "run-tests.mjs"), "utf8");

  assert.match(runner, /process\.platform === "win32" \? \["--test-concurrency=1"\] : \[\]/u);
});

test("every supported-agent guide uses latest Ambassador without pinning a provider release", async () => {
  const guides = ["codex", "claude", "hermes", "openclaw"];
  for (const guide of guides) {
    const contents = await readFile(
      join(process.cwd(), "docs", `getting-started-${guide}.md`),
      "utf8",
    );

    assert.match(contents, /npx --yes @embassys\/ambassador@latest start/u, guide);
    assert.match(contents, /Node\.js `>=24\.19\.0`/u, guide);
    assert.doesNotMatch(contents, /<25/u, guide);
    assert.match(contents, /latest/iu, guide);
    assert.doesNotMatch(
      contents,
      /0\.149\.0|0\.152\.1|2\.1\.257|2\.1\.258|0\.58\.0|0\.20\.5|0\.21\.0|2026\.8\.1|1\.8\.0|0\.73\.0/u,
      guide,
    );
    assert.doesNotMatch(contents, /local-token|AMBASSADOR_LOCAL_TOKEN/u, guide);
    assert.match(contents, /Register me with Embassys/u, guide);
    if (guide === "hermes" || guide === "openclaw") {
      assert.match(contents, /ambassador(?:@latest)? webhook-secret/u, guide);
      assert.match(contents, /delivery\.url/u, guide);
    } else {
      assert.doesNotMatch(contents, /webhook/u, guide);
    }
    if (guide === "openclaw") {
      assert.match(contents, /\/hooks\/agent/u, guide);
      assert.doesNotMatch(contents, /plugins install|plugins enable|embassys-ambassador/u, guide);
    }
    assert.doesNotMatch(contents, /delivery\.secret_env/u, guide);
    assert.doesNotMatch(contents, /@a2adev\/gateway|a2a-gateway/u, guide);
  }
});
