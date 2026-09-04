import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("real-agent runner loads the packed candidate without installing agents", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "qualify-agents.mjs"), "utf8");
  const probeSource = await readFile(
    join(process.cwd(), "scripts", "agent-version-probes.mjs"),
    "utf8",
  );
  const probeCommand = await readFile(
    join(process.cwd(), "scripts", "probe-agent-versions.mjs"),
    "utf8",
  );
  const combined = `${source}\n${probeSource}\n${probeCommand}`;
  assert.match(source, /tar", \["-tzf", candidatePath\]/u);
  assert.match(source, /@embassys\/ambassador/u);
  assert.match(source, /resolveAgentCapability\(clientInfo/u);
  assert.match(source, /get_my_permissions/u);
  assert.match(combined, /openclaw/u);
  assert.match(combined, /hermes/u);
  assert.match(combined, /codex-acp/u);
  assert.match(combined, /claude/u);
  assert.doesNotMatch(combined, /claude-agent-acp/u);
  assert.doesNotMatch(combined, /agy_acp_server|antigravity-client|gemini-cli-mcp-client/u);
  assert.match(source, /version_probe/u);
  assert.doesNotMatch(
    source,
    /if \(!profile\.direct\?\.agentInfo\.versions\.includes\(installedVersion\)\)/u,
    "an observational version probe must not skip qualification cases",
  );
  assert.equal(source.includes('import("../dist/'), false);
  assert.equal(/\b(?:npm|pnpm|npx|pip|brew)\b[^\n]*(?:install|add|update)/u.test(combined), false);
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
  assert.equal(stderr.includes("CODEX_WEBHOOK_SECRET"), false);
  assert.equal(stderr.includes("CLAUDE_WEBHOOK_SECRET"), false);
});

test("agent version probes report unavailable commands without failing", async () => {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "scripts", "probe-agent-versions.mjs")],
    {
      env: { PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const report = JSON.parse(stdout) as {
    probes: Array<{ kind: string; status: string; reported_version: string | null }>;
  };
  assert.deepEqual(
    report.probes,
    ["openclaw", "hermes", "codex", "claude"].map((kind) => ({
      kind,
      status: "unavailable",
      reported_version: null,
    })),
  );
});

test("live runner has a fixed, separately confirmed real-Codex mode", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "live-qualification.mjs"), "utf8");
  assert.match(source, /AMBASSADOR_LIVE_DIRECT_AGENT/u);
  assert.match(source, /run-live-qualification-with-real-codex/u);
  assert.match(source, /codex-mcp-client/u);
  assert.match(source, /codex-acp/u);
  assert.match(source, /observeAgentVersion/u);
  assert.match(source, /get_my_permissions/u);
  assert.match(source, /submit_action_result/u);
  assert.match(source, /Controlled Embassys qualification policy/u);
  assert.match(source, /RESTART_POLL_DRAIN_MS/u);
  assert.match(source, /ack_message/u);
  assert.equal(
    /AMBASSADOR_LIVE_(?:AGENT_)?COMMAND/u.test(source),
    false,
    "the live runner must not accept an arbitrary agent command",
  );
  assert.equal(/\b(?:npm|pnpm|npx|pip|brew)\b[^\n]*(?:install|add|update)/u.test(source), false);
});

test("live runner has a fixed, separately confirmed real-Claude mode", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "live-qualification.mjs"), "utf8");
  assert.match(source, /run-live-qualification-with-real-claude/u);
  assert.match(source, /AMBASSADOR_CLAUDE_QUALIFICATION_HOME/u);
  assert.match(
    source,
    /const CLAUDE_CLIENT_INFO = \{ name: "claude-code", version: "qualification" \}/u,
  );
  assert.match(source, /@embassys\/claude-cli-acp/u);
  assert.match(source, /\.claude\.json/u);
  assert.match(source, /prepareClaudeMcp/u);
  assert.match(source, /usesOrdinaryHome/u);
  assert.match(source, /\.\.\.process\.env/u);
  assert.match(source, /CLAUDE_USER_MCP_PORT/u);
  assert.equal(source.match(/localMcpPortFor\(index\)/gu)?.length, 2);
  assert.equal(source.match(/await prepareClaudeMcp\(/gu)?.length, 2);
  assert.match(source, /claudeCapability\.direct\.mcp === "provider_config"/u);
  assert.match(source, /target_version_probe/u);
  assert.match(source, /claude_permission_decision/u);
  assert.match(source, /claude_action_result_mcp_call/u);
  assert.match(source, /claude_action_result_call_count/u);
  assert.equal(
    /AMBASSADOR_LIVE_(?:AGENT_)?COMMAND/u.test(source),
    false,
    "the live runner must not accept an arbitrary agent command",
  );
  assert.equal(/\b(?:npm|pnpm|npx|pip|brew)\b[^\n]*(?:install|add|update)/u.test(source), false);
});

