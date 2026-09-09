import { randomUUID } from "node:crypto";

export const CONNECTION_CHECK_MS = 180000;
/** Ephemeral evidence for an owner-started check. This grants no access or permissions. */
export class ConnectionCheck {
  #pending:
    | { challenge: string; enrollment: string; expires: number; observed: boolean }
    | undefined;
  constructor(readonly now = Date.now) {}
  begin(enrollment: string): string {
    if (this.#pending) throw new Error("A connection check is already running.");
    const challenge = randomUUID();
    this.#pending = {
      challenge,
      enrollment,
      expires: this.now() + CONNECTION_CHECK_MS,
      observed: false,
    };
    return challenge;
  }
  receive(challenge: string, enrollment: string): boolean {
    const pending = this.#pending;
    if (
      !pending ||
      pending.challenge !== challenge ||
      pending.enrollment !== enrollment ||
      this.now() >= pending.expires
    )
      return false;
    pending.observed = true;
    return true;
  }
  observed(challenge: string): boolean {
    return Boolean(
      this.#pending?.challenge === challenge &&
        this.#pending.observed &&
        this.now() < this.#pending.expires,
    );
  }
  end(challenge: string): void {
    if (this.#pending?.challenge === challenge) this.#pending = undefined;
  }
}
