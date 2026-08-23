import { setTimeout as delay } from "node:timers/promises";

import { ControllerRequestError } from "./controller.js";
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
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof ControllerRequestError && !error.retryable) throw error;
      options.onEvent?.({ code: "relay_iteration_failed" });
      try {
        await wait(
          error instanceof ControllerRequestError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : 1_000,
          signal,
        );
      } catch {
        if (!signal.aborted) throw new Error("Daemon retry delay failed");
      }
    }
  }
}
