import type { AgentConfig } from "../config.js";
import { NotImplementedError } from "../errors.js";
import type { WakeAdapter } from "./types.js";

export interface AdapterFactoryOptions {
  env: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createWakeAdapter(
  _agent: AgentConfig,
  _options: AdapterFactoryOptions,
): WakeAdapter {
  throw new NotImplementedError("createWakeAdapter");
}
