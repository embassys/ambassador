import { centralJwkThumbprint } from "../../src/central-credential.js";
export const OWNER_ID = "00000000-0000-4000-8000-000000000010";
export const AGENT_ID = "00000000-0000-4000-8000-000000000011";
export const SESSION_ID = "00000000-0000-4000-8000-000000000012";
export const DEVICE_ID = "00000000-0000-4000-8000-000000000013";
const peerId = "00000000-0000-4000-8000-000000000014";
const email = "owner@fixture.test";
const decode = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
// Test authors describe a screen row; this fixture emits the reviewed owner REST shape.
export function wireRequests(raw: Record<string, unknown>) {
  const permissions = (raw.permission_requests ?? []) as Array<Record<string, unknown>>;
  const inputs = (raw.input_requests ?? []) as Array<Record<string, unknown>>;
  const common = (row: Record<string, unknown>) => ({
    request_id: row.id,
    revision: row.revision ?? 1,
    state: row.state ?? "pending",
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    action: { name: row.action_type, verified: true, input_schema: null },
    correlation: { message_id: null },
    expires_at: row.expires_at ?? null,
    created_at: row.created_at,
  });
  return {
    items: [
      ...permissions.map((row) => ({
        ...common(row),
        kind: "permission",
        peer: {
          agent_id: peerId,
          email: row.requester_email,
          email_verified: true,
          display_name: row.requester_name,
          display_name_verified: false,
        },
        scope: decode(row.scope),
        reason: row.reason ?? null,
        offered: {
          type: "decision",
          options:
            row.offered_options ??
            (row.decision_options === "once_always"
              ? ["deny", "allow_once", "allow_always"]
              : row.decision_options === "accept_deny"
                ? ["deny", "accept"]
                : []),
        },
      })),
      ...inputs.map((row) => ({
        ...common(row),
        kind: "human_input",
        peer: null,
        scope: null,
        reason: row.prompt,
        prompt: row.prompt,
        request_kind: "provider_option",
        provider: null,
        offered:
          row.input_type === "text"
            ? { type: "text", max_length: 4000 }
            : { type: "options", options: decode(row.options) },
      })),
    ],
    next_cursor: null,
    has_more: false,
    watermark: 0,
  };
}
export function wireGrants(raw: Record<string, unknown>) {
  return {
    items: ((raw.permissions ?? []) as Array<Record<string, unknown>>).map((row) => ({
      permission_id: row.id,
      direction: row.direction === "granted_by_me" ? "outbound" : "inbound",
      state: row.status,
      stored_state: row.status,
      revision: row.revision ?? 1,
      action: row.action_type,
      action_verified: true,
      scope: row.scope,
      reason: null,
      grantor: { agent_id: AGENT_ID, email: row.grantor_email, display_name: row.grantor_name },
      grantee: {
        agent_id: peerId,
        email: row.grantee_email,
        display_name: row.grantee_name,
        email_verified: true,
      },
      uses_remaining: row.uses_remaining,
      expires_at: row.expires_at,
      created_at: row.created_at,
      decided_at: row.decided_at,
      revoked_at: null,
      last_used_at: null,
      revocable: row.status === "granted",
    })),
    next_cursor: null,
    has_more: false,
    watermark: 0,
  };
}
export function ownerSession(now: number, jkt: string, overrides: Record<string, unknown> = {}) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = {
    sub: OWNER_ID,
    email,
    sid: SESSION_ID,
    dev: DEVICE_ID,
    cnf: { jkt },
    aud: "owner",
    typ: "owner_access",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 900,
    ...overrides,
  };
  return {
    owner_id: OWNER_ID,
    device_id: DEVICE_ID,
    email,
    access_token: `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.Zml4dHVyZS1zaWduYXR1cmU`,
    refresh_token: "fixture-refresh-original",
    access_token_expires_at: new Date(now + 900000).toISOString(),
    session_expires_at: new Date(now + 30 * 86400000).toISOString(),
    replayed: false,
    agents: [
      {
        id: AGENT_ID,
        email,
        display_name: "Fixture agent",
        email_verified: true,
        executor_device_id: null,
        is_executed_here: false,
        executor_epoch: 0,
      },
    ],
  };
}
export { centralJwkThumbprint };
