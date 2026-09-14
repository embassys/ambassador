import assert from "node:assert/strict";
import { test } from "node:test";
import { invitationSchema, sessionResponse } from "../src/desktop/owner-contract.js";
import { inboxPage, permissionPage } from "../src/desktop/owner-projections.js";

const id = "00000000-0000-4000-8000-000000000011";
const timestamp = "2026-09-14T12:00:00Z";
test("owner inbox preserves exact options, revision, reason and verified peer identity", () => {
  const page = inboxPage({
    items: [
      {
        kind: "permission",
        request_id: id,
        revision: 3,
        state: "pending",
        owner_id: id,
        agent_id: id,
        peer: {
          agent_id: id,
          email: "peer@example.test",
          email_verified: false,
          display_name: "Unverified name",
          display_name_verified: false,
        },
        action: { name: "lookup", verified: true, input_schema: {} },
        scope: { title: "Exact title" },
        reason: "My stated reason",
        correlation: { message_id: null },
        offered: { type: "decision", options: ["allow_once", "allow_always", "deny"] },
        expires_at: null,
        created_at: timestamp,
      },
    ],
    has_more: true,
    next_cursor: "next-page",
    watermark: 4,
  });
  assert.equal(page.permission_requests[0]?.revision, 3);
  assert.equal(page.permission_requests[0]?.reason, "My stated reason");
  assert.equal(page.permission_requests[0]?.requester_verified, false);
  assert.deepEqual(page.permission_requests[0]?.offered_options, [
    "allow_once",
    "allow_always",
    "deny",
  ]);
  assert.equal(page.next_cursor, "next-page");
  assert.equal(page.has_more, true);
});
test("owner pages refuse inconsistent cursors and active permission does not hide exhaustion", () => {
  assert.throws(() => inboxPage({ items: [], has_more: true, next_cursor: null, watermark: 0 }));
  const page = permissionPage(
    {
      items: [
        {
          permission_id: id,
          direction: "outbound",
          state: "exhausted",
          stored_state: "granted",
          revision: 4,
          action: "lookup",
          action_verified: true,
          scope: null,
          reason: null,
          grantor: { agent_id: id, email: "owner@example.test", display_name: null },
          grantee: {
            agent_id: id,
            email: "peer@example.test",
            display_name: null,
            email_verified: true,
          },
          uses_remaining: 0,
          expires_at: null,
          created_at: timestamp,
          decided_at: timestamp,
          revoked_at: null,
          last_used_at: timestamp,
          revocable: true,
        },
      ],
      has_more: false,
      next_cursor: null,
      watermark: 5,
    },
    "granted",
  );
  assert.equal(page.permissions[0]?.status, "exhausted");
  assert.equal(page.permissions[0]?.revision, 4);
});
test("sign-in accepts an owner with no agents but never accepts the old agent-shaped response", () => {
  assert.throws(() =>
    sessionResponse.parse({
      agent_id: id,
      email: "owner@example.test",
      access_token: "old",
      refresh_token: "old",
      expires_in: 900,
    }),
  );
  const session = sessionResponse.parse({
    owner_id: id,
    device_id: id,
    email: "owner@example.test",
    access_token: "x".repeat(30),
    refresh_token: "y".repeat(30),
    access_token_expires_at: timestamp,
    session_expires_at: timestamp,
    agents: [],
    replayed: false,
  });
  assert.equal(session.agents.length, 0);
});

test("invitation dates require an offset after the server timestamp repair", () => {
  const invitation = invitationSchema.parse({
    invitation_id: id,
    direction: "outgoing",
    state: "pending",
    other_email: "peer@example.test",
    other_name: null,
    inviter_email: "owner@example.test",
    invitee_email: "peer@example.test",
    created_at: "2026-09-14T09:56:48.121617+00:00",
    responded_at: null,
    delivered: true,
  });
  assert.equal(invitation.created_at, "2026-09-14T09:56:48.121617+00:00");
  assert.throws(() =>
    invitationSchema.parse({ ...invitation, created_at: "2026-09-14T09:56:48.121617" }),
  );
  assert.throws(() => invitationSchema.parse({ ...invitation, created_at: "yesterday" }));
});
