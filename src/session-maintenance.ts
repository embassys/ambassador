import type { AcpSessionStore } from "./acp-session-store.js";
import { capabilityForKind } from "./agent-capabilities.js";
import { AcpSessionController, type AcpSessionControllerOptions } from "./direct-delivery.js";
import type { VerboseLogger } from "./verbose-log.js";

export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export class SessionMaintenance {
  #running: Promise<void> | undefined;
  constructor(
    readonly options: {
      readonly store: AcpSessionStore;
      readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
      readonly environment: NodeJS.ProcessEnv;
      readonly signal: AbortSignal;
      readonly nowMs: () => number;
      readonly log: VerboseLogger;
      readonly controller?: (
        capability: AcpSessionControllerOptions["capability"],
      ) => Pick<AcpSessionController, "delete">;
    },
  ) {}

  run(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    this.#running = this.#clean()
      .catch((error: unknown) => {
        this.options.log("acp.session.maintenance_failed", {
          error: error instanceof Error ? error.name : "Error",
        });
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async settled(): Promise<void> {
    await this.#running;
  }

  async #clean(): Promise<void> {
    const { store, serialize, signal, log } = this.options;
    const cutoff = Math.max(0, this.options.nowMs() - SESSION_RETENTION_MS);
    let after: { time: number; id: string } | undefined;
    while (!signal.aborted) {
      const batch = await serialize(async () => {
        if (signal.aborted) return undefined;
        const retired = store.retireIdle(cutoff);
        const pruned = store.pruneSettled(cutoff);
        return { retired, pruned, expired: store.expiredRetired(cutoff, after) };
      });
      if (batch === undefined) return;
      for (const record of batch.expired) {
        if (signal.aborted) return;
        if (record.retired_at_ms === undefined) throw new Error("Missing retirement timestamp");
        after = { time: record.retired_at_ms, id: record.session_id };
        // Release the provider operation queue between records so delivery and reads can proceed.
        await serialize(async () => {
          if (signal.aborted) return;
          const capability = capabilityForKind(record.agent_kind)?.direct;
          if (capability === undefined) {
            store.forget(record.session_id);
            return;
          }
          try {
            const controller =
              this.options.controller?.(capability) ??
              new AcpSessionController({
                capability,
                environment: this.options.environment,
                log,
              });
            const result = await controller.delete(record, signal);
            store.forget(record.session_id);
            log("acp.session.cleaned", { session_id: record.session_id, result });
          } catch (error) {
            log("acp.session.cleanup_failed", {
              session_id: record.session_id,
              error: error instanceof Error ? error.name : "Error",
            });
          }
        });
      }
      if (batch.expired.length < 32 && batch.retired < 64 && batch.pruned === 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
