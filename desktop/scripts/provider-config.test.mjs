import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "embassys-parser-test-"));
await build({
  stdin: {
    contents:
      'export { providerDocument } from "./src/provider-config.ts"; export { AgentConnection, connectionEntry } from "../src/desktop/agent-connections.ts";',
    resolveDir: process.cwd(),
    sourcefile: "provider-test-entry.ts",
  },
  absWorkingDir: process.cwd(),
  outfile: join(root, "config.mjs"),
  bundle: true,
  banner: {
    js: 'import { createRequire as embassysCreateRequire } from "node:module"; const require = embassysCreateRequire(import.meta.url);',
  },
  platform: "node",
  format: "esm",
  packages: "bundle",
});
const { providerDocument, AgentConnection, connectionEntry } = await import(
  pathToFileURL(join(root, "config.mjs")).href
);
test.after(() => rm(root, { recursive: true, force: true }));

for (const provider of ["codex", "hermes"]) {
  const original =
    provider === "codex"
      ? '# Keep my preferences\nmodel = "example" # inline comment\n[mcp_servers.calendar]\nurl = "http://localhost:9999/mcp"\n'
      : "# Keep my preferences\nmodel: example # inline comment\nmcp_servers:\n  calendar:\n    url: http://localhost:9999/mcp\n";
  test(`${provider} connect, ownership conflict, repair and disconnect preserve unrelated settings`, async (_t) => {
    const dir = await mkdtemp(join(root, `${provider}-`));
    const path = join(dir, provider === "codex" ? "config.toml" : "config.yaml");
    const options = {
      provider,
      configurationPath: path,
      ownershipPath: join(dir, "ownership.json"),
      document: providerDocument(provider),
      run: async () => assert.fail("must not run a provider command"),
    };
    await writeFile(path, original);
    const setup = new AgentConnection(options);
    assert.equal((await setup.inspect(8877)).state, "missing");
    const preview = await setup.prepare("connect", 8877);
    assert.ok(preview.previewId);
    assert.equal((await setup.apply(preview.previewId)).state, "configured");
    const connected = await readFile(path, "utf8");
    assert.match(connected, /Keep my preferences/);
    assert.match(connected, /inline comment/);
    assert.match(connected, /localhost:9999/);
    assert.deepEqual(providerDocument(provider).read(connected), connectionEntry(provider, 8877));
    assert.equal((await new AgentConnection(options).inspect(8878)).state, "conflict");
    const disconnect = await setup.prepare("disconnect", 8877);
    assert.ok(disconnect.previewId);
    assert.equal((await setup.apply(disconnect.previewId)).state, "missing");
    const removed = await readFile(path, "utf8");
    assert.match(removed, /inline comment/);
    assert.equal(providerDocument(provider).read(removed), undefined);
    const again = await setup.prepare("connect", 8877);
    await setup.apply(again.previewId);
    await writeFile(path, original);
    const repair = await setup.prepare("repair", 8877);
    assert.ok(repair.previewId);
    await setup.apply(repair.previewId);
    assert.equal((await setup.inspect(8877)).owned, true);
  });
  test(`${provider} manual matching entry stays unowned and changed review is refused`, async () => {
    const dir = await mkdtemp(join(root, `${provider}-`));
    const path = join(dir, "config");
    const doc = providerDocument(provider);
    const setup = new AgentConnection({
      provider,
      configurationPath: path,
      ownershipPath: join(dir, "owner"),
      document: doc,
      run: async () => assert.fail(),
    });
    await writeFile(path, doc.edit(original, connectionEntry(provider, 8877)));
    assert.equal((await setup.inspect(8877)).owned, false);
    assert.equal((await setup.prepare("disconnect", 8877)).previewId, undefined);
    await writeFile(path, original);
    const preview = await setup.prepare("connect", 8877);
    await writeFile(path, `${original}\n# edited during review\n`);
    await assert.rejects(setup.apply(preview.previewId), /changed/);
    assert.equal(await readFile(path, "utf8"), `${original}\n# edited during review\n`);
  });
}

test("TOML refuses unsupported inline tables and removes only the exact ambassador table", () => {
  const doc = providerDocument("codex");
  assert.throws(() => doc.edit("mcp_servers = {}\n", connectionEntry("codex", 8877)));
  const withPeer =
    '[mcp_servers.ambassador]\nurl = "http://127.0.0.1:8877/mcp"\ntool_timeout_sec = 660\n\n# next provider\n[mcp_servers.peer]\nurl = "http://localhost:1111/mcp"\n';
  const removed = doc.edit(withPeer, undefined);
  assert.match(removed, /# next provider/);
  assert.match(removed, /mcp_servers.peer/);
  assert.throws(() => doc.read("duplicate=1\nduplicate=2"));
});
test("YAML refuses duplicate keys, aliases, merge keys and non-map configuration", () => {
  const doc = providerDocument("hermes");
  for (const text of [
    "mcp_servers: {}\nmcp_servers: {}",
    "settings: &a {enabled: true}\nother: *a",
    "mcp_servers:\n  <<: {example: true}",
    "- list",
  ])
    assert.throws(() => doc.edit(text, connectionEntry("hermes", 8877)));
});
