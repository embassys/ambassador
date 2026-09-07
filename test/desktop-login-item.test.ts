import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopLoginItem, linuxLoginEntry } from "../src/desktop/login-item.js";

test("Windows startup reads and writes the same fixed executable and arguments", async () => {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const item = new DesktopLoginItem({
    platform: "win32",
    packaged: true,
    executable: "C:\\Program Files\\Ambassador.exe",
    native: {
      read(options) {
        reads.push(options);
        return { openAtLogin: true, executableWillLaunchAtLogin: false };
      },
      write(options) {
        writes.push(options);
      },
    },
  });
  const state = await item.read();
  assert.equal(state.configured, true);
  assert.equal(state.enabled, false);
  assert.match(state.message, /Windows/);
  await item.set(false);
  assert.deepEqual(reads[0], { path: "C:\\Program Files\\Ambassador.exe", args: ["--background"] });
  assert.deepEqual(writes[0], {
    path: "C:\\Program Files\\Ambassador.exe",
    args: ["--background"],
    name: "com.embassys.ambassador.development",
    openAtLogin: false,
  });
});

test("unsigned Mac and unpackaged builds cannot claim reliable launch at login", async () => {
  let writes = 0;
  for (const options of [
    { platform: "darwin" as const, packaged: true },
    { platform: "win32" as const, packaged: false },
  ]) {
    const item = new DesktopLoginItem({
      ...options,
      executable: "/application",
      native: {
        read: () => ({ openAtLogin: false }),
        write: () => {
          writes++;
        },
      },
    });
    assert.equal((await item.read()).canChange, false);
    await assert.rejects(item.set(true));
  }
  assert.equal(writes, 0);
});

test("qualified Mac reports OS approval separately from enabled", async () => {
  const item = new DesktopLoginItem({
    platform: "darwin",
    packaged: true,
    macDistributionVerified: true,
    executable: "/application",
    native: {
      read: () => ({ openAtLogin: false, status: "requires-approval" }),
      write: () => {},
    },
  });
  const state = await item.read();
  assert.equal(state.configured, true);
  assert.equal(state.enabled, false);
  assert.match(state.message, /System Settings/);
});

test("Linux startup creates and removes only its own entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-autostart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = new DesktopLoginItem({
    platform: "linux",
    packaged: true,
    executable: "/opt/Ambassador/bin/app",
    configurationDirectory: root,
  });
  assert.equal((await item.read()).enabled, false);
  assert.equal((await item.set(false)).enabled, false);
  await item.set(true);
  await item.set(true);
  assert.equal((await item.read()).enabled, true);
  const file = join(root, "autostart/com.embassys.ambassador.development.desktop");
  const entry = await readFile(file, "utf8");
  assert.match(entry, /--background/);
  await writeFile(file, `${entry}X-User-Change=true\n`);
  assert.equal((await item.read()).canChange, false);
  await assert.rejects(item.set(false));
  assert.match(await readFile(file, "utf8"), /X-User-Change/);
  await writeFile(file, entry);
  await item.set(false);
  await assert.rejects(readFile(file));
});

test("Linux startup rejects aliases and invalid executable syntax", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-autostart-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const item = new DesktopLoginItem({
    platform: "linux",
    packaged: true,
    executable: "/opt/app",
    configurationDirectory: root,
  });
  await item.set(true);
  const path = join(root, "autostart/com.embassys.ambassador.development.desktop");
  const target = join(root, "unrelated");
  await writeFile(target, "preserve");
  await rm(path);
  if (process.platform !== "win32") {
    await symlink(target, path);
    assert.equal((await item.read()).canChange, false);
    await assert.rejects(item.set(true));
    assert.equal(await readFile(target, "utf8"), "preserve");
  }
  for (const invalid of ["relative", "/opt/app\nHidden=true", "/opt/a=b"])
    assert.throws(() => linuxLoginEntry(invalid));
  assert.match(linuxLoginEntry('/opt/a % " $ ` \\ app'), /%%/);
  assert.match(linuxLoginEntry('/opt/a % " $ ` \\ app'), /Exec="/);
});
