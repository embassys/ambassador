import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AcpSessionStore } from "../acp-session-store.js";
import { DiagnosticLog } from "../diagnostic-log.js";
import { GatewayError } from "../errors.js";
import { openGatewayApplication, type RunningGatewayApplication } from "../gateway-application.js";
import { pathsForStateDirectory } from "../gateway-paths.js";
import { EncryptedFileLocalControlSecretStore, LocalControlClient } from "../local-control.js";
import { clearLocalGatewayState } from "../local-state-cleaner.js";
import { ProcessLock } from "../process-lock.js";
import { redactVerboseValue } from "../verbose-log.js";
import type { GatewaySnapshot } from "./protocol.js";

export interface DesktopGatewayOptions {
  readonly id: string;
  readonly name: string;
  readonly stateDirectory: string;
  readonly port: number;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChange?: (snapshot: GatewaySnapshot) => void;
}

export class DesktopGateway {
  readonly #paths;
  #state: GatewaySnapshot;
  #application: RunningGatewayApplication | undefined;
  #lock: ProcessLock | undefined;
  #diagnostics: DiagnosticLog | undefined;
  #abort: AbortController | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(readonly options: DesktopGatewayOptions) {
    this.#paths = pathsForStateDirectory(options.stateDirectory);
    this.#state = { id: options.id, state: "stopped" };
  }

  snapshot(): GatewaySnapshot {
    return { ...this.#state };
  }

  #changed(value: GatewaySnapshot): void {
    this.#state = value;
    this.options.onChange?.(this.snapshot());
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  start(): Promise<void> {
    return this.#serial(async () => {
      if (this.#state.state === "running") return;
      this.#changed({ id: this.options.id, state: "starting" });
      try {
        this.#lock = await ProcessLock.acquire(this.#paths.lockPath);
        await mkdir(this.options.workingDirectory, { recursive: true, mode: 0o700 });
        this.#abort = new AbortController();
        this.#diagnostics = new DiagnosticLog(join(this.options.stateDirectory, "diagnostics"));
        this.#diagnostics.log("desktop.gateway.starting", {
          instance_id: this.options.id,
          name: this.options.name,
        });
        const application = await openGatewayApplication({
          ...this.#paths,
          workingDirectory: await realpath(this.options.workingDirectory),
          environment: this.options.environment,
          localMcpPort: this.options.port,
          signal: this.#abort.signal,
          log: this.#diagnostics.log,
          onStopRequested: () => {
            void this.stop();
          },
          onRuntimeNotice: (notice) =>
            this.#diagnostics?.log("gateway.notice", { message: notice.message }),
        });
        this.#application = application;
        this.#changed({
          id: this.options.id,
          state: "running",
          endpoint: application.endpoint,
          startedAt: new Date().toISOString(),
        });
        this.#diagnostics.log("desktop.gateway.ready", {
          instance_id: this.options.id,
          endpoint: application.endpoint,
        });
        void application.failure
          .then(() =>
            this.#serial(async () => {
              if (this.#application !== application) return;
              await this.#close();
              this.#changed({
                id: this.options.id,
                state: "error",
                error:
                  "The server stopped after a runtime failure. Review Diagnostics before restarting.",
              });
            }),
          )
          .catch(() =>
            this.#changed({
              id: this.options.id,
              state: "error",
              error:
                "Server shutdown did not finish normally. Review Diagnostics before restarting.",
            }),
          );
      } catch (error) {
        await this.#close();
        this.#changed({
          id: this.options.id,
          state: "error",
          error:
            error instanceof GatewayError
              ? error.message
              : "The server could not start. Check its data location and runtime.",
        });
      }
    });
  }

  async #close(): Promise<void> {
    this.#abort?.abort();
    const application = this.#application;
    this.#application = undefined;
    try {
      await application?.close();
    } finally {
      try {
        this.#diagnostics?.log("desktop.gateway.stopped", { instance_id: this.options.id });
        await this.#diagnostics?.close();
      } finally {
        this.#diagnostics = undefined;
        await this.#lock?.release();
        this.#lock = undefined;
        this.#abort = undefined;
      }
    }
  }

  stop(): Promise<void> {
    this.#abort?.abort();
    return this.#serial(async () => {
      this.#changed({ id: this.options.id, state: "stopping" });
      await this.#close();
      this.#changed({ id: this.options.id, state: "stopped" });
    });
  }

  clean(): Promise<void> {
    return this.#serial(async () => {
      if (this.#state.state !== "stopped" && this.#state.state !== "error")
        throw new Error("The server must be stopped before cleaning this instance.");
      const lock = await ProcessLock.acquire(this.#paths.lockPath);
      try {
        await clearLocalGatewayState(this.options.stateDirectory, this.#paths.lockPath);
      } finally {
        await lock.release();
      }
      this.#changed({ id: this.options.id, state: "stopped" });
    });
  }

  async #control(): Promise<LocalControlClient> {
    const endpoint = this.#state.endpoint;
    if (this.#state.state !== "running" || endpoint === undefined)
      throw new Error("Start this server to load provider history.");
    const secret = await new EncryptedFileLocalControlSecretStore(
      this.#paths.localControlSecretPath,
      this.#paths.localControlSecretKeyPath,
    ).load();
    if (secret === undefined) throw new Error("Local control is unavailable.");
    return new LocalControlClient(endpoint, secret);
  }

  sessions(): Promise<unknown> {
    return this.#serial(async () => {
      if (this.#state.state === "running") return await (await this.#control()).listSessions();
      const lock = await ProcessLock.acquire(this.#paths.lockPath);
      try {
        const store = new AcpSessionStore(this.#paths.acpSessionPath);
        try {
          return store.list();
        } finally {
          store.close();
        }
      } finally {
        await lock.release();
      }
    });
  }

  history(sessionId: string): Promise<readonly string[]> {
    return this.#serial(async () => await (await this.#control()).showSession(sessionId, false));
  }

  async logs(): Promise<unknown[]> {
    const path = join(this.options.stateDirectory, "diagnostics", "events.jsonl");
    let file: FileHandle | undefined;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid diagnostic file.");
      file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      const size = (await file.stat()).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n");
      if (size > length) lines.shift();
      return lines
        .filter(Boolean)
        .slice(-100)
        .flatMap((line) => {
          try {
            return [redactVerboseValue(JSON.parse(line))];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return [];
      throw new Error("Recent diagnostics could not be read.");
    } finally {
      await file?.close();
    }
  }
}
