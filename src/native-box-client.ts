import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** A native observer can only read saved work or repeat an explicit receipt. */
export class NativeBoxClient {
  readonly #lifetime = new AbortController();
  #connection: Promise<Client> | undefined;
  constructor(readonly endpoint = "http://127.0.0.1:8787/mcp") {}

  #connect(): Promise<Client> {
    this.#lifetime.signal.throwIfAborted();
    if (this.#connection !== undefined) return this.#connection;
    const client = new Client({ name: "ambassador-openclaw-return", version: "1" });
    const connection = client
      .connect(new StreamableHTTPClientTransport(new URL(this.endpoint)), {
        signal: this.#lifetime.signal,
        timeout: 10_000,
      })
      .then(() => {
        this.#lifetime.signal.throwIfAborted();
        return client;
      })
      .catch(async (error: unknown) => {
        if (this.#connection === connection) this.#connection = undefined;
        await client.close();
        throw error;
      });
    this.#connection = connection;
    return connection;
  }

  async call(
    input: Record<string, unknown>,
    callerSignal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (input.type !== "check" && input.type !== "acknowledge")
      throw new Error("Only checks and receipts can use the native observer");
    const signal = AbortSignal.any([callerSignal, this.#lifetime.signal]);
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const connection = this.#connect();
      let client: Client | undefined;
      let result: Awaited<ReturnType<Client["callTool"]>>;
      try {
        client = await connection;
        signal.throwIfAborted();
        result = await client.callTool(
          { name: "message_box", arguments: input },
          { signal, timeout: 650_000 },
        );
      } catch (error) {
        signal.throwIfAborted();
        // A restart invalidates MCP initialization. Reconnect once, sharing the
        // replacement across concurrent observers. Neither operation submits work.
        if (this.#connection === connection) {
          this.#connection = undefined;
          await client?.close();
        }
        if (attempt === 1) throw error;
        continue;
      }
      if (
        result.isError ||
        result.structuredContent === null ||
        typeof result.structuredContent !== "object" ||
        Array.isArray(result.structuredContent)
      )
        throw new Error("Ambassador check failed");
      return result.structuredContent as Record<string, unknown>;
    }
    throw new Error("Ambassador check failed");
  }

  async close(): Promise<void> {
    this.#lifetime.abort(new Error("Native observer is closed"));
    const client = await this.#connection?.catch(() => undefined);
    this.#connection = undefined;
    await client?.close();
  }
}
