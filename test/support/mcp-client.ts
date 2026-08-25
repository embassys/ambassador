import assert from "node:assert/strict";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function parseEventStream(body: string): unknown {
  for (const line of body.split(/\r?\n/u)) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice(5).trim()) as unknown;
    }
  }
  throw new Error("MCP event stream contained no data event");
}

function parseResponse(contentType: string | null, body: string): JsonRpcResponse {
  const parsed = contentType?.includes("text/event-stream")
    ? parseEventStream(body)
    : (JSON.parse(body) as unknown);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as JsonRpcResponse;
}

export class TestMcpClient {
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
      clientInfo: { name: "a2a-gateway-test", version: "1" },
    });
    assert.ok(response.result !== undefined, "initialize did not return a result");

    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, [200, 202, 204]);
  }

  async listTools(): Promise<McpTool[]> {
    const response = await this.#request("tools/list", {});
    const result = response.result as { tools?: unknown } | undefined;
    assert.ok(result !== undefined && Array.isArray(result.tools));
    return result.tools as McpTool[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.#request("tools/call", { name, arguments: args });
    const result = response.result as
      | { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> }
      | undefined;
    assert.ok(result !== undefined, `tool ${name} did not return a result`);

    if (
      result.structuredContent !== null &&
      typeof result.structuredContent === "object" &&
      !Array.isArray(result.structuredContent)
    ) {
      return result.structuredContent as Record<string, unknown>;
    }

    const text = result.content?.find((item) => item.type === "text")?.text;
    assert.ok(typeof text === "string", `tool ${name} returned no structured content`);
    const parsed = JSON.parse(text) as unknown;
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
    return parsed as Record<string, unknown>;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.#nextId;
    this.#nextId += 1;
    const { response, parsed } = await this.#post({ jsonrpc: "2.0", id, method, params }, [200]);
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    assert.equal(parsed.id, id);
    if (parsed.error !== undefined) {
      throw new Error(`MCP ${method} failed: ${parsed.error.code} ${parsed.error.message}`);
    }
    return parsed;
  }

  async #post(
    message: Record<string, unknown>,
    acceptedStatuses: number[],
  ): Promise<{ response: Response; parsed: JsonRpcResponse }> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: this.#authorization,
      "content-type": "application/json",
    };
    if (this.#sessionId !== undefined) {
      headers["mcp-session-id"] = this.#sessionId;
    }

    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      redirect: "manual",
    });
    const body = await response.text();
    assert.ok(
      acceptedStatuses.includes(response.status),
      `MCP request returned ${response.status}: ${body}`,
    );

    if (response.status === 202 || response.status === 204) {
      return { response, parsed: { jsonrpc: "2.0" } };
    }

    return { response, parsed: parseResponse(response.headers.get("content-type"), body) };
  }
}
