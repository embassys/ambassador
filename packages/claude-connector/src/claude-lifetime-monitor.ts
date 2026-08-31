import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

export const CLAUDE_LIFETIME_MONITOR_PROTOCOL = 1;

const RECORD_BYTES = 16_384;
const RECORD_DEPTH = 16;
const RECORD_COUNT = 32;
const TOTAL_BYTES = 65_536;
const PROVIDER_OUTPUT_BYTES = 8_388_608;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FIXED_ARGUMENT_PREFIX = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--replay-user-messages",
  "--safe-mode",
  "--restricted",
  "--permission-mode",
  "dontAsk",
  "--no-chrome",
  "--disable-slash-commands",
  "--tools",
] as const;
const TOOL_CEILINGS = new Set(["Read,Glob,Grep", "Read,Glob,Grep,Edit,Write"]);

type FaultCode =
  | "invalid_control"
  | "spawn_failed"
  | "stream_failed"
  | "containment_failed"
  | "internal_failure";

type MonitorBarrier =
  | "before_monitor_ready"
  | "during_start_record"
  | "before_claude_spawn"
  | "after_claude_spawn"
  | "before_child_started";

interface StartCommand {
  readonly type: "start";
  readonly executable: string;
  readonly arguments: readonly string[];
}

class MonitorProtocolFailure extends Error {}
class InjectedMonitorFault extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

class StrictJsonScanner {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.#space();
    const value = this.#value(0);
    this.#space();
    if (this.#index !== this.source.length) throw new MonitorProtocolFailure();
    return value;
  }

  #space(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.source[this.#index] ?? "")) this.#index += 1;
  }

  #value(depth: number): unknown {
    this.#space();
    const character = this.source[this.#index];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === '"') return this.#string();
    if (this.source.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.source.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.source.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #container(depth: number): void {
    if (depth > RECORD_DEPTH) throw new MonitorProtocolFailure();
  }

  #object(depth: number): Record<string, unknown> {
    this.#container(depth);
    this.#index += 1;
    this.#space();
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      if (this.source[this.#index] !== '"') throw new MonitorProtocolFailure();
      const key = this.#string();
      if (keys.has(key)) throw new MonitorProtocolFailure();
      keys.add(key);
      this.#space();
      if (this.source[this.#index] !== ":") throw new MonitorProtocolFailure();
      this.#index += 1;
      result[key] = this.#value(depth);
      this.#space();
      const delimiter = this.source[this.#index];
      this.#index += 1;
      if (delimiter === "}") return result;
      if (delimiter !== ",") throw new MonitorProtocolFailure();
      this.#space();
    }
  }

  #array(depth: number): unknown[] {
    this.#container(depth);
    this.#index += 1;
    this.#space();
    const result: unknown[] = [];
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    for (;;) {
      result.push(this.#value(depth));
      this.#space();
      const delimiter = this.source[this.#index];
      this.#index += 1;
      if (delimiter === "]") return result;
      if (delimiter !== ",") throw new MonitorProtocolFailure();
      this.#space();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    for (;;) {
      const character = this.source[this.#index];
      if (character === undefined) throw new MonitorProtocolFailure();
      if (character === '"') {
        this.#index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.#index));
        } catch {
          throw new MonitorProtocolFailure();
        }
        if (typeof value !== "string") throw new MonitorProtocolFailure();
        return value;
      }
      if (character === "\\") {
        this.#index += 1;
        const escaped = this.source[this.#index];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(this.#index + 1, this.#index + 5))) {
            throw new MonitorProtocolFailure();
          }
          this.#index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escaped ?? "")) {
          throw new MonitorProtocolFailure();
        }
        this.#index += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw new MonitorProtocolFailure();
      this.#index += 1;
    }
  }

  #number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.source.slice(this.#index),
    );
    if (match === null) throw new MonitorProtocolFailure();
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new MonitorProtocolFailure();
    return value;
  }
}

function parseRecord(bytes: Buffer): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > RECORD_BYTES) throw new MonitorProtocolFailure();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MonitorProtocolFailure();
  }
  const value = new StrictJsonScanner(source).parse();
  if (!isRecord(value)) throw new MonitorProtocolFailure();
  return value;
}