test("live runner has a fixed real Codex-to-Claude mode", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "live-qualification.mjs"), "utf8");
  assert.match(source, /run-live-qualification-with-real-codex-and-real-claude/u);
  assert.match(source, /directAgent === "codex-claude"/u);
  assert.match(source, /CODEX_CLIENT_INFO/u);
  assert.match(source, /CLAUDE_CLIENT_INFO/u);
  assert.match(source, /requesterDirectMessages/u);
  assert.match(source, /codex_response_delivery/u);
  assert.match(source, /requester_version_probe/u);
  assert.equal(
    /AMBASSADOR_LIVE_(?:AGENT_)?COMMAND/u.test(source),
    false,
    "the live runner must not accept an arbitrary agent command",
  );
});

test("live runner has fixed, separately confirmed real-Hermes modes", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "live-qualification.mjs"), "utf8");
  assert.match(source, /run-live-qualification-with-real-hermes-direct/u);
  assert.match(source, /run-live-qualification-with-real-hermes-webhook/u);
  assert.match(source, /AMBASSADOR_HERMES_QUALIFICATION_HOME/u);
  assert.match(source, /const HERMES_CLIENT_INFO = \{ name: "mcp", version: "qualification" \}/u);
  assert.match(source, /target_version_probe/u);
  assert.doesNotMatch(source, /HERMES_VERSION|startsWith\(HERMES_VERSION\)/u);
  assert.match(source, /hermes-acp/u);
  assert.match(source, /X-Webhook-Signature-V2/iu);
  assert.match(source, /assertHermesWebhookBearerFilter/u);
  assert.match(source, /headers\.Authorization/u);
  assert.match(source, /webhookAcceptedByGateway/u);
  assert.match(source, /localCompletedByGateway/u);
  assert.match(source, /targetActionResultCallCount/u);
  assert.equal(
    /AMBASSADOR_LIVE_(?:AGENT_)?COMMAND/u.test(source),
    false,
    "the live runner must not accept an arbitrary agent command",
  );
  assert.equal(/\b(?:npm|pnpm|npx|pip|brew)\b[^\n]*(?:install|add|update)/u.test(source), false);
});

test("live runner has fixed, separately confirmed real-OpenClaw modes", async () => {
  const source = await readFile(join(process.cwd(), "scripts", "live-qualification.mjs"), "utf8");
  assert.match(source, /run-live-qualification-with-real-openclaw-direct/u);
  assert.match(source, /run-live-qualification-with-real-openclaw-webhook/u);
  assert.match(source, /AMBASSADOR_OPENCLAW_QUALIFICATION_HOME/u);
  assert.match(
    source,
    /const OPENCLAW_CLIENT_INFO = \{ name: "openclaw-bundle-mcp", version: "qualification" \}/u,
  );
  assert.match(source, /\[\s*"mcp",\s*"set"/u);
  assert.match(source, /\[\s*"gateway",\s*"run"/u);
  assert.match(source, /\["config", "patch", "--stdin"\]/u);
  assert.match(source, /path: "\/hooks"/u);
  assert.match(source, /allowedAgentIds: \["main"\]/u);
  assert.match(source, /allowRequestSessionKey: false/u);
  assert.match(source, /OPENCLAW_WEBHOOK_PATH = "\/hooks\/agent"/u);
  assert.doesNotMatch(source, /plugins", "install|plugins", "enable/u);
  assert.doesNotMatch(source, /AMBASSADOR_WEBHOOK_SECRET/u);
  assert.doesNotMatch(source, /OPENCLAW_VERSION|startsWith\(OPENCLAW_VERSION\)/u);
  assert.match(source, /webhookAcceptedByGateway/u);
  assert.match(source, /targetActionResultCallCount/u);
  assert.equal(
    /AMBASSADOR_LIVE_(?:AGENT_)?COMMAND/u.test(source),
    false,
    "the live runner must not accept an arbitrary agent command",
  );
});
