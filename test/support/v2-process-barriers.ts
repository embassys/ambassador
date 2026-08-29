import type { ChildProcess } from "node:child_process";

export const V2_PROCESS_BARRIER_NAMES = [
  "startup",
  "readiness",
  "operation",
  "commit",
  "response",
  "teardown",
] as const;

export type V2ProcessBarrierName = (typeof V2_PROCESS_BARRIER_NAMES)[number];

interface BarrierArrival {
  readonly name: V2ProcessBarrierName;
  readonly sequence: number;
}

interface BarrierWaiter {
  readonly resolve: (arrival: BarrierArrival) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface BarrierArrivalMessage {
  readonly kind: "a2a-t02-barrier-arrival";
  readonly name: V2ProcessBarrierName;
  readonly sequence: number;
}

interface BarrierReleaseMessage {
  readonly kind: "a2a-t02-barrier-release";
  readonly name: V2ProcessBarrierName;
  readonly sequence: number;
}

let childSequence = 0;

function isBarrierName(value: unknown): value is V2ProcessBarrierName {
  return typeof value === "string" && V2_PROCESS_BARRIER_NAMES.some((name) => name === value);
}

function parseArrival(message: unknown): BarrierArrival | undefined {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const candidate = message as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    candidate.kind !== "a2a-t02-barrier-arrival" ||
    !isBarrierName(candidate.name) ||
    !Number.isSafeInteger(candidate.sequence) ||
    (candidate.sequence as number) < 1
  ) {
    return undefined;
  }
  return { name: candidate.name, sequence: candidate.sequence as number };
}

function isRelease(message: unknown, arrival: BarrierArrival): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    candidate.kind === "a2a-t02-barrier-release" &&
    candidate.name === arrival.name &&
    candidate.sequence === arrival.sequence
  );
}

/**
 * Stops a child at a named test-only boundary until its parent releases it.
 * The IPC payload is deliberately content-free.
 */
export async function arriveAtV2ProcessBarrier(
  name: V2ProcessBarrierName,
  timeoutMs = 5_000,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("invalid process barrier timeout");
  }
  if (process.send === undefined || !process.connected) {
    throw new Error("process barrier requires a connected IPC parent");
  }

  childSequence += 1;
  const arrival: BarrierArrival = { name, sequence: childSequence };
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    };
    const onMessage = (message: unknown): void => {
      if (!isRelease(message, arrival)) return;
      cleanup();
      resolve();
    };
    const onDisconnect = (): void => {
      cleanup();
      reject(new Error("process barrier parent disconnected"));
    };
    const timer = setTimeout(() => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      reject(new Error("timed out waiting for process barrier release"));
    }, timeoutMs);
    timer.unref();
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send?.({
      kind: "a2a-t02-barrier-arrival",
      name: arrival.name,
      sequence: arrival.sequence,
    } satisfies BarrierArrivalMessage);
  });
}

/** Parent-side controller for content-free child-process barriers. */
export class V2ProcessBarrierController {
  readonly #child: ChildProcess;
  readonly #arrivals = new Map<V2ProcessBarrierName, BarrierArrival[]>();
  readonly #waiters = new Map<V2ProcessBarrierName, BarrierWaiter[]>();
  readonly #releaseQueue = new Map<V2ProcessBarrierName, BarrierArrival[]>();
  readonly #arrivalOrder: V2ProcessBarrierName[] = [];
  #closedError: Error | undefined;

  constructor(child: ChildProcess) {
    if (child.send === undefined) throw new Error("process barrier child requires IPC");
    this.#child = child;
    child.on("message", this.#onMessage);
    child.once("error", this.#onError);
    child.once("exit", this.#onExit);
    child.once("disconnect", this.#onDisconnect);
  }

  get arrivalOrder(): readonly V2ProcessBarrierName[] {
    return [...this.#arrivalOrder];
  }

  async waitFor(name: V2ProcessBarrierName, timeoutMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error("invalid process barrier timeout");
    }
    if (this.#closedError !== undefined) throw this.#closedError;
    const queued = this.#arrivals.get(name)?.shift();
    if (queued !== undefined) {
      this.#queueForRelease(queued);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: BarrierWaiter = {
        resolve: (arrival) => {
          clearTimeout(waiter.timer);
          this.#queueForRelease(arrival);
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          const waiters = this.#waiters.get(name);
          const index = waiters?.indexOf(waiter) ?? -1;
          if (index >= 0) waiters?.splice(index, 1);
          reject(new Error(`timed out waiting for ${name} process barrier`));
        }, timeoutMs),
      };
      waiter.timer.unref();
      const waiters = this.#waiters.get(name) ?? [];
      waiters.push(waiter);
      this.#waiters.set(name, waiters);
    });
  }

  release(name: V2ProcessBarrierName): void {
    if (this.#closedError !== undefined) throw this.#closedError;
    const arrival = this.#releaseQueue.get(name)?.shift();
    if (arrival === undefined) throw new Error(`${name} process barrier has not arrived`);
    if (!this.#child.connected || this.#child.send === undefined) {
      throw new Error("process barrier child is disconnected");
    }
    this.#child.send({
      kind: "a2a-t02-barrier-release",
      name: arrival.name,
      sequence: arrival.sequence,
    } satisfies BarrierReleaseMessage);
  }

  close(): void {
    this.#fail(new Error("process barrier controller closed"));
  }

  readonly #onMessage = (message: unknown): void => {
    const arrival = parseArrival(message);
    if (arrival === undefined || this.#closedError !== undefined) return;
    this.#arrivalOrder.push(arrival.name);
    const waiter = this.#waiters.get(arrival.name)?.shift();
    if (waiter !== undefined) {
      waiter.resolve(arrival);
      return;
    }
    const queued = this.#arrivals.get(arrival.name) ?? [];
    queued.push(arrival);
    this.#arrivals.set(arrival.name, queued);
  };

  readonly #onError = (): void => {
    this.#fail(new Error("process barrier child failed"));
  };

  readonly #onExit = (): void => {
    this.#fail(new Error("process barrier child exited"));
  };

  readonly #onDisconnect = (): void => {
    this.#fail(new Error("process barrier child disconnected"));
  };

  #queueForRelease(arrival: BarrierArrival): void {
    const queued = this.#releaseQueue.get(arrival.name) ?? [];
    queued.push(arrival);
    this.#releaseQueue.set(arrival.name, queued);
  }

  #fail(error: Error): void {
    if (this.#closedError !== undefined) return;
    this.#closedError = error;
    this.#child.off("message", this.#onMessage);
    this.#child.off("error", this.#onError);
    this.#child.off("exit", this.#onExit);
    this.#child.off("disconnect", this.#onDisconnect);
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.#waiters.clear();
  }
}
