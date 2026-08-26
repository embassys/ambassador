import { CentralMcpClient, CentralMcpError } from "./central-mcp.js";
import { type CredentialStore, EncryptedFileCredentialStore } from "./credential-store.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
import { type LocalMcpRouter, LocalMcpServer } from "./local-mcp.js";
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

export interface GatewayApplicationOptions {
  webhookUrl: string;
  webhookToken: string;
  journalPath: string;
  credentialPath: string;
  centralApiUrl?: string;
  centralMcpUrl?: string;
  credentialStore?: CredentialStore;
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
      : new CentralMcpClient({ centralMcpUrl: options.centralMcpUrl });
  const controller = new AbortController();
  let identity: GatewayIdentity | undefined;
  let relay: NotificationRelay | undefined;
  let relayRun: Promise<void> | undefined;
  let local: LocalMcpServer;
  let closed = false;
  let reportFailure: ((error: Error) => void) | undefined;
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });

  const requireCentral = (): CentralMcpClient => {
    if (central === undefined) throw safeFailure();
    return central;
  };

  const requireIdentity = (): GatewayIdentity => {
    if (identity === undefined) throw safeFailure();
    return identity;
  };

  const requireRelay = (): NotificationRelay => {
    if (relay === undefined) throw safeFailure();
    return relay;
  };

  const remoteTool = async (
    name: string,
    enrolled: boolean,
    signal: AbortSignal,
  ): Promise<CentralToolDefinition> => {
    const catalog = await requireCentral().listTools(signal);
    const selected = selectCentralTools(catalog, enrolled);
    const tool = selected.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new McpContractError();
    return tool;
  };

  const stopRelayForAuthenticationFailure = async (): Promise<void> => {
    requireIdentity().markAuthenticationFailed();
    await relay?.shutdown().catch(() => undefined);
    relay = undefined;
    await local.sendToolListChanged().catch(() => undefined);
  };

  const startRelay = (centralToken: string): void => {
    if (relay !== undefined) return;
    if (options.centralApiUrl === undefined) throw safeFailure();
    const nextRelay = new NotificationRelay({
      journal,
      centralApiUrl: options.centralApiUrl,
      centralToken,
      webhookUrl: options.webhookUrl,
      webhookToken: options.webhookToken,
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

        const centralToken = currentIdentity.authenticatedToken();
        const tool = await remoteTool(name, true, signal);
        if (name === "poll_messages") {
          const localArguments = safeLocalToolArguments(arguments_);
          const result = await requireRelay().pollMessages(pollTimeout(localArguments), signal);
          assertSafeUpstreamResult(result, centralToken);
          return result;
        }
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
        if (
          error instanceof CentralMcpError &&
          error.code === "central_mcp_authentication_failed"
        ) {
          await stopRelayForAuthenticationFailure();
        }
        if (
          error instanceof CentralMcpError ||
          error instanceof IdentityError ||
          error instanceof McpContractError
        ) {
          throw safeFailure();
        }
        throw safeFailure();
      }
    },
  };

  local = new LocalMcpServer(options.webhookToken, router);
  try {
    await local.listen();
    identity = await GatewayIdentity.open(credentialStore);
    if (identity.enrolled) startRelay(identity.authenticatedToken());
  } catch (error) {
    controller.abort();
    await local.close().catch(() => undefined);
    await central?.close().catch(() => undefined);
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
      await local.close();
      await relay?.shutdown().catch(() => undefined);
      await relayRun?.catch(() => undefined);
      await central?.close().catch(() => undefined);
      journal.close();
    },
  };
}
