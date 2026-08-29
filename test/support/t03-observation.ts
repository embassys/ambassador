import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { OutgoingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TestContext } from "node:test";

const MAX_OBSERVED_BODY_BYTES = 1024 * 1024;

export interface T03HttpObservation {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody: Buffer;
  readonly responseStatus: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseBody: Buffer;
}

export interface T03ScriptedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawHeaderBytes: number;
  readonly body: Buffer;
  readonly connectionClosed: () => boolean;
  readonly responseFinished: () => boolean;
}

export interface T03ResponsePlan {
  readonly method?: string;
  readonly path?: string;
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string | Uint8Array | ((request: T03ScriptedRequest) => string | Uint8Array);
  readonly waitFor?: Promise<void>;
  readonly drop?: boolean;
  readonly hold?: boolean;
}

export interface T03McpFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface T03JsonRpcResponse {
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: T03McpFailure;
}

function parseMcpResponse(contentType: string | null, body: string): T03JsonRpcResponse {
  let text = body;
  if (contentType?.includes("text/event-stream") === true) {
    const data = body.split(/\r?\n/u).find((line) => line.startsWith("data:"));
    assert.ok(data !== undefined, "local MCP response contained no data event");
    text = data.slice(5).trim();
  }
  const value = JSON.parse(text) as unknown;
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as T03JsonRpcResponse;
}

/** Low-level local MCP observer used when the shared convenience client discards error data. */
export class T03RawMcpClient {
  readonly #endpoint: string;
  readonly #authorization: string;
  #id = 1;
  #sessionId: string | undefined;

  constructor(endpoint: string, bearerToken: string) {
    this.#endpoint = endpoint;
    this.#authorization = `Bearer ${bearerToken}`;
  }

  async initialize(): Promise<void> {
    const initialized = await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "a2a-t03-raw-test", version: "1" },
    });
    assert.ok(initialized.result !== undefined, "local MCP initialization failed");
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, [200, 202, 204]);
  }

  async callToolFailure(name: string, arguments_: Record<string, unknown>): Promise<T03McpFailure> {
    const response = await this.#request("tools/call", { name, arguments: arguments_ });
    assert.ok(response.error !== undefined, "local MCP call unexpectedly succeeded");
    return response.error;
  }

  async listToolsFailure(): Promise<T03McpFailure> {
    const response = await this.#request("tools/list", {});
    assert.ok(response.error !== undefined, "local MCP list unexpectedly succeeded");
    return response.error;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<T03JsonRpcResponse> {
    const id = this.#id;
    this.#id += 1;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, [200]);
    assert.equal(response.id, id, "local MCP response identifier changed");
    return response;
  }

  async #post(message: Record<string, unknown>, statuses: readonly number[]) {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: this.#authorization,
      "content-type": "application/json",
    };
    if (this.#sessionId !== undefined) {
      headers["mcp-session-id"] = this.#sessionId;
      headers["mcp-protocol-version"] = "2025-06-18";
    }
    const response = await fetch(this.#endpoint, {
      method: "POST",
      redirect: "manual",
      headers,
      body: JSON.stringify(message),
    });
    assert.ok(statuses.includes(response.status), "local MCP returned an unexpected status");
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    if (response.status === 202 || response.status === 204) return {};
    return parseMcpResponse(response.headers.get("content-type"), await response.text());
  }
}

function boundedBuffer(value: ArrayBuffer): Buffer {
  const bytes = Buffer.from(value);
  assert.ok(bytes.byteLength <= MAX_OBSERVED_BODY_BYTES, "observed HTTP body exceeded its bound");
  return bytes;
}

