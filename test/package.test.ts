import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("package metadata exposes only the Ambassador package and binary", async () => {
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), "package.json"), "utf8"),
  ) as Record<string, unknown>;

  assert.equal(packageJson.name, "@embassys/ambassador");
  assert.equal(packageJson.version, "0.2.7");
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.license, "MIT");
  assert.equal(
    packageJson.packageManager,
    "pnpm@11.22.0+sha512.1ff870c4c6133dfd88fb2afc46dd13d47f09c9794b438c6fdb47ca98caf3bc16381ee0be93a091b8e3824cf01f889f46d7d9e20910fb0be1ab0fb5baa80dd621",
  );
  assert.deepEqual(packageJson.bin, { ambassador: "dist/cli.js" });
  assert.equal(
    (packageJson.dependencies as Record<string, string>)["@agentclientprotocol/sdk"],
    "1.4.0",
  );
  assert.deepEqual(packageJson.files, [
    "dist",
    "docs/getting-started-claude.md",
    "docs/getting-started-codex.md",
    "docs/getting-started-gemini.md",
    "docs/getting-started-hermes.md",
    "docs/getting-started-openclaw.md",
    "docs/live-qualification.md",
  ]);
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/embassys/ambassador.git",
  });

  const workspace = await readFile(join(process.cwd(), "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /minimumReleaseAge: 1440/u);
  assert.match(workspace, /minimumReleaseAgeStrict: true/u);
  assert.match(workspace, /blockExoticSubdeps: true/u);
  assert.match(workspace, /allowBuilds:\n {2}better-sqlite3: true/u);
  const lockfile = await readFile(join(process.cwd(), "pnpm-lock.yaml"), "utf8");
  assert.match(lockfile, /^lockfileVersion:/u);
  await assert.rejects(
    readFile(join(process.cwd(), "package-lock.json")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});
