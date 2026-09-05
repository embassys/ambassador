import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AcpSessionStore, AcpSessionStoreError } from "./acp-session-store.js";
import { ActionCatalogError } from "./action-catalog.js";
import { ActionResultInbox, ActionResultInboxError } from "./action-result-inbox.js";
import type { AgentCapability } from "./agent-capabilities.js";
import { capabilityForKind } from "./agent-capabilities.js";
import { CentralAgentPermissionCoordinator } from "./central-agent-permission.js";
import {
  CentralEnrollmentClient,
  CentralEnrollmentError,
  REST_BOOTSTRAP_TOOLS,
} from "./central-enrollment.js";
import { CentralProtectedTransport } from "./central-protected-transport.js";
import { CentralRestClient, CentralRestError, REST_AUTHENTICATED_TOOLS } from "./central-rest.js";
import { type CredentialStore, EncryptedFileCredentialStore } from "./credential-store.js";
import {
  type DeliveryProfile,
  DeliveryProfileError,
  DeliveryProfileStore,
  validateStoredDeliveryProfile,
} from "./delivery-profile.js";
import {
  type AcpPermissionApproval,
  AcpSessionController,
  DirectDeliveryError,
  DirectDeliveryTarget,
} from "./direct-delivery.js";
import { DpopNonceCache } from "./dpop.js";
import { GatewayError } from "./errors.js";
import { GuidedRegistration, GuidedRegistrationError } from "./guided-registration.js";
import { HumanInputMailbox } from "./human-input-mailbox.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
import {
  EncryptedFileLocalControlSecretStore,
  type LocalControlSecretStore,
  LocalSessionControlError,
} from "./local-control.js";
import {
  type LocalMcpRouter,
  LocalMcpServer,
  LocalMcpServerError,
  LocalMcpToolError,
} from "./local-mcp.js";
import {
  assertSafeUpstreamResult,
  McpContractError,
  safeLocalToolArguments,
} from "./mcp-contract.js";
import { MESSAGE_BOX_TOOL, MessageBox, MessageBoxError } from "./message-box.js";
import {
  type DeliveryTarget,
  NotificationRelay,
  NotificationRelayError,
  RetryableNotificationReceiveError,
} from "./notification-relay.js";
import { NotificationStore } from "./notification-store.js";
import { OutboundActionError, OutboundActions } from "./outbound-actions.js";
import { OwnerQuestionError, OwnerQuestions } from "./owner-questions.js";
import { PendingActionInbox, PendingActionInboxError } from "./pending-action-inbox.js";
import { SessionMaintenance } from "./session-maintenance.js";
import { describeVerboseError, traceFetch, type VerboseLogger } from "./verbose-log.js";
import { WebhookDeliveryError, WebhookDeliveryTarget } from "./webhook-delivery.js";
import {
  EncryptedFileWebhookSecretStore,
  type WebhookSecretStore,
} from "./webhook-secret-store.js";

export const CENTRAL_ORIGIN = "https://mcp.embassys.ai";
const CENTRAL_POLL_SECONDS = 30;
const SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface DeliveryTargetContext {
  readonly profile: DeliveryProfile;
  readonly capability: AgentCapability;
  readonly endpoint: string;
  readonly sessionStore?: AcpSessionStore;
  readonly approvePermission: AcpPermissionApproval;
}

export interface GatewayApplicationOptions {
  readonly journalPath: string;
  readonly credentialPath: string;
  readonly credentialKeyPath: string;
  readonly webhookSecretPath: string;
  readonly webhookSecretKeyPath: string;
  readonly localControlSecretPath: string;
  readonly localControlSecretKeyPath: string;
  readonly pendingActionPath: string;
  readonly actionResultPath: string;
  readonly outboundActionPath?: string;
  readonly acpSessionPath: string;
  readonly profilePath: string;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly centralOrigin?: string;
  readonly centralFetch?: typeof fetch;
  readonly webhookFetch?: typeof fetch;
  readonly credentialStore?: CredentialStore;
  readonly webhookSecretStore?: WebhookSecretStore;
  readonly localControlSecretStore?: LocalControlSecretStore;
  readonly deliveryTargetFactory?: (context: DeliveryTargetContext) => DeliveryTarget;
  readonly acpSessionControllerFactory?: (
    capability: NonNullable<AgentCapability["direct"]>,
  ) => Pick<AcpSessionController, "delete" | "show">;
  readonly localMcpPort?: number;
  readonly nowSeconds?: () => number;
  readonly signal?: AbortSignal;
  readonly onRuntimeNotice?: (notice: GatewayError) => void;
  readonly onStopRequested?: () => void;
  readonly log?: VerboseLogger;
}

