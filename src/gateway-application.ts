import {
  CentralEnrollmentClient,
  CentralEnrollmentError,
  type CentralTokenProfile,
  REST_BOOTSTRAP_TOOLS,
} from "./central-enrollment.js";
import { CentralMcpClient, CentralMcpError } from "./central-mcp.js";
import { CentralProtectedTransport } from "./central-protected-transport.js";
import { CentralReissueController } from "./central-reissue.js";
import { type CredentialStore, EncryptedFileCredentialStore } from "./credential-store.js";
import type { DevelopmentVerboseTranscript } from "./development-verbose.js";
import { DpopNonceCache } from "./dpop.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
import { type LocalMcpRouter, LocalMcpServer, LocalMcpToolError } from "./local-mcp.js";
import {
  assertSafeUpstreamResult,
  type CentralToolDefinition,
  localToolDefinition,
  McpContractError,
  safeLocalToolArguments,
  selectCentralTools,
  upstreamToolArguments,
} from "./mcp-contract.js";
import { NotificationJournal, validateNotificationId } from "./notification-journal.js";
import { NotificationRelay, NotificationRelayError } from "./notification-relay.js";

const MCP_NOTIFICATION_POLL_SECONDS = 20;

export interface GatewayApplicationOptions {
  webhookUrl: string;
  webhookToken: string;
  journalPath: string;
  credentialPath: string;
  centralApiUrl?: string;
  centralMcpUrl?: string;
  centralEnrollmentProfile?: CentralTokenProfile;
  centralEnrollmentFetch?: typeof fetch;
  credentialStore?: CredentialStore;
  verboseTranscript?: DevelopmentVerboseTranscript;
}

export interface RunningGatewayApplication {
  endpoint: string;
  failure: Promise<Error>;
  close(): Promise<void>;
}

function safeFailure(): Error {
  return new Error("Gateway operation failed");
}

function credentialScope(options: GatewayApplicationOptions): string {
  return JSON.stringify({
    centralApiUrl: options.centralApiUrl === undefined ? null : new URL(options.centralApiUrl).href,
    centralMcpUrl: options.centralMcpUrl === undefined ? null : new URL(options.centralMcpUrl).href,
  });
}

function contentAcknowledgement(
  result: Record<string, unknown>,
  arguments_: Record<string, unknown>,
): string {
  const keys = Object.keys(result).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "message_id" ||
    keys[1] !== "status" ||
    typeof result.message_id !== "string" ||
    result.message_id !== arguments_.message_id ||
    result.status !== "acked"
  ) {
    throw new McpContractError();
  }
  return validateNotificationId(result.message_id);
}

function pollTimeout(arguments_: Record<string, unknown>): number {
  const keys = Object.keys(arguments_);
  if (keys.some((key) => key !== "timeout")) throw new McpContractError();
  if (arguments_.timeout === undefined) return 30;
  if (
    typeof arguments_.timeout !== "number" ||
    !Number.isInteger(arguments_.timeout) ||
    arguments_.timeout < 0 ||
    arguments_.timeout > 60
  ) {
    throw new McpContractError();
  }
  return Math.min(arguments_.timeout, 30);
}

function rethrowMcpNotificationPollError(error: unknown): never {
  if (error instanceof NotificationRelayError) throw error;
  if (error instanceof McpContractError) {
    throw new NotificationRelayError(
      "invalid_notification_response",
      "Central notification response is invalid",
    );
  }
  if (error instanceof CentralMcpError) {
    switch (error.code) {
      case "central_mcp_authentication_failed":
        throw new NotificationRelayError(
          "central_authentication_failed",
          "Central authentication failed",
        );
      case "central_mcp_redirect_rejected":
        throw new NotificationRelayError(
          "central_redirect_rejected",
          "Central notification redirect was rejected",
        );
      case "central_mcp_response_invalid":
        throw new NotificationRelayError(
          "invalid_notification_response",
          "Central notification response is invalid",
        );
      case "central_mcp_response_too_large":
        throw new NotificationRelayError(
          "notification_response_too_large",
          "Central notification response exceeded its size limit",
        );
      case "central_mcp_closed":
      case "invalid_configuration":
        throw new NotificationRelayError("relay_failed", "Notification relay failed");
      default:
        break;
    }
  }
  throw error;
}

