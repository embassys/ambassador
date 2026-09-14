import { z } from "zod";
import { consistentPage, grant, inboxItem, snapshotFields } from "./owner-contract.js";
import { inputRequestSchema, permissionRequestSchema, permissionSchema } from "./owner-protocol.js";
export function projectInboxItem(raw: unknown) {
  const item = inboxItem.parse(raw);
  const common = {
    id: item.request_id,
    agent_id: item.agent_id,
    owner_id: item.owner_id,
    revision: item.revision,
    state: item.state,
    action_type: item.action.name,
    action_verified: item.action.verified,
    created_at: item.created_at,
    expires_at: item.expires_at,
    message_id: item.correlation.message_id,
    reason: item.reason,
  };
  if (item.kind === "permission")
    return {
      kind: "permission" as const,
      item: permissionRequestSchema.parse({
        ...common,
        decision_options: null,
        offered_options: item.offered.options,
        scope: item.scope,
        action_description: null,
        requester_agent_id: item.peer.agent_id,
        requester_email: item.peer.email,
        requester_name: item.peer.display_name,
        requester_verified: item.peer.email_verified,
      }),
    };
  return {
    kind: "input" as const,
    item: inputRequestSchema.parse({
      ...common,
      prompt: item.prompt,
      input_type: item.offered.type === "text" ? "text" : "buttons",
      options: item.offered.type === "options" ? item.offered.options : null,
      request_kind: item.request_kind,
      provider: item.provider,
    }),
  };
}
export function inboxPage(raw: unknown) {
  const page = z
    .object({ items: z.array(inboxItem).max(200), ...snapshotFields })
    .refine(consistentPage)
    .parse(raw);
  const items = page.items.map(projectInboxItem);
  return {
    permission_requests: items.flatMap((row) => (row.kind === "permission" ? [row.item] : [])),
    input_requests: items.flatMap((row) => (row.kind === "input" ? [row.item] : [])),
    total: items.length,
    has_more: page.has_more,
    next_cursor: page.next_cursor,
    watermark: page.watermark,
  };
}
export function permissionPage(raw: unknown, direction: "granted" | "received") {
  const page = z
    .object({ items: z.array(grant).max(200), ...snapshotFields })
    .refine(consistentPage)
    .parse(raw);
  const expected = direction === "granted" ? "outbound" : "inbound";
  if (page.items.some((item) => item.direction !== expected && item.direction !== "internal"))
    throw new Error("Permission direction changed");
  return {
    direction,
    permissions: page.items.map((item) =>
      permissionSchema.parse({
        id: item.permission_id,
        revision: item.revision,
        status: item.state,
        revocable: item.revocable,
        internal: item.direction === "internal",
        scope: item.scope,
        reason: item.reason,
        uses_remaining: item.uses_remaining,
        created_at: item.created_at,
        decided_at: item.decided_at,
        expires_at: item.expires_at,
        action_type: item.action,
        action_description: null,
        action_verified: item.action_verified,
        decision: null,
        decision_options: null,
        grantor_email: item.grantor.email,
        grantor_name: item.grantor.display_name,
        grantee_email: item.grantee.email,
        grantee_name: item.grantee.display_name,
        direction: direction === "granted" ? "granted_by_me" : "granted_to_me",
      }),
    ),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    watermark: page.watermark,
  };
}
