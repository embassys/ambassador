import { z } from "zod";
import type { ConnectionProvider } from "./agent-connections.js";

const timeout = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60 * 1000)
  .optional();
const connection = { url: z.string(), enabled: z.literal(true).optional() };
const shapes = {
  claude_code: z.strictObject({ ...connection, type: z.literal("http"), timeout }),
  codex: z.strictObject({ ...connection, tool_timeout_sec: timeout, startup_timeout_sec: timeout }),
  hermes: z.strictObject({ ...connection, timeout }),
  openclaw: z.strictObject({
    ...connection,
    transport: z.literal("streamable-http").optional(),
    requestTimeoutMs: timeout,
  }),
};

/** Existing owner settings may omit optional fields; recognition never grants ownership. */
export function matchesConnectionEntry(
  provider: ConnectionProvider,
  entry: unknown,
  port: number,
): boolean {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return false;
  const result = shapes[provider].safeParse(entry);
  return result.success && result.data.url === `http://127.0.0.1:${port}/mcp`;
}
