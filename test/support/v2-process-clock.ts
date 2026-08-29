const FIXTURE_INITIAL_TIME = 1_788_000_000;
const MAX_ADVANCE_SECONDS = 604_800;
const TEST_CONTROL_KEY = "central-fixture-control";

export interface V2FixtureClock {
  readonly now: () => number;
  readonly advance: (seconds: number) => Promise<number>;
}

function validateAdvance(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_ADVANCE_SECONDS) {
    throw new Error("invalid fixture clock advancement");
  }
}

export function createInProcessV2FixtureClock(source: {
  readonly clock: () => number;
  readonly advanceClock: (seconds: number) => void;
}): V2FixtureClock {
  return {
    now: source.clock,
    advance: async (seconds) => {
      validateAdvance(seconds);
      source.advanceClock(seconds);
      return source.clock();
    },
  };
}

async function readBoundedObject(response: Response): Promise<Record<string, unknown>> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > 4_096) {
    await response.body?.cancel();
    throw new Error("fixture clock response is too large");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > 4_096) {
        await reader.cancel();
        throw new Error("fixture clock response is too large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid fixture clock response");
  }
  return parsed as Record<string, unknown>;
}

export function createHttpV2FixtureClock(options: {
  readonly fixtureOrigin: string;
  readonly initialTime?: number;
  readonly controlKey?: string;
}): V2FixtureClock {
  const origin = new URL(options.fixtureOrigin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("HTTP fixture clock requires a literal-loopback origin");
  }
  let current = options.initialTime ?? FIXTURE_INITIAL_TIME;
  if (!Number.isSafeInteger(current) || current < 0) throw new Error("invalid fixture clock time");
  const controlKey = options.controlKey ?? TEST_CONTROL_KEY;
  if (controlKey.length < 1 || controlKey.includes("\n") || controlKey.includes("\r")) {
    throw new Error("invalid fixture control key");
  }
  let pending: Promise<void> = Promise.resolve();

  return {
    now: () => current,
    advance: async (seconds) => {
      validateAdvance(seconds);
      let next = current;
      const operation = pending.then(async () => {
        const response = await fetch(new URL("/__test/v2/clock", origin), {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-a2a-test-key": controlKey,
          },
          body: JSON.stringify({ seconds }),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error("fixture clock control failed");
        }
        const result = await readBoundedObject(response);
        if (
          Object.keys(result).length !== 1 ||
          !Number.isSafeInteger(result.now) ||
          result.now !== current + seconds
        ) {
          throw new Error("invalid fixture clock response");
        }
        current = result.now as number;
        next = current;
      });
      pending = operation.catch(() => undefined);
      await operation;
      return next;
    },
  };
}
