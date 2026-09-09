import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpSessionStore } from "../acp-session-store.js";
import { capabilityForKind } from "../agent-capabilities.js";
import { DiagnosticLog } from "../diagnostic-log.js";
import { AcpSessionController } from "../direct-delivery.js";
import { GatewayError } from "../errors.js";
import {
  type GatewayApplicationOptions,
  type GatewayOverview,
  openGatewayApplication,
  type RunningGatewayApplication,
} from "../gateway-application.js";
import { pathsForStateDirectory } from "../gateway-paths.js";
import { gatewayWorkingDirectory } from "../gateway-working-directory.js";
import { GatewayIdentity } from "../identity.js";
import { LocalControlClient } from "../local-control.js";
import { clearLocalGatewayState } from "../local-state-cleaner.js";
import { ProcessLock } from "../process-lock.js";
import { redactVerboseValue } from "../verbose-log.js";
import { type TranscriptPage, VisibleTranscripts } from "../visible-transcripts.js";
import type { ConnectionProvider } from "./agent-connections.js";
import { CONNECTION_CHECK_MS, ConnectionCheck } from "./connection-check.js";
import { desktopCredentialStores } from "./credential-stores.js";
import { type DiagnosticMode, desktopDiagnosticOptions } from "./diagnostic-policy.js";
import { type DiagnosticQuery, readDiagnostics } from "./diagnostics.js";
import { readLocalSummary } from "./local-summary.js";
import type { LocalNotification } from "./notifications.js";
import type { DesktopCommand, GatewaySnapshot } from "./protocol.js";
import type { SetupPermission } from "./setup-approval.js";

