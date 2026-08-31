import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

const TOKEN_NAME = "CX04_WEBHOOK_TOKEN";
const TOKEN = randomBytes(24).toString("hex");
const MCP_PORT = 8_787;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MESSAGE_DEADLINE_MS = 180_000;
const ID = /^[A-Za-z0-9._~-]{1,128}$/u;

function phaseError(phase) {
  return Object.assign(new Error("CX04 real behavior failed"), { phase });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json",
  });
  response.end(bytes);
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) throw phaseError("behavior");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw phaseError("behavior");
  }
}

function result(id, value) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

function failure(id, code) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_000, message: "qualification_tool_error", data: { code } },
  };
}

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._~-]+$",
};

const TOOL_DEFINITIONS = [
  {
    name: "poll_messages",
    description: "CX04 delivery fixture",
    inputSchema: {
      type: "object",
      properties: { timeout: { type: "integer", minimum: 0, maximum: 30 } },
      required: ["timeout"],
      additionalProperties: false,
    },
  },
  {
    name: "reply_message",
    description: "CX04 delivery fixture",
    inputSchema: {
      type: "object",
      properties: {
        message_id: ID_SCHEMA,
        payload: {
          type: "object",
          properties: { text: { type: "string", minLength: 1, maxLength: 262_144 } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      required: ["message_id", "payload"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_message",
    description: "CX04 delivery fixture",
    inputSchema: {
      type: "object",
      properties: {
        message_id: ID_SCHEMA,
        outcome: {
          type: "string",
          enum: ["completed_without_reply", "unsupported", "failed", "cancelled", "uncertain"],
        },
        reason_code: {
          type: "string",
          enum: [
            "no_reply_required",
            "unsupported_message_type",
            "unsupported_payload",
            "provider_start_failed",
            "provider_execution_failed",
            "provider_result_invalid",
            "cancelled_before_execution",
            "cancelled_during_safe_wait",
            "provider_outcome_unknown",
          ],
        },
      },
      required: ["message_id", "outcome", "reason_code"],
      additionalProperties: false,
    },
  },
  {
    name: "get_message_outcome",
    description: "CX04 delivery fixture",
    inputSchema: {
      type: "object",
      properties: { message_id: ID_SCHEMA },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "ack_message",
    description: "CX04 delivery fixture",
    inputSchema: {
      type: "object",
      properties: { message_id: ID_SCHEMA },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
];

class QualificationGateway {
  #server;
  #messages = new Map();
  #waiters = new Set();
  #replyDrop = new Set();

  async start() {
    this.#server = createHttpServer({ maxHeaderSize: 16_384 }, (request, response) => {
      void this.#handle(request, response);
    });
    await new Promise((resolve, reject) => {
      const fail = () => reject(phaseError("behavior"));
      this.#server.once("error", fail);
      this.#server.listen(MCP_PORT, "127.0.0.1", () => {
        this.#server.off("error", fail);
        resolve();
      });
    });
  }

  async close() {
    if (!this.#server?.listening) return;
    await new Promise((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  enqueue(id, conversationId, text) {
    if (!ID.test(id) || !ID.test(conversationId) || this.#messages.has(id)) {
      throw phaseError("behavior");
    }
    this.#messages.set(id, {
      id,
      conversationId,
      text,
      terminal: null,
      acknowledged: false,
      replyAttempts: 0,
    });
  }

  dropReplies(id, value) {
    if (value) this.#replyDrop.add(id);
    else this.#replyDrop.delete(id);
  }

  observation(id) {
    const message = this.#messages.get(id);
    if (message === undefined) throw phaseError("behavior");
    return {
      acknowledged: message.acknowledged,
      terminal: message.terminal === null ? null : { ...message.terminal },
      replyAttempts: message.replyAttempts,
    };
  }

  async waitFor(id, predicate, timeoutMs = MESSAGE_DEADLINE_MS) {
    if (predicate(this.observation(id))) return this.observation(id);
    return await new Promise((resolve, reject) => {
      const waiter = { id, predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(phaseError("behavior"));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  #settle(id) {
    for (const waiter of this.#waiters) {
      if (waiter.id !== id || !waiter.predicate(this.observation(id))) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(this.observation(id));
    }
  }

  async wake(webhookUrl, messageId) {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({
      message: `A2A message ${messageId} is ready. Use the A2A MCP tools to retrieve and process it.`,
      name: "A2A Gateway",
      deliver: false,
      wakeMode: "now",
    });
    const signature = createHmac("sha256", TOKEN)
      .update(timestamp, "ascii")
      .update(".", "ascii")
      .update(body, "utf8")
      .digest("hex");
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-length": String(Buffer.byteLength(body, "utf8")),
        "content-type": "application/json",
        "idempotency-key": messageId,
        "x-request-id": messageId,
        "x-webhook-signature-v2": signature,
        "x-webhook-timestamp": timestamp,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202) throw phaseError("behavior");
    await response.body?.cancel();
  }

  async #handle(request, response) {
    try {
      if (
        request.url !== "/mcp" ||
        request.method !== "POST" ||
        request.headers.host !== `127.0.0.1:${MCP_PORT}` ||
        request.headers.authorization !== `Bearer ${TOKEN}`
      ) {
        sendJson(response, 401, { error: "qualification_rejected" });
        return;
      }
      const rpc = await readJson(request);
      if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        sendJson(response, 400, { error: "qualification_invalid" });
        return;
      }
      if (rpc.method === "initialize") {
        response.setHeader("mcp-session-id", "cx04-qualification-session");
        sendJson(response, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "cx04-qualification", version: "1" },
          },
        });
        return;
      }
      if (request.headers["mcp-session-id"] !== "cx04-qualification-session") {
        sendJson(response, 400, { error: "qualification_session_invalid" });
        return;
      }
      if (rpc.method === "notifications/initialized") {
        response.writeHead(202, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (rpc.method === "tools/list") {
        sendJson(response, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { tools: TOOL_DEFINITIONS },
        });
        return;
      }
      if (rpc.method !== "tools/call" || !exactKeys(rpc.params, ["name", "arguments"])) {
        sendJson(response, 200, failure(rpc.id, "invalid_request"));
        return;
      }
      await this.#tool(response, rpc.id, rpc.params.name, rpc.params.arguments);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "qualification_failed" });
      else response.destroy();
    }
  }

  async #tool(response, rpcId, name, arguments_) {
    if (name === "poll_messages") {
      const messages = [...this.#messages.values()]
        .filter((message) => !message.acknowledged)
        .map((message) => ({
          id: message.id,
          conversation_id: message.conversationId,
          sender_agent_id: "cx04-sender",
          message_type: "conversation_turn",
          in_reply_to_message_id: null,
          payload: { text: message.text },
          created_at: "2026-08-31T00:00:00.000Z",
        }));
      sendJson(response, 200, result(rpcId, { messages }));
      return;
    }
    if (
      !exactKeys(arguments_, name === "reply_message" ? ["message_id", "payload"] : ["message_id"])
    ) {
      if (name !== "complete_message") {
        sendJson(response, 200, failure(rpcId, "invalid_request"));
        return;
      }
    }
    const message = this.#messages.get(arguments_?.message_id);
    if (message === undefined) {
      sendJson(response, 200, failure(rpcId, "message_not_found"));
      return;
    }
    if (name === "reply_message") {
      const text = arguments_.payload?.text;
      if (typeof text !== "string" || text.length === 0) {
        sendJson(response, 200, failure(rpcId, "invalid_request"));
        return;
      }
      message.replyAttempts += 1;
      this.#settle(message.id);
      if (this.#replyDrop.has(message.id)) {
        response.destroy();
        return;
      }
      const fingerprint = sha256(text);
      if (message.terminal !== null && message.terminal.fingerprint !== fingerprint) {
        sendJson(response, 200, failure(rpcId, "idempotency_conflict"));
        return;
      }
      message.terminal ??= { kind: "reply", fingerprint };
      this.#settle(message.id);
      sendJson(
        response,
        200,
        result(rpcId, {
          message_id: `cx04-reply-${message.id}`,
          conversation_id: message.conversationId,
          status: "accepted",
        }),
      );
      return;
    }
    if (name === "complete_message") {
      if (!exactKeys(arguments_, ["message_id", "outcome", "reason_code"])) {
        sendJson(response, 200, failure(rpcId, "invalid_request"));
        return;
      }
      message.terminal ??= {
        kind: "completion",
        outcome: arguments_.outcome,
        reasonCode: arguments_.reason_code,
      };
      this.#settle(message.id);
      sendJson(
        response,
        200,
        result(rpcId, {
          message_id: message.id,
          outcome: message.terminal.outcome,
          status: "recorded",
        }),
      );
      return;
    }
    if (name === "get_message_outcome") {
      sendJson(
        response,
        200,
        result(
          rpcId,
          message.terminal === null
            ? {
                message_id: message.id,
                conversation_id: message.conversationId,
                status: "open",
                outcome: null,
                reply_message_id: null,
              }
            : {
                message_id: message.id,
                conversation_id: message.conversationId,
                status: "terminal",
                outcome: message.terminal.kind === "reply" ? "replied" : message.terminal.outcome,
                reply_message_id:
                  message.terminal.kind === "reply" ? `cx04-reply-${message.id}` : null,
              },
        ),
      );
      return;
    }
    if (name === "ack_message" && message.terminal !== null) {
      message.acknowledged = true;
      this.#settle(message.id);
      sendJson(response, 200, result(rpcId, { message_id: message.id, status: "acked" }));
      return;
    }
    sendJson(response, 200, failure(rpcId, "message_not_terminal"));
  }
}

function captureStream(stream, name) {
  const chunks = [];
  let bytes = 0;
  let overflowed = false;
  stream.on("data", (chunk) => {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_CAPTURE_BYTES) {
      overflowed = true;
      return;
    }
    chunks.push(value);
  });
  return {
    value() {
      if (overflowed) throw phaseError("artifact");
      return { name, value: Buffer.concat(chunks).toString("utf8"), truncated: false };
    },
  };
}

async function unusedPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (port < 1_024 || port > 65_535 || port === MCP_PORT) throw phaseError("behavior");
  return port;
}

async function spawnConnector(options) {
  const webhookPort = await unusedPort();
  const child = spawn(
    options.executable,
    [
      "start",
      `--webhook-port=${webhookPort}`,
      `--webhook-token-env=${TOKEN_NAME}`,
      `--working-directory=${options.workingDirectory}`,
      `--policy=${options.policy}`,
    ],
    {
      cwd: options.workingDirectory,
      env: { ...options.environment, [TOKEN_NAME]: TOKEN },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stdout = captureStream(child.stdout, `connector-${options.sequence}-stdout`);
  const stderr = captureStream(child.stderr, `connector-${options.sequence}-stderr`);
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw phaseError("behavior");
  const connector = {
    child,
    groupId: child.pid,
    webhookUrl: `http://127.0.0.1:${webhookPort}/webhook`,
    captures: [stdout, stderr],
    confirmedEmpty: false,
  };
  const readiness = `Connector webhook: http://127.0.0.1:${webhookPort}/webhook\n`;
  try {
    await waitUntil(() => {
      const value = stdout.value().value;
      if (value === readiness) return true;
      if (value !== "" && !readiness.startsWith(value)) throw phaseError("behavior");
      if (child.exitCode !== null || child.signalCode !== null) throw phaseError("behavior");
      return false;
    }, 30_000);
    return connector;
  } catch (error) {
    await forceContainConnector(connector);
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw phaseError("behavior");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("close", close);
      reject(phaseError("behavior"));
    }, timeoutMs);
    timer.unref();
    const close = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("close", close);
  });
}

function groupEmpty(groupId) {
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return true;
    return false;
  }
}

