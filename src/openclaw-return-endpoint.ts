import { createHash } from "node:crypto";
import { z } from "zod";

/** Only the owner's literal loopback MCP connection can receive observer calls. */
export function localNativeEndpoint(value: unknown): string {
  const match =
    typeof value === "string"
      ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/u.exec(value)
      : null;
  if (!match || Number(match[1]) > 65535)
    throw new Error("Invalid local MCP endpoint for native return.");
  return value as string;
}

const configuration = z.object({
  mcp: z.object({
    enabled: z.literal(true).optional(),
    servers: z.object({
      ambassador: z.object({
        url: z.string(),
        enabled: z.literal(true).optional(),
        transport: z.literal("streamable-http").optional(),
        command: z.never().optional(),
        args: z.never().optional(),
        headers: z.never().optional(),
      }),
    }),
  }),
});

export function openClawReturnEndpoint(value: unknown): string {
  const parsed = configuration.safeParse(value);
  if (!parsed.success) throw new Error("OpenClaw's local Ambassador connection is unavailable.");
  return localNativeEndpoint(parsed.data.mcp.servers.ambassador.url);
}

/** An endpoint change never attaches saved conversation routes to another instance. */
export function nativeRouteNamespace(endpoint: string): string {
  return createHash("sha256").update(localNativeEndpoint(endpoint)).digest("hex");
}