export interface DesktopGatewayOptions {
  readonly id: string;
  readonly name: string;
  readonly stateDirectory: string;
  readonly port: number;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly diagnostics?: DiagnosticMode;
  readonly onChange?: (snapshot: GatewaySnapshot) => void;
  readonly onNotification?: (event: LocalNotification) => void;
  readonly beforeDirectDelivery?: GatewayApplicationOptions["beforeDirectDelivery"];
  readonly approveSetup?: (
    permission: SetupPermission,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly testOverrides?: Pick<
    GatewayApplicationOptions,
    "centralOrigin" | "nowSeconds" | "deliveryTargetFactory"
  > & {
    setupControllerFactory?: (
      options: ConstructorParameters<typeof AcpSessionController>[0],
    ) => Pick<AcpSessionController, "checkConnection">;
  };
}

export class DesktopGateway {
  readonly #paths;
  #state: GatewaySnapshot;
  #application: RunningGatewayApplication | undefined;
  #lock: ProcessLock | undefined;
  #diagnostics: DiagnosticLog | undefined;
  #abort: AbortController | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #handedOff = false;
  readonly #connectionCheck = new ConnectionCheck();
  #setupTask: Promise<unknown> | undefined;
  #cleanPreview: { id: string; lock: ProcessLock; timer: NodeJS.Timeout } | undefined;

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
      if (this.#cleanPreview) throw new Error("Finish the Clean preview before starting.");
      this.#changed({ id: this.options.id, state: "starting" });
      this.#handedOff = false;
      try {
        this.#lock = await ProcessLock.acquire(this.#paths.lockPath);
        await mkdir(this.options.workingDirectory, { recursive: true, mode: 0o700 });
        this.#abort = new AbortController();
        this.#diagnostics = new DiagnosticLog(
          join(this.options.stateDirectory, "diagnostics"),
          desktopDiagnosticOptions(this.options.diagnostics ?? "production"),
        );
        this.#diagnostics.log("desktop.gateway.starting", {
          instance_id: this.options.id,
          name: this.options.name,
        });
        const application = await openGatewayApplication({
          ...this.#paths,
          ...desktopCredentialStores(this.#paths),
          ...this.options.testOverrides,
          workingDirectory: await gatewayWorkingDirectory(
            this.#paths.profilePath,
            await realpath(this.options.workingDirectory),
          ),
          environment: this.options.environment,
          ...(this.options.beforeDirectDelivery
            ? { beforeDirectDelivery: this.options.beforeDirectDelivery }
            : {}),
          localMcpPort: this.options.port,
          signal: this.#abort.signal,
          log: this.#diagnostics.log,
          visibleTranscriptPath: join(this.options.stateDirectory, "visible-transcripts.sqlite"),
          desktopRegistrationPath: join(this.options.stateDirectory, "registration.json"),
          onSetupCheck: (challenge, enrollmentId) =>
            this.#connectionCheck.receive(challenge, enrollmentId),
          ...(this.options.onNotification
            ? { onDesktopNotification: this.options.onNotification }
            : {}),
          onStopRequested: () => {
            this.#handedOff = true;
            void this.stop();
          },
          onRuntimeNotice: (notice) => {
            this.#diagnostics?.log("gateway.notice", { message: notice.message });
            this.#changed({ ...this.#state, notice: notice.message });
          },
        });
        this.#application = application;
        this.#changed({
          id: this.options.id,
          state: "running",
          endpoint: application.endpoint,
          startedAt: new Date().toISOString(),
          ...(this.#state.notice ? { notice: this.#state.notice } : {}),
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
    await this.#releaseClean();
    this.#abort?.abort();
    await this.#setupTask?.catch(() => undefined);
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
      this.#changed({
        id: this.options.id,
        state: "stopping",
        ...(this.#handedOff ? { stopReason: "handoff" as const } : {}),
      });
      await this.#close();
      this.#changed({
        id: this.options.id,
        state: "stopped",
        ...(this.#handedOff ? { stopReason: "handoff" as const } : {}),
      });
    });
  }

  externalProcess(): Promise<{ processInstanceId?: string }> {
    return this.#serial(async () => {
      if (this.#application || this.#cleanPreview) return {};
      try {
        const lock = await ProcessLock.acquire(this.#paths.lockPath);
        await lock.release();
        return {};
      } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== "daemon_running") throw error;
      }
      return {
        processInstanceId: await (await this.#externalControl()).getProcessInstance(
          AbortSignal.timeout(15000),
        ),
      };
    });
  }

  stopExternal(processInstanceId: string): Promise<void> {
    return this.#serial(async () => {
      if (this.#application || this.#cleanPreview)
        throw new Error("This app already owns the installation.");
      const signal = AbortSignal.timeout(30000);
      await (await this.#externalControl()).stopProcess(processInstanceId, signal);
      for (;;) {
        signal.throwIfAborted();
        try {
          const lock = await ProcessLock.acquire(this.#paths.lockPath);
          await lock.release();
          return;
        } catch (error) {
          if (!(error instanceof GatewayError) || error.code !== "daemon_running") throw error;
        }
        await delay(100, undefined, { signal });
      }
    });
  }

  async #releaseClean(): Promise<void> {
    const preview = this.#cleanPreview;
    this.#cleanPreview = undefined;
    if (preview) {
      clearTimeout(preview.timer);
      await preview.lock.release();
    }
  }

  prepareClean() {
    return this.#serial(async () => {
      if (!["stopped", "error"].includes(this.#state.state))
        throw new Error("Stop this server before reviewing Clean.");
      await this.#releaseClean();
      const lock = await ProcessLock.acquire(this.#paths.lockPath);
      try {
        const summary = await readLocalSummary(this.#paths);
        const id = randomUUID();
        const timer = setTimeout(() => {
          void this.#serial(() => this.#releaseClean());
        }, 300_000);
        timer.unref();
        this.#cleanPreview = { id, lock, timer };
        return { previewId: id, ...summary };
      } catch (error) {
        await lock.release();
        throw error;
      }
    });
  }

  cancelClean(previewId: string): Promise<void> {
    return this.#serial(async () => {
      if (this.#cleanPreview?.id === previewId) await this.#releaseClean();
    });
  }

  clean(previewId?: string): Promise<void> {
    return this.#serial(async () => {
      if (this.#state.state !== "stopped" && this.#state.state !== "error")
        throw new Error("The server must be stopped before cleaning this instance.");
      if ((previewId !== undefined || this.#cleanPreview) && previewId !== this.#cleanPreview?.id)
        throw new Error("The Clean preview expired or does not match.");
      const lock = this.#cleanPreview?.lock ?? (await ProcessLock.acquire(this.#paths.lockPath));
      try {
        await clearLocalGatewayState(this.options.stateDirectory, this.#paths.lockPath);
      } finally {
        if (this.#cleanPreview) await this.#releaseClean();
        else await lock.release();
      }
      this.#changed({ id: this.options.id, state: "stopped" });
    });
  }

  async #control(): Promise<LocalControlClient> {
    const endpoint = this.#state.endpoint;
    if (this.#state.state !== "running" || endpoint === undefined)
      throw new Error("Start this server to load provider history.");
    const secret = await desktopCredentialStores(this.#paths).localControlSecretStore.load();
    if (secret === undefined) throw new Error("Local control is unavailable.");
    return new LocalControlClient(endpoint, secret);
  }

  async #externalControl(): Promise<LocalControlClient> {
    const secret = await desktopCredentialStores(this.#paths).localControlSecretStore.load();
    if (secret === undefined)
      throw new Error(
        "The running server cannot be identified. Stop it from its terminal before continuing.",
      );
    return new LocalControlClient(`http://127.0.0.1:${this.options.port}/mcp`, secret);
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

  overview(): Promise<GatewayOverview> {
    return this.#serial(async () => {
      if (this.#application) return this.#application.localOverview();
      const lock = this.#cleanPreview ? undefined : await ProcessLock.acquire(this.#paths.lockPath);
      try {
        const { enrollment, pendingCalls, receivedResults, sessionCount } = await readLocalSummary(
          this.#paths,
        );
        return { enrollment, pendingCalls, receivedResults, sessionCount };
      } finally {
        await lock?.release();
      }
    });
  }

  desktopCommand(command: DesktopCommand): Promise<unknown> {
    return this.#serial(async () => {
      const services = this.#application?.desktop;
      if (!services)
        return { state: "stopped", phase: "stopped", items: [], hasMore: false, nextCursor: 0 };
      switch (command.type) {
        case "enrollment_status":
          return services.registration.snapshot();
        case "enrollment_register":
          return services.registration.register({
            email: command.email,
            executor: command.executor,
          });
        case "enrollment_verify":
          return services.registration.verify(command.code);
        case "enrollment_resend":
          return services.registration.resend();
        case "enrollment_executor":
          return services.registration.selectExecutor(command.executor);
        case "permissions":
          return services.permissions();
        case "activity":
          return services.activity(command.kind, command.after);
        default:
          throw new Error("Unsupported desktop operation.");
      }
    });
  }

  async testAgent(
    provider: ConnectionProvider,
  ): Promise<{ state: "verified" | "configured"; message: string }> {
    const application = this.#application;
    const registration = application?.desktop?.registration.snapshot();
    const agent = provider === "claude_code" ? "claude" : provider;
    const capability = capabilityForKind(agent)?.direct;
    if (
      !application ||
      !capability ||
      !this.#abort ||
      registration?.phase !== "registered" ||
      registration.needsExecutor ||
      registration.credentialStatus === "expired"
    )
      return {
        state: "configured",
        message:
          "Settings saved. Complete this device's registration in Embassys before checking the agent.",
      };
    if (this.#setupTask)
      return { state: "configured", message: "A connection check is already running." };
    const enrollment = application.localOverview().enrollment;
    const challenge = this.#connectionCheck.begin(String(enrollment.agent_id));
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(CONNECTION_CHECK_MS)]);
    const task = (async () => {
      try {
        await this.options.beforeDirectDelivery?.(
          { agent, workingDirectory: this.options.workingDirectory },
          signal,
        );
        const settings = {
          capability,
          environment: this.options.environment,
          deadlineMs: CONNECTION_CHECK_MS,
          ...(this.#diagnostics ? { log: this.#diagnostics.log } : {}),
        };
        const controller =
          this.options.testOverrides?.setupControllerFactory?.(settings) ??
          new AcpSessionController(settings);
        await controller.checkConnection(
          this.options.workingDirectory,
          challenge,
          async (request, approvalSignal) => {
            const detail = JSON.stringify(redactVerboseValue(request.toolCall));
            if (Buffer.byteLength(detail) > 8192) return undefined;
            return this.options.approveSetup?.(
              {
                title: request.toolCall.title ?? "Agent connection check",
                detail,
                options: request.options,
              },
              approvalSignal,
            );
          },
          signal,
        );
      } catch {
        // A successful MCP observation remains evidence if the provider's final turn fails.
      }
      const verified =
        !signal.aborted &&
        this.#application === application &&
        this.#connectionCheck.observed(challenge);
      this.#diagnostics?.log("desktop.agent.check", { agent, verified });
      return verified
        ? {
            state: "verified" as const,
            message: `${capabilityForKind(agent)?.displayName ?? agent} connected to Embassys as ${String(enrollment.email)}. Reopen existing chats to load the new skill.`,
          }
        : {
            state: "configured" as const,
            message:
              "Settings and skill saved, but the agent check did not finish. Open the agent, complete any provider login or approval, then choose Test connection. No registration was repeated.",
          };
    })();
    this.#setupTask = task;
    try {
      return await task;
    } finally {
      this.#connectionCheck.end(challenge);
      this.#setupTask = undefined;
    }
  }

  async #offlineArchive<T>(operation: (archive: VisibleTranscripts | undefined) => T): Promise<T> {
    if (this.#cleanPreview) throw new Error("Finish the Clean review first.");
    const lock = await ProcessLock.acquire(this.#paths.lockPath);
    let archive: VisibleTranscripts | undefined;
    try {
      const identity = await GatewayIdentity.open(
        desktopCredentialStores(this.#paths).credentialStore,
      );
      if (identity.enrolled)
        archive = new VisibleTranscripts(
          join(this.options.stateDirectory, "visible-transcripts.sqlite"),
          identity.localCredential(),
        );
      return await operation(archive);
    } finally {
      archive?.close();
      await lock.release();
    }
  }

  history(
    sessionId: string,
    after = 0,
  ): Promise<
    | TranscriptPage
    | {
        source: "provider";
        lines: readonly string[];
        warnings: string[];
        hasMore: false;
        nextCursor: number;
      }
  > {
    return this.#serial(async () => {
      const archived = this.#application
        ? this.#application.visibleHistory(sessionId, after)
        : await this.#offlineArchive((archive) => archive?.page(sessionId, after));
      if (archived?.items.length || archived?.hasMore || after > 0)
        return (
          archived ?? {
            source: "archive",
            items: [],
            hasMore: false,
            nextCursor: after,
            warnings: [],
          }
        );
      if (this.#application) {
        try {
          return {
            source: "provider",
            lines: await (await this.#control()).showSession(sessionId, false),
            warnings: [
              ...(archived?.warnings ?? []),
              "Provider history is a partial preview. It is not saved in the local archive.",
            ],
            hasMore: false,
            nextCursor: 0,
          };
        } catch {
          /* An unavailable provider does not hide the archive notice. */
        }
      }
      return {
        source: "archive",
        items: [],
        hasMore: false,
        nextCursor: after,
        warnings: [
          ...(archived?.warnings ?? []),
          "No archived content is available for this session. Older history requires the running server and its provider.",
        ],
      };
    });
  }

  deleteHistory(sessionId: string): Promise<void> {
    return this.#serial(async () => {
      if (this.#application) await this.#application.deleteVisibleHistory(sessionId);
      else {
        await this.#offlineArchive(async (archive) => {
          while (archive?.deleteSession(sessionId))
            await new Promise<void>((resolve) => setImmediate(resolve));
        });
      }
    });
  }

  async #withDiagnostics<T>(operation: (log: DiagnosticLog) => Promise<T>): Promise<T> {
    if (this.#diagnostics) return operation(this.#diagnostics);
    if (this.#cleanPreview)
      throw new Error("Finish the Clean preview before changing diagnostics.");
    const lock = await ProcessLock.acquire(this.#paths.lockPath);
    let log: DiagnosticLog | undefined;
    try {
      log = new DiagnosticLog(
        join(this.options.stateDirectory, "diagnostics"),
        desktopDiagnosticOptions(this.options.diagnostics ?? "production"),
      );
      return await operation(log);
    } finally {
      await log?.close();
      await lock.release();
    }
  }

  logs(query?: DiagnosticQuery) {
    return this.#serial(() =>
      this.#withDiagnostics(async (log) => {
        await log.maintain();
        return readDiagnostics(log.directory, query);
      }),
    );
  }

  clearLogs() {
    return this.#serial(() =>
      this.#withDiagnostics(async (log) => {
        await log.clear();
        return { cleared: true };
      }),
    );
  }
}
