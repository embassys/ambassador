#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { observeAgentVersion } from "./agent-version-probes.mjs";

const SOURCE_REPOSITORY = "https://github.com/embassys/agent2agent";
const SOURCE_REVISION = "ac3f7a6e33829eb80301c7944f611d29cc2499b5";
const LIVE_ORIGIN = "https://mcp.embassys.ai";
const KEYCHAIN_SERVICE = "ai.embassys.ambassador.development.mailosaur";
const MOCK_CONFIRMATION = "run-live-qualification-with-two-disposable-mailosaur-identities";
const CODEX_CONFIRMATION =
  "run-live-qualification-with-real-codex-and-two-disposable-mailosaur-identities";
const CLAUDE_CONFIRMATION =
  "run-live-qualification-with-real-claude-and-two-disposable-mailosaur-identities";
const CODEX_CLAUDE_CONFIRMATION =
  "run-live-qualification-with-real-codex-and-real-claude-and-two-disposable-mailosaur-identities";
const HERMES_DIRECT_CONFIRMATION =
  "run-live-qualification-with-real-hermes-direct-and-two-disposable-mailosaur-identities";
const HERMES_WEBHOOK_CONFIRMATION =
  "run-live-qualification-with-real-hermes-webhook-and-two-disposable-mailosaur-identities";
const OPENCLAW_DIRECT_CONFIRMATION =
  "run-live-qualification-with-real-openclaw-direct-and-two-disposable-mailosaur-identities";
const OPENCLAW_WEBHOOK_CONFIRMATION =
  "run-live-qualification-with-real-openclaw-webhook-and-two-disposable-mailosaur-identities";
const OPENCLAW_CLIENT_INFO = { name: "openclaw-bundle-mcp", version: "qualification" };
const CODEX_CLIENT_INFO = { name: "codex-mcp-client", version: "qualification" };
const CLAUDE_CLIENT_INFO = { name: "claude-code", version: "qualification" };
const HERMES_CLIENT_INFO = { name: "mcp", version: "qualification" };
const CLAUDE_COMMAND = "claude";
const CLAUDE_USER_MCP_PORT = 8787;
const HERMES_ACP_COMMAND = "hermes-acp";
const OPENCLAW_ACP_COMMAND = "openclaw";
const OPENCLAW_WEBHOOK_PATH = "/hooks/agent";
const MAX_CAPTURE_BYTES = 256 * 1024;
const WEBHOOK_WAIT_MS = 90_000;
const RESTART_POLL_DRAIN_MS = 31_000;
const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function safeFailure(phase) {
  return Object.assign(new Error("live qualification failed"), { phase });
}

function assert(condition, phase) {
  if (!condition) throw safeFailure(phase);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function fieldTypes(value) {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((name) => [name, valueType(value[name])]),
  );
}

async function sanitizedResponseObservation(target, response, expectedEmail) {
  const observation = {
    route: `${target.pathname}`,
    status: response.status,
    content_type: response.headers.get("content-type"),
    content_encoding: response.headers.get("content-encoding"),
    cache_control: response.headers.get("cache-control"),
    set_cookie: response.headers.has("set-cookie"),
    top_level: "unreadable",
    field_types: {},
  };
  try {
    const body = await response.clone().json();
    if (isRecord(body)) {
      observation.top_level = "object";
      observation.field_types = fieldTypes(body);
      if (target.pathname === "/api/register_agent") {
        observation.contract_checks = {
          agent_id_syntax:
            typeof body.agent_id === "string" && /^[A-Za-z0-9._~-]{1,256}$/u.test(body.agent_id),
          email_matches_request: body.email === expectedEmail,
          message_length:
            typeof body.message === "string" &&
            body.message.length >= 1 &&
            body.message.length <= 512,
        };
      }
      if (Array.isArray(body.messages)) {
        const first = body.messages.find(isRecord);
        observation.collection = {
          field: "messages",
          count: body.messages.length,
          first_item_field_types: first === undefined ? {} : fieldTypes(first),
          first_payload_field_types:
            first !== undefined && isRecord(first.payload) ? fieldTypes(first.payload) : {},
        };
      }
    } else {
      observation.top_level = valueType(body);
      if (Array.isArray(body)) {
        const first = body.find(isRecord);
        observation.collection = {
          field: "response",
          count: body.length,
          first_item_field_types: first === undefined ? {} : fieldTypes(first),
        };
      }
    }
  } catch {
    // The observation deliberately records no response bytes or values.
  }
  return observation;
}

async function keychain(account) {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", maxBuffer: 16 * 1024 },
    );
    const value = stdout.trim();
    if (value.length < 3 || value.length > 8_192) throw safeFailure("keychain");
    return value;
  } catch {
    throw safeFailure("keychain");
  }
}

async function mailosaurFetch(credentials, path, init = {}) {
  const response = await fetch(new URL(path, "https://mailosaur.com"), {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${credentials.apiKey}:`, "utf8").toString("base64")}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    credentials: "omit",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw safeFailure("mailbox");
  }
  return response;
}

async function findVerification(credentials, address, receivedAfter) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({
      server: credentials.serverId,
      receivedAfter: receivedAfter.toISOString(),
      itemsPerPage: "10",
    });
    const search = await mailosaurFetch(credentials, `/api/messages/search?${query.toString()}`, {
      method: "POST",
      body: JSON.stringify({ sentTo: address }),
    });
    const result = await search.json();
    if (isRecord(result) && Array.isArray(result.items)) {
      const summary = result.items.find(
        (item) => isRecord(item) && typeof item.id === "string" && item.id.length > 0,
      );
      if (isRecord(summary) && typeof summary.id === "string") {
        const detailResponse = await mailosaurFetch(
          credentials,
          `/api/messages/${encodeURIComponent(summary.id)}`,
        );
        const detail = await detailResponse.json();
        const candidates = [];
        if (isRecord(detail)) {
          for (const format of ["text", "html"]) {
            const content = detail[format];
            if (!isRecord(content) || !Array.isArray(content.codes)) continue;
            for (const code of content.codes) {
              if (isRecord(code) && typeof code.value === "string") candidates.push(code.value);
            }
          }
        }
        const code = candidates.find((value) => /^\d{6}$/u.test(value));
        if (code !== undefined) return { code, messageId: summary.id };
        throw safeFailure("mail_code");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw safeFailure("mail_timeout");
}

async function deleteMessage(credentials, messageId) {
  try {
    const response = await mailosaurFetch(
      credentials,
      `/api/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE" },
    );
    await response.body?.cancel().catch(() => undefined);
  } catch {
    throw safeFailure("mail_cleanup");
  }
}

async function deleteRecentQualificationMessages(credentials, receivedAfter) {
  try {
    const query = new URLSearchParams({
      server: credentials.serverId,
      receivedAfter: receivedAfter.toISOString(),
      itemsPerPage: "100",
    });
    const response = await mailosaurFetch(credentials, `/api/messages?${query.toString()}`);
    const result = await response.json();
    if (!isRecord(result) || !Array.isArray(result.items)) return;
    for (const item of result.items) {
      if (!isRecord(item) || typeof item.id !== "string" || !Array.isArray(item.to)) continue;
      const belongsToQualification = item.to.some(
        (recipient) =>
          isRecord(recipient) &&
          typeof recipient.email === "string" &&
          recipient.email.startsWith("live-qualification-") &&
          recipient.email.endsWith(`@${credentials.domain}`),
      );
      if (belongsToQualification) await deleteMessage(credentials, item.id);
    }
  } catch {
    throw safeFailure("mail_cleanup");
  }
}

function parseRpcResponse(contentType, body) {
  let value;
  if (contentType?.includes("text/event-stream")) {
    const data = body
      .split(/\r?\n/u)
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    if (data === undefined) throw safeFailure("local_mcp");
    value = JSON.parse(data);
  } else {
    value = JSON.parse(body);
  }
  if (!isRecord(value)) throw safeFailure("local_mcp");
  return value;
}

class QualificationMcpClient {
  #nextId = 1;
  #sessionId;

  constructor(endpoint, clientInfo) {
    this.endpoint = endpoint;
    this.clientInfo = clientInfo;
  }

  async initialize() {
    await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
  }

  async listTools() {
    const response = await this.#request("tools/list", {});
    assert(isRecord(response.result) && Array.isArray(response.result.tools), "local_catalog");
    return response.result.tools;
  }

  async call(name, arguments_) {
    const response = await this.#request("tools/call", { name, arguments: arguments_ });
    assert(isRecord(response.result), "local_tool");
    if (isRecord(response.result.structuredContent)) return response.result.structuredContent;
    const content = Array.isArray(response.result.content) ? response.result.content : [];
    const item = content.find((entry) => isRecord(entry) && entry.type === "text");
    assert(isRecord(item) && typeof item.text === "string", "local_tool");
    const parsed = JSON.parse(item.text);
    assert(isRecord(parsed), "local_tool");
    return parsed;
  }

