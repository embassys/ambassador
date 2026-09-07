import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dependencyBom, inventory, signingOptions, verifyInventory } from "./artifact-tools.mjs";

test("package inventory verifies exact bytes and detects additions, changes and missing files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "worker.js"), "export const protocol = 1;");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@example/engine",
      version: "1.2.3",
      license: "MIT",
      private_setting: "excluded",
    }),
  );
  const manifest = await inventory(root);
  await verifyInventory(root, manifest);
  const bom = await dependencyBom(root, manifest, {
    app: "0.1.0",
    electron: "44.2.0",
    node: "24.19.0",
  });
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.ok(bom.components.some((item) => item.purl === "pkg:npm/%40example/engine@1.2.3"));
  assert.doesNotMatch(JSON.stringify(bom), /excluded|private_setting/);
  await writeFile(join(root, "extra"), "unexpected");
  await assert.rejects(verifyInventory(root, manifest));
  await rm(join(root, "extra"));
  await writeFile(join(root, "nested", "worker.js"), "changed");
  await assert.rejects(verifyInventory(root, manifest));
  await rm(join(root, "nested", "worker.js"));
  await assert.rejects(verifyInventory(root, manifest));
});

test("inventory bounds entries and refuses links outside the package", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "package"));
  await writeFile(join(root, "private"), "outside");
  await symlink("../private", join(root, "package", "escape"));
  await assert.rejects(inventory(join(root, "package")));
  await rm(join(root, "package", "escape"));
  await writeFile(join(root, "package", "one"), "one");
  await writeFile(join(root, "package", "two"), "two");
  await assert.rejects(inventory(join(root, "package"), { maximumEntries: 1 }));
  await assert.rejects(inventory(join(root, "package"), { maximumBytes: 1 }));
});

test("requested signing never silently downgrades to unsigned output", () => {
  assert.deepEqual(signingOptions("darwin", {}), {
    signed: false,
    options: { osxSign: false, osxNotarize: false },
  });
  assert.throws(() => signingOptions("darwin", { EMBASSYS_DESKTOP_SIGN: "1" }));
  assert.throws(() => signingOptions("win32", { EMBASSYS_DESKTOP_SIGN: "1" }));
  assert.throws(() => signingOptions("linux", { EMBASSYS_DESKTOP_SIGN: "1" }));
  assert.throws(() => signingOptions("darwin", { EMBASSYS_DESKTOP_SIGN: "yes" }));
  const mac = signingOptions("darwin", {
    EMBASSYS_DESKTOP_SIGN: "1",
    EMBASSYS_MAC_IDENTITY: "Developer ID Application: Fixture (ABCDE12345)",
    EMBASSYS_NOTARY_PROFILE: "embassys-development",
  });
  assert.equal(mac.signed, true);
  assert.equal(mac.options.osxSign.continueOnError, false);
  assert.equal(mac.options.osxNotarize.keychainProfile, "embassys-development");
});
