import { CentralMcpClient, CentralMcpError } from "./central-mcp.js";
import { type CredentialStore, EncryptedFileCredentialStore } from "./credential-store.js";
import { GatewayIdentity, IdentityError } from "./identity.js";
import { type LocalMcpRouter, LocalMcpServer } from "./local-mcp.js";
import {
  assertSafeUpstreamResult,
  type CentralToolDefinition,
  localToolDefinition,
  McpContractError,
  selectCentralTools,
  upstreamToolArguments,
} from "./mcp-contract.js";
import { NotificationJournal, validateNotificationId } from "./notification-journal.js";
import { NotificationRelay, NotificationRelayError } from "./notification-relay.js";

const BOOTSTRAP_DEFINITIONS: CentralToolDefinition[] = [
  {
    name: "register_agent",
    description: "Register this agent with A2A.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        email: { type: "string" },
        display_name: { type: "string" },
      },
      required: ["username", "email"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_email",
    description: "Verify this agent's email address.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" }, code: { type: "string" } },
      required: ["email", "code"],
      additionalProperties: false,
    },
  },
  {
    name: "resend_verification",
    description: "Resend this agent's verification code.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
      additionalProperties: false,
    },
  },
];

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
  close(): Promise<void>;
}

function safeFailure(): Error {
  return new Error("Gateway operation failed");
}

function contentAcknowledgement(
  result: Record<string, unknown>,
  arguments_: Record<string, unknown>,
): string {
  const keys = Object.keys(result).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "acknowledged" ||
    keys[1] !== "message_id" ||
    result.acknowledged !== true ||
    typeof result.message_id !== "string" ||
    result.message_id !== arguments_.message_id
  ) {
    throw new McpContractError();
  }
  return validateNotificationId(result.message_id);
}

export async function openGatewayApplication(
  options: GatewayApplicationOptions,
): Promise<RunningGatewayApplication> {
  const journal = new NotificationJournal(options.journalPath);
  const credentialStore =
    options.credentialStore ??
    new EncryptedFileCredentialStore(options.credentialPath, options.webhookToken);
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

  const requireCentral = (): CentralMcpClient => {
    if (central === undefined) throw safeFailure();
    return central;
  };

  const requireIdentity = (): GatewayIdentity => {
    if (identity === undefined) throw safeFailure();
    return identity;
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
      }
    });
  };

  const router: LocalMcpRouter = {
    async listTools() {
      const currentIdentity = requireIdentity();
      if (!currentIdentity.enrolled) {
        return BOOTSTRAP_DEFINITIONS.map(localToolDefinition);
      }
      currentIdentity.authenticatedToken();
      const catalog = await requireCentral().listTools();
      return selectCentralTools(catalog, true).map(localToolDefinition);
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
        const upstreamArguments = upstreamToolArguments(tool, arguments_, centralToken);
        const result = await requireCentral().callTool(name, upstreamArguments, signal);
        assertSafeUpstreamResult(result, centralToken);
        if (name === "ack_message") {
          relay?.confirmContentAcknowledgement(contentAcknowledgement(result, arguments_));
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
