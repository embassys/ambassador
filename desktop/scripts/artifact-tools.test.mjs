import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  dependencyBom,
  inventory,
  runArchiveTool,
  signingOptions,
  verifyInventory,
} from "./artifact-tools.mjs";

test("archive failures retain bounded tool diagnostics and enforce a deadline", async () => {
  await assert.rejects(
    runArchiveTool(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(10000) + 'final image error', () => process.exit(1))",
    ]),
    (error) => error.message.endsWith("final image error") && error.message.length < 5000,
  );
  await assert.rejects(
    runArchiveTool(process.execPath, [
      "-e",
      "process.stderr.write('disk image failure'); process.exit(7)",
    ]),
    /exited 7: disk image failure/u,
  );
  await assert.rejects(
    runArchiveTool(process.execPath, [
      "-e",
      "process.stderr.write('x'.repeat(100000)); process.exit(1)",
    ]),
    (error) => error.message.includes("exited 1") && error.message.length < 5000,
  );
  await assert.rejects(
    runArchiveTool(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100),
    /timed out/u,
  );
});

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
  const preview = signingOptions("darwin", {});
  assert.equal(preview.signed, false);
  assert.equal(preview.adHocSigned, true);
  assert.equal(preview.options.osxSign.identity, "-");
  assert.equal(preview.options.osxSign.identityValidation, false);
  assert.equal(preview.options.osxSign.continueOnError, false);
  assert.equal(preview.options.osxNotarize, false);
  assert.equal(signingOptions("win32", {}).options.osxSign, false);
  assert.equal(signingOptions("linux", {}).options.osxSign, false);
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
