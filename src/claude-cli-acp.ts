import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as acp from "@agentclientprotocol/sdk";

const AGENT_NAME = "@embassys/claude-cli-acp";
const MAXIMUM_SESSIONS = 4;
const MAXIMUM_PROMPT_BYTES = 512 * 1024;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const AUTH_DEADLINE_MS = 15_000;
const PROMPT_DEADLINE_MS = 15 * 60 * 1_000;
const ALLOWED_AMBASSADOR_TOOLS = [
  "mcp__ambassador__list_action_types",
  "mcp__ambassador__list_pending_permission_requests",
  "mcp__ambassador__list_pending_action_calls",
  "mcp__ambassador__submit_action_result",
  "mcp__ambassador__get_my_permissions",
].join(",");

type ManagedChild = ChildProcess;
type SpawnClaude = (
  command: string,
  args: readonly string[],
  options: SpawnOptions & { readonly stdio: readonly ["pipe", "pipe", "pipe"] },
) => ManagedChild;

export interface ClaudeCliAcpOptions {
  readonly command?: string;
  readonly commandPrefixArguments?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: SpawnClaude;
  readonly authDeadlineMs?: number;
  readonly promptDeadlineMs?: number;
  readonly maximumOutputBytes?: number;
}

interface BridgeSession {
  readonly cwd: string;
  readonly mcpEndpoint: string;
  active: AbortController | undefined;
}

class ClaudeCliFailure extends Error {}
class ClaudeCliSignedOut extends Error {}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedCommandPart(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.includes("\u0000");
}

function exactAmbassadorEndpoint(servers: readonly acp.McpServer[]): string {
  if (servers.length !== 1) throw new ClaudeCliFailure();
  const server = servers[0];
  if (
    server === undefined ||
    !("type" in server) ||
    server.type !== "http" ||
    server.name !== "ambassador" ||
    server.headers.length !== 0
  ) {
    throw new ClaudeCliFailure();
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new ClaudeCliFailure();
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.pathname !== "/mcp" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ClaudeCliFailure();
  }
  return url.href;
}

