// Fictional, offline data for the actual desktop renderer. Never imported by a production entry.
export const instanceId = "00000000-0000-4000-8000-000000000001";
export const ownerId = "00000000-0000-4000-8000-000000000002";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const owner = {
  status: "signed_in",
  context: id(3),
  email: "morgan@fixture.test",
  account: {
    agent_id: ownerId,
    email: "morgan@fixture.test",
    display_name: "Morgan",
    username: null,
  },
};
export const requests = {
  kind: "requests",
  total: 4,
  unconfirmed: [],
  permission_requests: [
    {
      id: id(10),
      decision_options: "once_always",
      scope: {
        calendar_id: "primary",
        date_from: "2026-09-11T09:00:00+01:00",
        date_to: "2026-09-11T17:00:00+01:00",
      },
      created_at: "2026-09-10T10:32:00Z",
      expires_at: "2026-09-11T17:00:00Z",
      action_type: "get_free_busy_permission",
      action_description: "Check your calendar availability",
      requester_name: "Alex Morgan",
      requester_email: "alex@fixture.test",
    },
    {
      id: id(11),
      decision_options: "once_always",
      scope: null,
      created_at: "2026-09-10T09:24:00Z",
      expires_at: null,
      action_type: "get_phone_number",
      action_description: "Share your phone number",
      requester_name: "Sam Chen",
      requester_email: "sam@fixture.test",
    },
    {
      id: id(12),
      decision_options: "accept_deny",
      scope: { title: "Project catch-up", calendar_id: "primary" },
      created_at: "2026-09-09T16:15:00Z",
      expires_at: null,
      action_type: "read_calendar_event_by_title",
      action_description: "Find a calendar event by its title",
      requester_name: "Priya Patel",
      requester_email: "priya@fixture.test",
    },
  ],
  input_requests: [
    {
      id: id(13),
      prompt: "You’re busy between 2 and 4 pm. Which time should I offer Alex?",
      input_type: "buttons",
      options: [
        { label: "Tomorrow at 10 am", value: "tomorrow-10" },
        { label: "Tomorrow at 4:30 pm", value: "tomorrow-1630" },
        { label: "Ask Alex for another day", value: "another-day" },
      ],
      created_at: "2026-09-10T10:41:00Z",
      action_type: "get_free_busy_permission",
    },
  ],
};
export const sessions = [
  {
    session_id: "claude-session-7b82f391",
    agent_kind: "claude_code",
    status: "active",
    last_used_at_ms: Date.parse("2026-09-10T10:42:00Z"),
  },
  {
    session_id: "claude-session-b81f5a20",
    agent_kind: "claude_code",
    status: "active",
    last_used_at_ms: Date.parse("2026-09-10T11:32:00Z"),
  },
  {
    session_id: "claude-session-927de14c",
    agent_kind: "claude_code",
    status: "active",
    last_used_at_ms: Date.parse("2026-09-09T16:22:00Z"),
  },
  {
    session_id: "claude-session-load-error",
    agent_kind: "claude_code",
    status: "retired",
    last_used_at_ms: Date.parse("2026-09-08T15:00:00Z"),
  },
];
function turn(session, index, action, stamp, status = "complete") {
  return {
    id: `turn-${index}`,
    sessionId: session,
    messageId: id(50 + index),
    createdAt: Date.parse(stamp),
    kind: "turn",
    senderId: id(
      session === sessions[0].session_id ? 90 : session === sessions[1].session_id ? 91 : 92,
    ),
    actionType: action,
    fingerprint: "0".repeat(64),
    status,
    parts: 3,
    sourceSequence: 1,
    sourceFingerprint: "1".repeat(64),
    chars: 100,
  };
}
function entry(session, index, role, text, stamp, messageNumber = 51) {
  return {
    id: `entry-${index}`,
    sessionId: session,
    messageId: id(messageNumber),
    createdAt: Date.parse(stamp),
    kind: "entry",
    role,
    text,
  };
}
const a = sessions[0].session_id,
  b = sessions[1].session_id,
  c = sessions[2].session_id;