function validArguments(arguments_: readonly unknown[]): arguments_ is readonly string[] {
  if (arguments_.length === 1 && arguments_[0] === "--version") return true;
  if (arguments_.length !== FIXED_ARGUMENT_PREFIX.length + 5) return false;
  if (!FIXED_ARGUMENT_PREFIX.every((value, index) => arguments_[index] === value)) return false;
  const tools = arguments_[FIXED_ARGUMENT_PREFIX.length];
  return (
    typeof tools === "string" &&
    TOOL_CEILINGS.has(tools) &&
    arguments_[FIXED_ARGUMENT_PREFIX.length + 1] === "--disallowedTools" &&
    arguments_[FIXED_ARGUMENT_PREFIX.length + 2] === "mcp__*" &&
    ["--session-id", "--resume"].includes(String(arguments_[FIXED_ARGUMENT_PREFIX.length + 3])) &&
    typeof arguments_[FIXED_ARGUMENT_PREFIX.length + 4] === "string" &&
    SESSION_ID.test(arguments_[FIXED_ARGUMENT_PREFIX.length + 4] as string)
  );
}

function parseStart(value: Record<string, unknown>): StartCommand {
  if (!hasExactKeys(value, ["type", "executable", "arguments"]) || value.type !== "start") {
    throw new MonitorProtocolFailure();
  }
  if (
    typeof value.executable !== "string" ||
    !isAbsolute(value.executable) ||
    !Array.isArray(value.arguments) ||
    !validArguments(value.arguments)
  ) {
    throw new MonitorProtocolFailure();
  }
  const canonicalExecutable = realpathSync(value.executable);
  if (canonicalExecutable !== value.executable) throw new MonitorProtocolFailure();
  return {
    type: "start",
    executable: canonicalExecutable,
    arguments: value.arguments,
  } as StartCommand;
}

interface FaultInjection {
  readonly barrier: MonitorBarrier;
  readonly beforeFault?: () => Promise<void>;
  readonly faultAfterBarrier: boolean;
}

