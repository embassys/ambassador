import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { secureWindowsArtifact } from "../windows-access-control.js";

export const connectionProvider = z.enum(["claude_code", "openclaw", "codex", "hermes"]);
export const connectionOperation = z.enum(["connect", "repair", "disconnect"]);
export type ConnectionProvider = z.infer<typeof connectionProvider>;
export type ConnectionOperation = z.infer<typeof connectionOperation>;
/** Manual setup remains available while the installed-provider matrix is qualified. */
export function connectionAvailable(platform: string, arch: string): boolean {
  return platform === "darwin" && arch === "arm64";
}
export interface ConnectionDocument {
  read(text: string): unknown;
  edit(text: string, entry: Record<string, unknown> | undefined): string;
}
export interface ConnectionState {
  state: "missing" | "configured" | "conflict" | "unavailable";
  owned: boolean;
  message: string;
  previewId?: string;
}
const ownershipSchema = z.strictObject({
  version: z.literal(1),
  provider: connectionProvider,
  configurationPath: z.string().max(4096),
  port: z.number().int().min(1024).max(65535),
  phase: z.enum(["prepared", "configured", "removed"]),
});
type Ownership = z.infer<typeof ownershipSchema>;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const unavailable: ConnectionState = {
  state: "unavailable",
  owned: false,
  message:
    "The configuration could not be checked. Use the manual instructions or review the provider's settings.",
};
const conflict: ConnectionState = {
  state: "conflict",
  owned: false,
  message:
    "This provider has different connection settings. They were left untouched. Use a separate provider profile for another instance.",
};

export function connectionEntry(
  provider: ConnectionProvider,
  port: number,
): Record<string, unknown> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid port.");
  const url = `http://127.0.0.1:${port}/mcp`;
  if (provider === "codex") return { url, tool_timeout_sec: 660 };
  if (provider === "hermes") return { url, timeout: 660 };
  return provider === "claude_code"
    ? { type: "http", url, timeout: 660000 }
    : { url, transport: "streamable-http", requestTimeoutMs: 660000 };
}
async function readBounded(
  path: string,
  maximum = 4 * 1024 * 1024,
): Promise<{ bytes: Buffer; fingerprint: string }> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1) throw new Error("Invalid configuration.");
    const file = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > maximum ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error("Invalid configuration.");
      const buffer = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maximum) throw new Error("Configuration too large.");
      const bytes = buffer.subarray(0, length);
      return { bytes, fingerprint: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { bytes: Buffer.from("{}"), fingerprint: "absent" };
    throw error;
  }
}