export interface RunningGatewayApplication {
  readonly endpoint: string;
  readonly failure: Promise<Error>;
  close(): Promise<void>;
}

function safeFailure(): Error {
  return new Error("Ambassador operation failed");
}

function startupFailure(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (
    error instanceof OutboundActionError ||
    error instanceof PendingActionInboxError ||
    error instanceof ActionResultInboxError ||
    error instanceof AcpSessionStoreError
  ) {
    return new GatewayError(
      "local_state_invalid",
      "Ambassador could not open its local state. Stop Ambassador, run `npx --yes @embassys/ambassador@latest clean`, then start it again",
      7,
    );
  }
  if (error instanceof LocalMcpServerError) {
    if (error.code === "address_in_use") {
      return new GatewayError(
        "local_mcp_address_in_use",
        `Ambassador could not bind its local MCP endpoint because 127.0.0.1:${error.port} is already in use`,
        7,
      );
    }
    return new GatewayError(
      "local_mcp_listen_failed",
      "Ambassador could not bind its local MCP endpoint. Check local network permissions and try again",
      7,
    );
  }
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  if (code === "SQLITE_NOTADB" || code === "SQLITE_FORMAT" || code === "SQLITE_CORRUPT") {
    return new GatewayError(
      "local_state_invalid",
      "Ambassador could not open its local state. Stop Ambassador, run `npx --yes @embassys/ambassador@latest clean`, then start it again",
      7,
    );
  }
  if (code === "ERR_DLOPEN_FAILED" || code === "MODULE_NOT_FOUND") {
    return new GatewayError(
      "local_runtime_unavailable",
      "Ambassador could not load its local database runtime for this Node platform. Reinstall the latest Ambassador with a supported Node.js release",
      7,
    );
  }
  return new GatewayError(
    "local_state_unavailable",
    "Ambassador could not open its local state. Check that its state directory is writable; if the state is partial, stop Ambassador and run `npx --yes @embassys/ambassador@latest clean`",
    7,
  );
}

function directDeliveryFailure(error: unknown): DirectDeliveryError["code"] | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof DirectDeliveryError) return current.code;
    if (current === null || typeof current !== "object") return undefined;
    const candidate = current as { cause?: unknown; code?: unknown; name?: unknown };
    if (
      candidate.name === "DirectDeliveryError" &&
      [
        "agent_unavailable",
        "cancelled",
        "invalid_configuration",
        "startup_failed",
        "uncertain_outcome",
      ].includes(String(candidate.code))
    ) {
      return candidate.code as DirectDeliveryError["code"];
    }
    current = candidate.cause;
  }
  return undefined;
}

function webhookDeliveryFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof WebhookDeliveryError) return true;
    if (current === null || typeof current !== "object") return false;
    const candidate = current as { cause?: unknown; name?: unknown };
    if (candidate.name === "WebhookDeliveryError") return true;
    current = candidate.cause;
  }
  return false;
}

function runtimeFailure(error: unknown, agentName: string): GatewayError {
  if (credentialExpiryFailure(error)) return expiredCredentialNotice();
  const direct = directDeliveryFailure(error);
  if (direct === "agent_unavailable") {
    return new GatewayError(
      "direct_agent_unavailable",
      `Ambassador paused incoming delivery because ${agentName} is unavailable. Confirm ${agentName} is installed and signed in, then restart Ambassador to resume delivery`,
      0,
    );
  }
  if (direct === "startup_failed") {
    return new GatewayError(
      "direct_agent_startup_failed",
      `Ambassador paused incoming delivery because ${agentName} could not start. Confirm the agent is signed in, then restart Ambassador to resume delivery`,
      0,
    );
  }
  if (direct === "uncertain_outcome") {
    return new GatewayError(
      "direct_delivery_uncertain",
      `Ambassador paused incoming delivery after losing confirmation from ${agentName}. It did not retry the message because that could duplicate an action. Restart Ambassador to resume new delivery`,
      0,
    );
  }
  if (webhookDeliveryFailure(error)) {
    return new GatewayError(
      "webhook_delivery_failed",
      "Ambassador paused incoming delivery because the configured webhook could not accept a message. Check the webhook and restart Ambassador to resume delivery",
      0,
    );
  }
  return new GatewayError(
    "delivery_failed",
    "Ambassador stopped because incoming-message delivery failed. Check the configured agent or webhook, then restart Ambassador",
    7,
  );
}