export const histories = {
  [a]: {
    source: "archive",
    hasMore: false,
    nextCursor: 6,
    warnings: [],
    items: [
      turn(a, 1, "get_free_busy_permission", "2026-09-10T10:38:00Z"),
      entry(
        a,
        1,
        "user",
        JSON.stringify(
          {
            id: id(51),
            sender_agent_id: id(90),
            payload: {
              type: "action_call",
              action_type: "get_free_busy_permission",
              payload: {
                reason:
                  "Alex would like a 30-minute catch-up tomorrow. Is Morgan available in the afternoon?",
                date_from: "2026-09-11T09:00:00+01:00",
                date_to: "2026-09-11T17:00:00+01:00",
              },
            },
          },
          null,
          2,
        ),
        "2026-09-10T10:38:00Z",
      ),
      entry(
        a,
        2,
        "agent",
        "You’re busy between 2 and 4 pm tomorrow. I can offer Alex either 10 am or 4:30 pm for a 30-minute catch-up.\n\nI’ll check with you before confirming a time. No event has been created.",
        "2026-09-10T10:39:00Z",
      ),
      entry(
        a,
        3,
        "tool",
        JSON.stringify(
          {
            tool: "message_box",
            type: "ask_owner",
            status: "waiting_for_owner",
            question: "Which time works for your catch-up?",
          },
          null,
          2,
        ),
        "2026-09-10T10:40:00Z",
      ),
      turn(a, 2, "get_free_busy_permission", "2026-09-10T10:41:00Z", "recording"),
      entry(
        a,
        5,
        "user",
        JSON.stringify({
          id: id(52),
          sender_agent_id: id(90),
          payload: {
            type: "action_call",
            action_type: "get_free_busy_permission",
            payload: { reason: "4:30 pm works for Alex. Could you confirm that time with Morgan?" },
          },
        }),
        "2026-09-10T10:41:00Z",
        52,
      ),
      entry(
        a,
        4,
        "agent",
        "4:30 pm fits your calendar. I’m waiting for your choice before I reply to Alex’s agent.",
        "2026-09-10T10:42:00Z",
        52,
      ),
    ],
  },
  [b]: {
    source: "archive",
    hasMore: false,
    nextCursor: 4,
    warnings: [],
    items: [
      turn(b, 3, "get_phone_number", "2026-09-10T09:30:00Z"),
      entry(
        b,
        1,
        "user",
        JSON.stringify(
          {
            id: id(53),
            sender_agent_id: id(91),
            payload: {
              type: "action_call",
              action_type: "get_phone_number",
              payload: { reason: "Sam would like a contact number for the project catch-up." },
            },
          },
          null,
          2,
        ),
        "2026-09-10T09:30:00Z",
        53,
      ),
      entry(
        b,
        2,
        "agent",
        "I shared your approved contact number for Sam’s project catch-up:\n\n+44 7700 900627\n\nThe number was returned through the approved request.",
        "2026-09-10T09:31:00Z",
        53,
      ),
      entry(
        b,
        3,
        "tool",
        '{"tool":"message_box","type":"submit_action_result","status":"success"}',
        "2026-09-10T09:32:00Z",
        53,
      ),
    ],
  },
  [c]: {
    source: "archive",
    hasMore: false,
    nextCursor: 2,
    warnings: ["Only part of this conversation was saved."],
    items: [
      turn(c, 4, "read_calendar_event_by_title", "2026-09-09T16:20:00Z", "partial"),
      entry(
        c,
        1,
        "agent",
        "I found “Project catch-up” on Friday at 10 am. The remaining conversation is unavailable in this local archive.",
        "2026-09-09T16:21:00Z",
        54,
      ),
    ],
  },
};

export function edgeRequests() {
  const data = structuredClone(requests);
  data.input_requests[0].prompt =
    "Choose how your agent may use this request. " +
    "This is deliberately long sample text to check wrapping, keyboard access and scrolling. ".repeat(
      8,
    );
  data.input_requests[0].options = [
    {
      label:
        "Allow this one request only, including the selected calendar, date range and the exact recipient already shown above. Do not grant permission for later requests or other calendars.",
      value: "provider:allow_this_exact_request",
    },
    { label: "<script>This text must remain plain text</script>", value: "provider:deny" },
  ];
  data.permission_requests[0].scope = {
    calendar_id: "primary",
    path: `/Users/sample/Shared documents/${"A long project folder/".repeat(12)}`,
    context: { text: "<img src=x onerror=untrusted()>", requested_fields: ["availability"] },
  };
  data.permission_requests[2].decision_options = "future_choices";
  return data;
}

export const communications = [
  { id: id(51), sender_name: "Alex Morgan", sender_email: "alex@fixture.test" },
  { id: id(53), sender_name: "Sam Chen", sender_email: "sam@fixture.test" },
  { id: id(54), sender_name: "Priya Patel", sender_email: "priya@fixture.test" },
].map((message) => ({
  ...message,
  outbound: false,
  message_type: "action_call",
  status: "delivered",
  payload: {},
  created_at: "2026-09-10T10:38:00Z",
  delivered_at: "2026-09-10T10:38:00Z",
  action_type: "get_free_busy_permission",
  recipient_email: "morgan@fixture.test",
  recipient_name: "Morgan",
}));
