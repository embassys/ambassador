#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const SOURCE_REPOSITORY = "https://github.com/embassys/agent2agent";
const LIVE_ORIGIN = "https://mcp.embassys.ai";
const KEYCHAIN_SERVICE = "ai.embassys.ambassador.development.mailosaur";
const CONFIRMATION = "run-live-qualification-with-two-disposable-mailosaur-identities";
const MAX_CAPTURE_BYTES = 256 * 1024;
const WEBHOOK_WAIT_MS = 90_000;
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

  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.authorization = `Bearer ${token}`;
  }

  async initialize() {
    await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "openclaw-bundle-mcp", version: "0.0.0" },
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
      authorization: this.authorization,
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

async function startWebhook(token) {
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
      const timestamp = request.headers["x-webhook-timestamp"];
      const expected =
        typeof timestamp === "string"
          ? createHmac("sha256", token).update(timestamp).update(".").update(body).digest("hex")
          : "";
      valid =
        valid &&
        request.method === "POST" &&
        request.url === "/hooks/agent" &&
        request.headers.authorization === `Bearer ${token}` &&
        request.headers["x-webhook-signature-v2"] === expected &&
        isRecord(parsed) &&
        typeof parsed.sender_agent_id === "string" &&
        isRecord(parsed.payload) &&
        typeof parsed.created_at === "string";
      response.writeHead(valid ? 200 : 400, { "content-type": "application/json" });
      response.end(valid ? '{"ok":true}' : '{"ok":false}');
      if (!valid) return;
      const waiter = waiters.shift();
      if (waiter === undefined) wakes.push(parsed);
      else {
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
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

async function startGateway(packed, stateRoot, centralFetch, token, deliveryTargetFactory) {
  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
  const running = packed.runCli(["start", "--local-token-env=LIVE_QUALIFICATION_LOCAL_TOKEN"], {
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
    env: {
      LIVE_QUALIFICATION_LOCAL_TOKEN: token,
      LIVE_QUALIFICATION_WEBHOOK_SECRET: token,
    },
    cwd: repositoryRoot,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: LIVE_ORIGIN,
      stateRoot,
      localMcpPort: 0,
      centralFetch,
      ...(deliveryTargetFactory === undefined ? {} : { deliveryTargetFactory }),
    },
  });
  const endpoint = await waitForEndpoint(() => stdout);
  const client = new QualificationMcpClient(endpoint, token);
  await client.initialize();
  return {
    client,
    token,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      controller.abort();
      const result = await running;
      assert(result === 0, "gateway_stop");
    },
  };
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
  if (process.env.AMBASSADOR_CONFIRM_LIVE_QUALIFICATION !== CONFIRMATION) {
    process.stderr.write("live qualification: explicit_confirmation_required\n");
    return 2;
  }
  const cliPath = process.env.AMBASSADOR_PACKED_CLI;
  const tarballPath = process.env.AMBASSADOR_PACKED_TARBALL;
  assert(cliPath !== undefined && tarballPath !== undefined, "package_input");

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
  const actionReason = `synthetic-live-qualification-${randomUUID()}`;
  const capturedMail = [];
  const roots = [];
  const gateways = [];
  const webhooks = [];
  const localTokens = [];
  const centralRoutes = new Set();
  const centralObservations = [];
  const directMessages = [];
  let catalogObservation;
  const centralFetch = async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input);
    assert(target.origin === LIVE_ORIGIN && target.pathname.startsWith("/api/"), "central_route");
    assert(target.pathname !== "/mcp", "central_route");
    centralRoutes.add(`${init?.method ?? "GET"} ${target.pathname}`);
    const response = await fetch(input, init);
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
    assert(typeof packed.runCli === "function", "package_input");
    phase = "package_scan";
    await assertPackedRuntime(cliPath);

    phase = "state_setup";
    const qualificationRoot = await mkdtemp(join(tmpdir(), "ambassador-live-qualification-"));
    roots.push(join(qualificationRoot, "identity-a"), join(qualificationRoot, "identity-b"));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));

    for (let index = 0; index < 2; index += 1) {
      phase = `webhook_setup_${index + 1}`;
      const token = randomBytes(24).toString("hex");
      localTokens.push(token);
      const webhook = await startWebhook(token);
      webhooks.push(webhook);
      phase = `gateway_setup_${index + 1}`;
      const deliveryTargetFactory =
        index === 0
          ? undefined
          : ({ endpoint }) => {
              const target = new directDeliveryModule.DirectDeliveryTarget({
                capability: {
                  command: process.execPath,
                  args: [
                    join(repositoryRoot, ".test-dist", "test", "fixtures", "mock-acp-agent.js"),
                    "success-provider-mcp",
                  ],
                  agentInfo: { name: "mock-agent", versions: ["1.0.0"] },
                  mcp: "provider_config",
                  environment: ["HOME", "PATH", "TMPDIR"],
                },
                workingDirectory: repositoryRoot,
                environment: process.env,
                mcpEndpoint: endpoint,
                localToken: token,
              });
              return {
                async deliver(message, signal) {
                  const result = await target.deliver(message, signal);
                  directMessages.push(message);
                  return result;
                },
                async close() {
                  await target.close();
                },
              };
            };
      gateways.push(
        await startGateway(packed, roots[index], centralFetch, token, deliveryTargetFactory),
      );
    }

    phase = "registration";
    const codes = [];
    for (let index = 0; index < 2; index += 1) {
      const client = gateways[index].client;
      assert(
        JSON.stringify((await client.listTools()).map((tool) => tool.name)) ===
          JSON.stringify(["register_agent", "verify_email", "resend_verification"]),
        "bootstrap_catalog",
      );
      const initial = await client.call("register_agent", { email: addresses[index] });
      assert(initial.status === "input_required" && initial.default === "direct", "registration");
      await client.call("register_agent", {
        email: addresses[index],
        delivery:
          index === 0
            ? {
                mode: "webhook",
                url: webhooks[index].url,
                secret_env: "LIVE_QUALIFICATION_WEBHOOK_SECRET",
              }
            : { mode: "direct" },
      });
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
    for (const gateway of gateways.splice(0)) await gateway.stop();
    for (let index = 0; index < 2; index += 1) {
      gateways.push(
        await startGateway(
          packed,
          roots[index],
          centralFetch,
          localTokens[index],
          index === 0
            ? undefined
            : ({ endpoint }) => {
                const target = new directDeliveryModule.DirectDeliveryTarget({
                  capability: {
                    command: process.execPath,
                    args: [
                      join(repositoryRoot, ".test-dist", "test", "fixtures", "mock-acp-agent.js"),
                      "success-provider-mcp",
                    ],
                    agentInfo: { name: "mock-agent", versions: ["1.0.0"] },
                    mcp: "provider_config",
                    environment: ["HOME", "PATH", "TMPDIR"],
                  },
                  workingDirectory: repositoryRoot,
                  environment: process.env,
                  mcpEndpoint: endpoint,
                  localToken: localTokens[index],
                });
                return {
                  async deliver(message, signal) {
                    const result = await target.deliver(message, signal);
                    directMessages.push(message);
                    return result;
                  },
                  async close() {
                    await target.close();
                  },
                };
              },
        ),
      );
      const names = (await gateways[index].client.listTools()).map((tool) => tool.name);
      assert(
        JSON.stringify(names) ===
          JSON.stringify([
            "list_action_types",
            "request_permission",
            "respond_to_permission",
            "call_action",
            "get_my_permissions",
          ]),
        "restart_catalog",
      );
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
      gateways[0].token,
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
    const requested = await gateways[0].client.call("request_permission", {
      target_email: addresses[1],
      action_type: "get_email",
    });
    assert(
      typeof requested.permission_id === "string" && requested.status === "pending",
      "permission",
    );
    phase = "permission_request_direct";
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

    phase = "permission_listing";
    let permissionListing = { status: "server_error", fields: [] };
    try {
      const listing = await gateways[1].client.call("get_my_permissions", {});
      assert(Array.isArray(listing.permissions), "permission_listing");
      const listed = listing.permissions.find(
        (permission) => isRecord(permission) && permission.id === requested.permission_id,
      );
      assert(isRecord(listed), "permission_listing");
      permissionListing = { status: "ok", fields: Object.keys(listed).sort() };
    } catch {
      permissionListing = { status: "server_error", fields: [] };
    }

    await gateways[1].client.call("respond_to_permission", {
      permission_id: requested.permission_id,
      decision: "granted",
    });
    phase = "permission_response_webhook";
    const responseMessage = await webhooks[0].wait("permission_response_webhook_timeout");
    assert(
      isRecord(responseMessage) &&
        typeof responseMessage.id === "string" &&
        isRecord(responseMessage.payload) &&
        responseMessage.payload.type === "permission_response" &&
        responseMessage.payload.permission_id === requested.permission_id,
      "permission_response",
    );

    phase = "action";
    const called = await gateways[0].client.call("call_action", {
      target_email: addresses[1],
      action_type: "get_email",
      payload: { reason: actionReason },
    });
    assert(typeof called.message_id === "string" && called.status === "delivered", "action");
    phase = "action_direct";
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

    phase = "artifact_scan";
    const secondStore = new credentialStoreModule.EncryptedFileCredentialStore(
      join(roots[1], "central-credential.json"),
      gateways[1].token,
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
      { name: "local-token-a", value: gateways[0].token },
      { name: "local-token-b", value: gateways[1].token },
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
    for (const gateway of gateways.splice(0)) await gateway.stop();
    for (const webhook of webhooks.splice(0)) await webhook.close();
    await rm(qualificationRoot, { recursive: true, force: true });

    const tarball = await readFile(tarballPath);
    const schemaDigests = Object.fromEntries(
      catalog.map((action) => [action.name, schemaDigest(action.input_schema)]),
    );
    const report = {
      qualification: "ambassador-live",
      date: new Date().toISOString().slice(0, 10),
      source_repository: SOURCE_REPOSITORY,
      live_origin: LIVE_ORIGIN,
      package_sha256: createHash("sha256").update(tarball).digest("hex"),
      results: {
        registration: "passed",
        email_delivery: "passed",
        verification: "passed",
        encrypted_restart: "passed",
        dpop_positive: "passed",
        dpop_negative_matrix: "passed",
        permission_request_decision: "passed",
        permission_listing: permissionListing,
        webhook_delivery_ack: "passed",
        direct_delivery_ack: "passed",
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
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    phase = typeof error?.phase === "string" ? error.phase : phase;
    const failurePhase = phase.endsWith("_failed") ? phase : `${phase}_failed`;
    process.stderr.write(
      `live qualification: ${JSON.stringify({ phase: failurePhase, central_routes: [...centralRoutes].sort(), central_observations: centralObservations, action_catalog: catalogObservation, ambassador_stderr_nonempty: gateways.map((gateway) => gateway.stderr().length > 0) })}\n`,
    );
    return 1;
  } finally {
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
