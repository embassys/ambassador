import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentConnection,
  connectionAvailable,
  connectionEntry,
  runConnectionCommand,
} from "../src/desktop/agent-connections.js";

test("automatic setup is exposed only on a natively qualified platform", () => {
  assert.equal(connectionAvailable("darwin", "arm64"), true);
  assert.equal(connectionAvailable("win32", "x64"), false);
  assert.equal(connectionAvailable("linux", "x64"), false);
  assert.equal(connectionAvailable("darwin", "x64"), false);
});

test("setup recognizes a valid existing connection without taking ownership or changing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-existing-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const provider of ["claude_code", "openclaw", "codex", "hermes"] as const) {
    const path = join(root, `${provider}.json`);
    const ownershipPath = join(root, `${provider}-ownership.json`);
    const entry =
      provider === "claude_code"
        ? { type: "http", url: "http://127.0.0.1:8789/mcp" }
        : { url: "http://127.0.0.1:8789/mcp" };
    const contents = JSON.stringify({ ambassador: entry, unrelated: "keep" });
    await writeFile(path, contents);
    const setup = new AgentConnection({
      provider,
      configurationPath: path,
      ownershipPath,
      run: async () => assert.fail("Existing settings must not be rewritten."),
      document: {
        read: (text) => JSON.parse(text).ambassador,
        edit: () => assert.fail("Existing settings must not be edited."),
      },
    });
    const result = await setup.prepare("connect", 8789);
    assert.equal(result.state, "configured", provider);
    assert.equal(result.owned, false);
    assert.equal(result.previewId, undefined);
    assert.equal((await setup.prepare("disconnect", 8789)).previewId, undefined);
    assert.equal(await readFile(path, "utf8"), contents);
    await assert.rejects(readFile(ownershipPath), { code: "ENOENT" });
    assert.equal((await setup.inspect(8790)).state, "conflict");
    for (const extra of [
      { enabled: false },
      { headers: {} },
      { command: "something" },
      { unknown: true },
    ]) {
      await writeFile(path, JSON.stringify({ ambassador: { ...entry, ...extra } }));
      assert.equal((await setup.prepare("connect", 8789)).state, "conflict");
    }
    await writeFile(
      ownershipPath,
      JSON.stringify({
        version: 1,
        provider,
        configurationPath: path,
        port: 8789,
        phase: "configured",
      }),
    );
    await writeFile(path, contents);
    assert.equal(
      (await setup.prepare("disconnect", 8789)).state,
      "conflict",
      "An owner-edited app entry is not removable.",
    );
  }
});

for (const provider of ["claude_code", "openclaw"] as const) {
  test(`${provider} connects, repairs a removed owned entry and disconnects only its own entry`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "provider.json");
    const journal = join(root, "ownership.json");
    let calls = 0;
    const original = {
      unrelated: { url: "https://fixture.test", headers: { Authorization: "private-marker" } },
    };
    const store = async (entry?: unknown) =>
      writeFile(
        path,
        JSON.stringify(
          provider === "claude_code"
            ? {
                mcpServers: { ...original, ...(entry ? { ambassador: entry } : {}) },
                preference: "keep",
              }
            : {
                mcp: { servers: { ...original, ...(entry ? { ambassador: entry } : {}) } },
                preference: "keep",
              },
        ),
      );
    await store();
    const connection = () =>
      new AgentConnection({
        provider,
        configurationPath: path,
        ownershipPath: journal,
        run: async (command, args) => {
          calls++;
          assert.equal(command, provider === "claude_code" ? "claude" : "openclaw");
          assert.ok(args.includes("ambassador"));
          if (calls === 1 && provider === "claude_code")
            assert.deepEqual(args, [
              "mcp",
              "add-json",
              "--scope",
              "user",
              "ambassador",
              JSON.stringify(connectionEntry(provider, 8789)),
            ]);
          if (calls === 1 && provider === "openclaw")
            assert.deepEqual(args, [
              "mcp",
              "add",
              "ambassador",
              "--url",
              "http://127.0.0.1:8789/mcp",
              "--transport",
              "streamable-http",
              "--timeout",
              "660",
              "--no-probe",
            ]);
          await store(
            args.includes("remove") || args.includes("unset")
              ? undefined
              : connectionEntry(provider, 8789),
          );
        },
      });
    const setup = connection();
    const preview = await setup.prepare("connect", 8789);
    assert.equal(calls, 0);
    assert.ok(preview.previewId);
    assert.equal((await setup.apply(preview.previewId)).state, "configured");
    assert.equal((await connection().inspect(8789)).owned, true);
    await store();
    const repair = await setup.prepare("repair", 8789);
    assert.ok(repair.previewId);
    await setup.apply(repair.previewId);
    const disconnect = await setup.prepare("disconnect", 8789);
    assert.ok(disconnect.previewId);
    assert.equal((await setup.apply(disconnect.previewId)).state, "missing");
    assert.equal(calls, 3);
    assert.match(await readFile(path, "utf8"), /private-marker/);
    assert.doesNotMatch(await readFile(journal, "utf8"), /private-marker/);
  });
}

