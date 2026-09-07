import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeSetup, runClaudeSetup } from "../src/desktop/claude-setup.js";

const entry = { type: "http", url: "http://127.0.0.1:8788/mcp", timeout: 660000 };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "embassys-claude-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, ".claude.json") };
}

test("Claude setup changes only after review and verifies the saved entry", async (t) => {
  const { root, path } = await fixture(t);
  const original = {
    mcpServers: { unrelated: { type: "http", url: "https://example.test" } },
    userSetting: true,
  };
  await writeFile(path, JSON.stringify(original));
  let calls = 0;
  const setup = new ClaudeSetup({
    configurationPath: path,
    workingDirectory: root,
    run: async (args) => {
      calls++;
      assert.deepEqual(args, [
        "mcp",
        "add-json",
        "--scope",
        "user",
        "ambassador",
        JSON.stringify(entry),
      ]);
      await writeFile(
        path,
        JSON.stringify({ ...original, mcpServers: { ...original.mcpServers, ambassador: entry } }),
      );
    },
  });
  const preview = await setup.prepare(8788);
  assert.equal(preview.state, "available");
  assert.ok(preview.previewId);
  assert.equal(calls, 0);
  assert.equal((await setup.apply(preview.previewId)).state, "configured");
  assert.equal(calls, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path, "utf8")).mcpServers.unrelated,
    original.mcpServers.unrelated,
  );
  await assert.rejects(setup.apply(preview.previewId));
});

test("Claude setup never replaces an existing entry or adopts extra credentials", async (t) => {
  const { root, path } = await fixture(t);
  const setup = new ClaudeSetup({
    configurationPath: path,
    workingDirectory: root,
    run: async () => assert.fail("must not run"),
  });
  for (const existing of [
    entry,
    { ...entry, url: "http://127.0.0.1:8787/mcp" },
    { ...entry, headers: { Authorization: "private-marker" } },
  ]) {
    await writeFile(path, JSON.stringify({ mcpServers: { ambassador: existing } }));
    const result = await setup.prepare(8788);
    assert.equal(result.state, existing === entry ? "configured" : "conflict");
    assert.equal(result.previewId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-marker/);
  }
});

test("Claude setup refuses changed, expired and invalid previews without running a command", async (t) => {
  const { root, path } = await fixture(t);
  let now = 1;
  const setup = new ClaudeSetup({
    configurationPath: path,
    workingDirectory: root,
    now: () => now,
    run: async () => assert.fail("must not run"),
  });
  const first = await setup.prepare(8788);
  assert.ok(first.previewId);
  await assert.rejects(setup.apply("wrong-id"));
  await writeFile(path, JSON.stringify({ userChanged: true }));
  await assert.rejects(setup.apply(first.previewId));
  const second = await setup.prepare(8788);
  assert.ok(second.previewId);
  now += 300001;
  await assert.rejects(setup.apply(second.previewId));
  await assert.rejects(setup.prepare(65536));
  await assert.rejects(setup.prepare(8788.5));
});

test("Claude setup rejects malformed, oversized and aliased configuration", async (t) => {
  const { root, path } = await fixture(t);
  const setup = new ClaudeSetup({
    configurationPath: path,
    workingDirectory: root,
    run: async () => assert.fail("must not run"),
  });
  for (const body of ["bad JSON", "[]", '{"mcpServers":[]}', " ".repeat(4 * 1024 * 1024 + 1)]) {
    await writeFile(path, body);
    assert.equal((await setup.prepare(8788)).state, "unavailable");
  }
  if (process.platform !== "win32") {
    const target = join(root, "other.json");
    await writeFile(target, "{}");
    await rm(path);
    await symlink(target, path);
    assert.equal((await setup.prepare(8788)).state, "unavailable");
    assert.equal(await readFile(target, "utf8"), "{}");
  }
});

test("Claude setup checks saved state after a lost response and never reports a false success", async (t) => {
  const { root, path } = await fixture(t);
  let calls = 0;
  const setup = new ClaudeSetup({
    configurationPath: path,
    workingDirectory: root,
    run: async () => {
      calls++;
      if (calls === 2) await writeFile(path, JSON.stringify({ mcpServers: { ambassador: entry } }));
      throw new Error("Provider failure containing private-marker");
    },
  });
  const first = await setup.prepare(8788);
  assert.ok(first.previewId);
  assert.equal((await setup.apply(first.previewId)).state, "unavailable");
  const second = await setup.prepare(8788);
  assert.ok(second.previewId);
  const result = await setup.apply(second.previewId);
  assert.equal(result.state, "configured");
  assert.doesNotMatch(JSON.stringify(result), /private-marker/);
  assert.equal(calls, 2);
});

test("cancelled provider setup cannot launch a configuration command", async (t) => {
  const { root } = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runClaudeSetup(["mcp", "add-json"], root, { PATH: "" }, abort.signal),
    /cancelled/,
  );
});
