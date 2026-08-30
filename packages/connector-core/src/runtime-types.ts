import type { ConnectorPolicy, ProviderKind } from "./constants.js";

export interface ConnectorClock {
  nowMs(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface ProviderPort {
  readonly spawnRecord: {
    executable: string;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
    shell: false;
  };
  readonly containmentAttempts: number;
  readonly postTerminalDeliveries: number;
  start(request: Record<string, unknown>): AsyncIterable<unknown>;
  resume(request: Record<string, unknown>): AsyncIterable<unknown>;
  recover(request: Record<string, unknown>): AsyncIterable<unknown>;
  cancel(request: Record<string, unknown>): Promise<unknown>;
  contain(executionId: string): Promise<boolean>;
}

export interface ConnectorFoundationOptions {
  providerKind: ProviderKind;
  webhookPort: number;
  webhookToken: string;
  workingDirectory: string;
  policy: ConnectorPolicy;
  gatewayEndpoint: string;
  stateDirectory: string;
  provider: ProviderPort;
  providerProcessObserver?: {
    executable: string;
    arguments: readonly string[];
    inheritedEnvironment: Readonly<Record<string, string | undefined>>;
    webhookTokenEnvironmentName: string;
    observe(record: {
      executable: string;
      arguments: readonly string[];
      environment: Readonly<Record<string, string>>;
      shell: false;
      stdin: "ignore";
    }): void;
  };
  clock?: ConnectorClock;
  crashAfter?: string;
  failStateAfter?: string;
  failPairedStateWriteAfter?: "conversation_update";
  crashAtUnboundState?: "turn_running" | "waiting_for_approval";
  crashAfterCancellation?: boolean;
  crashAfterLostReplyUncertain?: boolean;
  crashForRecoveryState?: string;
  crashAfterReceived?: boolean;
  crashAfterTurnStarting?: boolean;
  proveNoProviderDispatch?: boolean;
  stallWebhookResponseAfterCommit?: boolean;
}

export const SYSTEM_CLOCK: ConnectorClock = {
  nowMs: () => Date.now(),
  setTimer(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimer(timer) {
    clearTimeout(timer as NodeJS.Timeout);
  },
};
