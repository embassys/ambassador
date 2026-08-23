import { NotImplementedError } from "./errors.js";
import type { Journal } from "./journal.js";
import type { Relay } from "./relay.js";

export interface DaemonEvent {
  code: "relay_iteration_failed";
}

export interface DaemonOptions {
  relay: Pick<Relay, "runOnce">;
  journal: Pick<Journal, "recoverInFlight">;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: DaemonEvent) => void;
}

export async function runDaemon(_options: DaemonOptions, _signal: AbortSignal): Promise<void> {
  throw new NotImplementedError("runDaemon");
}
