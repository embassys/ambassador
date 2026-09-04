import { AcpSessionStore, AcpSessionStoreError } from "./acp-session-store.js";
import type { AgentCapability } from "./agent-capabilities.js";
import { capabilityForKind } from "./agent-capabilities.js";
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
  AcpSessionController,
  DirectDeliveryError,
  DirectDeliveryTarget,
} from "./direct-delivery.js";
import { DpopNonceCache } from "./dpop.js";
import { GatewayError } from "./errors.js";
import { GuidedRegistration, GuidedRegistrationError } from "./guided-registration.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
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
import { NotificationJournal } from "./notification-journal.js";
import {
  type DeliveryTarget,
  NotificationRelay,
  NotificationRelayError,
  RetryableNotificationReceiveError,
} from "./notification-relay.js";
import { PendingActionInbox, PendingActionInboxError } from "./pending-action-inbox.js";
import { traceFetch, type VerboseLogger } from "./verbose-log.js";
import { WebhookDeliveryError, WebhookDeliveryTarget } from "./webhook-delivery.js";
import {
  EncryptedFileWebhookSecretStore,
  type WebhookSecretStore,
} from "./webhook-secret-store.js";

export const CENTRAL_ORIGIN = "https://mcp.embassys.ai";
const CENTRAL_POLL_SECONDS = 30;
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSION_CLEANUP_BATCH = 8;

export interface DeliveryTargetContext {
  readonly profile: DeliveryProfile;
  readonly capability: AgentCapability;
  readonly endpoint: string;
  readonly sessionStore?: AcpSessionStore;
}

