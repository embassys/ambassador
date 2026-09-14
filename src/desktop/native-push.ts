export interface NativePushState {
  state: "disabled" | "checking" | "registered" | "unavailable";
  reason?: string;
}
/** Receives a device token only from the trusted native API in the main process. */
export class NativePushRegistration {
  #generation = 0;
  #selection = "";
  #mutations: Promise<void> = Promise.resolve();
  #state: NativePushState = { state: "disabled" };
  constructor(
    readonly options: {
      platform: NodeJS.Platform;
      status(
        context: string,
      ): Promise<{ available: boolean; registered: boolean; reason?: string | null }>;
      osToken(): Promise<string>;
      register(token: string, context: string): Promise<void>;
      unregister(context: string): Promise<void>;
      changed?(): void;
    },
  ) {}
  snapshot(): NativePushState {
    return { ...this.#state };
  }
  #set(state: NativePushState) {
    this.#state = state;
    this.options.changed?.();
  }
  #mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.#mutations.then(operation);
    this.#mutations = pending.catch(() => undefined);
    return pending;
  }
  async configure(context: string | undefined, enabled: boolean, retry = false): Promise<void> {
    const selection = `${context ?? ""}:${enabled}`;
    if (!retry && selection === this.#selection) return;
    this.#selection = selection;
    const generation = ++this.#generation;
    if (!context || !enabled) {
      this.#set({ state: "disabled" });
      if (context)
        await this.#mutate(() => this.options.unregister(context)).catch(() => undefined);
      return;
    }
    this.#set({ state: "checking" });
    try {
      const status = await this.options.status(context);
      if (generation !== this.#generation) return;
      if (!status.available) {
        this.#set({
          state: "unavailable",
          reason: status.reason ?? "The server cannot send push notifications yet.",
        });
        return;
      }
      if (this.options.platform !== "darwin") {
        this.#set({
          state: "unavailable",
          reason:
            "Remote push is not available in this platform build. Keep Embassys running for notifications.",
        });
        return;
      }
      const token = await this.options.osToken();
      if (generation !== this.#generation) return;
      if (!/^[a-f0-9]{16,512}$/iu.test(token)) throw new Error("Invalid native token");
      await this.#mutate(async () => {
        if (generation !== this.#generation) return;
        await this.options.register(token, context);
        if (generation !== this.#generation) {
          await this.options.unregister(context).catch(() => undefined);
          return;
        }
        this.#set({ state: "registered" });
      });
    } catch {
      if (generation === this.#generation)
        this.#set({
          state: "unavailable",
          reason:
            "Remote push could not register. It requires a signed app and a configured notification service.",
        });
    }
  }
}
