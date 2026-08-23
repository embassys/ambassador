import { setTimeout as delay } from "node:timers/promises";

import type { Journal } from "./journal.js";
import type { Relay } from "./relay.js";

const SUCCESS_YIELD_MS = 100;

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

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}

export async function runDaemon(options: DaemonOptions, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;

  options.journal.recoverInFlight((options.now ?? Date.now)());
  const wait = options.sleep ?? sleep;

  while (!signal.aborted) {
    try {
      await options.relay.runOnce(signal);
      if (!signal.aborted) await wait(SUCCESS_YIELD_MS, signal);
    } catch {
      if (signal.aborted) break;
      options.onEvent?.({ code: "relay_iteration_failed" });
      try {
        await wait(1_000, signal);
      } catch {
        if (!signal.aborted) throw new Error("Daemon retry delay failed");
      }
    }
  }
}
