import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { controlPalette, DesktopAppearance, windowAppearance } from "../src/desktop/appearance.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";

test("system accents keep readable button labels and links in both themes", () => {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(
      (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
    );
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    const [red = 0, green = 0, blue = 0] = linear;
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const contrast = (a: string, b: string) => {
    const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (lighter + 0.05) / (darker + 0.05);
  };
  for (const dark of [false, true]) {
    for (const accent of ["A850C4FF", "ffffffff", "000000ff", "ffff00ff", "777777ff", "007affff"]) {
      const palette = controlPalette(accent, dark);
      assert.equal(palette.accent, `#${accent.slice(0, 6).toLowerCase()}`);
      assert.ok(contrast(palette.accent, palette.accentText) >= 4.5);
      assert.ok(contrast(palette.link, dark ? "#29292c" : "#f5f5f7") >= 4.5);
    }
  }
  for (const invalid of [undefined, "", "var(--remote)", "#fff", "112233", "11223300"])
    assert.equal(controlPalette(invalid, false).accent, "#007aff");
});

test("desktop appearance follows the platform and respects reduced transparency", () => {
  assert.equal(windowAppearance("darwin", false, false).titleBarStyle, "hiddenInset");
  assert.equal(windowAppearance("darwin", false, false).vibrancy, "under-window");
  assert.deepEqual(windowAppearance("darwin", false, false).trafficLightPosition, { x: 14, y: 19 });
  assert.equal(windowAppearance("win32", false, false).trafficLightPosition, undefined);
  assert.equal(windowAppearance("darwin", false, true).vibrancy, undefined);
  assert.equal(windowAppearance("win32", true, false).backgroundMaterial, "mica");
  assert.equal(windowAppearance("win32", true, true).backgroundMaterial, undefined);
  assert.equal(windowAppearance("linux", true, false).titleBarStyle, "default");
  assert.equal(windowAppearance("linux", true, false).backgroundColor, "#1e1e20");
});

test("Mac vibrancy stays visible in both themes and becomes opaque when transparency is reduced", () => {
  for (const dark of [false, true]) {
    const vibrant = windowAppearance("darwin", dark, false);
    assert.equal(vibrant.backgroundColor, "#00000000");
    assert.equal(vibrant.vibrancy, "under-window");
    assert.equal(vibrant.visualEffectState, "followWindow");
    const reduced = windowAppearance("darwin", dark, true);
    assert.equal(reduced.backgroundColor, dark ? "#1e1e20" : "#f5f5f7");
    assert.equal(reduced.vibrancy, undefined);
    for (const platform of ["win32", "linux"])
      assert.notEqual(windowAppearance(platform, dark, false).backgroundColor, "#00000000");
  }
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