/** Journal contains only our public entry's ownership, never other provider settings. */
export class AgentConnection {
  #preview:
    | {
        id: string;
        port: number;
        operation: ConnectionOperation;
        fingerprint: string;
        ownershipFingerprint: string;
        expires: number;
      }
    | undefined;
  constructor(
    readonly options: {
      provider: ConnectionProvider;
      configurationPath: string;
      ownershipPath: string;
      run: (command: "claude" | "openclaw", args: string[]) => Promise<void>;
      now?: () => number;
      document?: ConnectionDocument | undefined;
    },
  ) {
    if (!isAbsolute(options.configurationPath) || !isAbsolute(options.ownershipPath))
      throw new Error("Invalid configuration location.");
  }
  async #read() {
    const current = await readBounded(this.options.configurationPath);
    const text = current.fingerprint === "absent" ? "" : current.bytes.toString("utf8");
    if (this.options.document)
      return { fingerprint: current.fingerprint, text, entry: this.options.document.read(text) };
    if (["codex", "hermes"].includes(this.options.provider))
      throw new Error("Desktop parser is unavailable.");
    const parsed: unknown = JSON.parse(current.bytes.toString("utf8"));
    if (!record(parsed)) throw new Error("Invalid configuration.");
    const group =
      this.options.provider === "claude_code"
        ? parsed.mcpServers
        : record(parsed.mcp)
          ? parsed.mcp.servers
          : undefined;
    if (group !== undefined && !record(group)) throw new Error("Invalid MCP settings.");
    if (this.options.provider === "openclaw" && parsed.mcp !== undefined && !record(parsed.mcp))
      throw new Error("Invalid MCP settings.");
    return {
      fingerprint: current.fingerprint,
      text,
      entry: record(group) ? group.ambassador : undefined,
    };
  }
  async #ownership() {
    const saved = await readBounded(this.options.ownershipPath, 8192);
    const value =
      saved.fingerprint === "absent"
        ? undefined
        : ownershipSchema.parse(JSON.parse(saved.bytes.toString("utf8")));
    if (
      value &&
      (value.provider !== this.options.provider ||
        value.configurationPath !== this.options.configurationPath)
    )
      throw new Error("Invalid ownership binding.");
    return { value, fingerprint: saved.fingerprint };
  }
  async #save(port: number, phase: Ownership["phase"]) {
    const value = ownershipSchema.parse({
      version: 1,
      provider: this.options.provider,
      configurationPath: this.options.configurationPath,
      port,
      phase,
    });
    await mkdir(dirname(this.options.ownershipPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.ownershipPath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      if (process.platform === "win32") await secureWindowsArtifact(temporary, "file");
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.options.ownershipPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async inspect(port: number): Promise<ConnectionState> {
    const expected = connectionEntry(this.options.provider, port);
    try {
      const current = await this.#read();
      const { value } = await this.#ownership();
      if (value && value.phase !== "removed" && value.port !== port) return conflict;
      const owned = value?.port === port && value.phase !== "removed";
      if (current.entry === undefined)
        return {
          state: "missing",
          owned,
          message: owned
            ? "This app's connection is missing. Repair can restore it."
            : "No Embassys connection is saved in this provider profile.",
        };
      if (!isDeepStrictEqual(current.entry, expected)) return conflict;
      return {
        state: "configured",
        owned,
        message: owned
          ? "Connection saved by Embassys. Reload the provider to use it."
          : "A matching connection already exists. This app does not own it.",
      };
    } catch {
      return unavailable;
    }
  }
  async prepare(operation: ConnectionOperation, port: number): Promise<ConnectionState> {
    this.#preview = undefined;
    const result = await this.inspect(port);
    if (result.state === "conflict" || result.state === "unavailable") return result;
    if (operation === "disconnect" && !result.owned)
      return {
        ...result,
        message: "Only a connection created by this app can be disconnected here.",
      };
    if (operation !== "disconnect" && result.state === "configured") return result;
    if (operation === "repair" && !result.owned)
      return {
        ...result,
        message: "This app has no saved connection to repair. Choose Connect to create one.",
      };
    if (operation === "disconnect" && result.state === "missing") {
      await this.#save(port, "removed");
      return { ...result, owned: false };
    }
    const before = await this.#read();
    if (this.options.document) {
      try {
        this.options.document.edit(
          before.text,
          operation === "disconnect" ? undefined : connectionEntry(this.options.provider, port),
        );
      } catch {
        return unavailable;
      }
    }
    const ownership = await this.#ownership();
    const id = randomUUID();
    this.#preview = {
      id,
      port,
      operation,
      fingerprint: before.fingerprint,
      ownershipFingerprint: ownership.fingerprint,
      expires: (this.options.now ?? Date.now)() + 300000,
    };
    return { ...result, previewId: id };
  }
  async #replaceConfiguration(fingerprint: string, contents: string) {
    if (Buffer.byteLength(contents) > 4 * 1024 * 1024) throw new Error("Configuration too large.");
    const path = this.options.configurationPath;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        if (process.platform === "win32") await secureWindowsArtifact(temporary, "file");
        await file.writeFile(contents);
        await file.sync();
      } finally {
        await file.close();
      }
      if ((await readBounded(path)).fingerprint !== fingerprint)
        throw new Error("Settings changed during setup.");
      if (fingerprint === "absent") await link(temporary, path);
      else await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async apply(id: string): Promise<ConnectionState> {
    const preview = this.#preview;
    if (!preview || preview.id !== id || preview.expires <= (this.options.now ?? Date.now)())
      throw new Error("Review the connection again.");
    this.#preview = undefined;
    const before = await this.#read();
    const ownership = await this.#ownership();
    if (
      before.fingerprint !== preview.fingerprint ||
      ownership.fingerprint !== preview.ownershipFingerprint
    )
      throw new Error("Settings changed during review.");
    const expected = connectionEntry(this.options.provider, preview.port);
    const remove = preview.operation === "disconnect";
    const provider = this.options.provider;
    const args =
      provider === "claude_code"
        ? remove
          ? ["mcp", "remove", "ambassador", "--scope", "user"]
          : ["mcp", "add-json", "--scope", "user", "ambassador", JSON.stringify(expected)]
        : remove
          ? ["mcp", "unset", "ambassador"]
          : [
              "mcp",
              "add",
              "ambassador",
              "--url",
              String(expected.url),
              "--transport",
              "streamable-http",
              "--timeout",
              "660",
              "--no-probe",
            ];
    await this.#save(preview.port, "prepared");
    try {
      if (this.options.document) {
        const updated = this.options.document.edit(before.text, remove ? undefined : expected);
        await this.#replaceConfiguration(before.fingerprint, updated);
      } else await this.options.run(provider === "claude_code" ? "claude" : "openclaw", args);
    } catch {
      /* Reconcile saved state; never replay an uncertain command. */
    }
    const after = await this.#read();
    const succeeded = remove ? after.entry === undefined : isDeepStrictEqual(after.entry, expected);
    if (!succeeded)
      return {
        ...unavailable,
        message:
          "Setup did not reach the expected state. Check the connection before trying again.",
      };
    await this.#save(preview.port, remove ? "removed" : "configured");
    return this.inspect(preview.port);
  }
}

export function runConnectionCommand(
  command: "claude" | "openclaw",
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Setup cancelled."));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
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
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forced);
      signal?.removeEventListener("abort", terminate);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("Provider command unavailable."));
    });
    child.once("exit", (code) => {
      cleanup();
      if (code === 0 && !terminating) resolve();
      else reject(new Error("Provider command did not finish."));
    });
  });
}
