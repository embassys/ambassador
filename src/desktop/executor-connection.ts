import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { openClawReturnEndpoint } from "../openclaw-return-endpoint.js";
import {
  type ConnectionDocument,
  type ConnectionProvider,
  readBoundedConfiguration,
} from "./agent-connections.js";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const timeout = z
  .number()
  .int()
  .positive()
  .max(24 * 60 * 60 * 1000)
  .optional();
const connection = {
  url: z.string(),
  enabled: z.literal(true).optional(),
};
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

/** Reads only public MCP bindings. It never edits settings or obtains provider credentials. */
export async function verifyExecutorConnection(options: {
  provider: ConnectionProvider;
  configurationPath: string;
  workingDirectory: string;
  port: number;
  document?: ConnectionDocument | undefined;
}): Promise<boolean> {
  try {
    if (
      !isAbsolute(options.configurationPath) ||
      !isAbsolute(options.workingDirectory) ||
      !Number.isSafeInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535
    )
      return false;
    const cwd = await realpath(options.workingDirectory);
    const current = await readBoundedConfiguration(options.configurationPath);
    if (current.fingerprint === "absent") return false;
    const canonicalConfiguration = await realpath(options.configurationPath);
    const text = current.bytes.toString("utf8");
    let entry: unknown;
    if (options.provider === "codex" || options.provider === "hermes") {
      if (!options.document) return false;
      entry = options.document.read(text);
    } else {
      const parsed: unknown = JSON.parse(text);
      if (!record(parsed)) return false;
      if (options.provider === "openclaw") {
        if (openClawReturnEndpoint(parsed) !== `http://127.0.0.1:${options.port}/mcp`) return false;
        entry = (parsed.mcp as { servers: { ambassador: unknown } }).servers.ambassador;
      } else {
        if (!record(parsed.mcpServers)) return false;
        entry = parsed.mcpServers.ambassador;
        if (record(parsed.projects)) {
          for (const directory of new Set([cwd, options.workingDirectory])) {
            const project = parsed.projects[directory];
            if (record(project)) {
              if (record(project.mcpServers) && project.mcpServers.ambassador !== undefined)
                return false;
              if (
                Array.isArray(project.disabledMcpServers) &&
                project.disabledMcpServers.includes("ambassador")
              )
                return false;
            }
          }
        }
      }
    }
    const validated = shapes[options.provider].parse(entry);
    if (validated.url !== `http://127.0.0.1:${options.port}/mcp`) return false;

    // Project overrides need separate qualification. Never assume the global entry wins.
    if (options.provider === "claude_code" || options.provider === "codex") {
      let path = cwd;
      let bytes = current.bytes.length;
      for (let depth = 0; ; depth++) {
        if (depth >= 32) return false;
        const configuration =
          options.provider === "claude_code"
            ? join(path, ".mcp.json")
            : join(path, ".codex", "config.toml");
        if (configuration !== canonicalConfiguration) {
          const project = await readBoundedConfiguration(configuration);
          bytes += project.bytes.length;
          if (bytes > 8 * 1024 * 1024) return false;
          if (project.fingerprint !== "absent") {
            const content = project.bytes.toString("utf8");
            if (options.provider === "codex") {
              if (options.document?.read(content) !== undefined) return false;
            } else {
              const value: unknown = JSON.parse(content);
              if (!record(value) || (value.mcpServers !== undefined && !record(value.mcpServers)))
                return false;
              if (record(value.mcpServers) && value.mcpServers.ambassador !== undefined)
                return false;
            }
          }
        }
        const parent = dirname(path);
        if (parent === path) break;
        path = parent;
      }
    }
    return true;
  } catch {
    return false;
  }
}
