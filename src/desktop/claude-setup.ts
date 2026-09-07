import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

interface SetupResult {
  readonly state: "available" | "configured" | "conflict" | "unavailable";
  readonly message: string;
  readonly previewId?: string;
}
const maximumBytes = 4 * 1024 * 1024;
const configured: SetupResult = {
  state: "configured",
  message:
    "Connection saved. Reload Claude Code, then check that Embassys appears in its MCP list.",
};
const unavailable: SetupResult = {
  state: "unavailable",
  message:
    "Automatic setup could not verify the configuration. Use the manual instructions or review Claude Code's settings.",
};
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function expectedEntry(port: number) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid instance port.");
  return { type: "http", url: `http://127.0.0.1:${port}/mcp`, timeout: 660000 };
}
function matches(value: unknown, port: number): boolean {
  const expected = expectedEntry(port);
  return (
    object(value) &&
    Object.keys(value).length === 3 &&
    value.type === expected.type &&
    value.url === expected.url &&
    value.timeout === expected.timeout
  );
}

/** Configure the fixed entry through the provider. Never expose its other settings. */
export class ClaudeSetup {
  #preview: { id: string; port: number; fingerprint: string; expires: number } | undefined;
  constructor(
    readonly options: {
      configurationPath: string;
      workingDirectory: string;
      run: (args: string[]) => Promise<void>;
      now?: () => number;
    },
  ) {
    if (!isAbsolute(options.configurationPath) || !isAbsolute(options.workingDirectory))
      throw new Error("Invalid provider configuration location.");
  }
  async #read(): Promise<{ fingerprint: string; entry?: unknown }> {
    try {
      const before = await lstat(this.options.configurationPath);
      if (!before.isFile() || before.nlink !== 1) throw new Error("Invalid configuration file.");
      const file = await open(
        this.options.configurationPath,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > maximumBytes ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("Invalid configuration file.");
        const buffer = Buffer.alloc(maximumBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > maximumBytes) throw new Error("Configuration exceeds the supported limit.");
        const bytes = buffer.subarray(0, length);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers)))
          throw new Error("Invalid provider configuration.");
        return {
          fingerprint: createHash("sha256").update(bytes).digest("hex"),
          entry: object(value.mcpServers) ? value.mcpServers.ambassador : undefined,
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { fingerprint: "absent" };
      throw error;
    }
  }
  async prepare(port: number): Promise<SetupResult> {
    expectedEntry(port);
    this.#preview = undefined;
    try {
      const current = await this.#read();
      if (current.entry !== undefined)
        return matches(current.entry, port)
          ? configured
          : {
              state: "conflict",
              message:
                "Claude Code already has an Ambassador connection with different settings. It was left untouched. Use a separate provider profile for another instance.",
            };
      const id = randomUUID();
      this.#preview = {
        id,
        port,
        fingerprint: current.fingerprint,
        expires: (this.options.now ?? Date.now)() + 300000,
      };
      return {
        state: "available",
        previewId: id,
        message:
          "Add this instance to Claude Code's user configuration, with an eleven-minute tool timeout.",
      };
    } catch {
      return unavailable;
    }
  }
  async apply(id: string): Promise<SetupResult> {
    const preview = this.#preview;
    if (!preview || id !== preview.id || preview.expires <= (this.options.now ?? Date.now)())
      throw new Error("Review the connection again before applying it.");
    this.#preview = undefined;
    const before = await this.#read();
    if (before.fingerprint !== preview.fingerprint || before.entry !== undefined)
      throw new Error("Claude Code's settings changed. Review the connection again.");
    try {
      await this.options.run([
        "mcp",
        "add-json",
        "--scope",
        "user",
        "ambassador",
        JSON.stringify(expectedEntry(preview.port)),
      ]);
    } catch {
      /* Inspect saved state; never replay a command whose response was lost. */
    }
    try {
      return matches((await this.#read()).entry, preview.port) ? configured : unavailable;
    } catch {
      return unavailable;
    }
  }
}

/** No shell, stdin, credential prompts or provider output enters the app. */
export function runClaudeSetup(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Setup was cancelled."));
      return;
    }
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    let forced: ReturnType<typeof setTimeout> | undefined;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const timeout = setTimeout(terminate, 20000);
    signal?.addEventListener("abort", terminate, { once: true });
    child.once("error", () => {
      clearTimeout(timeout);
      clearTimeout(forced);
      signal?.removeEventListener("abort", terminate);
      reject(new Error("Claude Code setup is unavailable."));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      clearTimeout(forced);
      signal?.removeEventListener("abort", terminate);
      if (code === 0 && !terminating) resolve();
      else reject(new Error("Claude Code setup did not complete."));
    });
  });
}
