import { parseK04IpcEnvelope } from "./k04-ipc.js";

type K04GatewayFetchBarrier =
  | "receive_selected"
  | "wake_before_request"
  | "reply_before_request"
  | "reply_accepted_unobserved"
  | "ack_accepted_unobserved";

type K04GatewayOperation = "receive" | "wake" | "reply" | "complete" | "outcome" | "ack" | "other";

const BARRIER_NAMES = new Set<K04GatewayFetchBarrier>([
  "receive_selected",
  "wake_before_request",
  "reply_before_request",
  "reply_accepted_unobserved",
  "ack_accepted_unobserved",
]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function send(message: Readonly<Record<string, unknown>>): void {
  if (process.send === undefined || !process.connected) return;
  try {
    process.send(message);
  } catch {
    // The parent may kill the process immediately after a barrier arrives.
  }
}

function operationFor(
  request: Request,
  centralOrigin: string,
  webhookOrigin: string,
): K04GatewayOperation {
  const url = new URL(request.url);
  if (url.origin === webhookOrigin && request.method === "POST" && url.pathname === "/webhook") {
    return "wake";
  }
  if (url.origin !== centralOrigin) return "other";
  if (request.method === "GET" && url.pathname === "/api/v2/messages/receive") return "receive";
  if (request.method === "POST" && /^\/api\/v2\/messages\/[^/]+\/reply$/u.test(url.pathname)) {
    return "reply";
  }
  if (request.method === "POST" && /^\/api\/v2\/messages\/[^/]+\/complete$/u.test(url.pathname)) {
    return "complete";
  }
  if (request.method === "GET" && /^\/api\/v2\/messages\/[^/]+\/outcome$/u.test(url.pathname)) {
    return "outcome";
  }
  if (request.method === "POST" && /^\/api\/v2\/messages\/[^/]+\/ack$/u.test(url.pathname)) {
    return "ack";
  }
  return "other";
}

async function responseContainsMessage(response: Response): Promise<boolean> {
  try {
    const value = (await response.clone().json()) as unknown;
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as { messages?: unknown }).messages) &&
      (value as { messages: unknown[] }).messages.length > 0
    );
  } catch {
    return false;
  }
}

function installK04GatewayFetchPreload(): void {
  if (process.env.K04_GATEWAY_FETCH_PRELOAD !== "1") return;
  const centralOrigin = process.env.K04_GATEWAY_FETCH_CENTRAL_ORIGIN;
  const webhookOrigin = process.env.K04_GATEWAY_FETCH_WEBHOOK_ORIGIN;
  const configuredBarrier = process.env.K04_GATEWAY_FETCH_BARRIER;
  if (
    centralOrigin === undefined ||
    webhookOrigin === undefined ||
    !(
      configuredBarrier === undefined ||
      BARRIER_NAMES.has(configuredBarrier as K04GatewayFetchBarrier)
    )
  ) {
    throw new Error("invalid K04 gateway fetch preload configuration");
  }

  const barrier = configuredBarrier as K04GatewayFetchBarrier | undefined;
  const originalFetch = globalThis.fetch;
  let sequence = 0;
  let barrierUsed = false;
  let pending:
    | {
        readonly name: K04GatewayFetchBarrier;
        readonly sequence: number;
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly timer: NodeJS.Timeout;
      }
    | undefined;

  const clearPending = (): typeof pending => {
    const current = pending;
    if (current !== undefined) clearTimeout(current.timer);
    pending = undefined;
    return current;
  };
  process.on("message", (value: unknown) => {
    const envelope = parseK04IpcEnvelope("gateway_child", value);
    if (envelope.kind === "shared") return;
    const { message } = envelope;
    if (
      !hasExactKeys(message, ["channel", "command", "barrier", "sequence"]) ||
      message.command !== "release" ||
      pending === undefined ||
      message.barrier !== pending.name ||
      message.sequence !== pending.sequence
    ) {
      const current = clearPending();
      current?.reject(new Error("unexpected K04 gateway fetch control IPC"));
      throw new Error("unexpected K04 gateway fetch control IPC");
    }
    clearPending()?.resolve();
  });
  process.channel?.unref();
  process.once("disconnect", () => {
    clearPending()?.reject(new Error("K04 gateway fetch barrier parent disconnected"));
  });

  const arrive = async (name: K04GatewayFetchBarrier): Promise<void> => {
    if (name !== "reply_before_request") {
      if (barrierUsed) return;
      barrierUsed = true;
    }
    sequence += 1;
    const arrivalSequence = sequence;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending?.sequence === arrivalSequence) pending = undefined;
        reject(new Error("K04 gateway fetch barrier timed out"));
      }, 30_000);
      timer.unref();
      pending = { name, sequence: arrivalSequence, resolve, reject, timer };
      send({
        channel: "k04_gateway_fetch",
        event: "barrier",
        barrier: name,
        sequence: arrivalSequence,
      });
    });
  };

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const operation = operationFor(request, centralOrigin, webhookOrigin);
    if (operation !== "other") {
      send({ channel: "k04_gateway_fetch", event: "request", operation });
    }
    if (operation === "complete") {
      const body = (await request.clone().json()) as unknown;
      if (
        !isRecord(body) ||
        !hasExactKeys(body, ["outcome", "reason_code"]) ||
        body.outcome !== "failed" ||
        body.reason_code !== "provider_start_failed"
      ) {
        throw new Error("invalid K04 completion request observation");
      }
      send({
        channel: "k04_gateway_fetch",
        event: "completion_request",
        outcome: body.outcome,
        reason_code: body.reason_code,
      });
    }
    if (barrier === "wake_before_request" && operation === "wake") {
      await arrive(barrier);
    } else if (barrier === "reply_before_request" && operation === "reply") {
      await arrive(barrier);
    }

    const response = await originalFetch(request);
    if (
      barrier === "receive_selected" &&
      operation === "receive" &&
      response.status === 200 &&
      (await responseContainsMessage(response))
    ) {
      await arrive(barrier);
    } else if (
      barrier === "reply_accepted_unobserved" &&
      operation === "reply" &&
      response.status === 200
    ) {
      await arrive(barrier);
    } else if (
      barrier === "ack_accepted_unobserved" &&
      operation === "ack" &&
      response.status === 200
    ) {
      await arrive(barrier);
    }
    return response;
  };
}

installK04GatewayFetchPreload();