  async #request(method, params) {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params });
    if (response.id !== id) throw safeFailure("local_mcp");
    if (isRecord(response.error)) {
      const data = response.error.data;
      const code = isRecord(data) && typeof data.code === "string" ? data.code : "local_tool";
      throw safeFailure(/^[a-z0-9_]{1,80}$/u.test(code) ? code : "local_tool");
    }
    return response;
  }

  async #post(message, expectResponse = true) {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.#sessionId === undefined
        ? {}
        : {
            "mcp-protocol-version": "2025-06-18",
            "mcp-session-id": this.#sessionId,
          }),
    };
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      redirect: "manual",
      signal: AbortSignal.timeout(35_000),
    });
    assert(response.status >= 200 && response.status < 300, "local_mcp");
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    const body = await response.text();
    assert(Buffer.byteLength(body, "utf8") <= 4 * 1024 * 1024, "local_mcp");
    if (!expectResponse) return {};
    return parseRpcResponse(response.headers.get("content-type"), body);
  }
}

function openClawAmbassadorMessage(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "agentId,deliver,message,name,sessionMode" ||
    value.name !== "Embassys Ambassador" ||
    value.agentId !== "main" ||
    value.sessionMode !== "isolated" ||
    value.deliver !== false ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  const marker = "\nEmbassys message JSON:\n";
  const markerIndex = value.message.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  try {
    const message = JSON.parse(value.message.slice(markerIndex + marker.length));
    return isRecord(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

async function startWebhook(token, contract = "ambassador-hmac-v2") {
  const wakes = [];
  const waiters = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= 64 * 1024) chunks.push(chunk);
    });
    request.on("end", () => {
      let valid = bytes <= 64 * 1024;
      const body = Buffer.concat(chunks).toString("utf8");
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        valid = false;
      }
      let message = parsed;
      if (contract === "openclaw-agent") {
        message = openClawAmbassadorMessage(parsed);
        valid =
          valid &&
          request.headers["x-webhook-signature-v2"] === undefined &&
          request.headers["x-webhook-timestamp"] === undefined &&
          request.headers["x-request-id"] === undefined;
      } else {
        const timestamp = request.headers["x-webhook-timestamp"];
        const expected =
          typeof timestamp === "string"
            ? createHmac("sha256", token).update(timestamp).update(".").update(body).digest("hex")
            : "";
        valid =
          valid &&
          request.headers["x-webhook-signature-v2"] === expected &&
          request.headers["x-request-id"] === request.headers["idempotency-key"];
      }
      valid =
        valid &&
        request.method === "POST" &&
        request.url === "/hooks/agent" &&
        request.headers.authorization === `Bearer ${token}` &&
        isRecord(message) &&
        request.headers["idempotency-key"] === message.id &&
        typeof message.sender_agent_id === "string" &&
        isRecord(message.payload) &&
        typeof message.created_at === "string";
      response.writeHead(valid ? 200 : 400, { "content-type": "application/json" });
      response.end(
        valid && contract === "openclaw-agent"
          ? '{"ok":true,"runId":"qualification-run"}'
          : valid
            ? '{"ok":true}'
            : '{"ok":false}',
      );
      if (!valid) return;
      const waiter = waiters.shift();
      if (waiter === undefined) wakes.push(message);
      else {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(isRecord(address) && typeof address.port === "number", "webhook");
  return {
    url: `http://127.0.0.1:${address.port}/hooks/agent`,
    async wait(timeoutPhase = "webhook_timeout") {
      const available = wakes.shift();
      if (available !== undefined) return available;
      return await new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(safeFailure(timeoutPhase));
          }, WEBHOOK_WAIT_MS),
        };
        waiters.push(waiter);
      });
    },
    async close() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function hermesEnvironment(home, extra = {}) {
  return {
    HOME: home,
    HERMES_HOME: join(home, ".hermes"),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
    ...extra,
  };
}

function claudeEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
  };
}

async function runClaudeConfiguration(home, arguments_) {
  const child = spawn(CLAUDE_COMMAND, arguments_, {
    cwd: home,
    env: claudeEnvironment(home),
    shell: false,
    stdio: "ignore",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  timeout.unref();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timeout));
  assert(code === 0, "claude_mcp_configuration");
}

async function prepareClaudeMcp(home, endpoint, usesOrdinaryHome) {
  if (usesOrdinaryHome) {
    assert(endpoint === `http://127.0.0.1:${CLAUDE_USER_MCP_PORT}/mcp`, "claude_mcp_configuration");
  } else {
    await runClaudeConfiguration(home, ["mcp", "remove", "ambassador", "--scope", "user"]).catch(
      () => undefined,
    );
    await runClaudeConfiguration(home, [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "ambassador",
      endpoint,
    ]);
  }
  await runClaudeConfiguration(home, ["mcp", "get", "ambassador"]);
}

async function validateClaudeHome(configuredHome) {
  assert(configuredHome !== undefined && isAbsolute(configuredHome), "claude_isolation");
  const home = await realpath(configuredHome).catch(() => undefined);
  const ordinaryHome =
    process.env.HOME === undefined
      ? undefined
      : await realpath(process.env.HOME).catch(() => undefined);
  assert(home !== undefined, "claude_isolation");
  const usesOrdinaryHome = ordinaryHome !== undefined && home === ordinaryHome;
  const rootMetadata = await lstat(home).catch(() => undefined);
  assert(
    rootMetadata?.isDirectory() === true &&
      !rootMetadata.isSymbolicLink() &&
      (usesOrdinaryHome || (rootMetadata.mode & 0o077) === 0),
    "claude_isolation",
  );
  for (const relativePath of [".claude.json", ".claude/settings.json"]) {
    const metadata = await lstat(join(home, relativePath)).catch(() => undefined);
    assert(
      metadata?.isFile() === true &&
        !metadata.isSymbolicLink() &&
        (usesOrdinaryHome || (metadata.mode & 0o077) === 0),
      "claude_isolation",
    );
  }
  return { home, usesOrdinaryHome };
}

async function validateHermesHome(configuredHome) {
  assert(configuredHome !== undefined && isAbsolute(configuredHome), "hermes_isolation");
  const home = await realpath(configuredHome).catch(() => undefined);
  const ordinaryHome =
    process.env.HOME === undefined
      ? undefined
      : await realpath(process.env.HOME).catch(() => undefined);
  assert(home !== undefined && home !== ordinaryHome, "hermes_isolation");
  const rootMetadata = await lstat(home).catch(() => undefined);
  assert(
    rootMetadata?.isDirectory() === true &&
      !rootMetadata.isSymbolicLink() &&
      (rootMetadata.mode & 0o077) === 0,
    "hermes_isolation",
  );
  for (const relativePath of [
    ".hermes/.env",
    ".hermes/auth.json",
    ".hermes/config.yaml",
    ".hermes/shared/nous_auth.json",
  ]) {
    const metadata = await lstat(join(home, relativePath)).catch(() => undefined);
    assert(
      metadata?.isFile() === true && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0,
      "hermes_isolation",
    );
  }
  return home;
}

async function runHermesConfiguration(home, arguments_, input) {
  const child = spawn("hermes", arguments_, {
    cwd: home,
    env: hermesEnvironment(home),
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  timeout.unref();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timeout));
  assert(code === 0, "hermes_mcp_configuration");
}

