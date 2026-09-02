import {
  CentralEnrollmentClient,
  CentralEnrollmentError,
  REST_BOOTSTRAP_TOOLS,
} from "./central-enrollment.js";
import { CentralProtectedTransport } from "./central-protected-transport.js";
import { CentralRestClient, CentralRestError, REST_AUTHENTICATED_TOOLS } from "./central-rest.js";
import { type CredentialStore, EncryptedFileCredentialStore } from "./credential-store.js";
import { DpopNonceCache } from "./dpop.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
import { type LocalMcpRouter, LocalMcpServer, LocalMcpToolError } from "./local-mcp.js";
import {
  assertSafeUpstreamResult,
  McpContractError,
  safeLocalToolArguments,
} from "./mcp-contract.js";
import { NotificationJournal, validateNotificationId } from "./notification-journal.js";
import {
  NotificationRelay,
  NotificationRelayError,
  RetryableNotificationReceiveError,
} from "./notification-relay.js";

export const CENTRAL_ORIGIN = "https://mcp.embassys.ai";
const CENTRAL_POLL_SECONDS = 30;

export interface GatewayApplicationOptions {
  readonly webhookUrl: string;
  readonly webhookToken: string;
  readonly journalPath: string;
  readonly credentialPath: string;
  readonly centralOrigin?: string;
  readonly centralFetch?: typeof fetch;
  readonly webhookFetch?: typeof fetch;
  readonly credentialStore?: CredentialStore;
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
  return new Error("Gateway operation failed");
}

function localError(error: unknown): LocalMcpToolError {
  if (error instanceof LocalMcpToolError) return error;
  if (error instanceof IdentityError) return new LocalMcpToolError(error.code);
  if (error instanceof CentralEnrollmentError) return new LocalMcpToolError(error.code);
  if (error instanceof CentralRestError) return new LocalMcpToolError(error.code);
  if (error instanceof McpContractError) return new LocalMcpToolError("invalid_arguments");
  if (error instanceof NotificationRelayError) return new LocalMcpToolError(error.code);
  return new LocalMcpToolError("gateway_operation_failed");
}

function timeout(arguments_: Record<string, unknown>): number {
  if (Object.keys(arguments_).some((key) => key !== "timeout")) throw new McpContractError();
  const value = arguments_.timeout ?? 30;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60) {
    throw new McpContractError();
  }
  return value as number;
}

export async function openGatewayApplication(
  options: GatewayApplicationOptions,
): Promise<RunningGatewayApplication> {
  const centralOrigin = options.centralOrigin ?? CENTRAL_ORIGIN;
  const nowSeconds = options.nowSeconds ?? (() => Date.now() / 1_000);
  const journal = new NotificationJournal(options.journalPath);
  const store =
    options.credentialStore ??
    new EncryptedFileCredentialStore(
      options.credentialPath,
      options.webhookToken,
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
  const acknowledgements = new Set<string>();
  let reportFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });

  const enrollment = new CentralEnrollmentClient({
    centralOrigin,
    ...(options.centralFetch === undefined ? {} : { fetch: options.centralFetch }),
    nowSeconds,
  });

  const requireRest = (): CentralRestClient => {
    if (rest === undefined) throw safeFailure();
    return rest;
  };
  const requireRelay = (): NotificationRelay => {
    if (relay === undefined) throw safeFailure();
    return relay;
  };

  const enableEnrolledIdentity = async (): Promise<void> => {
    if (rest !== undefined && relay !== undefined) return;
    if (activation !== undefined) return activation;
    activation = (async () => {
      const transport = new CentralProtectedTransport({
        credential: () => identity.credential(),
        nonceCache: new DpopNonceCache(),
        ...(options.centralFetch === undefined ? {} : { fetch: options.centralFetch }),
        now: nowSeconds,
      });
      const nextRest = new CentralRestClient({ centralOrigin, transport });
      const nextRelay = new NotificationRelay({
        journal,
        webhookUrl: options.webhookUrl,
        webhookToken: options.webhookToken,
        ...(options.webhookFetch === undefined ? {} : { fetch: options.webhookFetch }),
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
            if (error instanceof CentralRestError) {
              throw new NotificationRelayError("relay_failed");
            }
            throw error;
          }
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

  const router: LocalMcpRouter = {
    async listTools() {
      return [...(identity.enrolled ? REST_AUTHENTICATED_TOOLS : REST_BOOTSTRAP_TOOLS)];
    },
    async callTool(name, untrustedArguments, signal) {
      try {
        const arguments_ = safeLocalToolArguments(untrustedArguments);
        let result: Record<string, unknown>;
        if (!identity.enrolled) {
          switch (name) {
            case "register_agent":
              result = await enrollment.register(arguments_, signal);
              break;
            case "resend_verification":
              result = await enrollment.resend(arguments_, signal);
              break;
            case "verify_email":
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
          case "poll_messages":
            result = await requireRelay().pollMessages(timeout(arguments_), signal);
            break;
          case "get_my_permissions":
            if (Object.keys(arguments_).length !== 0) throw new McpContractError();
            result = { permissions: await requireRest().getMyPermissions(signal) };
            break;
          case "ack_message": {
            if (Object.keys(arguments_).length !== 1) throw new McpContractError();
            const messageId = validateNotificationId(arguments_.message_id);
            if (!requireRelay().hasCurrentMessage(messageId) || acknowledgements.has(messageId)) {
              throw new LocalMcpToolError("message_not_available");
            }
            acknowledgements.add(messageId);
            try {
              result = await requireRest().ackMessage({ message_id: messageId }, signal);
              if (!requireRelay().confirmAcknowledgement(messageId)) {
                throw new LocalMcpToolError("message_not_available");
              }
            } finally {
              acknowledgements.delete(messageId);
            }
            break;
          }
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
    local = new LocalMcpServer(options.webhookToken, router, {
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