function expiredCredentialNotice(): GatewayError {
  return new GatewayError(
    "credential_expired",
    "Ambassador paused central delivery because its credential expired. Local inbox and session reads remain available. Embassys does not yet offer credential renewal; keep local state and contact the service owner for recovery",
    0,
  );
}

function credentialExpiryFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      (current instanceof CentralRestError || current instanceof IdentityError) &&
      current.code === "credential_expired"
    )
      return true;
    if (current === null || typeof current !== "object") return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function localDeliveryFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof DirectDeliveryError || current instanceof WebhookDeliveryError) {
      return true;
    }
    if (current === null || typeof current !== "object") return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function localError(error: unknown): LocalMcpToolError {
  if (error instanceof LocalMcpToolError) return error;
  if (
    error instanceof MessageBoxError ||
    error instanceof OwnerQuestionError ||
    error instanceof ActionCatalogError
  )
    return new LocalMcpToolError(error.code, undefined, "message_box");
  if (error instanceof IdentityError) {
    return new LocalMcpToolError(error.code, undefined, "local_identity");
  }
  if (error instanceof CentralEnrollmentError) {
    return new LocalMcpToolError(error.code, undefined, "central_enrollment");
  }
  if (error instanceof CentralRestError) {
    return new LocalMcpToolError(error.code, error.response?.retryAfterMs, "central_rest");
  }
  if (error instanceof GuidedRegistrationError) {
    return new LocalMcpToolError(error.code, undefined, "guided_registration");
  }
  if (error instanceof DeliveryProfileError) {
    return new LocalMcpToolError(error.code, undefined, "delivery_profile");
  }
  if (error instanceof McpContractError) {
    return new LocalMcpToolError("invalid_arguments", undefined, "local_mcp_contract");
  }
  if (error instanceof NotificationRelayError) {
    return new LocalMcpToolError(error.code, undefined, "notification_relay");
  }
  return new LocalMcpToolError("ambassador_operation_failed", undefined, "ambassador");
}

