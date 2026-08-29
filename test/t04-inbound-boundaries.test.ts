import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import Database from "better-sqlite3";

import {
  installT04FetchInterceptor,
  type T04FetchInterceptor,
  t04JsonResponse,
} from "./support/t04-fetch-interceptor.js";
import { requireT04Tool, startT04GatewayScenario } from "./support/t04-gateway-harness.js";

const COMPLETE_PROPERTIES = ["message_id", "outcome", "reason_code"];

function journalRowCount(stateRoot: string): number {
  const database = new Database(join(stateRoot, "notifications.sqlite"), { readonly: true });
  try {
    const row = database
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notification_relay")
      .get();
    return row?.count ?? 0;
  } finally {
    database.close();
  }
}

function inboundMessage(index: number, text: string): Record<string, unknown> {
  return {
    id: `t04_boundary_message_${index.toString().padStart(3, "0")}`,
    conversation_id: `t04_boundary_conversation_${index.toString().padStart(3, "0")}`,
    sender_agent_id: "fixture_sender_agent",
    message_type: "conversation_turn",
    in_reply_to_message_id: null,
    payload: { text },
    created_at: new Date(Date.UTC(2026, 7, 29, 12, 0, index)).toISOString(),
  };
}

function rawJsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
}

function exactReceiveBatch(targetBytes: 524_288 | 524_289): {
  readonly body: string;
  readonly messages: readonly Record<string, unknown>[];
} {
  const messages = Array.from({ length: 100 }, (_unused, index) =>
    inboundMessage(
      index,
      index === 0 ? "x".repeat(262_144) : index === 1 ? "" : `bounded-${index}`,
    ),
  );
  const baseBytes = Buffer.byteLength(JSON.stringify({ messages }), "utf8");
  const secondTextBytes = targetBytes - baseBytes;
  assert.ok(secondTextBytes >= 1 && secondTextBytes <= 262_144);
  messages[1] = inboundMessage(1, "y".repeat(secondTextBytes));
  const body = JSON.stringify({ messages });
  assert.equal(Buffer.byteLength(body, "utf8"), targetBytes);
  return { body, messages };
}

async function startWithSyntheticReceive(
  t: TestContext,
  firstResponse: () => Response,
): Promise<{
  readonly scenario: Awaited<ReturnType<typeof startT04GatewayScenario>>;
  readonly interceptor: T04FetchInterceptor;
  readonly receiveCalls: () => number;
}> {
  let interceptor: T04FetchInterceptor | undefined;
  let receiveCalls = 0;
  const scenario = await startT04GatewayScenario(t, {
    beforeVerification: (central) => {
      interceptor = installT04FetchInterceptor(t, async (_request, call) => {
        if (
          call.origin !== central.apiUrl ||
          call.method !== "GET" ||
          call.pathname !== "/api/v2/messages/receive"
        ) {
          return undefined;
        }
        receiveCalls += 1;
        return receiveCalls === 1 ? firstResponse() : t04JsonResponse(200, { messages: [] });
      });
    },
  });
  assert.ok(interceptor !== undefined);
  return { scenario, interceptor, receiveCalls: () => receiveCalls };
}

async function startWithGatedInvalidReceive(
  t: TestContext,
  responseFactory: () => Response,
): Promise<{
  readonly scenario: Awaited<ReturnType<typeof startT04GatewayScenario>>;
  readonly receiveCalls: () => number;
  readonly releaseResponseTail: () => void;
  readonly waitForProcessingTurn: () => Promise<void>;
}> {
  const source = responseFactory();
  const bytes = new Uint8Array(await source.arrayBuffer());
  assert.ok(bytes.byteLength > 0);
  let releaseTail: (() => void) | undefined;
  const tailReleased = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  let markProcessingTurn: (() => void) | undefined;
  const processingTurn = new Promise<void>((resolve) => {
    markProcessingTurn = resolve;
  });
  let receiveCalls = 0;
  const scenario = await startT04GatewayScenario(t, {
    beforeVerification: (central) => {
      installT04FetchInterceptor(t, async (_request, call) => {
        if (
          call.origin !== central.apiUrl ||
          call.method !== "GET" ||
          call.pathname !== "/api/v2/messages/receive"
        ) {
          return undefined;
        }
        receiveCalls += 1;
        if (receiveCalls !== 1) return t04JsonResponse(200, { messages: [] });
        let tailSent = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, bytes.byteLength - 1));
          },
          async pull(controller) {
            if (tailSent) return;
            tailSent = true;
            await tailReleased;
            controller.enqueue(bytes.subarray(bytes.byteLength - 1));
            controller.close();
            await nextTurn();
            markProcessingTurn?.();
          },
        });
        return new Response(body, {
          status: source.status,
          headers: source.headers,
        });
      });
    },
  });
  t.after(() => releaseTail?.());
  return {
    scenario,
    receiveCalls: () => receiveCalls,
    releaseResponseTail: () => releaseTail?.(),
    waitForProcessingTurn: async () => await processingTurn,
  };
}

