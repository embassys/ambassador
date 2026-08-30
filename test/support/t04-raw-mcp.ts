import assert from "node:assert/strict";

export interface T04RawMcpError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly result?: unknown;
  readonly error?: T04RawMcpError;
}

function parseResponse(contentType: string | null, body: string): JsonRpcResponse {
  let source = body;
  if (contentType?.includes("text/event-stream")) {
    const data = body.split(/\r?\n/u).find((line) => line.startsWith("data:"));
    assert.ok(data !== undefined, "MCP event stream contained no data event");
    source = data.slice(5).trim();
  }
  const parsed = JSON.parse(source) as unknown;
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as JsonRpcResponse;
}

export class T04RawMcpClient {
  readonly #endpoint: string;
  readonly #authorization: string;
  #nextId = 1;
  #sessionId: string | undefined;

  constructor(endpoint: string, bearerToken: string) {
    this.#endpoint = endpoint;
    this.#authorization = `Bearer ${bearerToken}`;
  }

  async initialize(): Promise<void> {
    const response = await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "a2a-t04-raw-test", version: "1" },
    });
    assert.ok(response.result !== undefined);
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, [200, 202, 204]);
  }

  async callToolError(name: string, arguments_: Record<string, unknown>): Promise<T04RawMcpError> {
    const response = await this.#request("tools/call", { name, arguments: arguments_ });
    assert.ok(response.error !== undefined, `tool ${name} did not return a JSON-RPC error`);
    return response.error;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.#nextId;
    this.#nextId += 1;
    const { response, parsed } = await this.#post({ jsonrpc: "2.0", id, method, params }, [200]);
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    assert.equal(parsed.id, id);
    return parsed;
  }

  async #post(
    message: Record<string, unknown>,
    acceptedStatuses: readonly number[],
  ): Promise<{ readonly response: Response; readonly parsed: JsonRpcResponse }> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: this.#authorization,
      "content-type": "application/json",
    };
    if (this.#sessionId !== undefined) {
      headers["mcp-protocol-version"] = "2025-06-18";
      headers["mcp-session-id"] = this.#sessionId;
    }
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      redirect: "manual",
    });
    const body = await response.text();
    assert.ok(acceptedStatuses.includes(response.status));
    if (response.status === 202 || response.status === 204) {
      return { response, parsed: { jsonrpc: "2.0" } };
    }
    return { response, parsed: parseResponse(response.headers.get("content-type"), body) };
  }
}