test("connection review refuses stale files, unowned removal and changed credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "provider.json");
  const setup = new AgentConnection({
    provider: "claude_code",
    configurationPath: path,
    ownershipPath: join(root, "ownership.json"),
    run: async () => assert.fail("must not run"),
  });
  const first = await setup.prepare("connect", 8789);
  assert.ok(first.previewId);
  await writeFile(path, '{"preference":"changed"}');
  await assert.rejects(setup.apply(first.previewId));
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { ambassador: connectionEntry("claude_code", 8789) } }),
  );
  assert.equal((await setup.inspect(8789)).owned, false);
  assert.equal((await setup.prepare("disconnect", 8789)).previewId, undefined);
  await writeFile(
    path,
    JSON.stringify({
      mcpServers: {
        ambassador: {
          ...connectionEntry("claude_code", 8789),
          headers: { Authorization: "secret-marker" },
        },
      },
    }),
  );
  const result = await setup.prepare("repair", 8789);
  assert.equal(result.state, "conflict");
  assert.doesNotMatch(JSON.stringify(result), /secret-marker/);
});

test("a lost setup response is reconciled and never repeated automatically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "provider.json");
  let calls = 0;
  const setup = new AgentConnection({
    provider: "openclaw",
    configurationPath: path,
    ownershipPath: join(root, "ownership.json"),
    run: async () => {
      calls++;
      await writeFile(
        path,
        JSON.stringify({ mcp: { servers: { ambassador: connectionEntry("openclaw", 8789) } } }),
      );
      throw new Error("unknown private-marker");
    },
  });
  const preview = await setup.prepare("connect", 8789);
  assert.ok(preview.previewId);
  assert.equal((await setup.apply(preview.previewId)).state, "configured");
  await assert.rejects(setup.apply(preview.previewId));
  assert.equal(calls, 1);
});

test("connection setup rejects malformed files and expired reviews without dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "provider.json");
  let now = 1;
  const setup = new AgentConnection({
    provider: "openclaw",
    configurationPath: path,
    ownershipPath: join(root, "ownership.json"),
    now: () => now,
    run: async () => assert.fail("must not run"),
  });
  for (const text of [
    "not json",
    "[]",
    '{"mcp":[]}',
    '{"mcp":{"servers":[]}}',
    " ".repeat(4 * 1024 * 1024 + 1),
  ]) {
    await writeFile(path, text);
    assert.equal((await setup.inspect(8789)).state, "unavailable");
  }
  await writeFile(path, "{}");
  const preview = await setup.prepare("connect", 8789);
  assert.ok(preview.previewId);
  await assert.rejects(setup.apply("wrong"));
  now += 300001;
  await assert.rejects(setup.apply(preview.previewId));
  await assert.rejects(setup.inspect(65536));
});

test("ownership binds one provider profile to one instance and rejects false success", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "provider.json");
  const ownershipPath = join(root, "ownership.json");
  const setup = new AgentConnection({
    provider: "claude_code",
    configurationPath: path,
    ownershipPath,
    run: async () => {},
  });
  const preview = await setup.prepare("connect", 8789);
  assert.ok(preview.previewId);
  assert.equal((await setup.apply(preview.previewId)).state, "unavailable");
  assert.equal((await setup.prepare("connect", 8790)).state, "conflict");
  const other = new AgentConnection({
    provider: "claude_code",
    configurationPath: join(root, "other.json"),
    ownershipPath,
    run: async () => assert.fail("must not run"),
  });
  assert.equal((await other.inspect(8789)).state, "unavailable");
});

test("connection setup refuses aliased files and a changed ownership journal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "provider.json");
  const target = join(root, "other.json");
  const ownershipPath = join(root, "ownership.json");
  await writeFile(target, "{}");
  const setup = new AgentConnection({
    provider: "claude_code",
    configurationPath: path,
    ownershipPath,
    run: async () => assert.fail("must not run"),
  });
  await link(target, path);
  assert.equal((await setup.inspect(8789)).state, "unavailable");
  await rm(path);
  if (process.platform !== "win32") {
    await symlink(target, path);
    assert.equal((await setup.inspect(8789)).state, "unavailable");
    await rm(path);
  }
  assert.equal(await readFile(target, "utf8"), "{}");
  const preview = await setup.prepare("connect", 8789);
  assert.ok(preview.previewId);
  await writeFile(
    ownershipPath,
    JSON.stringify({
      version: 1,
      provider: "claude_code",
      configurationPath: path,
      port: 8789,
      phase: "removed",
    }),
  );
  await assert.rejects(setup.apply(preview.previewId));
});

test("cancelled setup never launches a provider command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-connect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const abort = new AbortController();
  abort.abort();
  for (const command of ["claude", "openclaw"] as const)
    await assert.rejects(
      runConnectionCommand(command, ["mcp"], root, { PATH: "" }, abort.signal),
      /cancelled/,
    );
});
