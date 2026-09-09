import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpSessionController } from "../src/direct-delivery.js";

test("setup uses a fresh ACP session, normal provider MCP and exact owner approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "embassys-setup-acp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const promptPath = join(root, "prompt.txt");
  const controller = new AcpSessionController({
    capability: {
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./fixtures/mock-acp-agent.js", import.meta.url)),
        "setup-permission",
        join(root, "count"),
        "unused",
        promptPath,
      ],
      agentInfo: { name: "mock-agent" },
      mcp: "provider_config",
      environment: "inherit",
    },
    environment: process.env,
    deadlineMs: 5000,
  });
  const challenge = randomUUID();
  let approved = false;
  await controller.checkConnection(
    root,
    challenge,
    async (request) => {
      assert.equal(request.toolCall.title, "Read Embassys enrollment");
      assert.deepEqual(
        request.options.map((option) => option.optionId),
        ["opaque:once", "opaque:no"],
      );
      approved = true;
      return "opaque:once";
    },
    new AbortController().signal,
  );
  assert.ok(approved);
  assert.match(await readFile(promptPath, "utf8"), new RegExp(challenge));
});
