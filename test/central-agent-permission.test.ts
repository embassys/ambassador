import assert from "node:assert/strict";
import { test } from "node:test";
import { CentralAgentPermissionCoordinator } from "../src/central-agent-permission.js";
import type { CentralMessage } from "../src/central-rest.js";
import type { AcpPermissionRequest } from "../src/direct-delivery.js";

const MESSAGE_ID = "10000000-0000-4000-8000-000000000001";
const OUTCOME_ID = "10000000-0000-4000-8000-000000000002";
const PROMPT =
  "Codex wants to use the local tool “Run a shell command” while handling an Embassys request. Choose one of the options provided by the agent.";
const invocation = { provider_key: "embassys-acp:test:codex", generation: 1 };
const nextInvocation = () => invocation;

const request: AcpPermissionRequest = {
  agentKind: "codex",
  message: {
    id: MESSAGE_ID,
    sender_agent_id: "agent.sender",
    payload: { type: "action_call" },
    created_at: "2026-09-04T12:00:00Z",
  },
  sessionId: "provider-session",
  options: [
    { optionId: "provider-once", name: "Allow once", kind: "allow_once" },
    { optionId: "provider-deny", name: "Deny", kind: "reject_once" },
  ],
  toolCall: {
    toolCallId: "tool-call-1",
    title: "Run a shell command",
    kind: "execute",
    status: "pending",
    rawInput: { command: "contains private input" },
  },
};

function message(id: string, payload: Record<string, unknown>): CentralMessage {
  return {
    id,
    sender_agent_id: "agent.approver",
    payload,
    created_at: "2026-09-04T12:00:01Z",
  };
}

function response(requestId: string) {
  return {
    request_id: requestId,
    status: "pending" as const,
    input_type: "buttons" as const,
    message: "Question emailed to owner@example.test",
    options: [
      { label: "Allow once", value: "provider-once" },
      { label: "Deny", value: "provider-deny" },
    ],
  };
}

function outcome(
  requestId: string,
  value: "provider-once" | "provider-deny",
): Record<string, unknown> {
  return {
    type: "human_input_response",
    request_id: requestId,
    action_type: "ambassador_acp_tool_execution",
    input_type: "buttons",
    value,
    text: null,
    prompt: PROMPT,
    message_id: MESSAGE_ID,
  };
}

test("requests one email and waits for the shared receiver without polling central", async () => {
  let requested: unknown;
  const notifications: string[] = [];
  let release!: (value: CentralMessage) => void;
  const reply = new Promise<CentralMessage>((resolve) => {
    release = resolve;
  });
  const coordinator = new CentralAgentPermissionCoordinator({
    nextInvocation,
    onQuestion: (id) => {
      notifications.push(id);
      throw new Error("OS notification unavailable");
    },
    transport: {
      async requestHumanInput(args) {
        requested = args;
        return response("request-1");
      },
    },
    waitForResponse: async (id) => {
      assert.equal(id, "request-1");
      return reply;
    },
  });
  let finished = false;
  const waiting = coordinator.approve(request, new AbortController().signal).then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assert.deepEqual(notifications, ["request-1"]);
  assert.deepEqual(requested, {
    message_id: MESSAGE_ID,
    permission_type: "ambassador_acp_tool_execution",
    request: PROMPT,
    input_type: "buttons",
    options: response("request-1").options,
    request_kind: "provider_option",
    provider: { ...invocation, expires_in_seconds: 72 * 60 * 60 },
    expires_in_seconds: 72 * 60 * 60,
  });
  release(message(OUTCOME_ID, outcome("request-1", "provider-once")));
  assert.equal(await waiting, "provider-once");
});

test("presents every exact provider option and returns its opaque ID", async () => {
  const choices = [
    { optionId: "one:42", name: "Run once", kind: "allow_once" },
    { optionId: "saved:17", name: "Always run this tool", kind: "allow_always" },
    { optionId: "no:93", name: "Skip this invocation", kind: "reject_once" },
    { optionId: "saved:0", name: "Never run this tool", kind: "reject_always" },
  ];
  for (const choice of choices) {
    const coordinator = new CentralAgentPermissionCoordinator({
      nextInvocation,
      transport: {
        async requestHumanInput(args) {
          assert.deepEqual(
            args.options,
            choices.map(({ name, optionId }) => ({ label: name, value: optionId })),
          );
          return { ...response("choices"), options: args.options };
        },
      },
      waitForResponse: async () =>
        message(OUTCOME_ID, { ...outcome("choices", "provider-once"), value: choice.optionId }),
    });
    assert.equal(
      await coordinator.approve({ ...request, options: choices }, new AbortController().signal),
      choice.optionId,
    );
  }
});

