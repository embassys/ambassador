import { userInfo } from "node:os";
import { startConnectorFoundation } from "./connector.js";
import {
  ConnectorError,
  connectorError,
  type ProviderKind,
  WEBHOOK_TOKEN_PATTERN,
} from "./constants.js";
import { parseConnectorArgumentsForTest } from "./public-cli.js";
import type { ProviderPort } from "./runtime-types.js";
import {
  accountStateDirectory,
  ensureOwnerBeforeToken,
  retireConnectorStateForTest,
} from "./state.js";

export { startConnectorFoundation } from "./connector.js";
export { CONNECTOR_LIMITS } from "./constants.js";
export {
  buildProviderChildEnvironment,
  consumeProviderOutput,
} from "./provider-boundary.js";
export {
  enforcePolicyCeiling,
  parseConnectorArgumentsForTest,
} from "./public-cli.js";
export {
  initializeConnectorStateForTest,
  inspectConnectorStateForTest,
  retireConnectorStateForTest,
  seedConnectorConversationsForTest,
} from "./state.js";

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

function dormantProvider(provider: ProviderKind): ProviderPort {
  const unavailable = (): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<unknown>> {
          connectorError("connector_provider_unavailable");
        },
      };
    },
  });
  return {
    spawnRecord: {
      executable: provider,
      arguments: [],
      environment: {},
      shell: false,
    },
    containmentAttempts: 0,
    postTerminalDeliveries: 0,
    start: unavailable,
    resume: unavailable,
    recover: unavailable,
    async cancel() {
      return { accepted: false };
    },
    async contain() {
      return false;
    },
  };
}

function publicError(error: unknown): never {
  const candidate = error instanceof ConnectorError ? error.code : "connector_internal_error";
  const code = Object.hasOwn(EXIT_CODES, candidate) ? candidate : "connector_internal_error";
  process.stderr.write(`a2a connector: ${code}\n`);
  process.exit(EXIT_CODES[code] as number);
}

export async function runConnectorCli(provider: ProviderKind): Promise<void> {
  try {
    const parsed = parseConnectorArgumentsForTest(process.argv.slice(2));
    const stateDirectory = accountStateDirectory(userInfo().homedir, provider);
    if (parsed.command === "retire-state") {
      const result = await retireConnectorStateForTest({
        stateDirectory,
        providerKind: provider,
        arguments: process.argv.slice(2),
      });
      process.stdout.write(result.stdout);
      return;
    }

    ensureOwnerBeforeToken(stateDirectory);
    const token = process.env[parsed.webhookTokenEnvironmentName];
    if (token === undefined || !WEBHOOK_TOKEN_PATTERN.test(token)) {
      connectorError("webhook_token_unavailable");
    }
    const connector = await startConnectorFoundation({
      providerKind: provider,
      webhookPort: parsed.webhookPort,
      webhookToken: token,
      workingDirectory: parsed.workingDirectory,
      policy: parsed.policy,
      gatewayEndpoint: "http://127.0.0.1:8787/mcp",
      stateDirectory,
      provider: dormantProvider(provider),
    });
    process.stdout.write(`Connector webhook: ${connector.webhookUrl}\n`);
    const signal = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
      process.once("SIGINT", () => resolve("SIGINT"));
      process.once("SIGTERM", () => resolve("SIGTERM"));
    });
    const received = await Promise.race([signal, connector.waitForFatal()]);
    await connector.shutdown(received);
  } catch (error) {
    publicError(error);
  }
}
