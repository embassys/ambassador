import { z } from "zod";
import {
  communicationsPage,
  connectionsPage,
  devicesResponse,
  eventsPage,
  historyPage,
  invitationSchema,
  invitationsPage,
  ownedAgent,
  pushStatus,
} from "./owner-contract.js";
import { deviceResult, deviceReview } from "./owner-devices.js";
import { contactEmail, contactSchema, contactsSchema } from "./people-schema.js";

export { ownerEmail } from "./owner-email.js";

import { ownerEmail } from "./owner-email.js";

const context = z.uuid();
const pageCursor = z.string().min(1).max(2048).optional();
export const mutationKind = z.enum(["permission", "input", "revoke"]);
export const ownerCommands = [
  z.strictObject({ type: z.literal("owner_status") }),
  z.strictObject({ type: z.literal("owner_request_code"), context, email: ownerEmail }),
  z.strictObject({ type: z.literal("owner_verify"), context, code: z.string().regex(/^\d{6}$/u) }),
  z.strictObject({ type: z.literal("owner_signout"), context }),
  z.strictObject({ type: z.literal("owner_profile"), context }),
  z.strictObject({ type: z.literal("owner_create_agent"), context }),
  z.strictObject({ type: z.literal("owner_invitations"), context, cursor: pageCursor }),
  z.strictObject({ type: z.literal("owner_connections"), context, cursor: pageCursor }),
  z.strictObject({ type: z.literal("owner_invite"), context, email: ownerEmail }),
  z.strictObject({
    type: z.literal("owner_invitation_answer"),
    context,
    invitation_id: z.uuid(),
    answer: z.enum(["accept", "decline"]),
  }),
  z.strictObject({
    type: z.literal("owner_history"),
    context,
    cursor: pageCursor,
    permission_id: z.uuid().optional(),
  }),
  z.strictObject({
    type: z.literal("owner_events"),
    context,
    cursor: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("owner_devices"), context }),
  z.strictObject({
    type: z.literal("owner_device_review"),
    context,
    operation: z.enum(["revoke", "execute"]),
    device_id: z.uuid(),
    agent_id: z.uuid().optional(),
  }),
  z.strictObject({
    type: z.literal("owner_device_submit"),
    context,
    review_id: z.uuid(),
    instanceId: z.uuid().optional(),
  }),
  z.strictObject({ type: z.literal("owner_push_status"), context }),
  z.strictObject({ type: z.literal("owner_people"), context }),
  z.strictObject({
    type: z.literal("owner_people_save"),
    context,
    contacts: z.array(contactSchema).min(1).max(25),
    replace: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("owner_people_remove"), context, email: contactEmail }),
  z.strictObject({ type: z.literal("owner_requests"), context, cursor: pageCursor }),
  z.strictObject({
    type: z.literal("owner_permissions"),
    context,
    direction: z.enum(["granted", "received"]),
    cursor: pageCursor,
  }),
  z.strictObject({ type: z.literal("owner_communications"), context, cursor: pageCursor }),
  z.strictObject({ type: z.literal("owner_review"), context, kind: mutationKind, id: z.uuid() }),
  z.strictObject({
    type: z.literal("owner_submit"),
    context,
    review_id: z.uuid(),
    decision: z.enum(["accept", "deny", "allow_once", "allow_always"]).optional(),
    value: z.string().min(1).max(256).optional(),
    text: z.string().min(1).max(4000).optional(),
  }),
  z.strictObject({ type: z.literal("owner_open_web") }),
  z.strictObject({ type: z.literal("owner_reveal_logs") }),
] as const;
export const ownerCommandSchema = z.discriminatedUnion("type", ownerCommands);
export type OwnerCommand = z.infer<typeof ownerCommandSchema>;

