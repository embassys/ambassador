import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { type CentralCredentialRecord, parseCentralCredential } from "../central-credential.js";
import { type OwnerNotice, ownerNoticeSchema } from "./owner-feed.js";
import {
  type OwnerCommand,
  type OwnerReply,
  type OwnerSnapshot,
  ownerCommandSchema,
  ownerReplySchema,
  ownerSnapshotSchema,
} from "./owner-protocol.js";
import { OWNER_WORKER_STARTUP_MS } from "./owner-worker-startup.js";

export class OwnerWorkerClient {
  readonly #child: ChildProcess;
  readonly #ready: Promise<void>;
  readonly #exited: Promise<void>;
  readonly #pending = new Map<
    string,
    {
      resolve(reply: OwnerReply): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #secrets = new Map<string, { agentId: string; finish(value?: unknown): void }>();
  #snapshot: OwnerSnapshot = {
    context: randomUUID(),
    status: "loading",
  };
  #closed = false;
  #closeResult: Promise<void> | undefined;
  constructor(
    readonly options: {
      directory: string;
      nodePath: string;
      workerPath: string;
      expectedRuntime: string;
      diagnostics?: "development" | "production";
      onChange?: () => void;
      onNotifications?: (ownerId: string, events: OwnerNotice[]) => Promise<void>;
    },
  ) {
    const env: NodeJS.ProcessEnv = { PATH: dirname(options.nodePath) };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"])
      if (process.env[key]) env[key] = process.env[key];
    const childOptions = {
      execPath: options.nodePath,
      execArgv: [],
      env,
      stdio: ["ignore", "ignore", "ignore", "ipc"] as ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json" as const,
      windowsHide: true,
    };
    this.#child = fork(options.workerPath, [], childOptions);
    this.#exited = new Promise((resolve) => {
      this.#child.once("exit", () => resolve());
      this.#child.once("error", () => resolve());
    });
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The account service did not initialize."));
        void this.close();
      }, OWNER_WORKER_STARTUP_MS);
      const ended = () => {
        clearTimeout(timer);
        this.#snapshot = {
          context: randomUUID(),
          status: "unavailable",
          issue: "worker_unavailable",
        };
        options.onChange?.();
        reject(new Error("The account service is unavailable."));
        for (const item of this.#pending.values()) {
          clearTimeout(item.timer);
          item.reject(
            new Error("The account service disconnected. Reopen Account to check its saved state."),
          );
        }
        this.#pending.clear();
        for (const value of this.#secrets.values()) value.finish();
      };
      this.#child.once("error", ended);
      this.#child.once("exit", ended);
      this.#child.on("message", (raw: unknown) => {
        if (this.#closed) return;
        if (
          !raw ||
          typeof raw !== "object" ||
          !("protocol" in raw) ||
          raw.protocol !== 1 ||
          !("type" in raw)
        )
          return;
        if (Buffer.byteLength(JSON.stringify(raw)) > 4 * 1024 * 1024) {
          void this.close();
          return;
        }
        if (raw.type === "execution_credential") {
          if ("requestId" in raw && typeof raw.requestId === "string")
            this.#secrets
              .get(raw.requestId)
              ?.finish("credential" in raw ? raw.credential : undefined);
          return;
        }
        if (raw.type === "notifications") {
          const notice = z
            .object({
              deliveryId: z.uuid(),
              ownerId: z.uuid(),
              events: z.array(ownerNoticeSchema).max(200),
            })
            .safeParse(raw);
          if (!notice.success) {
            void this.close();
            return;
          }
          const value = notice.data;
          const matches =
            this.#snapshot.status === "signed_in" &&
            this.#snapshot.account?.owner_id === value.ownerId;
          void (
            matches && options.onNotifications
              ? options.onNotifications(value.ownerId, value.events)
              : Promise.reject(new Error("Account changed"))
          )
            .then(
              () => true,
              () => false,
            )
            .then((ok) => {
              if (!this.#closed && this.#child.connected)
                this.#child.send(
                  { protocol: 1, type: "notification_receipt", deliveryId: value.deliveryId, ok },
                  () => undefined,
                );
            });
          return;
        }
        if (raw.type === "ready" || raw.type === "state") {
          const parsed = ownerSnapshotSchema.safeParse(
            "snapshot" in raw ? raw.snapshot : undefined,
          );
          if (
            !parsed.success ||
            (raw.type === "ready" &&
              (!("runtime" in raw) || raw.runtime !== options.expectedRuntime))
          ) {
            reject(new Error("The account service is incompatible."));
            clearTimeout(timer);
            void this.close();
            return;
          }
          this.#snapshot = parsed.data;
          options.onChange?.();
          if (raw.type === "ready") {
            clearTimeout(timer);
            resolve();
          }
        } else if (
          raw.type === "reply" &&
          "requestId" in raw &&
          typeof raw.requestId === "string"
        ) {
          const pending = this.#pending.get(raw.requestId);
          if (!pending) return;
          this.#pending.delete(raw.requestId);
          clearTimeout(pending.timer);
          const result = ownerReplySchema.safeParse("result" in raw ? raw.result : undefined);
          if ("ok" in raw && raw.ok === true && result.success) {
            this.#snapshot = result.data.snapshot;
            options.onChange?.();
            pending.resolve(result.data);
          } else
            pending.reject(
              new Error(
                "Account changed or could not finish. Refresh Account before trying again.",
              ),
            );
        }
      });
      this.#child.send(
        {
          protocol: 1,
          type: "owner_initialize",
          directory: options.directory,
          diagnostics: options.diagnostics ?? "production",
        },
        (error) => {
          if (error) ended();
        },
      );
    });
    void this.#ready.catch(() => undefined);
  }
  ready(): Promise<void> {
    return this.#ready;
  }
  snapshot(): OwnerSnapshot {
    return structuredClone(this.#snapshot);
  }
  available(): boolean {
    return (
      !this.#closed &&
      this.#child.connected &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    );
  }
  async request(input: OwnerCommand): Promise<OwnerReply> {
    return this.#request({ command: ownerCommandSchema.parse(input) });
  }
  async executionCredential(context: string, agentId: string): Promise<CentralCredentialRecord> {
    z.uuid().parse(context);
    z.uuid().parse(agentId);
    await this.#ready;
    if (!this.available() || this.#snapshot.context !== context || this.#secrets.size >= 4)
      throw new Error("Account changed");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#secrets.get(requestId)?.finish(), 40000);
      this.#secrets.set(requestId, {
        agentId,
        finish: (value) => {
          clearTimeout(timer);
          this.#secrets.delete(requestId);
          try {
            const credential = parseCentralCredential(value);
            if (
              this.#snapshot.context !== context ||
              credential.token.subject !== agentId ||
              credential.token.executionDeviceId !== this.#snapshot.account?.device_id
            )
              throw new Error();
            resolve(credential.record);
          } catch {
            reject(new Error("Execution credential unavailable"));
          }
        },
      });
      this.#child.send(
        { protocol: 1, type: "execution_credential", requestId, context, agentId },
        (error) => {
          if (error) this.#secrets.get(requestId)?.finish();
        },
      );
    });
  }
  nativePush(context: string, token: string | null): Promise<OwnerReply> {
    z.uuid().parse(context);
    if (token !== null)
      z.string()
        .regex(/^[a-f0-9]{16,512}$/iu)
        .parse(token);
    return this.#request({ type: "native_push", context, token });
  }
  wake(): void {
    if (this.available()) this.#child.send({ protocol: 1, type: "wake" }, () => undefined);
  }
  async #request(payload: object): Promise<OwnerReply> {
    if (this.#closed) throw new Error("The account service is closed.");
    await this.#ready;
    if (!this.available() || this.#pending.size >= 8)
      throw new Error("The account service is busy or unavailable.");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("Account state is unresolved. Refresh Account before trying again."));
        // End observation and reload durable state on the next explicit command.
        void this.close();
      }, 40000);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#child.send({ protocol: 1, requestId, ...payload }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(requestId);
          reject(new Error("The account service disconnected."));
        }
      });
    });
  }
  close(): Promise<void> {
    if (this.#closeResult) return this.#closeResult;
    this.#closed = true;
    for (const value of this.#secrets.values()) value.finish();
    this.#snapshot = { context: randomUUID(), status: "unavailable", issue: "worker_unavailable" };
    this.options.onChange?.();
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error("The account service closed. Reopen Account to check its saved state."),
      );
    }
    this.#pending.clear();
    this.#closeResult = (async () => {
      if (this.#child.connected) this.#child.disconnect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Account service shutdown was not confirmed.")),
              25000,
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
