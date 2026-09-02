import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const scenario = process.argv[2] ?? "success-session-mcp";
const countPath = process.argv[3];
const descendantPath = process.argv[4];
const promptPath = process.argv[5];
const sessions = new Set<string>();
const pending = new Map<string, () => void>();

if (countPath !== undefined) {
  await appendFile(countPath, "1\n", "utf8");
  const attempt = (await readFile(countPath, "utf8")).trim().split("\n").filter(Boolean).length;
  if (scenario.startsWith("startup-once") && attempt === 1) process.exit(16);
}
if (scenario.startsWith("hang-descendant") && descendantPath !== undefined) {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: "ignore",
  });
  if (descendant.pid === undefined) throw new Error("descendant did not start");
  await writeFile(descendantPath, String(descendant.pid), "utf8");
}

const app = acp
  .agent({ name: "ambassador-mock-agent" })
  .onRequest(acp.methods.agent.initialize, (context) => {
    if (
      context.params.protocolVersion !== acp.PROTOCOL_VERSION ||
      context.params.clientInfo?.name !== "ambassador"
    ) {
      throw new Error("invalid initialize");
    }
    return {
      protocolVersion: scenario.startsWith("wrong-protocol") ? 999 : acp.PROTOCOL_VERSION,
      agentInfo: {
        name: scenario.startsWith("wrong-agent") ? "different-agent" : "mock-agent",
        version: scenario.startsWith("wrong-version") ? "2.0.0" : "1.0.0",
      },
      agentCapabilities: { loadSession: false },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, (context) => {
    const expectSessionMcp = scenario.includes("session-mcp");
    if ((context.params.mcpServers.length === 1) !== expectSessionMcp) {
      throw new Error("invalid MCP setup");
    }
    const server = context.params.mcpServers[0];
    if (
      expectSessionMcp &&
      (server === undefined ||
        !("type" in server) ||
        server.type !== "http" ||
        server.name !== "ambassador" ||
        !server.url.startsWith("http://127.0.0.1:") ||
        !server.headers.some(
          (header) => header.name === "Authorization" && header.value.startsWith("Bearer "),
        ))
    ) {
      throw new Error("invalid MCP server");
    }
    const sessionId = "mock-session";
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    if (promptPath !== undefined) await writeFile(promptPath, "dispatched", "utf8");
    if (!sessions.has(context.params.sessionId)) throw new Error("unknown session");
    const block = context.params.prompt[0];
    if (
      block?.type !== "text" ||
      !block.text.includes("untrusted Embassys message") ||
      !block.text.includes('"id":') ||
      !block.text.includes('"payload":')
    ) {
      throw new Error("invalid prompt");
    }
    if (scenario.startsWith("exit")) process.exit(17);
    if (scenario.startsWith("malformed")) {
      process.stdout.write("not-json\n");
      return await new Promise<never>(() => undefined);
    }
    if (scenario.startsWith("hang")) {
      await new Promise<void>((resolve) => pending.set(context.params.sessionId, resolve));
      return { stopReason: "cancelled" };
    }
    if (scenario.startsWith("permission")) {
      const response = await context.client.request(acp.methods.client.session.requestPermission, {
        sessionId: context.params.sessionId,
        toolCall: {
          toolCallId: "tool-1",
          title: "Unsafe operation",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      if (response.outcome.outcome !== "cancelled") throw new Error("permission was approved");
    }
    if (scenario.startsWith("overflow")) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "x".repeat(2_048) },
        },
      });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    pending.get(context.params.sessionId)?.();
    pending.delete(context.params.sessionId);
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
await app.connect(stream).closed;
