import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("real-agent runner loads the packed candidate without installing agents", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "qualify-agents.mjs"), "utf8");
  assert.match(source, /tar", \["-tzf", candidatePath\]/u);
  assert.match(source, /@embassys\/ambassador/u);
  assert.match(source, /resolveAgentCapability\(clientInfo/u);
  assert.match(source, /get_my_permissions/u);
  assert.equal(source.includes('import("../dist/'), false);
  assert.equal(/\b(?:npm|pnpm|npx|pip|brew)\b[^\n]*(?:install|add|update)/u.test(source), false);
});

test("real-agent runner refuses to act without the explicit confirmation", async () => {
  const child = spawn(process.execPath, [join(process.cwd(), "scripts", "qualify-agents.mjs")], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /explicit|confirm|AMBASSADOR_QUALIFY_CONFIRM/u);
  assert.equal(stderr.includes("OPENCLAW_WEBHOOK_SECRET"), false);
  assert.equal(stderr.includes("HERMES_WEBHOOK_SECRET"), false);
});