export const ownerIssue = z.enum([
  "history_unavailable",
  "cursor_expired",
  "invalid_code",
  "code_unconfirmed",
  "code_expired",
  "verification_uncertain",
  "refresh_uncertain",
  "session_expired",
  "signout_unconfirmed",
  "rate_limited",
  "offline",
  "invalid_response",
  "storage_unavailable",
  "worker_unavailable",
  "review_expired",
  "request_unavailable",
]);
export type OwnerIssue = z.infer<typeof ownerIssue>;
export const ownedAgentSchema = z.object({
  id: z.uuid(),
  email: ownerEmail,
  display_name: z.string().max(8192).nullable(),
  email_verified: z.boolean(),
  executor_device_id: z.uuid().nullable(),
  is_executed_here: z.boolean(),
  executor_epoch: z.number().int().nonnegative(),
});
export const ownerProfile = z.object({
  owner_id: z.uuid(),
  device_id: z.uuid(),
  agents: z.array(ownedAgentSchema).max(200),
  email: ownerEmail,
  display_name: z.string().max(512).nullable(),
  username: z.string().max(512).nullable(),
  session_id: z.uuid(),
});
export const publicOwnerProfile = ownerProfile.omit({ session_id: true });
export const ownerSnapshotSchema = z.strictObject({
  context,
  status: z.enum([
    "loading",
    "signed_out",
    "code_sent",
    "signed_in",
    "reauth_required",
    "unavailable",
  ]),
  email: ownerEmail.optional(),
  account: publicOwnerProfile.optional(),
  resendAt: z.number().int().nonnegative().optional(),
  eventCursor: z.number().int().nonnegative().optional(),
  issue: ownerIssue.optional(),
});
export type OwnerSnapshot = z.infer<typeof ownerSnapshotSchema>;
const text = z.string().max(8192);
const nullableText = text.nullable();
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
// asyncpg can return JSON columns as strings. Decode only these declared JSON fields.
const json = z.unknown().transform((value, ctx): unknown => {
  try {
    const decoded: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (decoded !== null && (typeof decoded !== "object" || Array.isArray(decoded)))
      throw new Error();
    if (JSON.stringify(decoded).length > 32768) throw new Error();
    return decoded;
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid account data." });
    return z.NEVER;
  }
});
const option = z.object({ label: z.string().max(256), value: z.string().max(256).optional() });
const options = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}, z.array(option).max(32).nullable());
const requestContext = {
  revision: z.number().int().positive().optional(),
  agent_id: z.uuid().optional(),
  owner_id: z.uuid().nullable().optional(),
  state: z.string().max(64).optional(),
  reason: nullableText.optional(),
  action_verified: z.boolean().optional(),
  message_id: z.uuid().nullable().optional(),
};
export const permissionRequestSchema = z.object({
  ...requestContext,
  requester_verified: z.boolean().optional(),
  requester_agent_id: z.uuid().optional(),
  offered_options: z
    .array(z.enum(["accept", "deny", "allow_once", "allow_always"]))
    .min(1)
    .max(4)
    .optional(),
  id: z.uuid(),
  decision_options: nullableText,
  scope: json,
  created_at: timestamp,
  expires_at: timestamp.nullable(),
  action_type: text,
  action_description: nullableText,
  requester_email: nullableText,
  requester_name: nullableText,
});
export const inputRequestSchema = z.object({
  ...requestContext,
  expires_at: timestamp.nullable().optional(),
  request_kind: z.enum(["text_answer", "provider_option", "resource_grant"]).optional(),
  provider: z.record(z.string(), z.unknown()).nullable().optional(),
  id: z.uuid(),
  prompt: text,
  input_type: z.string().max(64),
  options,
  created_at: timestamp,
  action_type: text,
});
export const permissionSchema = z.object({
  revision: z.number().int().positive().optional(),
  reason: nullableText.optional(),
  revocable: z.boolean().optional(),
  internal: z.boolean().optional(),
  action_verified: z.boolean().optional(),
  id: z.uuid(),
  status: z.string().max(64),
  decision: nullableText,
  decision_options: nullableText,
  uses_remaining: z.number().int().nonnegative().nullable(),
  scope: json,
  created_at: timestamp,
  decided_at: timestamp.nullable(),
  expires_at: timestamp.nullable(),
  action_type: text,
  action_description: nullableText,
  grantor_email: nullableText,
  grantor_name: nullableText,
  grantee_email: nullableText,
  grantee_name: nullableText,
  direction: z.enum(["granted_by_me", "granted_to_me"]),
});
const pagination = {
  next_cursor: z.string().max(2048).nullable().optional(),
  has_more: z.boolean().optional(),
  watermark: z.number().int().nonnegative().optional(),
};
export const requestsSchema = z.object({
  ...pagination,
  permission_requests: z.array(permissionRequestSchema).max(200),
  input_requests: z.array(inputRequestSchema).max(200),
  total: z.number().int().min(0).max(400),
});
export const permissionsSchema = z.object({
  ...pagination,
  direction: z.enum(["granted", "received"]),
  permissions: z.array(permissionSchema).max(200),
});
export const communicationsSchema = communicationsPage;
export const mutationSchema = z.object({
  kind: mutationKind,
  id: z.uuid(),
  action_type: text,
  status: z.enum(["confirmed", "unconfirmed", "settled"]),
  updated_at: timestamp,
});
export type OwnerMutation = z.infer<typeof mutationSchema>;
export const reviewSchema = z.object({
  kind: z.literal("review"),
  review_id: z.uuid(),
  expires_at: timestamp,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("permission"), item: permissionRequestSchema }),
    z.object({ kind: z.literal("input"), item: inputRequestSchema }),
    z.object({ kind: z.literal("revoke"), item: permissionSchema }),
  ]),
});
export type OwnerReview = z.infer<typeof reviewSchema>;
export const ownerViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent_setup"), agent: ownedAgent, created: z.boolean() }),
  deviceReview,
  deviceResult,
  invitationsPage.safeExtend({ kind: z.literal("invitations") }),
  connectionsPage.safeExtend({ kind: z.literal("connections") }),
  z.object({ kind: z.literal("invitation"), invitation: invitationSchema }),
  historyPage.safeExtend({ kind: z.literal("history") }),
  devicesResponse.extend({ kind: z.literal("devices") }),
  pushStatus.extend({ kind: z.literal("push") }),
  eventsPage.extend({ kind: z.literal("events") }),
  z.object({ kind: z.literal("people"), contacts: contactsSchema }),
  z.object({ kind: z.literal("profile"), profile: publicOwnerProfile }),
  z.object({
    kind: z.literal("requests"),
    ...requestsSchema.shape,
    unconfirmed: z.array(mutationSchema).max(100).optional(),
    unconfirmedMore: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("permissions"), ...permissionsSchema.shape }),
  z.object({ kind: z.literal("communications"), ...communicationsSchema.shape }),
  reviewSchema,
  z.object({
    kind: z.literal("mutation"),
    mutation: mutationSchema,
    status: mutationSchema.shape.status,
  }),
]);
export type OwnerView = z.infer<typeof ownerViewSchema>;
export const ownerReplySchema = z.strictObject({
  state: z.enum(["ready", "unavailable"]),
  snapshot: ownerSnapshotSchema,
  issue: ownerIssue.optional(),
  data: ownerViewSchema.optional(),
  fetchedAt: timestamp.optional(),
});
export type OwnerReply = z.infer<typeof ownerReplySchema>;
