/** Native Quit must wait for cleanup without re-entering the same OS event. */
export class DesktopQuitLifecycle {
  #state: "idle" | "stopping" | "complete" = "idle";
  #completion: Promise<void> = Promise.resolve();
  constructor(
    readonly options: {
      stop: () => Promise<void>;
      quit: () => void;
      failed: () => void;
    },
  ) {}
  get stopping(): boolean {
    return this.#state !== "idle";
  }
  get completion(): Promise<void> {
    return this.#completion;
  }
  /** True tells before-quit to prevent the native default action. */
  request(): boolean {
    if (this.#state === "complete") return false;
    if (this.#state === "stopping") return true;
    this.#state = "stopping";
    this.#completion = this.#finish();
    return true;
  }
  async #finish(): Promise<void> {
    try {
      await this.options.stop();
      // A resolved cleanup promise can run during Cocoa's terminate callback.
      // Re-entering app.quit there may be ignored even though its window closes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.#state = "complete";
      this.options.quit();
    } catch {
      this.#state = "idle";
      this.options.failed();
    }
  }
}
