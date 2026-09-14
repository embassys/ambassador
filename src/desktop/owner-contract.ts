import { z } from "zod";
import { ownerEmail } from "./owner-email.js";

const timestamp = z.iso.datetime({ offset: true });
const nullableText = z.string().max(8192).nullable();
export const ownedAgent = z.object({
  id: z.uuid(),
  email: ownerEmail,
  display_name: nullableText,
  email_verified: z.boolean(),
  executor_device_id: z.uuid().nullable(),
  is_executed_here: z.boolean(),
  executor_epoch: z.number().int().nonnegative(),
});
export const agentsResponse = z
  .object({
    agents: z.array(ownedAgent).max(200),
    newly_attached_agent_ids: z.array(z.uuid()).max(200),
  })
  .refine(({ agents, newly_attached_agent_ids }) => {
    const ids = new Set(agents.map((agent) => agent.id));
    return (
      ids.size === agents.length &&
      new Set(newly_attached_agent_ids).size === newly_attached_agent_ids.length &&
      newly_attached_agent_ids.every((id) => ids.has(id))
    );
  });
export const refreshResponse = z.object({
  access_token: z.string().min(20).max(16384),
  access_token_expires_at: timestamp,
  refresh_token: z.string().min(16).max(512),
  session_expires_at: timestamp,
  replayed: z.boolean(),
});
export const sessionResponse = refreshResponse.extend({
  owner_id: z.uuid(),
  email: ownerEmail,
  device_id: z.uuid(),
  agents: z.array(ownedAgent).max(200),
});
export const pageFields = {
  next_cursor: z.string().min(1).max(2048).nullable(),
  has_more: z.boolean(),
};
export const snapshotFields = { ...pageFields, watermark: z.number().int().nonnegative() };
export function consistentPage(page: { next_cursor: string | null; has_more: boolean }) {
  return page.has_more === (page.next_cursor !== null);
}
const peer = z.object({
  agent_id: z.uuid(),
  email: ownerEmail,
  email_verified: z.boolean(),
  display_name: nullableText,
  display_name_verified: z.literal(false),
});
const baseItem = z.object({
  kind: z.enum(["permission", "human_input"]),
  request_id: z.uuid(),
  revision: z.number().int().positive(),
  state: z.string().max(64),
  owner_id: z.uuid().nullable(),
  agent_id: z.uuid(),
  peer: peer.nullable(),
  action: z.object({
    name: z.string().min(1).max(128),
    verified: z.boolean(),
    input_schema: z.record(z.string(), z.unknown()).nullable(),
  }),
  scope: z.record(z.string(), z.unknown()).nullable(),
  reason: nullableText,
  correlation: z.object({ message_id: z.uuid().nullable() }),
  expires_at: timestamp.nullable(),
  created_at: timestamp,
});
const permissionItem = baseItem.extend({
  kind: z.literal("permission"),
  peer,
  offered: z.object({
    type: z.literal("decision"),
    options: z
      .array(z.enum(["accept", "deny", "allow_once", "allow_always"]))
      .min(1)
      .max(4),
  }),
});
const inputItem = baseItem.extend({
  kind: z.literal("human_input"),
  peer: z.null(),
  prompt: z.string().max(8192),
  request_kind: z.enum(["text_answer", "provider_option", "resource_grant"]),
  provider: z.record(z.string(), z.unknown()).nullable(),
  offered: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), max_length: z.number().int().positive().max(4000) }),
    z.object({
      type: z.literal("options"),
      options: z
        .array(z.object({ label: z.string().min(1).max(256), value: z.string().min(1).max(256) }))
        .min(1)
        .max(32),
    }),
  ]),
});
export const inboxItem = z.discriminatedUnion("kind", [permissionItem, inputItem]);
const party = z.object({ agent_id: z.uuid(), email: ownerEmail, display_name: nullableText });
export const grant = z.object({
  permission_id: z.uuid(),
  direction: z.enum(["outbound", "inbound", "internal"]),
  state: z.enum(["pending", "granted", "denied", "expired", "revoked", "exhausted"]),
  stored_state: z.string().max(64),
  revision: z.number().int().positive(),
  action: z.string().max(128),
  action_verified: z.boolean(),
  scope: z.unknown(),
  reason: nullableText,
  grantor: party,
  grantee: party.extend({ email_verified: z.boolean() }),
  uses_remaining: z.number().int().nonnegative().nullable(),
  expires_at: timestamp.nullable(),
  created_at: timestamp,
  decided_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
  last_used_at: timestamp.nullable(),
  revocable: z.boolean(),
});
export const invitationSchema = z.object({
  invitation_id: z.uuid(),
  direction: z.enum(["incoming", "outgoing"]),
  state: z.enum(["pending", "accepted", "declined"]),
  other_email: ownerEmail,
  other_name: nullableText,
  inviter_email: ownerEmail,
  invitee_email: ownerEmail,
  created_at: timestamp,
  responded_at: timestamp.nullable(),
  delivered: z.boolean(),
});
export const invitationsPage = z
  .object({ invitations: z.array(invitationSchema).max(200), ...pageFields })
  .refine(consistentPage);
export const connectionsPage = z
  .object({
    connections: z
      .array(
        z.object({
          invitation_id: z.uuid(),
          email: ownerEmail,
          name: nullableText,
          initiated_by_me: z.boolean(),
          connected_at: timestamp.nullable(),
        }),
      )
      .max(200),
    ...pageFields,
  })
  .refine(consistentPage);
export const devicesResponse = z.object({
  devices: z
    .array(
      z.object({
        id: z.uuid(),
        device_name: nullableText,
        platform: nullableText,
        jkt: z.string().max(128),
        created_at: timestamp,
        last_seen_at: timestamp.nullable(),
        revoked_at: timestamp.nullable(),
        executes_agent_ids: z.array(z.uuid()).max(200),
        is_current: z.boolean(),
      }),
    )
    .max(200),
});
export const historyPage = z
  .object({
    items: z
      .array(
        z.object({
          id: z.uuid(),
          permission_id: z.uuid(),
          event: z.string().max(128),
          from_state: nullableText,
          to_state: nullableText,
          revision: z.number().int().positive(),
          actor: nullableText,
          channel: nullableText,
          device_id: z.uuid().nullable(),
          reason: nullableText,
          at: timestamp,
        }),
      )
      .max(200),
    ...snapshotFields,
  })
  .refine(consistentPage);
export const eventsPage = z.object({
  events: z
    .array(
      z.object({
        event_id: z.uuid(),
        cursor: z.number().int().positive(),
        event_type: z.string().max(128),
        kind: z.string().max(128),
        request_id: z.uuid(),
        revision: z.number().int().nonnegative(),
        payload: z.record(z.string(), z.unknown()),
        created_at: timestamp,
      }),
    )
    .max(200),
  next_cursor: z.number().int().nonnegative(),
  watermark: z.number().int().nonnegative(),
  caught_up: z.boolean(),
});

export const pushEndpoint = z.object({
  id: z.uuid(),
  provider: z.enum(["apns", "wns"]),
  enabled: z.boolean(),
  muted_categories: z.array(z.string().min(1).max(128)).max(32),
  disabled_reason: nullableText,
  created_at: timestamp,
  updated_at: timestamp,
  last_success_at: timestamp.nullable(),
  last_failure_at: timestamp.nullable(),
});
export const pushStatus = z.object({
  registered: z.boolean(),
  available: z.boolean(),
  reason: nullableText,
  endpoint: pushEndpoint.nullable(),
  known_categories: z.array(z.string().min(1).max(128)).max(32),
});
