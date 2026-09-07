import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopAppearance, windowAppearance } from "../src/desktop/appearance.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";

test("desktop appearance follows the platform and respects reduced transparency", () => {
  assert.equal(windowAppearance("darwin", false, false).titleBarStyle, "hiddenInset");
  assert.equal(windowAppearance("darwin", false, false).vibrancy, "sidebar");
  assert.equal(windowAppearance("darwin", false, true).vibrancy, undefined);
  assert.equal(windowAppearance("win32", true, false).backgroundMaterial, "mica");
  assert.equal(windowAppearance("win32", true, true).backgroundMaterial, undefined);
  assert.equal(windowAppearance("linux", true, false).titleBarStyle, "default");
  assert.equal(windowAppearance("linux", true, false).backgroundColor, "#1e1e20");
});

test("appearance choices survive restart and invalid input leaves the preference intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-appearance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appearance = await DesktopAppearance.open(root);
  assert.equal(appearance.value, "system");
  await appearance.set("dark");
  assert.equal((await DesktopAppearance.open(root)).value, "dark");
  assert.throws(() => parseDesktopCommand({ type: "set_appearance", appearance: "remote" }));
  assert.throws(() =>
    parseDesktopCommand({ type: "set_appearance", appearance: "light", path: root }),
  );
  assert.equal(
    JSON.parse(await readFile(join(root, "appearance.json"), "utf8")).appearance,
    "dark",
  );
  await writeFile(join(root, "appearance.json"), "not json");
  await assert.rejects(DesktopAppearance.open(root));
});

test("appearance refuses linked files and does not replace their target", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "embassys-appearance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "original.json");
  await writeFile(target, '{"appearance":"dark"}');
  await symlink(target, join(root, "appearance.json"));
  await assert.rejects(DesktopAppearance.open(root));
  assert.equal(await readFile(target, "utf8"), '{"appearance":"dark"}');
});
