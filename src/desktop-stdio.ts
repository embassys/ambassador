import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const DESKTOP_WAIT_GUIDANCE =
  "Wait up to 600 seconds on request_action, request_permission and check by omitting wait_seconds; use a shorter wait only when explicitly requested. The host may disconnect sooner. If that happens, tell the user they can ask to check the same saved request later. A disconnected call cannot receive a later reply. For check, use the saved operation's request_id, not call_id; include its cursor when supplied. Inbox accepts only type, limit and cursor; omit wait_seconds. On a pending reply, explain that no update arrived and the user can ask to check the same request again. Never automatically retry, resubmit, or offer an unsupported resend/nudge. A host timeout does not mean the server crashed or the saved action failed.";

/** Hosts can omit initialization instructions from tool-search context. */
export function desktopRelayTool(tool: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
}) {
  if (tool.name !== "message_box") return tool;
  const schema = structuredClone(tool.inputSchema);
  const help: Record<string, string> = {
    wait_seconds:
      "Omit to wait up to 600 seconds. Use a shorter wait only when explicitly requested. If the host disconnects early, the user can ask to check the same request later. This field applies only to request_action, request_permission and check; omit it for inbox and other types.",
    request_id:
      "For check, use the saved outbound operation's request_id. For new submissions, supply a new UUID. A check uses request_id, never call_id.",
    call_id:
      "The incoming action call ID used for its result or owner input. Do not use this field for check; check needs request_id.",
  };
  const annotate = (node: unknown) => {
    if (!node || typeof node !== "object" || !("properties" in node)) return;
    const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties) return;
    for (const [key, description] of Object.entries(help))
      if (properties[key]) properties[key] = { ...properties[key], description };
  };
  annotate(schema);
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach(annotate);
  return {
    ...tool,
    description: `Embassys agent network: request another person's contact details, coordinate meetings, and check saved requests through this local connector. ${DESKTOP_WAIT_GUIDANCE}\n${tool.description ?? ""}`,
    inputSchema: schema,
  };
}

export function desktopRelayEndpoint(port: string | undefined): URL {
  const value = port ?? "8787";
  if (!/^[1-9][0-9]{3,4}$/u.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error("Use the local Embassys instance port.");
  return new URL(`http://127.0.0.1:${value}/mcp`);
}

/** Foreground transport only. Enrollment and inbound delivery stay with the app. */
export async function openDesktopRelay(options: { port?: string } = {}): Promise<void> {
  const endpoint = desktopRelayEndpoint(options.port);
  const client = new Client({ name: "embassys-desktop-relay", version: "1" });
  const transport = new StreamableHTTPClientTransport(endpoint);
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw error;
  }
  const server = new Server(
    { name: "ambassador", title: "Embassys Ambassador", version: "1" },
    {
      capabilities: { tools: {} },
      supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      instructions: [
        "Embassys is available through this local Ambassador connection. Register or sign in and choose an inbound agent in the Embassys app. This desktop connection observes foreground tool results; it does not provide native push into an idle conversation.",
        `Standalone Claude has host and connection-to-desktop deadlines as short as 60 seconds. ${DESKTOP_WAIT_GUIDANCE}`,
        client.getInstructions(),
      ]
        .filter(Boolean)
        .join("\n"),
    },
  );
  const lifetime = new AbortController();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("end", stop);
    // A legacy HTTP session can outlive its socket. End only this relay's session.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      transport.terminateSession().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(timer);
    await client.close();
    await server.close();
  };
  const stop = () => {
    void close();
  };
  server.setRequestHandler("tools/list", async () => ({
    tools: (await client.listTools()).tools.map(desktopRelayTool) as Tool[],
  }));
  server.setRequestHandler("tools/call", async (request, context) => {
    const progressToken = request.params._meta?.progressToken;
    return client.callTool(
      { name: request.params.name, arguments: request.params.arguments ?? {} },
      {
        signal: AbortSignal.any([context.mcpReq.signal, lifetime.signal]),
        timeout: 650000,
        ...(progressToken === undefined
          ? {}
          : {
              onprogress: async (progress) => {
                if (!lifetime.signal.aborted && !context.mcpReq.signal.aborted)
                  await context.mcpReq
                    .notify({
                      method: "notifications/progress",
                      params: { ...progress, progressToken },
                    })
                    .catch(() => undefined);
              },
            }),
      },
    );
  });
  server.onclose = stop;
  client.onclose = stop;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  void openDesktopRelay({
    ...(process.env.EMBASSYS_MCP_PORT ? { port: process.env.EMBASSYS_MCP_PORT } : {}),
  }).catch(() => {
    process.stderr.write(
      "Embassys could not connect. Start its server and check the configured local port.\n",
    );
    process.exitCode = 1;
  });
}
