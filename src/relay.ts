import type { WakeAdapter } from "./adapters/types.js";
import type { AgentConfig, SidecarConfig } from "./config.js";
import type { ControllerClient } from "./controller.js";
import { NotImplementedError } from "./errors.js";
import type { Journal } from "./journal.js";

export interface RelayOptions {
  config: SidecarConfig;
  journal: Journal;
  controller: ControllerClient;
  createAdapter: (agent: AgentConfig) => WakeAdapter;
  now?: () => number;
  random?: () => number;
}

export class Relay {
  constructor(_options: RelayOptions) {
    throw new NotImplementedError("Relay.constructor");
  }

  async runOnce(_signal: AbortSignal): Promise<void> {
    throw new NotImplementedError("Relay.runOnce");
  }
}
