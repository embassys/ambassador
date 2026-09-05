import type { CentralMessage } from "./central-rest.js";

export const CENTRAL_BATCH_MAX_BYTES = 512 * 1024;
const BUFFER_MAX_BYTES = 16 * 1024 * 1024;
const BUFFER_MAX_MESSAGES = 256;

export async function captureCentralMessages(
  messages: readonly CentralMessage[],
  capture: (message: CentralMessage) => void | Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(messages.map(async (message) => await capture(message)));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}

export class CentralMessageBuffer {
  readonly #messages: { message: CentralMessage; bytes: number }[] = [];
  #bytes = 0;

  push(messages: readonly CentralMessage[]): void {
    const entries = messages.map((message) => ({
      message,
      bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
    }));
    const additional = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (
      this.#messages.length + entries.length > BUFFER_MAX_MESSAGES ||
      this.#bytes + additional > BUFFER_MAX_BYTES ||
      entries.some((entry) => entry.bytes + 15 > CENTRAL_BATCH_MAX_BYTES)
    ) {
      throw new Error("Central message buffer capacity reached");
    }
    this.#messages.push(...entries);
    this.#bytes += additional;
  }

  take(): readonly CentralMessage[] {
    let bytes = 15;
    let count = 0;
    for (const entry of this.#messages) {
      if (bytes + entry.bytes + 1 > CENTRAL_BATCH_MAX_BYTES) break;
      bytes += entry.bytes + 1;
      count += 1;
    }
    const entries = this.#messages.splice(0, count);
    for (const entry of entries) this.#bytes -= entry.bytes;
    return entries.map((entry) => entry.message);
  }
}