test("unrepresentable menus fail before email submission", async () => {
  let emails = 0;
  for (const options of [
    [],
    [{ optionId: "", name: "Allow", kind: "allow_once" }],
    [{ optionId: "id", name: "x".repeat(65), kind: "allow_once" }],
    [{ optionId: "id", name: "Allow\nnow", kind: "allow_once" }],
    Array.from({ length: 11 }, (_, i) => ({
      optionId: String(i),
      name: "Allow",
      kind: "allow_once",
    })),
    [
      { optionId: "same", name: "One", kind: "allow_once" },
      { optionId: "same", name: "Always", kind: "allow_always" },
    ],
  ]) {
    const coordinator = new CentralAgentPermissionCoordinator({
      nextInvocation,
      transport: {
        async requestHumanInput() {
          emails++;
          return response("bad");
        },
      },
      waitForResponse: async () => {
        assert.fail("invalid menu");
      },
    });
    await assert.rejects(
      coordinator.approve({ ...request, options }, new AbortController().signal),
    );
  }
  assert.equal(emails, 0);
});

test("wrong request, triggering message, prompt, input type, or choice cannot approve a tool", async () => {
  for (const change of [
    { request_id: "other" },
    { value: "not-offered" },
    { message_id: "other" },
    { prompt: "other" },
    { text: "injected" },
    { input_type: "text" },
    { action_type: "other" },
  ]) {
    const coordinator = new CentralAgentPermissionCoordinator({
      nextInvocation,
      transport: {
        async requestHumanInput() {
          return response("expected");
        },
      },
      waitForResponse: async () =>
        message(OUTCOME_ID, { ...outcome("expected", "provider-once"), ...change }),
    });
    await assert.rejects(coordinator.approve(request, new AbortController().signal));
  }
});

test("cancellation while waiting never approves and already-cancelled requests send no email", async () => {
  let emails = 0;
  const coordinator = new CentralAgentPermissionCoordinator({
    nextInvocation,
    transport: {
      async requestHumanInput() {
        emails++;
        return response("cancel");
      },
    },
    waitForResponse: async (_id, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  });
  const controller = new AbortController();
  const waiting = coordinator.approve(request, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(waiting);
  await assert.rejects(coordinator.approve(request, controller.signal));
  assert.equal(emails, 1);
});

test("a lost provider question response resumes one exact mutation while its ACP request stays open", async () => {
  let savedKey: string | undefined;
  let submissions = 0;
  const coordinator = new CentralAgentPermissionCoordinator({
    nextInvocation,
    transport: {
      async requestHumanInput(_args, _signal, key) {
        savedKey = key;
        submissions++;
        throw new Error("lost");
      },
      async resumeMutation(operation, key) {
        assert.equal(operation, "get_human_input");
        assert.equal(key, savedKey);
        return response("request-recovered");
      },
    },
    waitForResponse: async (id) => message(OUTCOME_ID, outcome(id, "provider-once")),
  });
  assert.equal(await coordinator.approve(request, new AbortController().signal), "provider-once");
  assert.equal(submissions, 1);
});

test("an expired provider approval releases the wait and cannot approve a late answer", async () => {
  const coordinator = new CentralAgentPermissionCoordinator({
    nextInvocation,
    approvalTimeoutMs: 20,
    transport: {
      async requestHumanInput(args) {
        assert.equal(args.request_kind, "provider_option");
        assert.equal(args.expires_in_seconds, 1);
        return response("expired");
      },
    },
    waitForResponse: async (_id, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve(message(OUTCOME_ID, outcome("expired", "provider-once"))),
          { once: true },
        );
      }),
  });
  await assert.rejects(coordinator.approve(request, new AbortController().signal));
});

test("failure to persist a provider generation sends no approval request", async () => {
  const coordinator = new CentralAgentPermissionCoordinator({
    nextInvocation: () => {
      throw new Error("disk full");
    },
    transport: {
      async requestHumanInput() {
        assert.fail("no email before durable generation");
      },
    },
    waitForResponse: async () => {
      assert.fail("no wait");
    },
  });
  await assert.rejects(coordinator.approve(request, new AbortController().signal));
});
