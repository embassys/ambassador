import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { readLocalSettings, writeLocalSettings } from "../src/desktop/local-settings.js";

test("desktop settings reject malformed, oversized, linked and unexpected records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  const schema = z.strictObject({ enabled: z.boolean() });
  assert.equal(await readLocalSettings(path, schema), undefined);
  await writeLocalSettings(path, { enabled: true });
  assert.deepEqual(await readLocalSettings(path, schema), { enabled: true });
  for (const contents of [
    "{",
    JSON.stringify({ enabled: true, secret: "extra" }),
    " ".repeat(256 * 1024 + 1),
  ]) {
    await writeFile(path, contents);
    await assert.rejects(readLocalSettings(path, schema));
  }
  await writeLocalSettings(path, { enabled: true });
  await link(path, join(root, "hard-link"));
  await assert.rejects(readLocalSettings(path, schema));
  if (process.platform !== "win32") {
    await symlink(path, join(root, "symbolic-link"));
    await assert.rejects(readLocalSettings(join(root, "symbolic-link"), schema));
  }
  const directory = join(root, "directory");
  await mkdir(directory);
  await assert.rejects(writeLocalSettings(directory, { enabled: true }));
  assert.ok((await readdir(root)).every((name) => !name.endsWith(".tmp")));
});