async function runMonitor(faultInjection?: FaultInjection): Promise<never> {
  if (process.platform === "win32" || process.pid <= 0) throw new Error("unsupported monitor host");
  const owner = createReadStream("/dev/null", { fd: 3, autoClose: false });
  const commands = createReadStream("/dev/null", { fd: 4, autoClose: false });
  const lifecycle = createWriteStream("/dev/null", { fd: 5, autoClose: false });
  let sealing = false;
  let started = false;
  let interrupted = false;
  let contained = false;
  let child: ReturnType<typeof spawn> | undefined;
  let providerStdoutBytes = 0;
  let providerStderrBytes = 0;

  const writeLifecycle = async (value: Readonly<Record<string, unknown>>): Promise<void> => {
    const bytes = `${JSON.stringify(value)}\n`;
    await new Promise<void>((resolve, reject) => {
      lifecycle.write(bytes, "utf8", (error) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  };

  const seal = (): void => {
    if (sealing) return;
    sealing = true;
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          void writeLifecycle({ type: "fault", code: "containment_failed" });
        } catch {
          // The lifecycle pipe is untrusted during containment.
        }
      }
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(93);
      }
    }, 1_000);
  };

  const fault = (code: FaultCode): void => {
    if (!sealing) void writeLifecycle({ type: "fault", code }).catch(() => undefined);
    seal();
  };

  const forwardProviderStream = (
    source: Readable,
    destination: Writable,
    channel: "stdout" | "stderr",
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let ended = false;
      let pendingWrites = 0;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reject(new Error("provider stream forwarding failed"));
      };
      const finish = (): void => {
        if (settled || !ended || pendingWrites !== 0) return;
        settled = true;
        resolve();
      };
      source.once("error", fail);
      source.once("end", () => {
        ended = true;
        finish();
      });
      source.once("close", () => {
        if (!source.readableEnded) fail();
      });
      source.on("data", (raw: string | Buffer) => {
        source.pause();
        const chunk = Buffer.from(raw);
        if (channel === "stdout") providerStdoutBytes += chunk.byteLength;
        else providerStderrBytes += chunk.byteLength;
        const total = channel === "stdout" ? providerStdoutBytes : providerStderrBytes;
        if (total > PROVIDER_OUTPUT_BYTES) {
          fail();
          return;
        }
        pendingWrites += 1;
        destination.write(chunk, (error?: Error | null) => {
          pendingWrites -= 1;
          if (error !== undefined && error !== null) {
            fail();
            return;
          }
          source.resume();
          finish();
        });
      });
    });

  const endProviderStream = async (stream: Writable): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  };

  const atBarrier = async (barrier: MonitorBarrier): Promise<void> => {
    if (faultInjection?.barrier !== barrier) return;
    await faultInjection.beforeFault?.();
    if (faultInjection.faultAfterBarrier) throw new InjectedMonitorFault();
  };

  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => undefined);
  process.on("uncaughtException", () => fault("internal_failure"));
  process.on("unhandledRejection", () => fault("internal_failure"));
  owner.once("end", seal);
  owner.once("close", seal);
  owner.once("error", seal);
  commands.once("end", seal);
  commands.once("close", seal);
  commands.once("error", () => fault("invalid_control"));
  lifecycle.once("error", () => seal());
  owner.resume();
  process.stdin.pause();

  const handleStart = async (record: Record<string, unknown>): Promise<void> => {
    await atBarrier("during_start_record");
    if (sealing) return;
    const command = parseStart(record);
    await atBarrier("before_claude_spawn");
    if (sealing) return;
    child = spawn(command.executable, [...command.arguments], {
      cwd: process.cwd(),
      env: process.env,
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.once("error", () => fault("stream_failed"));
    if (child.stdout === null || child.stderr === null) throw new MonitorProtocolFailure();
    const forwarding = Promise.all([
      forwardProviderStream(child.stdout, process.stdout, "stdout"),
      forwardProviderStream(child.stderr, process.stderr, "stderr"),
    ]);
    void forwarding.catch(() => fault("stream_failed"));
    child.once("error", () => fault("spawn_failed"));
    child.once("close", (code, signal) => {
      const signalNumber = signal === null ? null : osConstants.signals[signal];
      void forwarding
        .then(async () => {
          await Promise.all([endProviderStream(process.stdout), endProviderStream(process.stderr)]);
          await writeLifecycle({ type: "child_exited", code, signal: signalNumber });
        })
        .catch(() => fault("stream_failed"));
    });
    await new Promise<void>((resolve, reject) => {
      child?.once("spawn", resolve);
      child?.once("error", reject);
    });
    if (sealing) return;
    await atBarrier("after_claude_spawn");
    if (sealing) return;
    await atBarrier("before_child_started");
    if (sealing) return;
    await writeLifecycle({ type: "child_started" });
    if (sealing) return;
    if (command.arguments.length === 1) child.stdin?.end();
    else {
      process.stdin.pipe(child.stdin ?? process.stdout);
      process.stdin.resume();
    }
  };

  const handleCommand = async (record: Record<string, unknown>): Promise<void> => {
    if (record.type === "start") {
      if (started) throw new MonitorProtocolFailure();
      started = true;
      await handleStart(record);
      return;
    }
    if (record.type === "interrupt") {
      if (!hasExactKeys(record, ["type"]) || !started || interrupted || contained) {
        throw new MonitorProtocolFailure();
      }
      interrupted = true;
      try {
        process.kill(-process.pid, "SIGINT");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    if (record.type === "contain") {
      if (!hasExactKeys(record, ["type"]) || !started || contained) {
        throw new MonitorProtocolFailure();
      }
      contained = true;
      seal();
      return;
    }
    throw new MonitorProtocolFailure();
  };

  let line = Buffer.alloc(0);
  let totalBytes = 0;
  let count = 0;
  let commandChain = Promise.resolve();
  commands.on("data", (raw: string | Buffer) => {
    if (sealing) return;
    const chunk = Buffer.from(raw);
    totalBytes += chunk.byteLength;
    if (totalBytes > TOTAL_BYTES) {
      fault("invalid_control");
      return;
    }
    line = Buffer.concat([line, chunk]);
    for (;;) {
      const newline = line.indexOf(0x0a);
      if (newline < 0) {
        if (line.byteLength > RECORD_BYTES) fault("invalid_control");
        return;
      }
      const bytes = line.subarray(0, newline);
      line = line.subarray(newline + 1);
      count += 1;
      if (count > RECORD_COUNT) {
        fault("invalid_control");
        return;
      }
      let record: Record<string, unknown>;
      try {
        record = parseRecord(bytes);
      } catch {
        fault("invalid_control");
        return;
      }
      commandChain = commandChain
        .then(async () => await handleCommand(record))
        .catch((error: unknown) => {
          fault(error instanceof InjectedMonitorFault ? "internal_failure" : "invalid_control");
        });
    }
  });

  try {
    await atBarrier("before_monitor_ready");
    if (!sealing) await writeLifecycle({ type: "ready" });
  } catch (error) {
    fault(error instanceof InjectedMonitorFault ? "internal_failure" : "internal_failure");
  }
  return await new Promise<never>(() => undefined);
}

export async function runClaudeLifetimeMonitor(): Promise<never> {
  return await runMonitor();
}

export async function runClaudeLifetimeMonitorForTest(
  barrier: MonitorBarrier,
  beforeFaultForTest?: () => Promise<void>,
  faultAfterBarrierForTest = true,
): Promise<never> {
  return await runMonitor({
    barrier,
    ...(beforeFaultForTest === undefined ? {} : { beforeFault: beforeFaultForTest }),
    faultAfterBarrier: faultAfterBarrierForTest,
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  await runClaudeLifetimeMonitor();
}
