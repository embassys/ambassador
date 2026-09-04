import assert from "node:assert/strict";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("MCP response contained invalid JSON");
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpCallError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly serverMessage: string;

  constructor(method: string, code: number, serverMessage: string, data?: unknown) {
    super(`MCP ${method} failed with code ${code}: ${serverMessage}`);
    this.name = "McpCallError";
    this.code = code;
    this.serverMessage = serverMessage;
    this.data = data;
  }
}

function parseEventStream(body: string): unknown {
  for (const line of body.split(/\r?\n/u)) {
    if (line.startsWith("data:")) {
      return parseJson(line.slice(5).trim());
    }
  }
  throw new Error("MCP event stream contained no data event");
}

function parseResponse(contentType: string | null, body: string): JsonRpcResponse {
  const parsed = contentType?.includes("text/event-stream")
    ? parseEventStream(body)
    : parseJson(body);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as JsonRpcResponse;
}

export class TestMcpClient {
  readonly #endpoint: string;
  readonly #forbiddenResponseValues: string[];
  #nextId = 1;
  #sessionId: string | undefined;
  serverCapabilities: Record<string, unknown> = {};
  serverInstructions: string | undefined;

  constructor(endpoint: string, options: { forbiddenResponseValues?: string[] } = {}) {
    this.#endpoint = endpoint;
    this.#forbiddenResponseValues = options.forbiddenResponseValues ?? [];
  }

  async initialize(clientInfo = { name: "ambassador-test", version: "1" }): Promise<void> {
    const response = await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo,
    });
    assert.ok(response.result !== undefined, "initialize did not return a result");
    const result = response.result as { capabilities?: unknown; instructions?: unknown };
    assert.ok(
      result.capabilities !== null &&
        typeof result.capabilities === "object" &&
        !Array.isArray(result.capabilities),
    );
    this.serverCapabilities = result.capabilities as Record<string, unknown>;
    this.serverInstructions =
      typeof result.instructions === "string" ? result.instructions : undefined;

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
    const parsed = parseJson(text);
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
    return parsed as Record<string, unknown>;
  }

  async postBatch(messages: Record<string, unknown>[]): Promise<Response> {
    assert.ok(this.#sessionId !== undefined, "MCP client is not initialized");
    return await fetch(this.#endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": this.#sessionId,
      },
      body: JSON.stringify(messages),
      redirect: "manual",
    });
  }

  async waitForNotification(method: string): Promise<void> {
    assert.ok(this.#sessionId !== undefined, "MCP client is not initialized");
    const response = await fetch(this.#endpoint, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": this.#sessionId,
        "mcp-protocol-version": "2025-06-18",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, "MCP notification stream did not open");
    assert.ok(response.body !== null);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) {
          throw new Error("MCP notification stream closed before the expected event");
        }
        buffered += decoder.decode(item.value, { stream: true });
        const events = buffered.split(/\r?\n\r?\n/u);
        buffered = events.pop() ?? "";
        for (const event of events) {
          const data = event
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data === "") {
            continue;
          }
          const parsed = parseJson(data) as { method?: unknown };
          if (parsed.method === method) {
            return;
          }
        }
      }
    } finally {
      await reader.cancel();
    }
  }

  async #request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.#nextId;
    this.#nextId += 1;
    const { response, parsed } = await this.#post({ jsonrpc: "2.0", id, method, params }, [200]);
    this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
    assert.equal(parsed.id, id);
    if (parsed.error !== undefined) {
      throw new McpCallError(method, parsed.error.code, parsed.error.message, parsed.error.data);
    }
    return parsed;
  }

  async #post(
    message: Record<string, unknown>,
    acceptedStatuses: number[],
  ): Promise<{ response: Response; parsed: JsonRpcResponse }> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (this.#sessionId !== undefined) {
      headers["mcp-session-id"] = this.#sessionId;
      headers["mcp-protocol-version"] = "2025-06-18";
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
      `MCP request returned ${response.status}`,
    );
    for (const value of this.#forbiddenResponseValues) {
      assert.ok(!body.includes(value), "MCP response contained forbidden credential bytes");
    }

    if (response.status === 202 || response.status === 204) {
      return { response, parsed: { jsonrpc: "2.0" } };
    }

    return { response, parsed: parseResponse(response.headers.get("content-type"), body) };
  }
}
