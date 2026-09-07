/** Activation can arrive before asynchronous registry and IPC setup finishes. */
export class DesktopWindowLifecycle {
  #ready = false;
  #requested = false;
  constructor(readonly open: () => void) {}

  requestOpen(): void {
    if (this.#ready) this.open();
    else this.#requested = true;
  }

  ready(background: boolean): void {
    if (this.#ready) return;
    this.#ready = true;
    if (this.#requested || !background) this.open();
    this.#requested = false;
  }
}
