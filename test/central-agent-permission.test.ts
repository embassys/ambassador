import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CentralAgentPermissionCoordinator,
  type CentralAgentPermissionTransport,
} from "../src/central-agent-permission.js";
import type { CentralMessage } from "../src/central-rest.js";
import type { AcpPermissionRequest } from "../src/direct-delivery.js";

const MESSAGE_ID = "10000000-0000-4000-8000-000000000001";
const OUTCOME_ID = "10000000-0000-4000-8000-000000000002";
const UNRELATED_ID = "10000000-0000-4000-8000-000000000003";
const PROMPT =
  "Codex wants to use the local tool “Run a shell command” while handling an Embassys request. Allow this once?";

const request: AcpPermissionRequest = {
  agentKind: "codex",
  message: {
    id: MESSAGE_ID,
    sender_agent_id: "agent.sender",
    payload: { type: "action_call" },
    created_at: "2026-09-04T12:00:00Z",
  },
  sessionId: "provider-session",
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
      { label: "Allow once", value: "allow_once" },
      { label: "Deny", value: "deny" },
    ],
  };
}

function outcome(requestId: string, value: "allow_once" | "deny"): Record<string, unknown> {
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

test("requests one emailed ACP approval and resolves it from poll_messages", async () => {
  let requested: unknown;
  let finishPoll!: (messages: CentralMessage[]) => void;
  let pollStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const polled = new Promise<CentralMessage[]>((resolve) => {
    finishPoll = resolve;
  });
  const transport: CentralAgentPermissionTransport = {
    async requestHumanInput(arguments_) {
      requested = arguments_;
      return response("20000000-0000-4000-8000-000000000001");
    },
    async pollRemoteMessages(timeout) {
      assert.equal(timeout, 0);
      pollStarted();
      return { messages: await polled };
    },
  };
  const coordinator = new CentralAgentPermissionCoordinator({
    transport,
    pollIntervalMs: 1,
  });

  let settled = false;
  const approval = coordinator.approve(request, new AbortController().signal).finally(() => {
    settled = true;
  });
  await started;
  assert.equal(settled, false);
  assert.deepEqual(requested, {
    message_id: MESSAGE_ID,
    permission_type: "ambassador_acp_tool_execution",
    request: PROMPT,
    input_type: "buttons",
    options: [
      { label: "Allow once", value: "allow_once" },
      { label: "Deny", value: "deny" },
    ],
  });
  assert.equal(JSON.stringify(requested).includes("contains private input"), false);

  finishPoll([
    message(UNRELATED_ID, { type: "action_call", call_id: "call-1" }),
    message(OUTCOME_ID, outcome("20000000-0000-4000-8000-000000000001", "allow_once")),
  ]);
  assert.equal(await approval, "allow");

  const buffered = coordinator.takeBufferedMessages();
  assert.deepEqual(
    buffered.map((item) => item.id),
    [UNRELATED_ID, OUTCOME_ID],
  );
  assert.equal(coordinator.consumeInternalMessage(buffered[0] as CentralMessage), false);
  assert.equal(coordinator.consumeInternalMessage(buffered[1] as CentralMessage), true);
  assert.equal(coordinator.consumeInternalMessage(buffered[1] as CentralMessage), false);
});

test("maps a denied human answer", async () => {
  let pollCalls = 0;
  const denied = new CentralAgentPermissionCoordinator({
    pollIntervalMs: 1,
    transport: {
      async requestHumanInput() {
        return response("20000000-0000-4000-8000-000000000002");
      },
      async pollRemoteMessages() {
        pollCalls += 1;
        return {
          messages: [message(OUTCOME_ID, outcome("20000000-0000-4000-8000-000000000002", "deny"))],
        };
      },
    },
  });
  assert.equal(await denied.approve(request, new AbortController().signal), "deny");
  assert.equal(pollCalls, 1);
});