function promptText(blocks: readonly acp.ContentBlock[]): string {
  if (blocks.length !== 1 || blocks[0]?.type !== "text") throw new ClaudeCliFailure();
  const value = blocks[0].text;
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAXIMUM_PROMPT_BYTES) {
    throw new ClaudeCliFailure();
  }
  return value;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly input: string;
    readonly signal: AbortSignal;
    readonly maximumOutputBytes: number;
    readonly spawnProcess: SpawnClaude;
  },
): Promise<{ readonly code: number; readonly stdout: string }> {
  let child: ManagedChild;
  try {
    child = options.spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] as const,
    });
  } catch {
    throw new ClaudeCliFailure();
  }
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill("SIGKILL");
    throw new ClaudeCliFailure();
  }

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exceeded = false;
  child.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.from(chunk);
    stdoutBytes += bytes.byteLength;
    if (stdoutBytes > options.maximumOutputBytes) {
      exceeded = true;
      child.kill("SIGKILL");
      return;
    }
    stdout.push(bytes);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > options.maximumOutputBytes) {
      exceeded = true;
      child.kill("SIGKILL");
    }
  });

  const onAbort = (): void => {
    child.kill("SIGTERM");
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  const exited = new Promise<number>((resolveExit, reject) => {
    child.once("error", () => reject(new ClaudeCliFailure()));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  try {
    child.stdin.end(options.input);
    const code = await exited;
    if (options.signal.aborted || exceeded) throw new ClaudeCliFailure();
    return { code, stdout: Buffer.concat(stdout).toString("utf8") };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function deadline(parent: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

function validClaudeResult(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).type === "result" &&
      (parsed as Record<string, unknown>).subtype === "success" &&
      (parsed as Record<string, unknown>).is_error === false
    );
  } catch {
    return false;
  }
}

export async function runClaudeCliAcpStdio(options: ClaudeCliAcpOptions = {}): Promise<void> {
  const command = options.command ?? "claude";
  const prefix = options.commandPrefixArguments ?? [];
  const environment = options.environment ?? process.env;
  const spawnProcess = options.spawnProcess ?? (spawn as SpawnClaude);
  const authDeadlineMs = options.authDeadlineMs ?? AUTH_DEADLINE_MS;
  const promptDeadlineMs = options.promptDeadlineMs ?? PROMPT_DEADLINE_MS;
  const maximumOutputBytes = options.maximumOutputBytes ?? MAXIMUM_OUTPUT_BYTES;
  if (
    !boundedCommandPart(command) ||
    prefix.length > 8 ||
    !prefix.every(boundedCommandPart) ||
    ![authDeadlineMs, promptDeadlineMs, maximumOutputBytes].every(positiveInteger)
  ) {
    throw new ClaudeCliFailure();
  }

  const sessions = new Map<string, BridgeSession>();
  const app = acp
    .agent({ name: "ambassador-claude-cli-bridge" })
    .onRequest(acp.methods.agent.initialize, (context) => {
      if (context.params.protocolVersion !== acp.PROTOCOL_VERSION) throw new ClaudeCliFailure();
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: AGENT_NAME, version: "1" },
        agentCapabilities: { loadSession: false },
        authMethods: [],
      };
    })
    .onRequest(acp.methods.agent.session.new, async (context) => {
      if (sessions.size >= MAXIMUM_SESSIONS || !isAbsolute(context.params.cwd)) {
        throw new ClaudeCliFailure();
      }
      const mcpEndpoint = exactAmbassadorEndpoint(context.params.mcpServers);
      const auth = await runCommand(command, [...prefix, "auth", "status"], {
        cwd: context.params.cwd,
        environment,
        input: "",
        signal: deadline(undefined, authDeadlineMs),
        maximumOutputBytes: 64 * 1024,
        spawnProcess,
      });
      let status: unknown;
      try {
        status = JSON.parse(auth.stdout);
      } catch {
        throw new ClaudeCliFailure();
      }
      if (
        auth.code !== 0 ||
        status === null ||
        typeof status !== "object" ||
        Array.isArray(status) ||
        (status as Record<string, unknown>).loggedIn !== true ||
        (status as Record<string, unknown>).authMethod !== "claude.ai"
      ) {
        throw new ClaudeCliSignedOut();
      }
      const sessionId = randomUUID();
      sessions.set(sessionId, { cwd: context.params.cwd, mcpEndpoint, active: undefined });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const session = sessions.get(context.params.sessionId);
      if (session === undefined || session.active !== undefined) throw new ClaudeCliFailure();
      const prompt = promptText(context.params.prompt);
      const active = new AbortController();
      session.active = active;
      const mcpConfig = JSON.stringify({
        mcpServers: { ambassador: { type: "http", url: session.mcpEndpoint } },
      });
      try {
        const result = await runCommand(
          command,
          [
            ...prefix,
            "--print",
            "--safe-mode",
            "--strict-mcp-config",
            "--mcp-config",
            mcpConfig,
            "--no-session-persistence",
            "--output-format",
            "json",
            "--permission-mode",
            "dontAsk",
            "--permission-prompts",
            "none",
            "--tools",
            "",
            "--allowedTools",
            ALLOWED_AMBASSADOR_TOOLS,
          ],
          {
            cwd: session.cwd,
            environment,
            input: prompt,
            signal: deadline(active.signal, promptDeadlineMs),
            maximumOutputBytes,
            spawnProcess,
          },
        );
        if (result.code !== 0 || !validClaudeResult(result.stdout)) throw new ClaudeCliFailure();
        return { stopReason: "end_turn" };
      } finally {
        session.active = undefined;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (context) => {
      sessions.get(context.params.sessionId)?.active?.abort();
    });

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  await app.connect(stream).closed;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === pathToFileURL(fileURLToPath(import.meta.url)).href
) {
  await runClaudeCliAcpStdio();
}