const INVALID_RESULTS = [
  {
    id: "T04-M02-unknown",
    response: () =>
      t04JsonResponse(200, {
        messages: [{ ...inboundMessage(1, "valid"), unexpected: true }],
      }),
  },
  {
    id: "T04-M02-duplicate",
    response: () => {
      const first = inboundMessage(2, "valid");
      const second = { ...inboundMessage(3, "changed"), id: first.id };
      return t04JsonResponse(200, { messages: [first, second] });
    },
  },
  {
    id: "T04-M02-duplicate-key",
    response: () =>
      rawJsonResponse(
        '{"messages":[{"id":"duplicate_key","id":"changed_key","conversation_id":"conv","sender_agent_id":"agent","message_type":"conversation_turn","in_reply_to_message_id":null,"payload":{"text":"valid"},"created_at":"2026-08-29T12:00:00.000Z"}]}',
      ),
  },
  {
    id: "T04-M02-oversized-text",
    response: () =>
      t04JsonResponse(200, {
        messages: [inboundMessage(3, "x".repeat(262_145))],
      }),
  },
  {
    id: "T04-M02-one-over-batch",
    response: () => rawJsonResponse(exactReceiveBatch(524_289).body),
  },
  {
    id: "T04-M02-http-oversized",
    response: () =>
      t04JsonResponse(200, {
        messages: Array.from({ length: 17 }, (_unused, index) =>
          inboundMessage(index, "z".repeat(262_144)),
        ),
      }),
  },
] as const;

for (const spec of INVALID_RESULTS) {
  test(`${spec.id} rejects an invalid receive result before journal or inbox admission`, async (t) => {
    const { scenario, receiveCalls, releaseResponseTail, waitForProcessingTurn } =
      await startWithGatedInvalidReceive(t, spec.response);
    assert.equal(
      scenario.usedLegacyEnrollment,
      false,
      `[${spec.id}] gateway did not start the REST v2 receive loop`,
    );
    let pollState:
      | { readonly status: "fulfilled"; readonly value: Record<string, unknown> }
      | { readonly status: "rejected" }
      | undefined;
    const poll = scenario.client
      .callTool("poll_messages", { timeout: 30 })
      .then((value) => {
        pollState = { status: "fulfilled", value };
      })
      .catch(() => {
        pollState = { status: "rejected" };
      });
    releaseResponseTail();
    await waitForProcessingTurn();
    assert.equal(receiveCalls(), 1, `[${spec.id}] gateway retried after a contract violation`);
    assert.equal(journalRowCount(scenario.gateway.stateRoot), 0);
    if (pollState?.status === "fulfilled") {
      assert.deepEqual(pollState.value, { messages: [] });
    }
    await scenario.gateway.stop();
    await poll;
  });
}

test("T04-D07 accepts an exact 524288-byte batch without reordering", async (t) => {
  const { body, messages } = exactReceiveBatch(524_288);
  const { scenario, interceptor } = await startWithSyntheticReceive(t, () => rawJsonResponse(body));
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-D07");
  await scenario.webhook.waitForWake();
  const local = await scenario.client.callTool("poll_messages", { timeout: 0 });
  assert.ok(Array.isArray(local.messages));
  assert.deepEqual(
    local.messages.map((message) => (message as Record<string, unknown>).id),
    messages.map((message) => message.id),
  );
  assert.equal(
    interceptor.calls.filter(
      (call) =>
        call.origin === scenario.central.apiUrl &&
        call.pathname === "/api/v2/messages/receive" &&
        call.search === "?timeout=30&limit=100",
    ).length,
    1,
  );
});

test("T04-D06 keeps one central receive active while local polls stay local", async (t) => {
  let releaseReceive: ((response: Response) => void) | undefined;
  const heldReceive = new Promise<Response>((resolve) => {
    releaseReceive = resolve;
  });
  t.after(() => releaseReceive?.(t04JsonResponse(200, { messages: [] })));
  let receiveCalls = 0;
  let receiveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    receiveStarted = resolve;
  });
  const scenario = await startT04GatewayScenario(t, {
    beforeVerification: (central) => {
      installT04FetchInterceptor(t, async (_request, call) => {
        if (
          call.origin === central.apiUrl &&
          call.method === "GET" &&
          call.pathname === "/api/v2/messages/receive"
        ) {
          receiveCalls += 1;
          receiveStarted?.();
          return await heldReceive;
        }
        return undefined;
      });
    },
  });
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-D06");
  await started;
  await Promise.all([
    scenario.client.callTool("poll_messages", { timeout: 0 }),
    scenario.client.callTool("poll_messages", { timeout: 0 }),
    scenario.client.callTool("poll_messages", { timeout: 0 }),
  ]);
  for (let index = 0; index < 4; index += 1) await nextTurn();
  assert.equal(receiveCalls, 1);
  releaseReceive?.(t04JsonResponse(200, { messages: [] }));
});

test("T04-V05 uses the fixed REST receive route without central MCP fallback", async (t) => {
  const { scenario, interceptor } = await startWithSyntheticReceive(t, () =>
    t04JsonResponse(409, {
      error: { code: "receive_in_progress", retry_after_ms: null },
    }),
  );
  await requireT04Tool(scenario.client, "complete_message", COMPLETE_PROPERTIES, "T04-V05");
  for (let index = 0; index < 4; index += 1) await nextTurn();
  const centralCalls = interceptor.calls.filter((call) => call.origin === scenario.central.apiUrl);
  assert.ok(
    centralCalls.every((call) =>
      ["/api/verify_email", "/api/v2/delivery/activate", "/api/v2/messages/receive"].includes(
        call.pathname,
      ),
    ),
  );
  assert.equal(
    centralCalls.filter(
      (call) =>
        call.method === "GET" &&
        call.pathname === "/api/v2/messages/receive" &&
        call.search === "?timeout=30&limit=100",
    ).length,
    1,
  );
  assert.equal(
    scenario.central.calls.some(
      (call) => call.name === "receive_messages" || call.name === "poll_messages",
    ),
    false,
  );
});