export interface GatewayApplicationOptions {
  readonly journalPath: string;
  readonly credentialPath: string;
  readonly credentialKeyPath: string;
  readonly webhookSecretPath: string;
  readonly webhookSecretKeyPath: string;
  readonly pendingActionPath: string;
  readonly acpSessionPath: string;
  readonly profilePath: string;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly centralOrigin?: string;
  readonly centralFetch?: typeof fetch;
  readonly webhookFetch?: typeof fetch;
  readonly credentialStore?: CredentialStore;
  readonly webhookSecretStore?: WebhookSecretStore;
  readonly deliveryTargetFactory?: (context: DeliveryTargetContext) => DeliveryTarget;
  readonly acpSessionControllerFactory?: (
    capability: NonNullable<AgentCapability["direct"]>,
  ) => Pick<AcpSessionController, "delete">;
  readonly localMcpPort?: number;
  readonly nowSeconds?: () => number;
  readonly signal?: AbortSignal;
  readonly onRuntimeNotice?: (notice: GatewayError) => void;
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
  if (error instanceof PendingActionInboxError || error instanceof AcpSessionStoreError) {
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
  if (error instanceof IdentityError) return new LocalMcpToolError(error.code);
  if (error instanceof CentralEnrollmentError) return new LocalMcpToolError(error.code);
  if (error instanceof CentralRestError) return new LocalMcpToolError(error.code);
  if (error instanceof GuidedRegistrationError) return new LocalMcpToolError(error.code);
  if (error instanceof DeliveryProfileError) return new LocalMcpToolError(error.code);
  if (error instanceof McpContractError) return new LocalMcpToolError("invalid_arguments");
  if (error instanceof NotificationRelayError) return new LocalMcpToolError(error.code);
  return new LocalMcpToolError("ambassador_operation_failed");
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
  let journal: NotificationJournal;
  try {
    journal = new NotificationJournal(options.journalPath);
  } catch (error) {
    throw startupFailure(error);
  }
  const profileStore = new DeliveryProfileStore(options.profilePath);
  const webhookSecretStore =
    options.webhookSecretStore ??
    new EncryptedFileWebhookSecretStore(options.webhookSecretPath, options.webhookSecretKeyPath);
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
  let relayRun: Promise<void> | undefined;
  let pendingActionInbox: PendingActionInbox | undefined;
  let acpSessionStore: AcpSessionStore | undefined;
  let sessionCleanupTimer: NodeJS.Timeout | undefined;
  let cleaningSessions = false;
  let closed = false;
  let activation: Promise<void> | undefined;
  let reportFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });

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

  const cleanExpiredSessions = async (): Promise<void> => {
    if (cleaningSessions || acpSessionStore === undefined) return;
    cleaningSessions = true;
    try {
      const cutoff = Math.max(0, Math.floor(nowSeconds() * 1_000) - SESSION_RETENTION_MS);
      const expired = acpSessionStore.expiredRetired(cutoff).slice(0, MAX_SESSION_CLEANUP_BATCH);
      for (const record of expired) {
        if (lifetimeSignal.aborted) return;
        const capability = capabilityForKind(record.agent_kind)?.direct;
        if (capability === undefined) {
          acpSessionStore.forget(record.session_id);
          continue;
        }
        try {
          const sessionController =
            options.acpSessionControllerFactory?.(capability) ??
            new AcpSessionController({
              capability,
              environment: options.environment,
              log,
            });
          const result = await sessionController.delete(record, lifetimeSignal);
          if (result === "deleted" || result === "unsupported") {
            acpSessionStore.forget(record.session_id);
            log("acp.session.cleaned", { session_id: record.session_id, result });
          }
        } catch (error) {
          log("acp.session.cleanup_failed", {
            session_id: record.session_id,
            error: error instanceof Error ? error.name : "Error",
          });
        }
      }
    } finally {
      cleaningSessions = false;
    }
  };

  const createDeliveryTarget = async (context: DeliveryTargetContext): Promise<DeliveryTarget> => {
    if (options.deliveryTargetFactory !== undefined) {
      return options.deliveryTargetFactory(context);
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
        now: () => nowSeconds() * 1_000,
        ...(options.webhookFetch === undefined ? {} : { fetch: options.webhookFetch }),
      });
    }
    if (context.capability.direct === undefined) {
      throw new DeliveryProfileError("incompatible_profile");
    }
    const sessionStore = context.sessionStore ?? acpSessionStore;
    if (sessionStore === undefined) throw new AcpSessionStoreError();
    return new DirectDeliveryTarget({
      agentKind: context.capability.kind,
      capability: context.capability.direct,
      workingDirectory: context.profile.working_directory,
      environment: options.environment,
      sessionStore,
      nowMs: () => Math.floor(nowSeconds() * 1_000),
      log,
    });
  };

  const enableEnrolledIdentity = async (): Promise<void> => {
    if (rest !== undefined && relay !== undefined) return;
    if (activation !== undefined) return activation;
    activation = (async () => {
      const profile = await loadProfile();
      if (profile.profile.mode === "direct" && acpSessionStore === undefined) {
        acpSessionStore = new AcpSessionStore(options.acpSessionPath);
        await cleanExpiredSessions();
        sessionCleanupTimer = setInterval(() => {
          void cleanExpiredSessions();
        }, SESSION_CLEANUP_INTERVAL_MS);
        sessionCleanupTimer.unref();
      }
      const transport = new CentralProtectedTransport({
        credential: () => identity.credential(),
        nonceCache: new DpopNonceCache(),
        ...(centralFetch === undefined ? {} : { fetch: centralFetch }),
        now: nowSeconds,
      });
      const nextRest = new CentralRestClient({ centralOrigin, transport });
      const nextPendingActionInbox =
        pendingActionInbox ??
        new PendingActionInbox(options.pendingActionPath, identity.credential());
      pendingActionInbox = nextPendingActionInbox;
      const target = await createDeliveryTarget({
        ...profile,
        endpoint: local.endpoint,
        ...(acpSessionStore === undefined ? {} : { sessionStore: acpSessionStore }),
      });
      const nextRelay = new NotificationRelay({
        journal,
        deliveryTarget: target,
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
        },
        captureMessage: (message) => {
          nextPendingActionInbox.capture(message);
        },
      });
      rest = nextRest;
      relay = nextRelay;
      relayRun = nextRelay.run(lifetimeSignal);
      void relayRun.catch((error: unknown) => {
        if (!closed && !lifetimeSignal.aborted) {
          const notice = runtimeFailure(error, profile.capability.displayName);
          if (localDeliveryFailure(error)) {
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

  const requirePendingActionInbox = (): PendingActionInbox => {
    if (pendingActionInbox === undefined) throw safeFailure();
    return pendingActionInbox;
  };

  const router: LocalMcpRouter = {
    async listTools() {
      return [...REST_BOOTSTRAP_TOOLS, ...REST_AUTHENTICATED_TOOLS];
    },
    async callTool(name, untrustedArguments, signal, clientInfo) {
      try {
        const arguments_ = safeLocalToolArguments(untrustedArguments);
        log("mcp.tool.request", { name, arguments: arguments_, client_info: clientInfo });
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
              if (REST_AUTHENTICATED_TOOLS.some((tool) => tool.name === name)) {
                throw new LocalMcpToolError("not_enrolled");
              }
              throw new LocalMcpToolError("tool_not_found");
          }
          assertSafeUpstreamResult(result);
          log("mcp.tool.response", { name, result });
          return result;
        }

        switch (name) {
          case "register_agent":
          case "verify_email":
          case "resend_verification":
            throw new LocalMcpToolError("already_enrolled");
          case "list_action_types":
            result = { action_types: await requireRest().listActionTypes(signal) };
            break;
          case "request_permission":
            result = await requireRest().requestPermission(arguments_, signal);
            break;
          case "list_pending_permission_requests": {
            if (Object.keys(arguments_).length !== 0) throw new McpContractError();
            const enrolledEmail = identity.credential().token.email;
            const pending = (await requireRest().getMyPermissions(signal)).filter(
              (permission) =>
                permission.status === "pending" && permission.grantor_email === enrolledEmail,
            );
            result = { count: pending.length, pending_permission_requests: pending };
            break;
          }
          case "respond_to_permission":
            result = await requireRest().respondToPermission(arguments_, signal);
            break;
          case "call_action":
            result = await requireRest().callAction(arguments_, signal);
            break;
          case "list_pending_action_calls": {
            if (Object.keys(arguments_).length !== 0) throw new McpContractError();
            const pending = requirePendingActionInbox().list();
            result = { count: pending.length, pending_action_calls: pending };
            break;
          }
          case "submit_action_result": {
            result = await requireRest().submitActionResult(arguments_, signal);
            const callId = String(result.call_id);
            requirePendingActionInbox().remove(callId);
            acpSessionStore?.retireByCallId(callId, Math.floor(nowSeconds() * 1_000));
            break;
          }
          case "get_my_permissions":
            if (Object.keys(arguments_).length !== 0) throw new McpContractError();
            result = { permissions: await requireRest().getMyPermissions(signal) };
            break;
          default:
            throw new LocalMcpToolError("tool_not_found");
        }
        assertSafeUpstreamResult(result, identity.credential().record.access_token);
        log("mcp.tool.response", { name, result });
        return result;
      } catch (error) {
        log("mcp.tool.error", {
          name,
          error: error instanceof Error ? error.name : "Error",
        });
        throw localError(error);
      }
    },
  };

  try {
    identity = await GatewayIdentity.open(store, nowSeconds);
    if (identity.enrolled) await loadProfile();
    local = new LocalMcpServer(router, {
      ...(options.localMcpPort === undefined ? {} : { port: options.localMcpPort }),
    });
    await local.listen();
    if (identity.enrolled) await enableEnrolledIdentity();
  } catch (error) {
    controller.abort();
    if (sessionCleanupTimer !== undefined) clearInterval(sessionCleanupTimer);
    await relay?.shutdown().catch(() => undefined);
    await local?.close().catch(() => undefined);
    pendingActionInbox?.close();
    acpSessionStore?.close();
    journal.close();
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
      pendingActionInbox?.close();
      acpSessionStore?.close();
      journal.close();
    },
  };
}
