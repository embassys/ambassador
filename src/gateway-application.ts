import type { AgentCapability } from "./agent-capabilities.js";
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
import { DirectDeliveryTarget } from "./direct-delivery.js";
import { DpopNonceCache } from "./dpop.js";
import { GuidedRegistration, GuidedRegistrationError } from "./guided-registration.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
import { type LocalMcpRouter, LocalMcpServer, LocalMcpToolError } from "./local-mcp.js";
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
import { WebhookDeliveryTarget } from "./webhook-delivery.js";
import {
  EncryptedFileWebhookSecretStore,
  type WebhookSecretStore,
} from "./webhook-secret-store.js";

export const CENTRAL_ORIGIN = "https://mcp.embassys.ai";
const CENTRAL_POLL_SECONDS = 30;

export interface DeliveryTargetContext {
  readonly profile: DeliveryProfile;
  readonly capability: AgentCapability;
  readonly endpoint: string;
}

export interface GatewayApplicationOptions {
  readonly journalPath: string;
  readonly credentialPath: string;
  readonly credentialKeyPath: string;
  readonly webhookSecretPath: string;
  readonly webhookSecretKeyPath: string;
  readonly profilePath: string;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly centralOrigin?: string;
  readonly centralFetch?: typeof fetch;
  readonly webhookFetch?: typeof fetch;
  readonly credentialStore?: CredentialStore;
  readonly webhookSecretStore?: WebhookSecretStore;
  readonly deliveryTargetFactory?: (context: DeliveryTargetContext) => DeliveryTarget;
  readonly localMcpPort?: number;
  readonly nowSeconds?: () => number;
  readonly signal?: AbortSignal;
}

export interface RunningGatewayApplication {
  readonly endpoint: string;
  readonly failure: Promise<Error>;
  close(): Promise<void>;
}

function safeFailure(): Error {
  return new Error("Ambassador operation failed");
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
  const journal = new NotificationJournal(options.journalPath);
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
  let closed = false;
  let activation: Promise<void> | undefined;
  let reportFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });

  const enrollment = new CentralEnrollmentClient({
    centralOrigin,
    ...(options.centralFetch === undefined ? {} : { fetch: options.centralFetch }),
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
    if (options.deliveryTargetFactory !== undefined) {
      return options.deliveryTargetFactory(context);
    }
    if (context.profile.mode === "webhook") {
      const secret = await webhookSecretStore.load();
      if (secret === undefined) throw new DeliveryProfileError("invalid_profile");
      return new WebhookDeliveryTarget({
        url: context.profile.url,
        secret,
        now: () => nowSeconds() * 1_000,
        ...(options.webhookFetch === undefined ? {} : { fetch: options.webhookFetch }),
      });
    }
    if (context.capability.direct === undefined) {
      throw new DeliveryProfileError("incompatible_profile");
    }
    return new DirectDeliveryTarget({
      capability: context.capability.direct,
      workingDirectory: context.profile.working_directory,
      environment: options.environment,
      mcpEndpoint: context.endpoint,
    });
  };

  const enableEnrolledIdentity = async (): Promise<void> => {
    if (rest !== undefined && relay !== undefined) return;
    if (activation !== undefined) return activation;
    activation = (async () => {
      const profile = await loadProfile();
      const transport = new CentralProtectedTransport({
        credential: () => identity.credential(),
        nonceCache: new DpopNonceCache(),
        ...(options.centralFetch === undefined ? {} : { fetch: options.centralFetch }),
        now: nowSeconds,
      });
      const nextRest = new CentralRestClient({ centralOrigin, transport });
      const target = await createDeliveryTarget({ ...profile, endpoint: local.endpoint });
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
      });
      rest = nextRest;
      relay = nextRelay;
      relayRun = nextRelay.run(lifetimeSignal);
      void relayRun.catch((error: unknown) => {
        if (!closed && !lifetimeSignal.aborted) {
          reportFailure?.(error instanceof Error ? error : safeFailure());
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

  const router: LocalMcpRouter = {
    async listTools() {
      return [...(identity.enrolled ? REST_AUTHENTICATED_TOOLS : REST_BOOTSTRAP_TOOLS)];
    },
    async callTool(name, untrustedArguments, signal, clientInfo) {
      try {
        const arguments_ = safeLocalToolArguments(untrustedArguments);
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
              await local.sendToolListChanged();
              break;
            default:
              throw new LocalMcpToolError("tool_not_found");
          }
          assertSafeUpstreamResult(result);
          return result;
        }

        switch (name) {
          case "list_action_types":
            result = { action_types: await requireRest().listActionTypes(signal) };
            break;
          case "request_permission":
            result = await requireRest().requestPermission(arguments_, signal);
            break;
          case "respond_to_permission":
            result = await requireRest().respondToPermission(arguments_, signal);
            break;
          case "call_action":
            result = await requireRest().callAction(arguments_, signal);
            break;
          case "submit_action_result":
            result = await requireRest().submitActionResult(arguments_, signal);
            break;
          case "get_my_permissions":
            if (Object.keys(arguments_).length !== 0) throw new McpContractError();
            result = { permissions: await requireRest().getMyPermissions(signal) };
            break;
          default:
            throw new LocalMcpToolError("tool_not_found");
        }
        assertSafeUpstreamResult(result, identity.credential().record.access_token);
        return result;
      } catch (error) {
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
    await relay?.shutdown().catch(() => undefined);
    await local?.close().catch(() => undefined);
    journal.close();
    throw error;
  }

  return {
    endpoint: local.endpoint,
    failure,
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      await relay?.shutdown().catch(() => undefined);
      await relayRun?.catch(() => undefined);
      await local.close();
      journal.close();
    },
  };
}
