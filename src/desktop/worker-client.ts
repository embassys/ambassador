import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { type ExecutorContext, executorCheckSchema } from "./executor-guard.js";
import { desktopLaunchEnvironment } from "./launch-environment.js";
import { type LocalNotification, localNotificationSchema } from "./notifications.js";
import {
  DESKTOP_PROTOCOL,
  type DesktopInstance,
  type GatewaySnapshot,
  type WorkerCommand,
  workerCommandSchema,
} from "./protocol.js";

const snapshotSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(["stopped", "starting", "running", "stopping", "error"]),
  endpoint: z.string().max(512).optional(),
  error: z.string().max(1000).optional(),
  notice: z.string().max(1000).optional(),
  startedAt: z.iso.datetime().optional(),
  stopReason: z.literal("handoff").optional(),
});

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DesktopGatewayClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, Pending>();
  readonly #ready: Promise<void>;
  readonly #exited: Promise<void>;
  #state: GatewaySnapshot;
  #closed = false;
  #closeResult: Promise<void> | undefined;
  #checkingExecutor = false;

  constructor(
    readonly options: {
      readonly nodePath: string;
      readonly workerPath: string;
      readonly expectedRuntime?: string;
      readonly diagnostics?: "development" | "production";
      readonly instance: DesktopInstance;
      readonly onChange?: (snapshot: GatewaySnapshot) => void;
      readonly onNotification?: (event: LocalNotification) => void;
      readonly checkExecutor?: (context: ExecutorContext) => Promise<boolean>;
    },
  ) {
    this.#state = { id: options.instance.id, state: "stopped" };
    const environment = desktopLaunchEnvironment(process.env, dirname(options.nodePath), homedir());
    const childOptions = {
      execPath: options.nodePath,
      execArgv: [],
      env: environment,
      stdio: ["ignore", "ignore", "ignore", "ipc"] as ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json" as const,
      windowsHide: true,
    };
    this.#child = fork(options.workerPath, [], childOptions);
    this.#exited = new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
      this.#child.once("error", () => resolve());
    });
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The server process did not initialize."));
        void this.close();
      }, 15_000);
      this.#child.on("message", (message: unknown) => {
        if (
          message === null ||
          typeof message !== "object" ||
          !("protocol" in message) ||
          message.protocol !== DESKTOP_PROTOCOL ||
          !("type" in message)
        )
          return;
        if (message.type === "executor_check") {
          const request = executorCheckSchema.safeParse(message);
          if (!request.success || this.#checkingExecutor || this.#closed) return;
          this.#checkingExecutor = true;
          void Promise.resolve()
            .then(() => options.checkExecutor?.(request.data.context) ?? false)
            .catch(() => false)
            .then((allowed) => {
              this.#checkingExecutor = false;
              if (this.#child.connected && !this.#closed)
                this.#child.send(
                  {
                    protocol: DESKTOP_PROTOCOL,
                    type: "executor_check_result",
                    requestId: request.data.requestId,
                    allowed: allowed === true,
                  },
                  () => {},
                );
            });
        } else if (message.type === "notification") {
          const parsed = localNotificationSchema.safeParse(
            "event" in message ? message.event : undefined,
          );
          if (parsed.success) options.onNotification?.(parsed.data);
        } else if (message.type === "ready" || message.type === "state") {
          if (
            message.type === "ready" &&
            options.expectedRuntime &&
            (!("runtime" in message) || message.runtime !== options.expectedRuntime)
          ) {
            clearTimeout(timer);
            this.#state = {
              id: options.instance.id,
              state: "error",
              error: "The bundled server runtime is incompatible. Reinstall a complete app build.",
            };
            options.onChange?.(this.snapshot());
            reject(new Error("The bundled server runtime is incompatible."));
            void this.close();
            return;
          }
          const parsed = snapshotSchema.safeParse(
            "snapshot" in message ? message.snapshot : undefined,
          );
          if (!parsed.success || parsed.data.id !== options.instance.id) return;
          this.#state = {
            id: parsed.data.id,
            state: parsed.data.state,
            ...(parsed.data.endpoint === undefined ? {} : { endpoint: parsed.data.endpoint }),
            ...(parsed.data.error === undefined ? {} : { error: parsed.data.error }),
            ...(parsed.data.notice === undefined ? {} : { notice: parsed.data.notice }),
            ...(parsed.data.startedAt === undefined ? {} : { startedAt: parsed.data.startedAt }),
            ...(parsed.data.stopReason ? { stopReason: parsed.data.stopReason } : {}),
          };
          options.onChange?.(this.snapshot());
          if (message.type === "ready") {
            clearTimeout(timer);
            resolve();
          }
        } else if (
          message.type === "reply" &&
          "requestId" in message &&
          typeof message.requestId === "string"
        ) {
          const pending = this.#pending.get(message.requestId);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          this.#pending.delete(message.requestId);
          if ("ok" in message && message.ok === true && "result" in message)
            pending.resolve(message.result);
          else pending.reject(new Error("The server could not complete this operation."));
        }
      });
      const ended = () => {
        clearTimeout(timer);
        reject(new Error("The server process is unavailable."));
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("The server process disconnected."));
        }
        this.#pending.clear();
        if (!this.#closed) {
          this.#state = {
            id: options.instance.id,
            state: "error",
            error: "The server process exited. Start it again to resume saved work.",
          };
          options.onChange?.(this.snapshot());
        }
      };
      this.#child.once("error", ended);
      this.#child.once("exit", ended);
      this.#child.send(
        {
          protocol: DESKTOP_PROTOCOL,
          type: "initialize",
          diagnostics: options.diagnostics ?? "production",
          instance: options.instance,
        },
        (error) => {
          if (error) ended();
        },
      );
    });
    // A worker can fail before its first caller awaits ready.
    void this.#ready.catch(() => undefined);
  }

  snapshot(): GatewaySnapshot {
    return { ...this.#state };
  }
  available(): boolean {
    return (
      !this.#closed &&
      this.#child.connected &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    );
  }
  ready(): Promise<void> {
    return this.#ready;
  }

  async request(input: WorkerCommand): Promise<unknown> {
    if (this.#closed) throw new Error("This server process is closed.");
    const command = workerCommandSchema.parse(input);
    if (!("instanceId" in command) || command.instanceId !== this.options.instance.id)
      throw new Error("Wrong instance.");
    await this.#ready;
    if (this.#closed || !this.#child.connected)
      throw new Error("This server process is disconnected.");
    if (this.#pending.size >= 16) throw new Error("The server is busy. Try again shortly.");
    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(
          new Error("The operation is still unresolved. Refresh its state before trying again."),
        );
      }, 45_000);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#child.send({ protocol: DESKTOP_PROTOCOL, requestId, command }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(requestId);
          reject(new Error("The server process disconnected."));
        }
      });
    });
  }

  close(): Promise<void> {
    if (this.#closeResult !== undefined) return this.#closeResult;
    this.#closed = true;
    this.#closeResult = (async () => {
      if (this.#child.connected) this.#child.disconnect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("The server has not confirmed shutdown. Its data was left untouched."),
                ),
              40_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.#closeResult;
  }
}
