import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { localNativeEndpoint } from "./openclaw-return-endpoint.js";

/** A native observer can only read saved work or repeat an explicit receipt. */
export class NativeBoxClient {
  readonly #lifetime = new AbortController();
  #connection: Promise<Client> | undefined;
  constructor(readonly endpoint = "http://127.0.0.1:8787/mcp") {
    localNativeEndpoint(endpoint);
  }

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
    for (let attempt = 0; attempt < 3; attempt++) {
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
        // A restart can invalidate the session and leave a pooled socket closed
        // during the next handshake. Allow two bounded reconnects, sharing each
        // replacement across observers. Neither operation submits work.
        if (this.#connection === connection) {
          this.#connection = undefined;
          await client?.close();
        }
        if (attempt === 2) throw error;
        await delay(100 * (attempt + 1), undefined, { signal });
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