function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export function installT03FetchObserver(
  t: TestContext,
  origins: readonly string[],
): { readonly observations: T03HttpObservation[] } {
  const accepted = new Set(origins.map((value) => new URL(value).origin));
  const observations: T03HttpObservation[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!accepted.has(new URL(request.url).origin)) return await original(request);
    const requestBody =
      request.body === null ? Buffer.alloc(0) : boundedBuffer(await request.clone().arrayBuffer());
    let response: Response;
    try {
      response = await original(request);
    } catch (error) {
      observations.push({
        method: request.method,
        url: request.url,
        requestHeaders: headerRecord(request.headers),
        requestBody,
        responseStatus: 0,
        responseHeaders: {},
        responseBody: Buffer.alloc(0),
      });
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    const responseBody =
      response.body === null || contentType.includes("text/event-stream")
        ? Buffer.alloc(0)
        : boundedBuffer(await response.clone().arrayBuffer());
    observations.push({
      method: request.method,
      url: request.url,
      requestHeaders: headerRecord(request.headers),
      requestBody,
      responseStatus: response.status,
      responseHeaders: headerRecord(response.headers),
      responseBody,
    });
    return response;
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { observations };
}

export async function startT03ScriptedCentralApi(
  t: TestContext,
  plans: readonly T03ResponsePlan[],
): Promise<{ readonly url: string; readonly requests: T03ScriptedRequest[] }> {
  const pending = [...plans];
  const requests: T03ScriptedRequest[] = [];
  const server = createServer({ maxHeaderSize: 32 * 1024 }, (request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= MAX_OBSERVED_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        assert.ok(size <= MAX_OBSERVED_BODY_BYTES, "scripted request exceeded its capture bound");
        let closed = false;
        let finished = false;
        request.once("aborted", () => {
          closed = true;
        });
        response.once("close", () => {
          closed = true;
        });
        response.once("finish", () => {
          finished = true;
        });
        const captured: T03ScriptedRequest = {
          method: request.method ?? "",
          path: request.url ?? "",
          headers: { ...request.headers },
          rawHeaderBytes: request.rawHeaders.reduce(
            (total, value, index) =>
              total + Buffer.byteLength(value, "latin1") + (index % 2 === 0 ? 2 : 2),
            0,
          ),
          body: Buffer.concat(chunks, size),
          connectionClosed: () => closed,
          responseFinished: () => finished,
        };
        requests.push(captured);
        const planIndex = pending.findIndex(
          (candidate) =>
            (candidate.method === undefined || candidate.method === captured.method) &&
            (candidate.path === undefined || candidate.path === captured.path.split("?")[0]),
        );
        const plan = planIndex < 0 ? undefined : pending.splice(planIndex, 1)[0];
        if (plan === undefined) {
          response.writeHead(500, {
            "cache-control": "no-store",
            "content-type": "application/json",
          });
          response.end('{"error":{"code":"internal_error"}}');
          return;
        }
        if (plan.drop === true) {
          response.socket?.destroy();
          return;
        }
        await plan.waitFor;
        if (response.destroyed) return;
        const headers: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(plan.headers ?? {})) {
          headers[name] = typeof value === "string" ? value : [...value];
        }
        response.writeHead(plan.status, headers);
        if (plan.hold === true) {
          response.flushHeaders();
          return;
        }
        response.end(typeof plan.body === "function" ? plan.body(captured) : (plan.body ?? ""));
      })().catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

export async function waitForT03Observation(
  predicate: () => boolean,
  maximumTurns = 2_000,
): Promise<void> {
  for (let turn = 0; turn < maximumTurns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("expected gateway observation did not occur within its bound");
}

export async function runT03ArtifactScan(options: {
  readonly artifactRoot: string;
  readonly captures: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly markers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}): Promise<void> {
  const scanner = join(process.cwd(), "scripts", "t02-artifact-scan.mjs");
  const child = spawn(process.execPath, [scanner], {
    cwd: process.cwd(),
    env: {},
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = (stdout + chunk.toString("utf8")).slice(-16_384);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
  });
  child.stdin.end(
    JSON.stringify({
      roots: [options.artifactRoot],
      captures: options.captures,
      markers: options.markers.map((marker) => ({
        name: marker.name,
        encoding: "utf8",
        value: marker.value,
      })),
    }),
  );
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(
    result,
    { code: 0, signal: null },
    `artifact scan failed without exposing marker values; stdout=${stdout.trim()} stderr=${stderr.trim()}`,
  );
}
