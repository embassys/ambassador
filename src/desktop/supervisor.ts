import type { DesktopCommand, GatewaySnapshot } from "./protocol.js";

interface GatewayProcess {
  available(): boolean;
  snapshot(): GatewaySnapshot;
  request(command: DesktopCommand): Promise<unknown>;
  close(): Promise<void>;
}

export class SupervisedGateway {
  #client: GatewayProcess | undefined;
  #wanted = false;
  #closed = false;
  #attempts = 0;
  #cancel: (() => void) | undefined;
  #generation = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #error: string | undefined;
  constructor(
    readonly options: {
      id: string;
      create(changed: () => void): GatewayProcess;
      onChange?: () => void;
      schedule?: (callback: () => void, delay: number) => () => void;
    },
  ) {}

  snapshot(): GatewaySnapshot {
    const snapshot = this.#client?.snapshot() ?? { id: this.options.id, state: "stopped" };
    return this.#error ? { id: this.options.id, state: "error", error: this.#error } : snapshot;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #process(): Promise<GatewayProcess> {
    if (this.#closed) throw new Error("This server supervisor is closed.");
    if (!this.#client?.available()) {
      await this.#client?.close();
      const generation = ++this.#generation;
      this.#client = this.options.create(() => {
        if (generation !== this.#generation) return;
        this.options.onChange?.();
        if (!this.#client?.available()) this.#recover();
      });
    }
    return this.#client;
  }

  #recover(): void {
    if (this.#closed || !this.#wanted || this.#cancel) return;
    const delays = [2000, 8000, 30000];
    const delay = delays[this.#attempts];
    if (delay === undefined) {
      this.#error =
        "The server exited three times during recovery. Review Diagnostics, then start it again.";
      this.options.onChange?.();
      return;
    }
    this.#attempts++;
    const generation = this.#generation;
    this.#error = `The server exited. Restarting in ${delay / 1000} seconds, attempt ${this.#attempts} of 3.`;
    this.options.onChange?.();
    const schedule =
      this.options.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.#cancel = schedule(() => {
      this.#cancel = undefined;
      if (this.#closed || !this.#wanted || generation !== this.#generation) return;
      void this.#serial(async () => {
        if (this.#closed || !this.#wanted) return;
        this.#error = undefined;
        try {
          await (await this.#process()).request({ type: "start", instanceId: this.options.id });
          this.options.onChange?.();
        } catch {
          this.#recover();
        }
      });
    }, delay);
  }

  request(command: DesktopCommand): Promise<unknown> {
    if (command.type === "start") {
      this.#wanted = true;
      this.#attempts = 0;
      this.#error = undefined;
      this.#cancel?.();
      this.#cancel = undefined;
    }
    if (command.type === "stop") {
      this.#wanted = false;
      this.#cancel?.();
      this.#cancel = undefined;
    }
    return this.#serial(async () => {
      try {
        return await (await this.#process()).request(command);
      } catch (error) {
        if (!this.#client?.available()) this.#recover();
        throw error;
      }
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#wanted = false;
    this.#generation++;
    this.#cancel?.();
    this.#cancel = undefined;
    return this.#serial(async () => {
      await this.#client?.close();
    });
  }
}
