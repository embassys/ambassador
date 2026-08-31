import { userInfo } from "node:os";
import { startConnector } from "./connector.js";
import {
  ConnectorError,
  type ConnectorPolicy,
  connectorError,
  type ProviderKind,
  WEBHOOK_TOKEN_PATTERN,
} from "./constants.js";
import { parseConnectorArguments } from "./public-cli.js";
import type { ProviderPort } from "./runtime-types.js";
import { accountStateDirectory, reserveConnectorState, retireConnectorState } from "./state.js";

interface ProviderFactoryOptions {
  readonly workingDirectory: string;
  readonly policy: ConnectorPolicy;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly webhookTokenEnvironmentName: string;
}

type ManagedProvider = ProviderPort & { close(deadlineUnixMs: number): Promise<void> };
type ProviderFactory = (options: ProviderFactoryOptions) => Promise<ManagedProvider>;

const EXIT_CODES: Readonly<Record<string, number>> = {
  connector_internal_error: 1,
  invalid_connector_arguments: 2,
  webhook_token_unavailable: 4,
  connector_already_running: 7,
  connector_scope_mismatch: 7,
  connector_state_unavailable: 7,
  connector_state_retired: 7,
  connector_state_retire_refused: 7,
  connector_state_filesystem_unqualified: 7,
  connector_listener_unavailable: 8,
  connector_message_blocked: 1,
  connector_conversation_unavailable: 1,
  connector_provider_cleanup_incomplete: 1,
  connector_gateway_operation_failed: 1,
  connector_shutdown_incomplete: 1,
};

function publicError(error: unknown): never {
  const candidate = error instanceof ConnectorError ? error.code : "connector_internal_error";
  const code = Object.hasOwn(EXIT_CODES, candidate) ? candidate : "connector_internal_error";
  process.stderr.write(`a2a connector: ${code}\n`);
  process.exit(EXIT_CODES[code] as number);
}

export async function runConnectorCli(
  provider: ProviderKind,
  providerFactory?: ProviderFactory,
): Promise<void> {
  try {
    const parsed = parseConnectorArguments(process.argv.slice(2));
    const stateDirectory = accountStateDirectory(userInfo().homedir, provider);
    const reservation = reserveConnectorState(stateDirectory, parsed.command === "retire-state");
    try {
      if (parsed.command === "retire-state") {
        const result = await retireConnectorState({
          stateDirectory,
          providerKind: provider,
          arguments: process.argv.slice(2),
          reservation,
        });
        process.stdout.write(result.stdout);
        return;
      }

      const token = process.env[parsed.webhookTokenEnvironmentName];
      if (token === undefined || !WEBHOOK_TOKEN_PATTERN.test(token)) {
        connectorError("webhook_token_unavailable");
      }
      const connector = await startConnector({
        providerKind: provider,
        webhookPort: parsed.webhookPort,
        webhookToken: token,
        workingDirectory: parsed.workingDirectory,
        policy: parsed.policy,
        stateReservation: reservation,
        ...(providerFactory === undefined
          ? {}
          : {
              providerFactory: async (options) =>
                await providerFactory({
                  ...options,
                  inheritedEnvironment: process.env,
                  webhookTokenEnvironmentName: parsed.webhookTokenEnvironmentName,
                }),
            }),
      });
      const signal = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
        process.once("SIGINT", () => resolve("SIGINT"));
        process.once("SIGTERM", () => resolve("SIGTERM"));
      });
      process.stdout.write(`Connector webhook: ${connector.webhookUrl}\n`);
      const received = await Promise.race([signal, connector.waitForFatal()]);
      await connector.shutdown(received);
    } finally {
      reservation.close();
    }
  } catch (error) {
    publicError(error);
  }
}