async function configureHermesMcp(home, endpoint) {
  await runHermesConfiguration(home, ["mcp", "remove", "ambassador"], "\n").catch(() => undefined);
  await runHermesConfiguration(
    home,
    ["mcp", "add", "ambassador", "--url", endpoint, "--connect-timeout", "15"],
    "n\n\n",
  );
  const config = await readFile(join(home, ".hermes", "config.yaml"), "utf8");
  assert(config.includes("  ambassador:") && config.includes(endpoint), "hermes_mcp_configuration");
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(isRecord(address) && typeof address.port === "number", "hermes_webhook_setup");
  await new Promise((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startHermesWebhook(home, workingDirectory, secret, requestedPort) {
  const port = requestedPort ?? (await availableLoopbackPort());
  await writeFile(
    join(home, ".hermes", "webhook_subscriptions.json"),
    `${JSON.stringify(
      {
        embassys: {
          description: "Controlled Embassys qualification route",
          events: [],
          filters: [{ field: "headers.Authorization", equals: `Bearer ${secret}` }],
          prompt: "",
          skills: [],
          deliver: "log",
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "w", mode: 0o600 },
  );
  const child = spawn("hermes", ["gateway", "run", "--quiet", "--force"], {
    cwd: workingDirectory,
    detached: true,
    env: hermesEnvironment(home, {
      WEBHOOK_ENABLED: "true",
      WEBHOOK_PORT: String(port),
      WEBHOOK_SECRET: secret,
    }),
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const healthUrl = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !exited) {
    const ready = await fetch(healthUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    })
      .then(async (response) => {
        await response.body?.cancel().catch(() => undefined);
        return response.ok;
      })
      .catch(() => false);
    if (ready) {
      return {
        url: `http://127.0.0.1:${port}/webhooks/embassys`,
        async stop() {
          if (exited) return;
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
          const stopped = await Promise.race([
            new Promise((resolve) => child.once("exit", () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
          ]);
          if (!stopped && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!exited && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  throw safeFailure("hermes_webhook_setup");
}

async function assertHermesWebhookBearerFilter(url, secret) {
  const body = JSON.stringify({ synthetic: true });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("hex");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": randomUUID(),
      "X-Webhook-Signature-V2": signature,
      "X-Webhook-Timestamp": timestamp,
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => undefined);
  assert(
    response.ok && isRecord(result) && result.status === "ignored" && result.reason === "filter",
    "hermes_webhook_bearer",
  );
}

function openClawEnvironment(home) {
  return {
    HOME: home,
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  };
}

async function validateOpenClawHome(configuredHome) {
  assert(configuredHome !== undefined && isAbsolute(configuredHome), "openclaw_isolation");
  const home = await realpath(configuredHome).catch(() => undefined);
  const ordinaryHome =
    process.env.HOME === undefined
      ? undefined
      : await realpath(process.env.HOME).catch(() => undefined);
  assert(home !== undefined && home !== ordinaryHome, "openclaw_isolation");
  const rootMetadata = await lstat(home).catch(() => undefined);
  assert(
    rootMetadata?.isDirectory() === true &&
      !rootMetadata.isSymbolicLink() &&
      (rootMetadata.mode & 0o077) === 0,
    "openclaw_isolation",
  );
  for (const relativePath of [
    ".openclaw/openclaw.json",
    ".openclaw/state/openclaw.sqlite",
    ".openclaw/agents/main/agent/openclaw-agent.sqlite",
  ]) {
    const metadata = await lstat(join(home, relativePath)).catch(() => undefined);
    assert(
      metadata?.isFile() === true && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0,
      "openclaw_isolation",
    );
  }
  return home;
}

async function runOpenClawConfiguration(home, arguments_, input = "") {
  const child = spawn("openclaw", arguments_, {
    cwd: home,
    env: openClawEnvironment(home),
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(input);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  timeout.unref();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  }).finally(() => clearTimeout(timeout));
  assert(code === 0, "openclaw_configuration");
}

async function configureOpenClawMcp(home, endpoint) {
  await runOpenClawConfiguration(home, [
    "mcp",
    "set",
    "ambassador",
    JSON.stringify({
      url: endpoint,
      transport: "streamable-http",
      enabled: true,
      connectionTimeoutMs: 15_000,
      requestTimeoutMs: 90_000,
    }),
  ]);
}

async function configureOpenClawGateway(home, workingDirectory, port) {
  for (const [path, value, strict] of [
    ["agents.defaults.workspace", workingDirectory, false],
    ["gateway.mode", "local", false],
    ["gateway.bind", "loopback", false],
    ["gateway.port", String(port), true],
    ["gateway.auth.mode", "none", false],
  ]) {
    await runOpenClawConfiguration(home, [
      "config",
      "set",
      path,
      value,
      ...(strict ? ["--strict-json"] : []),
    ]);
  }
}

async function prepareOpenClawWebhook(home, secret) {
  await runOpenClawConfiguration(
    home,
    ["config", "patch", "--stdin"],
    JSON.stringify({
      hooks: {
        enabled: true,
        token: secret,
        path: "/hooks",
        allowedAgentIds: ["main"],
        allowRequestSessionKey: false,
      },
    }),
  );
}

async function assertOpenClawWebhookBearerFilter(url) {
  const body = JSON.stringify({
    message: "Ambassador bearer filter probe",
    name: "Embassys Ambassador",
    agentId: "main",
    sessionMode: "isolated",
    deliver: false,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel().catch(() => undefined);
  assert(response.status === 401, "openclaw_webhook_bearer");
}

async function startOpenClawGateway(home, workingDirectory, endpoint, requestedPort) {
  const port = requestedPort ?? (await availableLoopbackPort());
  await configureOpenClawMcp(home, endpoint);
  await configureOpenClawGateway(home, workingDirectory, port);
  const child = spawn("openclaw", ["gateway", "run", "--allow-unconfigured"], {
    cwd: workingDirectory,
    detached: true,
    env: openClawEnvironment(home),
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const url = `http://127.0.0.1:${port}${OPENCLAW_WEBHOOK_PATH}`;
  const readinessUrl = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !exited) {
    const ready = await fetch(readinessUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    })
      .then(async (response) => {
        await response.body?.cancel().catch(() => undefined);
        return response.status < 500;
      })
      .catch(() => false);
    if (ready) {
      return {
        url,
        port,
        async stop() {
          if (exited) return;
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
          const stopped = await Promise.race([
            new Promise((resolve) => child.once("exit", () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
          ]);
          if (!stopped && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!exited && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  throw safeFailure("openclaw_gateway_setup");
}

async function waitForEndpoint(read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(read());
    if (match?.[1] !== undefined) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw safeFailure("gateway_start");
}

async function waitForDelivered(messages, predicate, phase) {
  const deadline = Date.now() + WEBHOOK_WAIT_MS;
  while (Date.now() < deadline) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw safeFailure(phase);
}

async function waitForObservation(predicate, phase) {
  const deadline = Date.now() + WEBHOOK_WAIT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw safeFailure(phase);
}

async function startGateway(
  packed,
  stateRoot,
  centralFetch,
  deliveryTargetFactory,
  clientInfo,
  extraEnvironment = {},
  workingDirectory = repositoryRoot,
  webhookFetch,
  localMcpPort = 0,
) {
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const running = packed.runCli(["start"], {
    io: {
      stdout: {
        write(chunk) {
          stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          if (Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) controller.abort();
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          if (Buffer.byteLength(stderr, "utf8") > MAX_CAPTURE_BYTES) controller.abort();
          return true;
        },
      },
    },
    env: { ...extraEnvironment },
    cwd: workingDirectory,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: LIVE_ORIGIN,
      stateRoot,
      localMcpPort,
      centralFetch,
      ...(webhookFetch === undefined ? {} : { webhookFetch }),
      ...(deliveryTargetFactory === undefined ? {} : { deliveryTargetFactory }),
    },
  });
  const endpoint = await waitForEndpoint(() => stdout);
  const client = new QualificationMcpClient(endpoint, clientInfo);
  await client.initialize();
  return {
    client,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      controller.abort();
      const result = await running;
      assert(result === 0, "gateway_stop");
    },
  };
}

async function createGatewayWebhookSecret(packed, stateRoot) {
  let stdout = "";
  let stderr = "";
  const result = await packed.runCli(["webhook-secret"], {
    io: {
      stdout: {
        write(chunk) {
          stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
    },
    env: {},
    cwd: repositoryRoot,
    testOverrides: { centralOrigin: LIVE_ORIGIN, stateRoot },
  });
  assert(result === 0 && stderr === "", "webhook_secret_setup");
  const secret = stdout.trim();
  assert(/^[a-f0-9]{48}$/u.test(secret), "webhook_secret_setup");
  return secret;
}

async function readTreeFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw safeFailure("package_scan");
    }
  };
  await visit(root);
  return files;
}

async function assertPackedRuntime(cliPath) {
  const packageRoot = await realpath(join(dirname(cliPath), ".."));
  const dist = join(packageRoot, "dist");
  const files = await readTreeFiles(dist);
  const names = files.map((path) => path.slice(dist.length + 1));
  for (const forbidden of [
    "central-mcp",
    "central-conversation",
    "central-reissue",
    "credential-v2",
    "development-verbose",
  ]) {
    assert(
      names.every((name) => !name.includes(forbidden)),
      "package_scan",
    );
  }
  const text = (
    await Promise.all(
      files.filter((path) => path.endsWith(".js")).map((path) => readFile(path, "utf8")),
    )
  ).join("\n");
  for (const forbidden of [
    "/api/v2",
    "/api/reissue",
    "/api/activate",
    "/api/conversations",
    "/api/reply",
    "/api/outcome",
  ]) {
    assert(!text.includes(forbidden), "package_scan");
  }
  const removedPlugin = await lstat(join(packageRoot, "integrations", "openclaw-ambassador")).catch(
    () => undefined,
  );
  assert(removedPlugin === undefined, "package_scan");
}

async function artifactScan(roots, captures, markers) {
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, "scripts", "t02-artifact-scan.mjs")],
    {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.end(
    JSON.stringify({
      roots,
      captures,
      markers: markers
        .filter((marker) => Buffer.byteLength(marker.value, "utf8") >= 6)
        .map((marker) => ({ name: marker.name, encoding: "utf8", value: marker.value })),
    }),
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert(
    code === 0 && stderr === "" && stdout.startsWith("artifact scan passed:"),
    "artifact_scan",
  );
}

function proofFactory(modules, credential, proofMarkers) {
  return (options = {}) => {
    const key = options.key ?? credential;
    const proof = modules.createDpopProof({
      method: options.method ?? "GET",
      targetUri: options.targetUri,
      privateKey: key.privateKey,
      publicJwk: key.publicJwk,
      accessToken: options.hashToken ?? credential.record.access_token,
      now: options.now,
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });
    proofMarkers.push(proof);
    return proof;
  };
}

async function dpopQualification(modules, credential) {
  const target = `${LIVE_ORIGIN}/api/list_action_types`;
  const proofMarkers = [];
  const createProof = proofFactory(modules, credential, proofMarkers);
  const send = async (proof) => {
    const response = await fetch(target, {
      method: "GET",
      headers: {
        authorization: `Bearer ${credential.record.access_token}`,
        ...(proof === undefined ? {} : { dpop: proof }),
      },
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const status = response.status;
    const nonce = response.headers.get("dpop-nonce");
    await response.body?.cancel().catch(() => undefined);
    return { status, nonce };
  };

  assert((await send(undefined)).status === 401, "dpop_missing");
  const other = modules.generateDpopKeyMaterial();
  assert(
    (await send(createProof({ key: other, targetUri: target }))).status === 401,
    "dpop_wrong_key",
  );
  assert(
    (await send(createProof({ targetUri: target, now: () => Date.now() / 1_000 - 120 }))).status ===
      401,
    "dpop_stale",
  );
  assert(
    (await send(createProof({ targetUri: target, now: () => Date.now() / 1_000 + 120 }))).status ===
      401,
    "dpop_future",
  );
  assert(
    (await send(createProof({ targetUri: `${LIVE_ORIGIN}/api/poll_messages?timeout=0` })))
      .status === 401,
    "dpop_wrong_url",
  );
  assert(
    (await send(createProof({ method: "POST", targetUri: target }))).status === 401,
    "dpop_wrong_method",
  );
  assert(
    (await send(createProof({ targetUri: target, hashToken: "synthetic-wrong-token-hash" })))
      .status === 401,
    "dpop_wrong_hash",
  );

  let positiveProof = createProof({ targetUri: target });
  let positive = await send(positiveProof);
  let nonceObserved = false;
  if (positive.status === 401 && positive.nonce !== null) {
    nonceObserved = true;
    positiveProof = createProof({ targetUri: target, nonce: positive.nonce });
    positive = await send(positiveProof);
  }
  assert(positive.status === 200, "dpop_positive");
  assert((await send(positiveProof)).status === 401, "dpop_replay");
  return { proofMarkers, nonceObserved, other };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function schemaDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function main() {
  const directAgent = process.env.AMBASSADOR_LIVE_DIRECT_AGENT ?? "mock";
  assert(
    [
      "mock",
      "codex",
      "codex-claude",
      "claude",
      "hermes-direct",
      "hermes-webhook",
      "openclaw-direct",
      "openclaw-webhook",
    ].includes(directAgent),
    "direct_agent",
  );
  const realCodexClaude = directAgent === "codex-claude";
  const realCodex = directAgent === "codex";
  const realClaude = directAgent === "claude" || realCodexClaude;
  const anyRealCodex = realCodex || realCodexClaude;
  const realHermesDirect = directAgent === "hermes-direct";
  const realHermesWebhook = directAgent === "hermes-webhook";
  const realHermes = realHermesDirect || realHermesWebhook;
  const realOpenClawDirect = directAgent === "openclaw-direct";
  const realOpenClawWebhook = directAgent === "openclaw-webhook";
  const realOpenClaw = realOpenClawDirect || realOpenClawWebhook;
  const realWebhook = realHermesWebhook || realOpenClawWebhook;
  const realDirect = anyRealCodex || realClaude || realHermesDirect || realOpenClawDirect;
  const realDirectOnly = realCodex || realClaude;
  const realTarget = realDirect || realWebhook;
  let targetVersionProbe = { status: "not_applicable", reported_version: null };
  let requesterVersionProbe = { status: "not_applicable", reported_version: null };
  const confirmation = realCodexClaude
    ? CODEX_CLAUDE_CONFIRMATION
    : realCodex
      ? CODEX_CONFIRMATION
      : realClaude
        ? CLAUDE_CONFIRMATION
        : realHermesDirect
          ? HERMES_DIRECT_CONFIRMATION
          : realHermesWebhook
            ? HERMES_WEBHOOK_CONFIRMATION
            : realOpenClawDirect
              ? OPENCLAW_DIRECT_CONFIRMATION
              : realOpenClawWebhook
                ? OPENCLAW_WEBHOOK_CONFIRMATION
                : MOCK_CONFIRMATION;
  if (process.env.AMBASSADOR_CONFIRM_LIVE_QUALIFICATION !== confirmation) {
    process.stderr.write("live qualification: explicit_confirmation_required\n");
    return 2;
  }
  const cliPath = process.env.AMBASSADOR_PACKED_CLI;
  const tarballPath = process.env.AMBASSADOR_PACKED_TARBALL;
  assert(cliPath !== undefined && tarballPath !== undefined, "package_input");

  let codexHome;
  if (anyRealCodex) {
    const configuredHome = process.env.AMBASSADOR_CODEX_QUALIFICATION_HOME;
    assert(configuredHome !== undefined && isAbsolute(configuredHome), "codex_isolation");
    codexHome = await realpath(configuredHome).catch(() => undefined);
    const ordinaryHome =
      process.env.HOME === undefined
        ? undefined
        : await realpath(process.env.HOME).catch(() => undefined);
    assert(codexHome !== undefined && codexHome !== ordinaryHome, "codex_isolation");
    const configuredAuthPath = join(codexHome, ".codex", "auth.json");
    const codexAuthPath = await realpath(configuredAuthPath).catch(() => undefined);
    assert(codexAuthPath === configuredAuthPath, "codex_isolation");
    const codexVersionProbe = await observeAgentVersion("codex", {
      HOME: codexHome,
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    });
    if (realCodexClaude) requesterVersionProbe = codexVersionProbe;
    else targetVersionProbe = codexVersionProbe;
  }
  const claudeQualification = realClaude
    ? await validateClaudeHome(process.env.AMBASSADOR_CLAUDE_QUALIFICATION_HOME)
    : undefined;
  const claudeHome = claudeQualification?.home;
  if (realClaude && claudeHome !== undefined) {
    targetVersionProbe = await observeAgentVersion("claude", claudeEnvironment(claudeHome));
  }
  const hermesHome = realHermes
    ? await validateHermesHome(process.env.AMBASSADOR_HERMES_QUALIFICATION_HOME)
    : undefined;
  if (realHermes && hermesHome !== undefined) {
    targetVersionProbe = await observeAgentVersion("hermes", hermesEnvironment(hermesHome));
  }
  const openClawHome = realOpenClaw
    ? await validateOpenClawHome(process.env.AMBASSADOR_OPENCLAW_QUALIFICATION_HOME)
    : undefined;
  if (realOpenClaw && openClawHome !== undefined) {
    targetVersionProbe = await observeAgentVersion("openclaw", openClawEnvironment(openClawHome));
  }

  const credentials = {
    apiKey: await keychain("api-key"),
    serverId: await keychain("server-id"),
    domain: await keychain("inbox-domain"),
  };
  assert(/^[A-Za-z0-9.-]+$/u.test(credentials.domain), "keychain");
  const receivedAfter = new Date(Date.now() - 5_000);
  const cleanupWindow = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  const addresses = [
    `live-qualification-${randomUUID().replaceAll("-", "")}@${credentials.domain}`,
    `live-qualification-${randomUUID().replaceAll("-", "")}@${credentials.domain}`,
  ];
  const syntheticPhone = "+447700900123";
  const actionReason =
    realTarget && !realClaude
      ? `synthetic-live-qualification-${randomUUID()}; return the approved synthetic phone number ${syntheticPhone} by calling the configured Ambassador submit_action_result tool exactly once with the call_id from this action_call, status success, and result containing only phone_number, then finish without disclosing any values elsewhere`
      : `synthetic-live-qualification-${randomUUID()}`;
  const permissionScope = {
    qualification: realClaude
      ? `synthetic-live-qualification-${randomUUID()}`
      : "The operator approved this synthetic phone-number test. Grant it through respond_to_permission.",
  };
  const capturedMail = [];
  const roots = [];
  const gateways = [];
  const webhooks = [];
  const webhookSecrets = [];
  const hermesWebhooks = [];
  const openClawGateways = [];
  const centralRoutes = new Set();
  const centralObservations = [];
  const directMessages = [];
  const requesterDirectMessages = [];
  const routeCounts = [new Map(), new Map()];
  const successfulAckCounts = [0, 0];
  const acknowledgedByGateway = [new Set(), new Set()];
  const webhookAcceptedByGateway = [new Set(), new Set()];
  const localCompletedByGateway = [new Set(), new Set()];
  const targetSubmittedCallIds = new Set();
  let targetPermissionDecisionObserved = false;
  let targetActionResultCallCount = 0;
  let hermesWebhookPort;
  let openClawGatewayPort;
  let catalogObservation;
  const centralFetchFor = (gatewayIndex) => async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    assert(target.origin === LIVE_ORIGIN && target.pathname.startsWith("/api/"), "central_route");
    assert(target.pathname !== "/mcp", "central_route");
    const route = `${init?.method ?? "GET"} ${target.pathname}`;
    centralRoutes.add(route);
    routeCounts[gatewayIndex].set(route, (routeCounts[gatewayIndex].get(route) ?? 0) + 1);
    const isTargetPermissionDecision =
      realTarget && gatewayIndex === 1 && route === "POST /api/respond_to_permission";
    const isTargetActionResult =
      realTarget && gatewayIndex === 1 && route === "POST /api/submit_action_result";
    let acknowledgedMessageId;
    let submittedCallId;
    if (route === "POST /api/ack_message" || isTargetActionResult) {
      try {
        const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (
          route === "POST /api/ack_message" &&
          isRecord(requestBody) &&
          typeof requestBody.message_id === "string"
        ) {
          acknowledgedMessageId = requestBody.message_id;
        }
        if (
          isTargetActionResult &&
          isRecord(requestBody) &&
          typeof requestBody.call_id === "string" &&
          requestBody.status === "success" &&
          canonicalJson(requestBody.result) === canonicalJson({ phone_number: syntheticPhone })
        ) {
          submittedCallId = requestBody.call_id;
        }
      } catch {
        // The production client owns request validation and serialization.
      }
    }
    if (acknowledgedMessageId !== undefined) {
      assert(localCompletedByGateway[gatewayIndex].has(acknowledgedMessageId), "ack_order");
    }
    const response = await fetch(input, init);
    if (isTargetPermissionDecision && response.ok) targetPermissionDecisionObserved = true;
    if (isTargetActionResult) targetActionResultCallCount += 1;
    if (submittedCallId !== undefined && response.ok) targetSubmittedCallIds.add(submittedCallId);
    if (acknowledgedMessageId !== undefined && response.ok) {
      acknowledgedByGateway[gatewayIndex].add(acknowledgedMessageId);
      successfulAckCounts[gatewayIndex] += 1;
    }
    let expectedEmail;
    if (target.pathname === "/api/register_agent") {
      try {
        const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (isRecord(requestBody) && typeof requestBody.email === "string") {
          expectedEmail = requestBody.email;
        }
      } catch {
        // The production client has already validated and serialized this request.
      }
    }
    const observation = await sanitizedResponseObservation(target, response, expectedEmail);
    if (
      centralObservations.length < 64 &&
      !centralObservations.some(
        (existing) => canonicalJson(existing) === canonicalJson(observation),
      )
    ) {
      centralObservations.push(observation);
    }
    return response;
  };
  const webhookFetchFor = (gatewayIndex) => async (input, init) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const messageId = request.headers.get("Idempotency-Key");
    const secret = webhookSecrets[gatewayIndex];
    const openClawNative = gatewayIndex === 0 || (gatewayIndex === 1 && realOpenClawWebhook);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw safeFailure("webhook_contract");
    }
    const message = openClawNative ? openClawAmbassadorMessage(parsed) : parsed;
    const timestamp = request.headers.get("X-Webhook-Timestamp");
    const signature = request.headers.get("X-Webhook-Signature-V2");
    const authenticated =
      secret !== undefined && request.headers.get("Authorization") === `Bearer ${secret}`;
    const contractValid = openClawNative
      ? timestamp === null && signature === null && request.headers.get("X-Request-ID") === null
      : timestamp !== null &&
        signature !== null &&
        signature ===
          createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex") &&
        request.headers.get("X-Request-ID") === messageId;
    assert(
      authenticated &&
        contractValid &&
        messageId !== null &&
        isRecord(message) &&
        message.id === messageId,
      "webhook_contract",
    );
    const response = await fetch(request);
    if (response.status >= 200 && response.status < 300) {
      webhookAcceptedByGateway[gatewayIndex].add(messageId);
      localCompletedByGateway[gatewayIndex].add(messageId);
    }
    return response;
  };
  let phase = "setup";
  try {
    phase = "package_import";
    const packed = await import(pathToFileURL(cliPath).href);
    const centralCredentialModule = await import(
      pathToFileURL(join(dirname(cliPath), "central-credential.js")).href
    );
    const credentialStoreModule = await import(
      pathToFileURL(join(dirname(cliPath), "credential-store.js")).href
    );
    const dpopModule = await import(pathToFileURL(join(dirname(cliPath), "dpop.js")).href);
    const directDeliveryModule = await import(
      pathToFileURL(join(dirname(cliPath), "direct-delivery.js")).href
    );
    const agentCapabilitiesModule = await import(
      pathToFileURL(join(dirname(cliPath), "agent-capabilities.js")).href
    );
    assert(typeof packed.runCli === "function", "package_input");
    if (realClaude) {
      const claudeCapability = agentCapabilitiesModule.PRODUCTION_AGENT_CAPABILITIES.find(
        (candidate) => candidate.kind === "claude",
      );
      assert(
        canonicalJson(claudeCapability?.aliases) === canonicalJson([CLAUDE_CLIENT_INFO.name]) &&
          claudeCapability?.direct?.command === CLAUDE_COMMAND &&
          canonicalJson(claudeCapability.direct.args) === canonicalJson([]) &&
          claudeCapability.direct.agentInfo.name === "@embassys/claude-cli-acp" &&
          claudeCapability.direct.mcp === "provider_config" &&
          claudeCapability.direct.builtInAdapter === "claude-cli",
        "claude_profile",
      );
    }
    if (realHermes) {
      const hermesCapability = agentCapabilitiesModule.PRODUCTION_AGENT_CAPABILITIES.find(
        (candidate) => candidate.kind === "hermes",
      );
      assert(
        canonicalJson(hermesCapability?.aliases) === canonicalJson([HERMES_CLIENT_INFO.name]) &&
          hermesCapability?.direct?.command === HERMES_ACP_COMMAND &&
          hermesCapability.direct.agentInfo.name === "hermes-agent",
        "hermes_profile",
      );
    }
    if (realOpenClaw) {
      const openClawCapability = agentCapabilitiesModule.PRODUCTION_AGENT_CAPABILITIES.find(
        (candidate) => candidate.kind === "openclaw",
      );
      assert(
        canonicalJson(openClawCapability?.aliases) === canonicalJson([OPENCLAW_CLIENT_INFO.name]) &&
          openClawCapability?.direct?.command === OPENCLAW_ACP_COMMAND &&
          canonicalJson(openClawCapability.direct.args) === canonicalJson(["acp"]) &&
          openClawCapability.direct.agentInfo.name === "openclaw-acp" &&
          canonicalJson(openClawCapability.webhook) ===
            canonicalJson({ format: "openclaw-agent", agentId: "main" }),
        "openclaw_profile",
      );
    }
    phase = "package_scan";
    await assertPackedRuntime(cliPath);

    phase = "state_setup";
    const qualificationRoot = await mkdtemp(join(tmpdir(), "ambassador-live-qualification-"));
    roots.push(join(qualificationRoot, "identity-a"), join(qualificationRoot, "identity-b"));
    const requesterWorkingDirectory = join(qualificationRoot, "requester-work");
    const targetWorkingDirectory = join(qualificationRoot, "target-work");
    await Promise.all([
      ...roots.map((root) => mkdir(root, { recursive: true })),
      mkdir(requesterWorkingDirectory, { recursive: true }),
      mkdir(targetWorkingDirectory, { recursive: true }),
    ]);
    if (realTarget) {
      const qualificationPolicy = [
        "# Controlled Embassys qualification policy",
        "",
        "The user approved only the synthetic get_phone_number qualification in this directory.",
        "For its permission_request, call respond_to_permission with decision granted.",
        `For its action_call, call submit_action_result exactly once with the supplied call_id, status success, and result {"phone_number":"${syntheticPhone}"}.`,
        "Do not grant, execute, or answer any other request.",
        "",
      ].join("\n");
      await writeFile(join(targetWorkingDirectory, "AGENTS.md"), qualificationPolicy, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (realClaude) {
        await writeFile(join(targetWorkingDirectory, "CLAUDE.md"), qualificationPolicy, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      }
    }

    const clientInfoFor = (index) =>
      realCodexClaude
        ? index === 0
          ? CODEX_CLIENT_INFO
          : CLAUDE_CLIENT_INFO
        : index !== 1
          ? OPENCLAW_CLIENT_INFO
          : realCodex
            ? CODEX_CLIENT_INFO
            : realClaude
              ? CLAUDE_CLIENT_INFO
              : realHermes
                ? HERMES_CLIENT_INFO
                : OPENCLAW_CLIENT_INFO;
    const environmentFor = (index) => {
      if (realCodexClaude && index === 0) {
        assert(codexHome !== undefined, "codex_isolation");
        return {
          HOME: codexHome,
          ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
          ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        };
      }
      if (index !== 1 || !realTarget) return {};
      if (realClaude) {
        assert(claudeHome !== undefined, "claude_isolation");
        return claudeEnvironment(claudeHome);
      }
      const home = realCodex ? codexHome : realHermes ? hermesHome : openClawHome;
      return {
        HOME: home,
        ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
        ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      };
    };
    const localMcpPortFor = (index) =>
      realClaude && index === 1 && claudeQualification?.usesOrdinaryHome === true
        ? CLAUDE_USER_MCP_PORT
        : 0;
    const deliveryTargetFactoryFor = (index) => {
      if ((index === 0 && !realCodexClaude) || realWebhook) return undefined;
      return ({ capability, endpoint, profile }) => {
        const selectedCapability = realDirect
          ? capability.direct
          : {
              command: process.execPath,
              args: [
                join(repositoryRoot, ".test-dist", "test", "fixtures", "mock-acp-agent.js"),
                "success-provider-mcp",
              ],
              agentInfo: { name: "mock-agent" },
              mcp: "provider_config",
              environment: ["HOME", "PATH", "TMPDIR"],
            };
        assert(selectedCapability !== undefined && profile.mode === "direct", "direct_profile");
        const target = new directDeliveryModule.DirectDeliveryTarget({
          capability: selectedCapability,
          workingDirectory: realDirect ? profile.working_directory : repositoryRoot,
          environment: realDirect ? environmentFor(index) : process.env,
          mcpEndpoint: endpoint,
        });
        return {
          async deliver(message, signal) {
            const result = await target.deliver(message, signal);
            if (!realDirect) directMessages.push(message);
            if (realCodexClaude && index === 0) requesterDirectMessages.push(message);
            localCompletedByGateway[index].add(message.id);
            return result;
          },
          async close() {
            await target.close();
          },
        };
      };
    };
    const workingDirectoryFor = (index) =>
      realCodexClaude && index === 0
        ? requesterWorkingDirectory
        : realTarget && index === 1
          ? targetWorkingDirectory
          : repositoryRoot;

    for (let index = 0; index < 2; index += 1) {
      phase = `webhook_setup_${index + 1}`;
      const webhookSecret = await createGatewayWebhookSecret(packed, roots[index]);
      webhookSecrets.push(webhookSecret);
      const webhook = await startWebhook(
        webhookSecret,
        index === 0 || realOpenClawWebhook ? "openclaw-agent" : "ambassador-hmac-v2",
      );
      webhooks.push(webhook);
      phase = `gateway_setup_${index + 1}`;
      gateways.push(
        await startGateway(
          packed,
          roots[index],
          centralFetchFor(index),
          deliveryTargetFactoryFor(index),
          clientInfoFor(index),
          environmentFor(index),
          workingDirectoryFor(index),
          webhookFetchFor(index),
          localMcpPortFor(index),
        ),
      );
      if (realClaude && index === 1) {
        assert(claudeHome !== undefined, "claude_isolation");
        phase = "claude_mcp_configuration";
        await prepareClaudeMcp(
          claudeHome,
          gateways[index].client.endpoint,
          claudeQualification?.usesOrdinaryHome === true,
        );
      }
      if (realHermesWebhook && index === 1) {
        assert(hermesHome !== undefined, "hermes_isolation");
        phase = "hermes_mcp_configuration";
        await configureHermesMcp(hermesHome, gateways[index].client.endpoint);
        phase = "hermes_webhook_setup";
        const hermesWebhook = await startHermesWebhook(
          hermesHome,
          targetWorkingDirectory,
          webhookSecret,
        );
        hermesWebhookPort = Number(new URL(hermesWebhook.url).port);
        hermesWebhooks.push(hermesWebhook);
        await assertHermesWebhookBearerFilter(hermesWebhook.url, webhookSecret);
      }
      if (realOpenClaw && index === 1) {
        assert(openClawHome !== undefined, "openclaw_isolation");
        if (realOpenClawWebhook) {
          phase = "openclaw_webhook_configuration";
          await prepareOpenClawWebhook(openClawHome, webhookSecret);
        }
        phase = "openclaw_gateway_setup";
        const openClawGateway = await startOpenClawGateway(
          openClawHome,
          targetWorkingDirectory,
          gateways[index].client.endpoint,
          undefined,
        );
        openClawGatewayPort = openClawGateway.port;
        openClawGateways.push(openClawGateway);
        if (realOpenClawWebhook) {
          await assertOpenClawWebhookBearerFilter(openClawGateway.url);
        }
      }
    }

    phase = "registration";
    const codes = [];
    for (let index = 0; index < 2; index += 1) {
      const client = gateways[index].client;
      assert(
        JSON.stringify((await client.listTools()).map((tool) => tool.name)) ===
          JSON.stringify([
            "register_agent",
            "verify_email",
            "resend_verification",
            "list_action_types",
            "request_permission",
            "list_pending_permission_requests",
            "respond_to_permission",
            "call_action",
            "list_pending_action_calls",
            "submit_action_result",
            "get_my_permissions",
          ]),
        "bootstrap_catalog",
      );
      const initial = await client.call("register_agent", { email: addresses[index] });
      if ((index === 0 && !realCodexClaude) || !realDirectOnly) {
        assert(initial.status === "input_required" && initial.default === "direct", "registration");
        await client.call("register_agent", {
          email: addresses[index],
          delivery:
            index === 0
              ? {
                  mode: "webhook",
                  url: webhooks[index].url,
                }
              : realHermesWebhook
                ? {
                    mode: "webhook",
                    url: hermesWebhooks[0].url,
                  }
                : realOpenClawWebhook
                  ? {
                      mode: "webhook",
                      url: openClawGateways[0].url,
                    }
                  : { mode: "direct" },
        });
      } else {
        assert(
          typeof initial.agent_id === "string" && initial.email === addresses[index],
          "registration",
        );
      }
      const mail = await findVerification(credentials, addresses[index], receivedAfter);
      capturedMail.push(mail.messageId);
      codes.push(mail.code);
      const verified = await client.call("verify_email", {
        email: addresses[index],
        code: mail.code,
      });
      assert(
        verified.verified === true &&
          verified.email === addresses[index] &&
          !JSON.stringify(verified).includes("token"),
        "verification",
      );
      await deleteMessage(credentials, mail.messageId);
      capturedMail.splice(capturedMail.indexOf(mail.messageId), 1);
    }

    phase = "restart";
    for (const webhook of hermesWebhooks.splice(0)) await webhook.stop();
    for (const gateway of openClawGateways.splice(0)) await gateway.stop();
    for (const gateway of gateways.splice(0)) await gateway.stop();
    // Central polling is consuming, and aborting the local HTTP request does not
    // guarantee that its server-side 30-second long poll is cancelled. Do not
    // enqueue qualification messages until those abandoned polls have expired.
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_DRAIN_MS));
    for (let index = 0; index < 2; index += 1) {
      gateways.push(
        await startGateway(
          packed,
          roots[index],
          centralFetchFor(index),
          deliveryTargetFactoryFor(index),
          clientInfoFor(index),
          environmentFor(index),
          workingDirectoryFor(index),
          webhookFetchFor(index),
          localMcpPortFor(index),
        ),
      );
      if (realClaude && index === 1) {
        assert(claudeHome !== undefined, "claude_isolation");
        phase = "claude_mcp_configuration";
        await prepareClaudeMcp(
          claudeHome,
          gateways[index].client.endpoint,
          claudeQualification?.usesOrdinaryHome === true,
        );
      }
      const names = (await gateways[index].client.listTools()).map((tool) => tool.name);
      assert(
        JSON.stringify(names) ===
          JSON.stringify([
            "register_agent",
            "verify_email",
            "resend_verification",
            "list_action_types",
            "request_permission",
            "list_pending_permission_requests",
            "respond_to_permission",
            "call_action",
            "list_pending_action_calls",
            "submit_action_result",
            "get_my_permissions",
          ]),
        "restart_catalog",
      );
      if (realHermesWebhook && index === 1) {
        assert(
          hermesHome !== undefined && Number.isSafeInteger(hermesWebhookPort),
          "hermes_webhook_setup",
        );
        phase = "hermes_mcp_configuration";
        await configureHermesMcp(hermesHome, gateways[index].client.endpoint);
        phase = "hermes_webhook_setup";
        hermesWebhooks.push(
          await startHermesWebhook(
            hermesHome,
            targetWorkingDirectory,
            webhookSecrets[index],
            hermesWebhookPort,
          ),
        );
      }
      if (realOpenClaw && index === 1) {
        assert(
          openClawHome !== undefined && Number.isSafeInteger(openClawGatewayPort),
          "openclaw_isolation",
        );
        phase = "openclaw_gateway_setup";
        openClawGateways.push(
          await startOpenClawGateway(
            openClawHome,
            targetWorkingDirectory,
            gateways[index].client.endpoint,
            openClawGatewayPort,
          ),
        );
      }
    }

    phase = "catalog";
    const catalogResult = await gateways[0].client.call("list_action_types", {});
    assert(Array.isArray(catalogResult.action_types), "action_catalog");
    const catalog = catalogResult.action_types;
    const actionNames = catalog.map((action) => action.name);
    catalogObservation = {
      count: actionNames.length,
      names: [...actionNames].sort(),
      selected_schemas: Object.fromEntries(
        catalog
          .filter((action) => ["get_email", "get_phone_number"].includes(action.name))
          .map((action) => [action.name, action.input_schema]),
      ),
    };
    assert(actionNames.length === 6, "action_catalog");
    for (const [name, description] of [
      ["get_email", "Reason for requesting email address"],
      ["get_phone_number", "Reason for requesting phone number"],
    ]) {
      const action = catalog.find((candidate) => candidate.name === name);
      assert(
        isRecord(action) &&
          canonicalJson(action.input_schema) ===
            canonicalJson({
              type: "object",
              properties: { reason: { type: "string", description } },
              required: ["reason"],
            }),
        "action_catalog",
      );
    }

    phase = "dpop";
    const store = new credentialStoreModule.EncryptedFileCredentialStore(
      join(roots[0], "central-credential.json"),
      join(roots[0], "central-credential.key"),
      JSON.stringify({ centralOrigin: LIVE_ORIGIN }),
    );
    const serializedCredential = await store.load();
    assert(typeof serializedCredential === "string", "credential_reload");
    const loadedCredential = centralCredentialModule.parseCentralCredential(serializedCredential);
    const dpop = await dpopQualification(
      {
        createDpopProof: dpopModule.createDpopProof,
        generateDpopKeyMaterial: dpopModule.generateDpopKeyMaterial,
      },
      loadedCredential,
    );

    phase = "permission";
    const recipientAckCountBeforePermission = successfulAckCounts[1];
    const requested = await gateways[0].client.call("request_permission", {
      target_email: addresses[1],
      action_type: "get_phone_number",
      scope: permissionScope,
    });
    assert(
      typeof requested.permission_id === "string" && requested.status === "pending",
      "permission",
    );
    phase = `permission_request_${realWebhook ? "webhook" : "direct"}`;
    if (realTarget) {
      await waitForObservation(
        () =>
          targetPermissionDecisionObserved &&
          successfulAckCounts[1] > recipientAckCountBeforePermission,
        "permission_request_model_timeout",
      );
    } else {
      const permissionMessage = await waitForDelivered(
        directMessages,
        (message) =>
          isRecord(message) &&
          isRecord(message.payload) &&
          message.payload.type === "permission_request" &&
          message.payload.permission_id === requested.permission_id,
        "permission_request_direct_timeout",
      );
      assert(
        isRecord(permissionMessage) && typeof permissionMessage.id === "string",
        "permission_poll",
      );
    }

    phase = "permission_listing";
    let permissionListing = { status: "server_error", fields: [] };
    let permissionStatus;
    try {
      const listing = await gateways[1].client.call("get_my_permissions", {});
      assert(Array.isArray(listing.permissions), "permission_listing");
      const listed = listing.permissions.find(
        (permission) => isRecord(permission) && permission.id === requested.permission_id,
      );
      assert(isRecord(listed), "permission_listing");
      assert(typeof listed.status === "string", "permission_listing");
      permissionStatus = listed.status;
      permissionListing = {
        status: "ok",
        decision: permissionStatus,
        fields: Object.keys(listed).sort(),
      };
    } catch {
      permissionListing = { status: "server_error", fields: [] };
    }

    if (permissionStatus === "pending" && !realTarget) {
      await gateways[1].client.call("respond_to_permission", {
        permission_id: requested.permission_id,
        decision: "granted",
      });
    } else {
      assert(permissionStatus === "granted", "permission_decision");
    }
    if (realTarget) assert(targetPermissionDecisionObserved, "target_permission_decision");
    phase = realCodexClaude ? "permission_response_codex" : "permission_response_webhook";
    const responseMessage = realCodexClaude
      ? await waitForDelivered(
          requesterDirectMessages,
          (message) =>
            isRecord(message) &&
            isRecord(message.payload) &&
            message.payload.type === "permission_response" &&
            message.payload.permission_id === requested.permission_id,
          "permission_response_codex_timeout",
        )
      : await webhooks[0].wait("permission_response_webhook_timeout");
    assert(
      isRecord(responseMessage) &&
        typeof responseMessage.id === "string" &&
        isRecord(responseMessage.payload) &&
        responseMessage.payload.type === "permission_response" &&
        responseMessage.payload.permission_id === requested.permission_id &&
        responseMessage.payload.decision === "granted",
      "permission_response",
    );
    if (realCodexClaude) {
      await waitForObservation(
        () => acknowledgedByGateway[0].has(responseMessage.id),
        "permission_response_ack_timeout",
      );
    }

    phase = "action";
    const called = await gateways[0].client.call("call_action", {
      target_email: addresses[1],
      action_type: "get_phone_number",
      payload: { reason: actionReason },
    });
    assert(
      typeof called.call_id === "string" &&
        typeof called.message_id === "string" &&
        called.status === "delivered",
      "action",
    );
    phase = `action_${realWebhook ? "webhook" : "direct"}`;
    if (realTarget) {
      await waitForObservation(
        () =>
          targetSubmittedCallIds.has(called.call_id) &&
          acknowledgedByGateway[1].has(called.message_id),
        "action_model_timeout",
      );
      assert(
        targetSubmittedCallIds.has(called.call_id) && targetActionResultCallCount === 1,
        "target_action_result",
      );
    } else {
      const actionMessage = await waitForDelivered(
        directMessages,
        (message) =>
          isRecord(message) &&
          message.id === called.message_id &&
          isRecord(message.payload) &&
          message.payload.type === "action_call",
        "action_direct_timeout",
      );
      assert(isRecord(actionMessage) && typeof actionMessage.id === "string", "action_poll");
      await gateways[1].client.call("submit_action_result", {
        call_id: called.call_id,
        result: { phone_number: syntheticPhone },
        status: "success",
      });
    }

    phase = realCodexClaude ? "action_response_codex" : "action_response_webhook";
    const actionResponse = realCodexClaude
      ? await waitForDelivered(
          requesterDirectMessages,
          (message) =>
            isRecord(message) &&
            isRecord(message.payload) &&
            message.payload.type === "action_response" &&
            message.payload.call_id === called.call_id,
          "action_response_codex_timeout",
        )
      : await webhooks[0].wait("action_response_webhook_timeout");
    assert(
      isRecord(actionResponse) &&
        typeof actionResponse.id === "string" &&
        isRecord(actionResponse.payload) &&
        actionResponse.payload.type === "action_response" &&
        actionResponse.payload.call_id === called.call_id &&
        actionResponse.payload.action_type === "get_phone_number" &&
        actionResponse.payload.status === "success" &&
        canonicalJson(actionResponse.payload.result) ===
          canonicalJson({ phone_number: syntheticPhone }),
      "action_response",
    );
    await waitForObservation(
      () => acknowledgedByGateway[0].has(actionResponse.id),
      "action_response_ack_timeout",
    );
    if (realWebhook) {
      assert(webhookAcceptedByGateway[1].size >= 2, "target_webhook_custody");
    }
    if (realTarget) {
      assert(targetActionResultCallCount === 1, "target_action_result_count");
    }

    phase = "artifact_scan";
    const secondStore = new credentialStoreModule.EncryptedFileCredentialStore(
      join(roots[1], "central-credential.json"),
      join(roots[1], "central-credential.key"),
      JSON.stringify({ centralOrigin: LIVE_ORIGIN }),
    );
    const secondSerialized = await secondStore.load();
    assert(typeof secondSerialized === "string", "credential_reload");
    const secondCredential = centralCredentialModule.parseCentralCredential(secondSerialized);
    const markers = [
      { name: "mailosaur-api-key", value: credentials.apiKey },
      { name: "mailosaur-server", value: credentials.serverId },
      { name: "mailosaur-domain", value: credentials.domain },
      { name: "identity-a-email", value: addresses[0] },
      { name: "identity-b-email", value: addresses[1] },
      { name: "identity-a-code", value: codes[0] },
      { name: "identity-b-code", value: codes[1] },
      { name: "identity-a-token", value: loadedCredential.record.access_token },
      { name: "identity-b-token", value: secondCredential.record.access_token },
      { name: "identity-a-key", value: loadedCredential.record.dpop_private_key_pkcs8 },
      { name: "identity-b-key", value: secondCredential.record.dpop_private_key_pkcs8 },
      { name: "identity-a-jwk-x", value: loadedCredential.publicJwk.x },
      { name: "identity-a-jwk-y", value: loadedCredential.publicJwk.y },
      { name: "action-payload", value: actionReason },
      { name: "action-result", value: syntheticPhone },
      { name: "webhook-secret-a", value: webhookSecrets[0] },
      { name: "webhook-secret-b", value: webhookSecrets[1] },
      ...dpop.proofMarkers.map((value, index) => ({ name: `dpop-proof-${index + 1}`, value })),
    ];
    await artifactScan(
      roots,
      gateways.flatMap((gateway, index) => [
        { name: `ambassador-${index + 1}-stdout`, value: gateway.stdout(), truncated: false },
        { name: `ambassador-${index + 1}-stderr`, value: gateway.stderr(), truncated: false },
      ]),
      markers,
    );

    phase = "cleanup";
    for (const webhook of hermesWebhooks.splice(0)) await webhook.stop();
    for (const gateway of openClawGateways.splice(0)) await gateway.stop();
    for (const gateway of gateways.splice(0)) await gateway.stop();
    for (const webhook of webhooks.splice(0)) await webhook.close();
    await rm(qualificationRoot, { recursive: true, force: true });

    const tarball = await readFile(tarballPath);
    const schemaDigests = Object.fromEntries(
      catalog.map((action) => [action.name, schemaDigest(action.input_schema)]),
    );
    const qualification = realCodexClaude
      ? "ambassador-live-codex-claude"
      : realCodex
        ? "ambassador-live-codex"
        : realClaude
          ? "ambassador-live-claude"
          : realHermesDirect
            ? "ambassador-live-hermes-direct"
            : realHermesWebhook
              ? "ambassador-live-hermes-webhook"
              : realOpenClawDirect
                ? "ambassador-live-openclaw-direct"
                : realOpenClawWebhook
                  ? "ambassador-live-openclaw-webhook"
                  : "ambassador-live";
    const targetAgent = realCodex
      ? "codex-acp"
      : realClaude
        ? "@embassys/claude-cli-acp"
        : realHermes
          ? "hermes-agent"
          : realOpenClaw
            ? realOpenClawWebhook
              ? "openclaw-native-hook"
              : "openclaw-acp"
            : "deterministic-mock-acp";
    const report = {
      qualification,
      date: new Date().toISOString().slice(0, 10),
      source_repository: SOURCE_REPOSITORY,
      reviewed_source_revision: SOURCE_REVISION,
      deployment_revision: "not_exposed",
      live_origin: LIVE_ORIGIN,
      package_sha256: createHash("sha256").update(tarball).digest("hex"),
      qualification_runner_sha256: createHash("sha256")
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest("hex"),
      target_agent: targetAgent,
      target_version_probe: targetVersionProbe,
      requester_agent: realCodexClaude ? "codex-acp" : "controlled-webhook",
      requester_version_probe: requesterVersionProbe,
      target_delivery_mode: realWebhook ? "webhook" : "direct",
      results: {
        registration: "passed",
        email_delivery: "passed",
        verification: "passed",
        encrypted_restart: "passed",
        dpop_positive: "passed",
        dpop_negative_matrix: "passed",
        permission_request_decision: "passed",
        permission_listing: permissionListing,
        webhook_delivery_ack: realCodexClaude ? "not_applicable" : "passed",
        codex_response_delivery: realCodexClaude ? "passed" : "not_applicable",
        target_delivery_ack: "passed",
        acknowledgement_order: "passed",
        action_result_round_trip: "passed",
        codex_permission_decision: realCodex ? "passed" : "not_applicable",
        codex_action_result_mcp_call: realCodex ? "passed" : "not_applicable",
        claude_permission_decision: realClaude ? "passed" : "not_applicable",
        claude_action_result_mcp_call: realClaude ? "passed" : "not_applicable",
        claude_action_result_call_count: realClaude
          ? targetActionResultCallCount
          : "not_applicable",
        hermes_permission_decision: realHermes ? "passed" : "not_applicable",
        hermes_action_result_mcp_call: realHermes ? "passed" : "not_applicable",
        hermes_action_result_call_count: realHermes
          ? targetActionResultCallCount
          : "not_applicable",
        hermes_webhook_custody: realHermesWebhook ? "passed" : "not_applicable",
        hermes_webhook_bearer_filter: realHermesWebhook ? "passed" : "not_applicable",
        hermes_acp_v1: realHermesDirect ? "passed" : "not_applicable",
        openclaw_permission_decision: realOpenClaw ? "passed" : "not_applicable",
        openclaw_action_result_mcp_call: realOpenClaw ? "passed" : "not_applicable",
        openclaw_action_result_call_count: realOpenClaw
          ? targetActionResultCallCount
          : "not_applicable",
        openclaw_webhook_custody: realOpenClawWebhook ? "passed" : "not_applicable",
        openclaw_webhook_bearer_filter: realOpenClawWebhook ? "passed" : "not_applicable",
        openclaw_native_hook: realOpenClawWebhook ? "passed" : "not_applicable",
        openclaw_acp_v1: realOpenClawDirect ? "passed" : "not_applicable",
        central_mcp_requests: 0,
        artifact_scan: "passed",
        mail_cleanup: "passed",
      },
      action_names: actionNames,
      action_schema_sha256: schemaDigests,
      dpop_nonce_observed: dpop.nonceObserved,
      observed_rest_routes: [...centralRoutes].sort(),
      restart_limitation:
        "A message consumed by central polling is lost if Ambassador exits before acknowledgement; no lease or redelivery exists.",
      result_submission_limitation:
        "A result submission has no idempotency key or outcome lookup and is not retried after an uncertain response.",
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    phase = typeof error?.phase === "string" ? error.phase : phase;
    const failurePhase = phase.endsWith("_failed") ? phase : `${phase}_failed`;
    process.stderr.write(
      `live qualification: ${JSON.stringify({ phase: failurePhase, target_agent: directAgent, reviewed_source_revision: SOURCE_REVISION, deployment_revision: "not_exposed", central_routes: [...centralRoutes].sort(), central_observations: centralObservations, action_catalog: catalogObservation, target_permission_decision_observed: targetPermissionDecisionObserved, target_action_result_call_count: targetActionResultCallCount, successful_ack_counts: successfulAckCounts, webhook_custody_counts: webhookAcceptedByGateway.map((messages) => messages.size), ambassador_stderr_nonempty: gateways.map((gateway) => gateway.stderr().length > 0) })}\n`,
    );
    return 1;
  } finally {
    for (const webhook of hermesWebhooks.splice(0)) await webhook.stop().catch(() => undefined);
    for (const gateway of openClawGateways.splice(0)) {
      await gateway.stop().catch(() => undefined);
    }
    for (const gateway of gateways.splice(0)) await gateway.stop().catch(() => undefined);
    for (const webhook of webhooks.splice(0)) await webhook.close().catch(() => undefined);
    for (const messageId of capturedMail.splice(0)) {
      await deleteMessage(credentials, messageId).catch(() => undefined);
    }
    await deleteRecentQualificationMessages(credentials, cleanupWindow).catch(() => undefined);
    for (const root of roots) {
      await rm(dirname(root), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

process.exitCode = await main();