export async function openGatewayApplication(
  options: GatewayApplicationOptions,
): Promise<RunningGatewayApplication> {
  const journal = new NotificationJournal(options.journalPath);
  const credentialStore =
    options.credentialStore ??
    new EncryptedFileCredentialStore(
      options.credentialPath,
      options.webhookToken,
      credentialScope(options),
    );
  const central =
    options.centralMcpUrl === undefined
      ? undefined
      : new CentralMcpClient({
          centralMcpUrl: options.centralMcpUrl,
          ...(options.verboseTranscript === undefined
            ? {}
            : { verboseTranscript: options.verboseTranscript }),
        });
  const protectedNonces = new DpopNonceCache();
  const enrollment =
    options.centralApiUrl === undefined || options.centralEnrollmentProfile === undefined
      ? undefined
      : new CentralEnrollmentClient({
          centralApiUrl: options.centralApiUrl,
          tokenProfile: options.centralEnrollmentProfile,
          ...(options.centralEnrollmentFetch === undefined
            ? {}
            : { fetch: options.centralEnrollmentFetch }),
          ...(options.verboseTranscript === undefined
            ? {}
            : { verboseTranscript: options.verboseTranscript }),
        });
  const controller = new AbortController();
  let identity: GatewayIdentity | undefined;
  let protectedCentral: CentralMcpClient | undefined;
  let protectedCatalog: readonly CentralToolDefinition[] | undefined;
  let reissue: CentralReissueController | undefined;
  let relay: NotificationRelay | undefined;
  let relayRun: Promise<void> | undefined;
  let local: LocalMcpServer;
  let closed = false;
  let reportFailure: ((error: Error) => void) | undefined;
  const enrollmentOperations = new Set<Promise<unknown>>();
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });

  const requireCentral = (): CentralMcpClient => {
    const selected = identity?.credentialVersion === 2 ? protectedCentral : central;
    if (selected === undefined) throw safeFailure();
    return selected;
  };

  const requireEnrollment = (): CentralEnrollmentClient => {
    if (enrollment === undefined) throw safeFailure();
    return enrollment;
  };

  const requireIdentity = (): GatewayIdentity => {
    if (identity === undefined) throw safeFailure();
    return identity;
  };

  const requireRelay = (): NotificationRelay => {
    if (relay === undefined) throw safeFailure();
    return relay;
  };

  const runEnrollment = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operation();
    enrollmentOperations.add(pending);
    try {
      return await pending;
    } finally {
      enrollmentOperations.delete(pending);
    }
  };

  const enableProtectedIdentity = (): void => {
    if (protectedCentral !== undefined || reissue !== undefined) return;
    const currentIdentity = requireIdentity();
    const credential = currentIdentity.authenticatedCredentialV2();
    if (options.centralApiUrl === undefined || options.centralMcpUrl === undefined) {
      throw safeFailure();
    }
    options.verboseTranscript?.addSecret(credential.record.access_token);
    options.verboseTranscript?.addSecret(credential.record.dpop_private_key_pkcs8);
    const mcpTransport = new CentralProtectedTransport({
      domain: "mcp",
      credential: () => currentIdentity.authenticatedCredentialV2(),
      nonceCache: protectedNonces,
      ...(options.verboseTranscript === undefined
        ? {}
        : { verboseTranscript: options.verboseTranscript }),
    });
    protectedCentral = new CentralMcpClient({
      centralMcpUrl: options.centralMcpUrl,
      fetch: async (url, init) => await mcpTransport.fetch(url, init),
      ...(options.verboseTranscript === undefined
        ? {}
        : { verboseTranscript: options.verboseTranscript }),
    });
    const apiTransport = new CentralProtectedTransport({
      domain: "api",
      credential: () => currentIdentity.authenticatedCredentialV2(),
      nonceCache: protectedNonces,
      ...(options.verboseTranscript === undefined
        ? {}
        : { verboseTranscript: options.verboseTranscript }),
    });
    reissue = new CentralReissueController({
      centralApiUrl: options.centralApiUrl,
      identity: currentIdentity,
      transport: apiTransport,
      ...(options.verboseTranscript === undefined
        ? {}
        : { verboseTranscript: options.verboseTranscript }),
    });
    reissue.start();
  };

  const remoteTool = async (
    name: string,
    enrolled: boolean,
    signal: AbortSignal,
  ): Promise<CentralToolDefinition> => {
    if (identity?.credentialVersion === 2 && protectedCatalog !== undefined) {
      const cached = protectedCatalog.find((candidate) => candidate.name === name);
      if (cached === undefined) throw new McpContractError();
      return cached;
    }
    const catalog = await requireCentral().listTools(signal);
    const selected = selectCentralTools(catalog, enrolled);
    if (identity?.credentialVersion === 2) protectedCatalog = selected;
    const tool = selected.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new McpContractError();
    return tool;
  };

  const stopRelayForAuthenticationFailure = async (): Promise<void> => {
    requireIdentity().markAuthenticationFailed();
    protectedCatalog = undefined;
    await relay?.shutdown().catch(() => undefined);
    relay = undefined;
    await local.sendToolListChanged().catch(() => undefined);
  };

  const startRelay = (centralToken: string): void => {
    if (relay !== undefined) return;
    if (options.centralApiUrl === undefined) throw safeFailure();
    options.verboseTranscript?.addSecret(centralToken);
    const nextRelay = new NotificationRelay({
      journal,
      centralApiUrl: options.centralApiUrl,
      centralToken,
      webhookUrl: options.webhookUrl,
      webhookToken: options.webhookToken,
      ...(options.verboseTranscript === undefined
        ? {}
        : { verboseTranscript: options.verboseTranscript }),
      pollMessagesThroughMcp: async (signal) => {
        try {
          const result = await requireCentral().callTool(
            "poll_messages",
            { token: centralToken, timeout: MCP_NOTIFICATION_POLL_SECONDS },
            signal,
            centralToken,
          );
          assertSafeUpstreamResult(result, centralToken);
          return result;
        } catch (error) {
          rethrowMcpNotificationPollError(error);
        }
      },
    });
    relay = nextRelay;
    relayRun = nextRelay.run(controller.signal).catch(async (error: unknown) => {
      if (
        error instanceof NotificationRelayError &&
        error.code === "central_authentication_failed"
      ) {
        await stopRelayForAuthenticationFailure();
        return;
      }
      relay = undefined;
      reportFailure?.(safeFailure());
      reportFailure = undefined;
    });
  };

  const router: LocalMcpRouter = {
    async listTools() {
      const currentIdentity = requireIdentity();
      if (!currentIdentity.enrolled && enrollment !== undefined) {
        return [...REST_BOOTSTRAP_TOOLS];
      }
      if (currentIdentity.credentialVersion === 2) {
        try {
          const credential = currentIdentity.authenticatedCredentialV2();
          if (credential.token.expiresAt <= Math.floor(Date.now() / 1_000)) return [];
          const catalog = await requireCentral().listTools();
          const selected = selectCentralTools(catalog, true);
          protectedCatalog = selected;
          const localCatalog = selected.map(localToolDefinition);
          assertSafeUpstreamResult(localCatalog, credential.record.access_token);
          return localCatalog;
        } catch (error) {
          if (
            error instanceof CentralMcpError &&
            error.code === "central_mcp_authentication_failed"
          ) {
            await stopRelayForAuthenticationFailure();
          }
          throw safeFailure();
        }
      }
      const catalog = await requireCentral().listTools();
      const localCatalog = selectCentralTools(catalog, currentIdentity.enrolled).map(
        localToolDefinition,
      );
      const centralToken = currentIdentity.enrolled
        ? currentIdentity.authenticatedToken()
        : undefined;
      assertSafeUpstreamResult(localCatalog, centralToken);
      return localCatalog;
    },

    async callTool(name, arguments_, signal) {
      const currentIdentity = requireIdentity();
      try {
        if (!currentIdentity.enrolled) {
          if (enrollment !== undefined) {
            const enrollmentSignal = AbortSignal.any([signal, controller.signal]);
            if (name === "verify_email") {
              const localResult = await runEnrollment(
                async () =>
                  await currentIdentity.enrollCredentialV2(
                    async () => await requireEnrollment().verify(arguments_, enrollmentSignal),
                  ),
              );
              enableProtectedIdentity();
              await local.sendToolListChanged();
              return localResult;
            }
            if (name === "register_agent") {
              return await runEnrollment(
                async () => await requireEnrollment().register(arguments_, enrollmentSignal),
              );
            }
            if (name === "resend_verification") {
              return await runEnrollment(
                async () => await requireEnrollment().resend(arguments_, enrollmentSignal),
              );
            }
            throw new McpContractError();
          }
          if (name === "verify_email") {
            const localResult = await currentIdentity.verify(async () => {
              const tool = await remoteTool(name, false, signal);
              const upstreamArguments = upstreamToolArguments(tool, arguments_, undefined);
              return await requireCentral().callTool(name, upstreamArguments, signal);
            });
            const centralToken = currentIdentity.authenticatedToken();
            startRelay(centralToken);
            await local.sendToolListChanged();
            return localResult;
          }

          const tool = await remoteTool(name, false, signal);
          const upstreamArguments = upstreamToolArguments(tool, arguments_, undefined);
          const result = await requireCentral().callTool(name, upstreamArguments, signal);
          assertSafeUpstreamResult(result);
          return result;
        }

        if (currentIdentity.credentialVersion === 2) {
          const credential = currentIdentity.authenticatedCredentialV2();
          if (credential.token.expiresAt <= Math.floor(Date.now() / 1_000)) {
            throw new McpContractError();
          }
          const tool = await remoteTool(name, true, signal);
          const upstreamArguments = upstreamToolArguments(tool, arguments_, undefined);
          const result = await requireCentral().callTool(
            name,
            upstreamArguments,
            signal,
            credential.record.access_token,
          );
          assertSafeUpstreamResult(result, credential.record.access_token);
          return result;
        }

        const centralToken = currentIdentity.authenticatedToken();
        if (name === "poll_messages") {
          const localArguments = safeLocalToolArguments(arguments_);
          const result = await requireRelay().pollMessages(pollTimeout(localArguments), signal);
          assertSafeUpstreamResult(result, centralToken);
          return result;
        }
        const tool = await remoteTool(name, true, signal);
        const upstreamArguments = upstreamToolArguments(tool, arguments_, centralToken);
        const result = await requireCentral().callTool(
          name,
          upstreamArguments,
          signal,
          centralToken,
        );
        assertSafeUpstreamResult(result, centralToken);
        if (name === "ack_message") {
          requireRelay().confirmContentAcknowledgement(contentAcknowledgement(result, arguments_));
        }
        return result;
      } catch (error) {
        options.verboseTranscript?.record({
          boundary: "gateway",
          direction: "error",
          body: {
            tool: name,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { value: String(error) },
          },
        });
        if (
          error instanceof CentralMcpError &&
          error.code === "central_mcp_authentication_failed"
        ) {
          await stopRelayForAuthenticationFailure();
        }
        if (
          error instanceof CentralEnrollmentError ||
          error instanceof CentralMcpError ||
          error instanceof IdentityError ||
          error instanceof McpContractError
        ) {
          if (error instanceof CentralEnrollmentError) {
            throw new LocalMcpToolError(error.code);
          }
          throw safeFailure();
        }
        throw safeFailure();
      }
    },
  };

  local = new LocalMcpServer(options.webhookToken, router, {
    ...(options.verboseTranscript === undefined
      ? {}
      : { verboseTranscript: options.verboseTranscript }),
  });
  try {
    await local.listen();
    identity = await GatewayIdentity.open(credentialStore);
    if (identity.enrolled) {
      if (identity.credentialVersion === 2) enableProtectedIdentity();
      else startRelay(identity.authenticatedToken());
    }
  } catch (error) {
    controller.abort();
    await local.close().catch(() => undefined);
    await central?.close().catch(() => undefined);
    await reissue?.close().catch(() => undefined);
    await protectedCentral?.close().catch(() => undefined);
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
      await Promise.allSettled([...enrollmentOperations]);
      await local.close();
      await relay?.shutdown().catch(() => undefined);
      await relayRun?.catch(() => undefined);
      await reissue?.close().catch(() => undefined);
      await protectedCentral?.close().catch(() => undefined);
      await central?.close().catch(() => undefined);
      journal.close();
    },
  };
}