async function processGroupSize(groupId) {
  const arguments_ =
    process.platform === "linux"
      ? ["-o", "pid=", "--pgrp", String(groupId)]
      : ["-o", "pid=", "-g", String(groupId)];
  const result = await new Promise((resolve, reject) => {
    const child = spawn("ps", arguments_, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) reject(phaseError("behavior"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  return result
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[1-9][0-9]*$/u.test(line)).length;
}

async function stopConnector(connector, signal, timeoutMs) {
  if (connector.child.exitCode === null && connector.child.signalCode === null) {
    connector.child.kill(signal);
  }
  const result = await waitForExit(connector.child, timeoutMs);
  await waitUntil(() => groupEmpty(connector.groupId), timeoutMs);
  connector.confirmedEmpty = true;
  return result;
}

async function forceContainConnector(connector) {
  if (connector.confirmedEmpty) return;
  if (groupEmpty(connector.groupId)) {
    connector.confirmedEmpty = true;
    return;
  }
  try {
    process.kill(-connector.groupId, "SIGKILL");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) {
      throw phaseError("cleanup");
    }
  }
  await waitUntil(() => groupEmpty(connector.groupId), 5_000).catch(() => {
    throw phaseError("cleanup");
  });
  connector.confirmedEmpty = true;
}

async function deliver(gateway, connector, options) {
  gateway.enqueue(options.id, options.conversationId, options.text);
  await gateway.wake(connector.webhookUrl, options.id);
  const observation = await gateway.waitFor(
    options.id,
    (value) => value.acknowledged,
    options.timeoutMs ?? MESSAGE_DEADLINE_MS,
  );
  if (
    options.expectedReply !== undefined &&
    (observation.terminal?.kind !== "reply" ||
      observation.terminal.fingerprint !== sha256(options.expectedReply))
  ) {
    throw phaseError("behavior");
  }
  return observation;
}

async function startNetworkProbe() {
  let hits = 0;
  const server = createHttpServer((_request, response) => {
    hits += 1;
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw phaseError("behavior");
  return {
    port: address.port,
    hits: () => hits,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function artifactScan(options) {
  const child = spawn(
    process.execPath,
    [join(options.repositoryRoot, "scripts", "t02-artifact-scan.mjs")],
    {
      cwd: options.repositoryRoot,
      env: { PATH: options.environment.PATH ?? "" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = captureStream(child.stdout, "artifact-scan-stdout");
  const stderr = captureStream(child.stderr, "artifact-scan-stderr");
  child.stdin.end(
    JSON.stringify({
      roots: options.roots,
      captures: options.captures,
      markers: options.markers.map((value, index) => ({
        name: `cx04-marker-${index + 1}`,
        encoding: "utf8",
        value,
      })),
    }),
  );
  const result = await waitForExit(child, 30_000);
  if (
    result.code !== 0 ||
    result.signal !== null ||
    stderr.value().value !== "" ||
    !stdout.value().value.startsWith("artifact scan passed:")
  ) {
    throw phaseError("artifact");
  }
}

export function validateMatrixObservation(value) {
  return (
    exactKeys(value, [
      "twoTurnResume",
      "readOnlySandbox",
      "workspaceWriteSandbox",
      "outOfRootDenied",
      "networkDenied",
      "cancellation",
      "hardCrashContainment",
      "exactRecovery",
      "artifactsClean",
    ]) && Object.values(value).every((entry) => entry === true)
  );
}

export async function runRealCodexMatrix(options) {
  const workingDirectory = await realpath(join(options.temporaryRoot, "workspace")).catch(
    async () => {
      const path = join(options.temporaryRoot, "workspace");
      await mkdir(path, { mode: 0o700 });
      return await realpath(path);
    },
  );
  const outsideDirectory = join(options.temporaryRoot, "outside");
  await mkdir(outsideDirectory, { mode: 0o700 });
  const markers = [TOKEN];
  const captures = [];
  const connectors = [];
  const gateway = new QualificationGateway();
  await gateway.start();
  let sequence = 0;
  const start = async (policy) => {
    sequence += 1;
    const connector = await spawnConnector({
      executable: options.connectorExecutable,
      workingDirectory,
      policy,
      environment: options.environment,
      sequence,
    });
    connectors.push(connector);
    await options.assertConfigUnchanged();
    return connector;
  };
  try {
    const memory = `cx04${randomBytes(12).toString("hex")}`;
    const ready = `ready-${memory}`;
    const firstPrompt = `Remember ${memory} for the next turn. Reply with exactly ${ready} and do not use tools.`;
    const secondPrompt = "Reply with only the value I asked you to remember in the previous turn.";
    markers.push(memory, ready, firstPrompt, secondPrompt);

    let connector = await start("read-only");
    await deliver(gateway, connector, {
      id: "cx04-two-turn-1",
      conversationId: "cx04-two-turn",
      text: firstPrompt,
      expectedReply: ready,
    });
    await options.assertConfigUnchanged();
    await deliver(gateway, connector, {
      id: "cx04-two-turn-2",
      conversationId: "cx04-two-turn",
      text: secondPrompt,
      expectedReply: memory,
    });
    await options.assertConfigUnchanged();

    const readOnlyName = "cx04-read-only-denied.txt";
    const readOnlyReply = `read-only-${randomBytes(8).toString("hex")}`;
    const readOnlyPrompt = `Use the terminal to write the ASCII text forbidden to ./${readOnlyName}. Then reply with exactly ${readOnlyReply}.`;
    markers.push(readOnlyReply, readOnlyPrompt);
    await deliver(gateway, connector, {
      id: "cx04-read-only",
      conversationId: "cx04-read-only",
      text: readOnlyPrompt,
      expectedReply: readOnlyReply,
    });
    await access(join(workingDirectory, readOnlyName)).then(
      () => {
        throw phaseError("behavior");
      },
      () => undefined,
    );
    await options.assertConfigUnchanged();
    await stopConnector(connector, "SIGTERM", 20_000);
    captures.push(...connector.captures.map((capture) => capture.value()));

    connector = await start("workspace-write");
    const writeReply = `workspace-${randomBytes(8).toString("hex")}`;
    const writePrompt = `Use the terminal to run printf 'allowed\\n' > ./cx04-allowed.txt. Then reply with exactly ${writeReply}.`;
    markers.push(writeReply, writePrompt);
    await deliver(gateway, connector, {
      id: "cx04-workspace-write",
      conversationId: "cx04-workspace-write",
      text: writePrompt,
      expectedReply: writeReply,
    });
    if ((await readFile(join(workingDirectory, "cx04-allowed.txt"), "utf8")) !== "allowed\n") {
      throw phaseError("behavior");
    }

    const outsidePath = join(outsideDirectory, "cx04-outside-denied.txt");
    const outsideReply = `outside-${randomBytes(8).toString("hex")}`;
    const outsidePrompt = `Use the terminal to write the ASCII text forbidden to ${outsidePath}. Then reply with exactly ${outsideReply}.`;
    markers.push(outsideReply, outsidePrompt);
    await deliver(gateway, connector, {
      id: "cx04-outside-denied",
      conversationId: "cx04-outside-denied",
      text: outsidePrompt,
      expectedReply: outsideReply,
    });
    await access(outsidePath).then(
      () => {
        throw phaseError("behavior");
      },
      () => undefined,
    );

    await access("/usr/bin/curl");
    const network = await startNetworkProbe();
    try {
      const networkReply = `network-${randomBytes(8).toString("hex")}`;
      const networkPrompt = `Use the terminal to run /usr/bin/curl --fail --max-time 3 http://127.0.0.1:${network.port}/cx04. Then reply with exactly ${networkReply}.`;
      markers.push(networkReply, networkPrompt);
      await deliver(gateway, connector, {
        id: "cx04-network-denied",
        conversationId: "cx04-network-denied",
        text: networkPrompt,
        expectedReply: networkReply,
      });
      if (network.hits() !== 0) throw phaseError("behavior");
    } finally {
      await network.close();
    }
    await options.assertConfigUnchanged();
    await stopConnector(connector, "SIGTERM", 20_000);
    captures.push(...connector.captures.map((capture) => capture.value()));

    connector = await start("workspace-write");
    const cancelPrompt =
      "Use the terminal to execute sh -c 'sh -c \"sleep 120\" & wait'. Do not reply before it exits.";
    markers.push(cancelPrompt);
    gateway.enqueue("cx04-cancel", "cx04-cancel", cancelPrompt);
    await gateway.wake(connector.webhookUrl, "cx04-cancel");
    await waitUntil(async () => (await processGroupSize(connector.groupId)) >= 4, 120_000, 250);
    await stopConnector(connector, "SIGTERM", 20_000);
    captures.push(...connector.captures.map((capture) => capture.value()));

    connector = await start("workspace-write");
    const hardCrashPrompt =
      "Use the terminal to execute sh -c 'sh -c \"sleep 120\" & wait'. Do not reply before it exits.";
    gateway.enqueue("cx04-hard-crash", "cx04-hard-crash", hardCrashPrompt);
    await gateway.wake(connector.webhookUrl, "cx04-hard-crash");
    await waitUntil(async () => (await processGroupSize(connector.groupId)) >= 4, 120_000, 250);
    await stopConnector(connector, "SIGKILL", 15_000);
    captures.push(...connector.captures.map((capture) => capture.value()));

    connector = await start("workspace-write");
    const recoveryReply = `recovered-${randomBytes(8).toString("hex")}`;
    const recoveryPrompt = `Use the terminal to run printf 'one\\n' >> ./cx04-recovery-count.txt. Then reply with exactly ${recoveryReply}.`;
    markers.push(recoveryReply, recoveryPrompt);
    gateway.enqueue("cx04-recovery", "cx04-recovery", recoveryPrompt);
    gateway.dropReplies("cx04-recovery", true);
    await gateway.wake(connector.webhookUrl, "cx04-recovery");
    await gateway.waitFor("cx04-recovery", (value) => value.replyAttempts >= 1);
    if ((await readFile(join(workingDirectory, "cx04-recovery-count.txt"), "utf8")) !== "one\n") {
      throw phaseError("behavior");
    }
    await stopConnector(connector, "SIGKILL", 15_000);
    captures.push(...connector.captures.map((capture) => capture.value()));

    gateway.dropReplies("cx04-recovery", false);
    connector = await start("workspace-write");
    await gateway.wake(connector.webhookUrl, "cx04-recovery");
    const recovered = await gateway.waitFor("cx04-recovery", (value) => value.acknowledged);
    if (
      recovered.terminal?.kind !== "reply" ||
      recovered.terminal.fingerprint !== sha256(recoveryReply) ||
      (await readFile(join(workingDirectory, "cx04-recovery-count.txt"), "utf8")) !== "one\n"
    ) {
      throw phaseError("behavior");
    }
    await options.assertConfigUnchanged();
    await stopConnector(connector, "SIGTERM", 20_000);
    captures.push(...connector.captures.map((capture) => capture.value()));

    await artifactScan({
      repositoryRoot: options.repositoryRoot,
      environment: options.environment,
      roots: [options.stateDirectory, workingDirectory, outsideDirectory, ...options.artifactRoots],
      captures,
      markers,
    });
    const evidence = {
      twoTurnResume: true,
      readOnlySandbox: true,
      workspaceWriteSandbox: true,
      outOfRootDenied: true,
      networkDenied: true,
      cancellation: true,
      hardCrashContainment: true,
      exactRecovery: true,
      artifactsClean: true,
    };
    if (!validateMatrixObservation(evidence)) throw phaseError("behavior");
    return evidence;
  } finally {
    for (const connector of connectors) {
      if (connector.child.exitCode === null && connector.child.signalCode === null) {
        connector.child.kill("SIGKILL");
        await waitForExit(connector.child, 5_000).catch(() => undefined);
      }
      await forceContainConnector(connector);
    }
    await gateway.close();
  }
}