export async function openGatewayApplication(
  options: GatewayApplicationOptions,
): Promise<RunningGatewayApplication> {
  const centralOrigin = options.centralOrigin ?? CENTRAL_ORIGIN;
  const nowSeconds = options.nowSeconds ?? (() => Date.now() / 1_000);
  const log = options.log ?? (() => undefined);
  const centralFetch =
    options.log === undefined
      ? options.centralFetch
      : traceFetch(options.centralFetch ?? globalThis.fetch, log);
  const profileStore = new DeliveryProfileStore(options.profilePath);
  const webhookSecretStore =
    options.webhookSecretStore ??
    new EncryptedFileWebhookSecretStore(options.webhookSecretPath, options.webhookSecretKeyPath);
  const localControlSecretStore =
    options.localControlSecretStore ??
    new EncryptedFileLocalControlSecretStore(
      options.localControlSecretPath,
      options.localControlSecretKeyPath,
    );
  const store =
    options.credentialStore ??
    new EncryptedFileCredentialStore(
      options.credentialPath,
      options.credentialKeyPath,
      JSON.stringify({ centralOrigin: new URL(centralOrigin).origin }),
    );
  const controller = new AbortController();
  const lifetimeSignal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
  let identity!: GatewayIdentity;
  let local!: LocalMcpServer;
  let rest: CentralRestClient | undefined;
  let relay: NotificationRelay | undefined;
  let notificationStore: NotificationStore | undefined;
  let humanInputMailbox: HumanInputMailbox | undefined;
  let messageBox: MessageBox | undefined;
  let ownerQuestions: OwnerQuestions | undefined;
  let relayRun: Promise<void> | undefined;
  let pendingActionInbox: PendingActionInbox | undefined;
  let outboundActions: OutboundActions | undefined;
  let actionResultInbox: ActionResultInbox | undefined;
  let acpSessionStore: AcpSessionStore | undefined;
  let sessionCleanupTimer: NodeJS.Timeout | undefined;
  let sessionMaintenance: SessionMaintenance | undefined;
  let closed = false;
  let activation: Promise<void> | undefined;
  let reportFailure: ((error: Error) => void) | undefined;
  let sessionOperationTail: Promise<void> = Promise.resolve();
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });

  const runSessionOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = sessionOperationTail.then(operation);
    sessionOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const enrollment = new CentralEnrollmentClient({
    centralOrigin,
    ...(centralFetch === undefined ? {} : { fetch: centralFetch }),
    nowSeconds,
  });
  const guidedRegistration = new GuidedRegistration({
    profileStore,
    webhookSecretStore,
    workingDirectory: options.workingDirectory,
    registerCentral: (arguments_, signal) => enrollment.register(arguments_, signal),
  });

  const loadProfile = async (): Promise<{
    readonly profile: DeliveryProfile;
    readonly capability: AgentCapability;
  }> => {
    const profile = await profileStore.load();
    if (profile === undefined) throw new DeliveryProfileError("invalid_profile");
    const validated = await validateStoredDeliveryProfile(profile, options.workingDirectory);
    if (validated.profile.mode === "webhook") {
      if ((await webhookSecretStore.load()) === undefined) {
        throw new DeliveryProfileError("invalid_profile");
      }
    }
    return validated;
  };

  const createDeliveryTarget = async (context: DeliveryTargetContext): Promise<DeliveryTarget> => {
    const serializeDirectTarget = (target: DeliveryTarget): DeliveryTarget => {
      if (context.profile.mode !== "direct") return target;
      return {
        deliver: (message, signal) =>
          runSessionOperation(async () => await target.deliver(message, signal)),
        close: async () => await target.close(),
      };
    };
    if (options.deliveryTargetFactory !== undefined) {
      return serializeDirectTarget(options.deliveryTargetFactory(context));
    }
    if (context.profile.mode === "webhook") {
      const secret = await webhookSecretStore.load();
      if (secret === undefined || context.capability.webhook === undefined) {
        throw new DeliveryProfileError("invalid_profile");
      }
      return new WebhookDeliveryTarget({
        url: context.profile.url,
        secret,
        contract: context.capability.webhook,
        identityScope: identity.localCredential().keyThumbprint,
        now: () => nowSeconds() * 1_000,
        fetch: traceFetch(options.webhookFetch ?? globalThis.fetch, log, "webhook"),
      });
    }
    if (context.capability.direct === undefined) {
      throw new DeliveryProfileError("incompatible_profile");
    }
    const sessionStore = context.sessionStore ?? acpSessionStore;
    if (sessionStore === undefined) throw new AcpSessionStoreError();
    const direct = new DirectDeliveryTarget({
      agentKind: context.capability.kind,
      identityScope: identity.localCredential().keyThumbprint,
      capability: context.capability.direct,
      workingDirectory: context.profile.working_directory,
      environment: options.environment,
      sessionStore,
      approvePermission: context.approvePermission,
      nowMs: () => Math.floor(nowSeconds() * 1_000),
      log,
    });
    return serializeDirectTarget(direct);
  };

  const enableEnrolledIdentity = async (): Promise<void> => {
    if (rest !== undefined && relay !== undefined) return;
    if (activation !== undefined) return activation;
    activation = (async () => {
      const profile = await loadProfile();
      if (profile.profile.mode === "direct" && acpSessionStore === undefined) {
        acpSessionStore = new AcpSessionStore(options.acpSessionPath);
        sessionMaintenance = new SessionMaintenance({
          store: acpSessionStore,
          serialize: runSessionOperation,
          environment: options.environment,
          signal: lifetimeSignal,
          nowMs: () => Math.floor(nowSeconds() * 1_000),
          log,
          ...(options.acpSessionControllerFactory === undefined
            ? {}
            : { controller: options.acpSessionControllerFactory }),
        });
        void sessionMaintenance.run();
        sessionCleanupTimer = setInterval(() => {
          void sessionMaintenance?.run();
        }, SESSION_CLEANUP_INTERVAL_MS);
        sessionCleanupTimer.unref();
      }
      const transport = new CentralProtectedTransport({
        credential: () => identity.localCredential(),
        nonceCache: new DpopNonceCache(),
        ...(centralFetch === undefined ? {} : { fetch: centralFetch }),
        now: nowSeconds,
      });
      const nextRest = new CentralRestClient({ centralOrigin, transport });
      const nextPendingActionInbox =
        pendingActionInbox ??
        new PendingActionInbox(options.pendingActionPath, identity.localCredential());
      pendingActionInbox = nextPendingActionInbox;
      const nextActionResultInbox =
        actionResultInbox ??
        new ActionResultInbox(options.actionResultPath, identity.localCredential());
      actionResultInbox = nextActionResultInbox;
      const nextOutboundActions =
        outboundActions ??
        new OutboundActions(
          options.outboundActionPath ??
            join(dirname(options.pendingActionPath), "outbound-actions.sqlite"),
          identity.localCredential(),
          nextRest,
        );
      outboundActions = nextOutboundActions;
      rest = nextRest;
      notificationStore ??= new NotificationStore(
        join(dirname(options.journalPath), "notification-custody.sqlite"),
        identity.localCredential(),
      );
      humanInputMailbox ??= new HumanInputMailbox(
        join(dirname(options.journalPath), "human-input-responses.sqlite"),
        identity.localCredential(),
      );
      const mailbox = humanInputMailbox;
      const custody = notificationStore;
      ownerQuestions ??= new OwnerQuestions({
        path: join(dirname(options.pendingActionPath), "owner-questions.sqlite"),
        credential: identity.localCredential(),
        pending: nextPendingActionInbox,
        transport: nextRest,
        enqueueContinuation: (message) => {
          custody.enqueueLocal(message);
          relay?.notifyStoredWork();
        },
      });
      const owners = ownerQuestions;
      while (owners.recoverLocalContinuations())
        await new Promise<void>((resolve) => setImmediate(resolve));
      messageBox ??= new MessageBox({
        path: join(dirname(options.pendingActionPath), "operations.sqlite"),
        credential: identity.localCredential(),
        transport: nextRest,
        pending: nextPendingActionInbox,
        results: nextActionResultInbox,
        outbound: nextOutboundActions,
        owners,
        expired: () => identity.expired,
        completeAction: (callId) =>
          acpSessionStore?.completeAction(callId, Math.floor(nowSeconds() * 1_000)),
        log,
      });
      const box = messageBox;
      if (identity.expired) {
        options.onRuntimeNotice?.(expiredCredentialNotice());
        return;
      }
      const captureMessage = async (
        message: import("./central-rest.js").CentralMessage,
      ): Promise<boolean> => {
        log("delivery.received", { message });
        const internal = mailbox.capture(message);
        const owned = await box.capture(message);
        return internal ? owned && owners.deliveryMessage(message) !== undefined : !owned;
      };
      const permissionCoordinator = new CentralAgentPermissionCoordinator({
        transport: nextRest,
        log,
        waitForResponse: (id, signal) => mailbox.wait(id, signal),
      });
      const baseTarget = await createDeliveryTarget({
        ...profile,
        endpoint: local.endpoint,
        ...(acpSessionStore === undefined ? {} : { sessionStore: acpSessionStore }),
        approvePermission: (request, signal) =>
          permissionCoordinator.approve(
            { ...request, message: owners.permissionMessage(request.message) },
            signal,
          ),
      });
      const nextRelay = new NotificationRelay({
        store: notificationStore,
        onDeliveryError: (error) =>
          options.onRuntimeNotice?.(runtimeFailure(error, profile.capability.displayName)),
        onAcknowledgementError: (error, messageId) =>
          log("delivery.acknowledgement_uncertain", {
            message_id: messageId,
            error: describeVerboseError(error),
          }),
        deliveryTarget: {
          deliver: async (message, signal) => {
            if (
              message.payload.type === "owner_input" &&
              !owners.isPendingLocalContinuation(message)
            )
              return { status: "completed" };
            if (message.payload.type === "human_input_response") {
              const resumed = owners.deliveryMessage(message);
              if (resumed !== undefined) return await baseTarget.deliver(resumed, signal);
              return { status: "completed" };
            }
            return await baseTarget.deliver(message, signal);
          },
          close: async () => await baseTarget.close(),
        },
        receiveMessages: async (signal) => {
          try {
            return (await nextRest.pollRemoteMessages(CENTRAL_POLL_SECONDS, signal)).messages;
          } catch (error) {
            if (
              error instanceof CentralRestError &&
              (error.code === "central_request_failed" || error.code === "central_request_rejected")
            ) {
              throw new RetryableNotificationReceiveError();
            }
            if (error instanceof CentralRestError && error.code === "central_response_invalid") {
              throw new NotificationRelayError("invalid_notification_response");
            }
            throw error;
          }
        },
        acknowledgeMessage: async (messageId, signal) => {
          await nextRest.ackMessage({ message_id: messageId }, signal);
          log("delivery.acknowledged", { message_id: messageId });
        },
        captureMessage,
      });
      rest = nextRest;
      relay = nextRelay;
      relayRun = nextRelay.run(lifetimeSignal);
      void relayRun.catch((error: unknown) => {
        if (!closed && !lifetimeSignal.aborted) {
          const notice = runtimeFailure(error, profile.capability.displayName);
          if (localDeliveryFailure(error) || credentialExpiryFailure(error)) {
            options.onRuntimeNotice?.(notice);
          } else {
            reportFailure?.(notice);
          }
        }
      });
    })();
    try {
      await activation;
    } finally {
      activation = undefined;
    }
  };

  const requireRest = (): CentralRestClient => {
    if (rest === undefined) throw safeFailure();
    return rest;
  };

  const listSessions = (): ReturnType<AcpSessionStore["list"]> => {
    if (acpSessionStore !== undefined) return acpSessionStore.list();
    const transient = new AcpSessionStore(options.acpSessionPath);
    try {
      return transient.list();
    } finally {
      transient.close();
    }
  };

  const sessionControl = {
    list: () => listSessions(),
    show: (sessionId: string, verbose: boolean, signal: AbortSignal) =>
      runSessionOperation(async () => {
        let transient: AcpSessionStore | undefined;
        let sessionStore = acpSessionStore;
        if (sessionStore === undefined) {
          transient = new AcpSessionStore(options.acpSessionPath);
          sessionStore = transient;
        }
        let record: ReturnType<AcpSessionStore["get"]>;
        try {
          record = sessionStore.get(sessionId);
        } finally {
          transient?.close();
        }
        if (record === undefined) throw new LocalSessionControlError("session_not_found");
        const capability = capabilityForKind(record.agent_kind)?.direct;
        if (capability === undefined) throw new LocalSessionControlError("agent_unsupported");
        const sessionController =
          options.acpSessionControllerFactory?.(capability) ??
          new AcpSessionController({ capability, environment: options.environment, log });
        return await sessionController.show(
          record,
          verbose,
          AbortSignal.any([signal, lifetimeSignal]),
        );
      }),
  };

  const router: LocalMcpRouter = {
    enrollmentContext: () => identity.enrollment,
    async listTools() {
      return [...REST_BOOTSTRAP_TOOLS, ...REST_AUTHENTICATED_TOOLS, MESSAGE_BOX_TOOL];
    },
    async callTool(name, untrustedArguments, signal, clientInfo) {
      const request_id = randomUUID();
      const started = performance.now();
      try {
        const arguments_ = safeLocalToolArguments(untrustedArguments);
        log("mcp.tool.request", {
          request_id,
          name,
          arguments: arguments_,
          client_info: clientInfo,
        });
        let result: Record<string, unknown>;
        if (!identity.enrolled) {
          switch (name) {
            case "register_agent":
              result = await guidedRegistration.register(arguments_, clientInfo, signal);
              break;
            case "resend_verification":
              result = await enrollment.resend(arguments_, signal);
              break;
            case "verify_email":
              await loadProfile();
              result = await identity.enroll(() => enrollment.verify(arguments_, signal));
              await enableEnrolledIdentity();
              break;
            default:
              if (
                name === "message_box" ||
                REST_AUTHENTICATED_TOOLS.some((tool) => tool.name === name)
              ) {
                throw new LocalMcpToolError("not_enrolled");
              }
              throw new LocalMcpToolError("tool_not_found");
          }
          assertSafeUpstreamResult(result);
          log("mcp.tool.response", {
            request_id,
            name,
            result,
            duration_ms: Math.round(performance.now() - started),
          });
          return result;
        }

        if (REST_AUTHENTICATED_TOOLS.some((tool) => tool.name === name)) identity.credential();
        switch (name) {
          case "register_agent":
          case "verify_email":
          case "resend_verification":
            throw new LocalMcpToolError("already_enrolled");
          case "list_action_types":
            result = {
              enrollment: identity.enrollment,
              workflow_guidance: {
                requester_email: identity.enrollment.email,
                meetings:
                  "For a coordinated meeting, get actual availability through a supported catalog action before requesting creation, even when the user proposes a specific time. Include requester_email as an attendee unless the user explicitly supplies another address; the agent provider's account email is not the Embassys requester identity. The target person's human decides permission. A denial must not be offered to the requester for approval.",
              },
              action_types: await requireRest().listActionTypes(signal),
            };
            break;
          case "message_box":
            if (messageBox === undefined) throw safeFailure();
            result = await messageBox.call(arguments_, signal);
            break;
          case "get_my_permissions":
            if (Object.keys(arguments_).length !== 0) throw new McpContractError();
            result = {
              enrollment: identity.enrollment,
              permissions: await requireRest().getMyPermissions(signal),
              message:
                "You are registered and verified. An empty permissions list means no permissions have been granted yet; you are still registered. Do not register again.",
            };
            break;
          default:
            throw new LocalMcpToolError("tool_not_found");
        }
        assertSafeUpstreamResult(result, identity.localCredential().record.access_token);
        log("mcp.tool.response", {
          request_id,
          name,
          result,
          duration_ms: Math.round(performance.now() - started),
        });
        return result;
      } catch (error) {
        const mappedError = localError(error);
        log("mcp.tool.error", {
          request_id,
          duration_ms: Math.round(performance.now() - started),
          name,
          source: mappedError.source,
          error_code: mappedError.code,
          error: describeVerboseError(error),
        });
        throw mappedError;
      }
    },
  };

  try {
    const localControlSecret = await localControlSecretStore.createOrLoad();
    identity = await GatewayIdentity.open(store, nowSeconds);
    if (identity.enrolled) await loadProfile();
    local = new LocalMcpServer(router, {
      ...(options.localMcpPort === undefined ? {} : { port: options.localMcpPort }),
      control: {
        secret: localControlSecret,
        sessions: sessionControl,
        ...(options.onStopRequested === undefined ? {} : { stop: options.onStopRequested }),
      },
    });
    await local.listen();
    if (identity.enrolled) await enableEnrolledIdentity();
  } catch (error) {
    controller.abort();
    if (sessionCleanupTimer !== undefined) clearInterval(sessionCleanupTimer);
    await relay?.shutdown().catch(() => undefined);
    await local?.close().catch(() => undefined);
    await messageBox?.close();
    ownerQuestions?.close();
    pendingActionInbox?.close();
    actionResultInbox?.close();
    outboundActions?.close();
    notificationStore?.close();
    humanInputMailbox?.close();
    await sessionMaintenance?.settled();
    acpSessionStore?.close();

    throw startupFailure(error);
  }

  return {
    endpoint: local.endpoint,
    failure,
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      if (sessionCleanupTimer !== undefined) clearInterval(sessionCleanupTimer);
      await relay?.shutdown().catch(() => undefined);
      await relayRun?.catch(() => undefined);
      await local.close();
      await messageBox?.close();
      ownerQuestions?.close();
      pendingActionInbox?.close();
      actionResultInbox?.close();
      outboundActions?.close();
      notificationStore?.close();
      humanInputMailbox?.close();
      await sessionMaintenance?.settled();
      acpSessionStore?.close();
    },
  };
}
