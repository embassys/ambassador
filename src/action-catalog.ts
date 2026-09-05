import { Worker } from "node:worker_threads";
import type { CentralActionType, CentralRestClient } from "./central-rest.js";

export class ActionCatalogError extends Error {
  constructor(
    readonly code: "action_type_unknown" | "invalid_action_payload" | "action_schema_unsupported",
  ) {
    super("The requested action does not match its catalog contract");
    this.name = "ActionCatalogError";
  }
}

export class ActionCatalog {
  constructor(readonly central: Pick<CentralRestClient, "listActionTypes">) {}
  async require(
    name: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CentralActionType> {
    const action = (await this.central.listActionTypes(signal)).find(
      (entry) => entry.name === name,
    );
    if (action === undefined) throw new ActionCatalogError("action_type_unknown");
    if (payload !== undefined) await this.#validate(action.input_schema, payload, signal);
    return action;
  }
  async #validate(
    schema: Record<string, unknown>,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    // Catalog schemas can be created by peers. Bound compilation and regex execution
    // outside the gateway event loop, using the SDK's existing schema implementation.
    const worker = new Worker(new URL("./schema-validation-worker.js", import.meta.url), {
      workerData: { schema, payload },
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    worker.stdout?.resume();
    worker.stderr?.resume();
    let timeout: NodeJS.Timeout | undefined;
    let cancel = () => {};
    try {
      const valid = await new Promise<boolean>((resolve, reject) => {
        const unsupported = () => reject(new ActionCatalogError("action_schema_unsupported"));
        timeout = setTimeout(unsupported, 1_000);
        cancel = () => reject(signal?.reason ?? new Error("Validation cancelled"));
        signal?.addEventListener("abort", cancel, { once: true });
        worker.once("message", (result) => {
          if (typeof result === "boolean") resolve(result);
          else unsupported();
        });
        worker.once("error", unsupported);
        worker.once("exit", unsupported);
        if (signal?.aborted) cancel();
      });
      if (!valid) throw new ActionCatalogError("invalid_action_payload");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      await worker.terminate();
    }
  }
}
