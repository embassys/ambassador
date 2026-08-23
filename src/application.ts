import type { FetchLike } from "./adapters/types.js";
import type { SidecarConfig } from "./config.js";
import type { DaemonEvent } from "./daemon.js";
import { NotImplementedError } from "./errors.js";

export interface SidecarApplicationOptions {
  config: SidecarConfig;
  journalPath: string;
  lockPath: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => number;
  random?: () => number;
  idGenerator?: () => string;
  onEvent?: (event: DaemonEvent) => void;
}

export class SidecarApplication {
  static async open(_options: SidecarApplicationOptions): Promise<SidecarApplication> {
    throw new NotImplementedError("SidecarApplication.open");
  }

  async runOnce(_signal: AbortSignal): Promise<void> {
    throw new NotImplementedError("SidecarApplication.runOnce");
  }

  async run(_signal: AbortSignal): Promise<void> {
    throw new NotImplementedError("SidecarApplication.run");
  }

  async close(): Promise<void> {
    throw new NotImplementedError("SidecarApplication.close");
  }
}
