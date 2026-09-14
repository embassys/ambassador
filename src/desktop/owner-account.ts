import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import {
  type CentralCredentialRecord,
  type CentralKeyMaterial,
  createCentralCredentialRecord,
  parseCentralCredential,
} from "../central-credential.js";
import { redactVerboseValue, type VerboseLogger } from "../verbose-log.js";
import { permissionChoices } from "./owner-choices.js";
import {
  agentsResponse,
  connectionsPage,
  devicesResponse,
  eventsPage,
  historyPage,
  invitationSchema,
  invitationsPage,
  ownedAgent,
  pushEndpoint,
  pushStatus,
  refreshResponse,
  sessionResponse,
} from "./owner-contract.js";
import { OwnerDecisions, type OwnerSubmission, reviewable } from "./owner-decisions.js";
import { OwnerDeviceReviews } from "./owner-devices.js";
import { OwnerPeople } from "./owner-people.js";
import { inboxPage, permissionPage, projectInboxItem } from "./owner-projections.js";
import {
  type OwnerCommand,
  type OwnerIssue,
  type OwnerMutation,
  type OwnerReply,
  type OwnerReview,
  type OwnerSnapshot,
  type OwnerView,
  ownerCommandSchema,
  ownerEmail,
} from "./owner-protocol.js";
import { type OwnerCredential, type OwnerState, OwnerStore } from "./owner-store.js";

const origin = "https://mcp.embassys.ai";
const maximumResponseBytes = 4 * 1024 * 1024;
const claims = z.object({
  sub: z.uuid(),
  email: ownerEmail,
  sid: z.uuid(),
  dev: z.uuid(),
  cnf: z.object({ jkt: z.string() }),
  aud: z.literal("owner"),
  typ: z.literal("owner_access"),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
});
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly reason?: string,
  ) {
    super("Account request failed.");
  }
}
class InvalidResponse extends Error {}

// This checks realm and identity consistency, not a JWT signature. Only the fixed
// HTTPS service authenticates the session; owner reads check the live session server-side.
function credential(
  raw: unknown,
  expected: { email: string; ownerId?: string; sessionId?: string; deviceId: string; jkt: string },
  now: number,
): OwnerCredential {
  const response = refreshResponse.parse(raw);
  const parts = response.access_token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part)))
    throw new InvalidResponse();
  const header = z
    .object({ alg: z.string().min(1) })
    .parse(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")));
  if (header.alg.toLowerCase() === "none") throw new InvalidResponse();
  const parsed = claims.parse(
    JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")),
  );
  if (
    parsed.email !== expected.email ||
    (expected.ownerId && parsed.sub !== expected.ownerId) ||
    (expected.sessionId && parsed.sid !== expected.sessionId) ||
    parsed.dev !== expected.deviceId ||
    parsed.cnf.jkt !== expected.jkt ||
    parsed.exp * 1000 <= now ||
    parsed.iat * 1000 > now + 60000 ||
    Date.parse(response.session_expires_at) <= now ||
    Date.parse(response.access_token_expires_at) <= now
  )
    throw new InvalidResponse();
  return {
    access: response.access_token,
    refresh: response.refresh_token,
    expiresAt: Math.min(parsed.exp * 1000, Date.parse(response.access_token_expires_at)),
    sessionExpiresAt: Date.parse(response.session_expires_at),
    deviceId: parsed.dev,
    jkt: parsed.cnf.jkt,
    email: parsed.email,
    ownerId: parsed.sub,
    sessionId: parsed.sid,
  };
}

function checkDepth(value: unknown): void {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    const [item, depth] = current;
    if (depth > 32) throw new InvalidResponse();
    if (item && typeof item === "object")
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
}

export class OwnerAccount {
  #state: OwnerState;
  readonly decisions: OwnerDecisions;
  readonly people: OwnerPeople;
  readonly deviceReviews = new OwnerDeviceReviews();
  #context = randomUUID();
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  readonly #grantReviews = new Map<string, Extract<OwnerReview["target"], { kind: "revoke" }>>();
  #eventCursor: number | undefined;
  #closed = false;
  #unavailable = false;
  #abort = new AbortController();
  private constructor(
    readonly store: OwnerStore,
    readonly options: {
      directory: string;
      fetch?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
      log?: VerboseLogger;
      onChange?: (snapshot: OwnerSnapshot) => void;
    },
    state: OwnerState,
    readonly device: CentralKeyMaterial,
  ) {
    this.#state = state;
    this.decisions = new OwnerDecisions(store);
    try {
      this.people = new OwnerPeople(store);
    } catch (error) {
      this.decisions.close();
      throw error;
    }
  }

  static async open(options: OwnerAccount["options"]): Promise<OwnerAccount> {
    const store = await OwnerStore.open(options.directory);
    try {
      return new OwnerAccount(store, options, await store.load(), await store.deviceKey());
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  eventsChanged(context: string, cursor: number): void {
    if (
      context !== this.#context ||
      this.#state.status !== "signed_in" ||
      this.#eventCursor === cursor
    )
      return;
    this.#eventCursor = cursor;
    this.options.onChange?.(this.snapshot());
  }
  #now(): number {
    return (this.options.now ?? Date.now)();
  }
  snapshot(): OwnerSnapshot {
    if (this.#unavailable)
      return { context: this.#context, status: "unavailable", issue: "storage_unavailable" };
    const state = this.#state;
    if (state.status === "signed_in")
      return {
        context: this.#context,
        status: "signed_in",
        account: { ...state.account },
        ...(this.#eventCursor === undefined ? {} : { eventCursor: this.#eventCursor }),
        email: state.credential.email,
      };
    return {
      context: this.#context,
      status: state.status,
      ...("email" in state && state.email ? { email: state.email } : {}),
      ...("resendAt" in state ? { resendAt: state.resendAt } : {}),
      ...("issue" in state && state.issue ? { issue: state.issue } : {}),
    };
  }
  #assign(state: OwnerState, preserveContext = false): void {
    this.#state = state;
    if (!preserveContext) {
      this.#context = randomUUID();
      this.#eventCursor = undefined;
    }
    this.options.onChange?.(this.snapshot());
  }
  async #save(state: OwnerState): Promise<void> {
    try {
      await this.store.save(state);
    } catch {
      this.#unavailable = true;
      this.#assign({ status: "signed_out" });
      throw new Error("Account storage is unavailable. Reopen the app before continuing.");
    }
  }
  async #invalidate(issue: OwnerIssue, email?: string): Promise<void> {
    const state: OwnerState = { status: "reauth_required", issue, ...(email ? { email } : {}) };
    await this.#save(state);
    this.#assign(state);
  }
  #reply(data?: OwnerView, issue?: OwnerIssue): OwnerReply {
    if (data && Buffer.byteLength(JSON.stringify(data)) > 3 * 1024 * 1024)
      return this.#reply(undefined, "invalid_response");
    return {
      state: issue ? "unavailable" : "ready",
      snapshot: this.snapshot(),
      ...(issue ? { issue } : {}),
      ...(data ? { data, fetchedAt: new Date(this.#now()).toISOString() } : {}),
    };
  }
  command(input: unknown): Promise<OwnerReply> {
    const command = ownerCommandSchema.parse(input);
    if (this.#closed || this.#pending >= 8)
      return Promise.reject(new Error("Account service is busy or closed."));
    this.#pending++;
    const result = this.#tail.then(async () => {
      if (this.#closed) throw new Error("Account service is closed.");
      if (command.type === "owner_status") return this.#reply();
      if (!("context" in command) || command.context !== this.#context)
        throw new Error("Account changed. Refresh this view before continuing.");
      if (this.#unavailable) return this.#reply(undefined, "storage_unavailable");
      return await this.#execute(command);
    });
    this.#tail = result.catch(() => undefined);
    return result.finally(() => {
      this.#pending--;
    });
  }
  executionCredential(context: string, agentId: string): Promise<CentralCredentialRecord> {
    const operation = this.#tail.then(async () => {
      if (
        this.#closed ||
        context !== this.#context ||
        !(await this.#ensureSession()) ||
        this.#state.status !== "signed_in"
      )
        throw new Error("Account changed");
      z.uuid().parse(agentId);
      const session = this.#state.credential;
      const reply = z
        .object({
          agent_id: z.literal(agentId),
          email: ownerEmail,
          device_id: z.literal(session.deviceId),
          executor_epoch: z.number().int().nonnegative(),
          token: z.string().max(4096),
          expires_at: z.iso.datetime({ offset: true }),
        })
        .parse(
          await this.#request("/agent_execution_token", {
            access: session.access,
            body: { agent_id: agentId },
          }),
        );
      const record = createCentralCredentialRecord(reply.token, this.device);
      const loaded = parseCentralCredential(record, () => this.#now() / 1000);
      if (
        loaded.token.subject !== agentId ||
        loaded.token.email !== reply.email ||
        loaded.token.executionDeviceId !== session.deviceId ||
        loaded.token.executorEpoch !== reply.executor_epoch
      )
        throw new InvalidResponse();
      return record;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
  nativePush(context: string, token: string | null): Promise<OwnerReply> {
    if (token !== null && !/^[a-f0-9]{16,512}$/iu.test(token))
      return Promise.reject(new Error("Invalid native token"));
    const operation = this.#tail.then(async () => {
      if (
        this.#closed ||
        context !== this.#context ||
        !(await this.#ensureSession()) ||
        this.#state.status !== "signed_in"
      )
        throw new Error("Account changed");
      if (token === null)
        z.object({ removed: z.boolean(), message: z.string().max(2048) }).parse(
          await this.#request("/push", { access: this.#state.credential.access, method: "DELETE" }),
        );
      else
        pushEndpoint.parse(
          await this.#request("/push/register", {
            access: this.#state.credential.access,
            body: { provider: "apns", token },
          }),
        );
      return this.#ownerView({ type: "owner_push_status", context }, this.#state.credential);
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
  async #execute(command: OwnerCommand): Promise<OwnerReply> {
    if (command.type === "owner_request_code") {
      if (this.#state.status === "signed_in")
        throw new Error("Sign out before using another account.");
      if (this.#state.status === "code_sent" && this.#state.resendAt > this.#now())
        throw new Error("Wait before requesting another code.");
      const state: OwnerState = {
        status: "code_sent",
        email: command.email,
        resendAt: this.#now() + 60000,
        expiresAt: this.#now() + 600000,
        issue: "code_unconfirmed",
      };
      await this.#save(state);
      const pending: OwnerState = { ...state };
      delete pending.issue;
      this.#assign(pending);
      try {
        const sent = z
          .object({
            message: z.string().max(512),
            expires_in_minutes: z.number().int().min(1).max(60),
          })
          .parse(await this.#request("/start_sign_in", { body: { email: command.email } }));
        const confirmed: OwnerState = {
          ...state,
          expiresAt: this.#now() + sent.expires_in_minutes * 60000,
        };
        delete confirmed.issue;
        await this.#save(confirmed);
        this.#assign(confirmed);
      } catch (error) {
        if (this.#unavailable) throw error;
        if (error instanceof HttpFailure && error.status === 429) {
          const limited: OwnerState = { ...state, issue: "rate_limited" };
          await this.#save(limited);
          this.#assign(limited);
        } else this.#assign(state);
      }
      return this.#reply();
    }
    if (command.type === "owner_verify") {
      if (this.#state.status !== "code_sent") throw new Error("Request a new sign-in code.");
      const challenge = this.#state;
      if (challenge.expiresAt <= this.#now()) {
        await this.#invalidate("code_expired", challenge.email);
        return this.#reply();
      }
      // Same-device verification is replayable during the challenge window.
      const uncertain: OwnerState = { ...challenge, issue: "verification_uncertain" };
      await this.#save(uncertain);
      try {
        const raw = await this.#request("/verify_sign_in", {
          body: {
            email: challenge.email,
            code: command.code,
            device: {
              jwk: this.device.publicJwk,
              device_name: hostname().slice(0, 100),
              platform: process.platform,
            },
          },
        });
        const identity = sessionResponse.parse(raw);
        if (identity.email !== challenge.email) throw new InvalidResponse();
        const session = credential(
          raw,
          {
            email: challenge.email,
            ownerId: identity.owner_id,
            deviceId: identity.device_id,
            jkt: this.device.thumbprint,
          },
          this.#now(),
        );
        const state: OwnerState = {
          status: "signed_in",
          credential: session,
          account: {
            owner_id: session.ownerId,
            device_id: session.deviceId,
            agents: identity.agents,
            email: session.email,
            display_name: null,
            username: null,
          },
        };
        this.people.adopt(
          session.ownerId,
          identity.agents
            .filter((agent) => agent.email_verified && agent.email === session.email)
            .map((agent) => agent.id),
        );
        await this.#save(state);
        this.#assign(state);
      } catch (error) {
        if (this.#unavailable) throw error;
        if (error instanceof HttpFailure && [400, 401, 429].includes(error.status)) {
          const rejected: OwnerState = {
            ...challenge,
            issue: error.status === 429 ? "rate_limited" : "invalid_code",
          };
          await this.#save(rejected);
          this.#assign(rejected);
        } else this.#assign(uncertain);
      }
      return this.#reply();
    }
    if (command.type === "owner_signout") {
      const session = this.#state.status === "signed_in" ? this.#state.credential : undefined;
      const state: OwnerState = {
        status: "signed_out",
        ...(session ? { issue: "signout_unconfirmed" as const } : {}),
      };
      await this.#save(state);
      // Persist uncertainty for a crash, but do not display failure before the request ends.
      this.#assign({ status: "signed_out" });
      if (session && session.expiresAt > this.#now()) {
        let pushRemoved = true;
        await this.#request("/push", { access: session.access, method: "DELETE" }).catch(() => {
          pushRemoved = false;
        });
        try {
          z.object({ message: z.string().max(512) }).parse(
            await this.#request("/sign_out", { access: session.access, post: true }),
          );
          const completed: OwnerState = pushRemoved ? { status: "signed_out" } : state;
          await this.#save(completed);
          this.#assign(completed);
        } catch (error) {
          if (this.#unavailable) throw error;
          this.#assign(state);
        }
      } else if (session) this.#assign(state);
      return this.#reply();
    }
    if (["owner_people", "owner_people_save", "owner_people_remove"].includes(command.type)) {
      if (this.#state.status !== "signed_in") return this.#reply(undefined, "session_expired");
      const agentId = this.#state.credential.ownerId;
      if (command.type === "owner_people_save")
        this.people.save(agentId, command.contacts, command.replace);
      if (command.type === "owner_people_remove") this.people.remove(agentId, command.email);
      return this.#reply({ kind: "people", contacts: this.people.list(agentId) });
    }
    if (!(await this.#ensureSession()))
      return this.#reply(undefined, this.snapshot().issue ?? "session_expired");
    if (this.#state.status !== "signed_in") return this.#reply(undefined, "session_expired");
    const state = this.#state;
    if (command.type === "owner_device_review" || command.type === "owner_device_submit")
      return this.#deviceCommand(command, state.credential);
    if (command.type === "owner_communications")
      return this.#reply(undefined, "history_unavailable");
    if (
      [
        "owner_create_agent",
        "owner_invite",
        "owner_invitation_answer",
        "owner_invitations",
        "owner_connections",
        "owner_history",
        "owner_devices",
        "owner_push_status",
        "owner_events",
      ].includes(command.type)
    )
      return this.#ownerView(command, state.credential);
    if (command.type === "owner_review" || command.type === "owner_submit")
      return this.#decision(command, state.credential);
    const path =
      command.type === "owner_profile"
        ? "/devices"
        : command.type === "owner_requests"
          ? `/inbox?limit=200${command.cursor ? `&cursor=${encodeURIComponent(command.cursor)}` : ""}`
          : command.type === "owner_permissions"
            ? `/permissions?direction=${command.direction === "granted" ? "outbound" : "inbound"}&limit=200${command.cursor ? `&cursor=${encodeURIComponent(command.cursor)}` : ""}`
            : undefined;
    if (!path) throw new Error("Unsupported account operation.");
    try {
      const raw = await this.#request(path, { access: state.credential.access });
      let data: OwnerView;
      if (command.type === "owner_profile") {
        const devices = devicesResponse.parse(raw).devices;
        const current = devices.find(
          (device) =>
            device.id === state.credential.deviceId &&
            device.is_current &&
            device.revoked_at === null,
        );
        if (!current || current.jkt !== state.credential.jkt) throw new InvalidResponse();
        data = { kind: "profile", profile: await this.#refreshAgents(state.credential) };
      } else if (command.type === "owner_requests") {
        const requests = inboxPage(raw);
        if (requests.total !== requests.permission_requests.length + requests.input_requests.length)
          throw new InvalidResponse();
        data = {
          kind: "requests",
          ...requests,
          ...this.decisions.unconfirmed(state.credential.ownerId),
        };
      } else if (command.type === "owner_permissions") {
        const permissions = permissionPage(raw, command.direction);
        if (
          permissions.direction !== command.direction ||
          permissions.permissions.some(
            (item) =>
              item.direction !==
              (command.direction === "granted" ? "granted_by_me" : "granted_to_me"),
          )
        )
          throw new InvalidResponse();
        this.#grantReviews.clear();
        for (const item of permissions.permissions)
          this.#grantReviews.set(item.id, { kind: "revoke", item });
        data = { kind: "permissions", ...permissions };
      } else throw new InvalidResponse();
      checkDepth(data);
      const visible = redactVerboseValue(data) as OwnerView;
      this.options.log?.("owner.view", { body: visible });
      return this.#reply(visible);
    } catch (error) {
      if (this.#unavailable) throw error;
      if (error instanceof HttpFailure && error.status === 401) {
        await this.#invalidate("session_expired", state.credential.email);
        return this.#reply(undefined, "session_expired");
      }
      return this.#reply(
        undefined,
        error instanceof HttpFailure && error.reason === "cursor_too_old"
          ? "cursor_expired"
          : error instanceof z.ZodError || error instanceof InvalidResponse
            ? "invalid_response"
            : error instanceof HttpFailure && error.status === 429
              ? "rate_limited"
              : "offline",
      );
    }
  }

  async #refreshAgents(session: OwnerCredential) {
    const { agents } = agentsResponse.parse(
      await this.#request("/agents", { access: session.access }),
    );
    if (
      agents.some(
        (agent) => agent.is_executed_here !== (agent.executor_device_id === session.deviceId),
      )
    )
      throw new InvalidResponse();
    if (this.#state.status !== "signed_in" || this.#state.credential !== session)
      throw new InvalidResponse();
    const account = { ...this.#state.account, agents };
    const updated = { ...this.#state, account };
    this.people.adopt(
      session.ownerId,
      agents
        .filter((agent) => agent.email_verified && agent.email === session.email)
        .map((agent) => agent.id),
    );
    await this.#save(updated);
    this.#assign(updated, true);
    return account;
  }

  async #deviceCommand(
    command: Extract<OwnerCommand, { type: "owner_device_review" | "owner_device_submit" }>,
    session: OwnerCredential,
  ): Promise<OwnerReply> {
    const devices = devicesResponse.parse(
      await this.#request("/devices", { access: session.access }),
    ).devices;
    const profile = await this.#refreshAgents(session);
    if (command.type === "owner_device_review") {
      const device = devices.find(
        (item) => item.id === command.device_id && item.revoked_at === null,
      );
      const agent = profile.agents.find((item) => item.id === command.agent_id);
      if (
        !device ||
        (command.operation === "execute" && !agent?.email_verified) ||
        (command.operation === "revoke" && command.agent_id)
      )
        return this.#reply(undefined, "request_unavailable");
      return this.#reply(
        this.deviceReviews.create(
          this.#context,
          { operation: command.operation, device, ...(agent ? { agent } : {}) },
          this.#now(),
        ),
      );
    }
    const review = this.deviceReviews.consume(this.#context, command.review_id, this.#now());
    if (!review) return this.#reply(undefined, "review_expired");
    if (review.agent) {
      const currentAgent = profile.agents.find((agent) => agent.id === review.agent?.id);
      if (!currentAgent || JSON.stringify(currentAgent) !== JSON.stringify(review.agent))
        return this.#reply(undefined, "review_expired");
    }
    const current = devices.find((item) => item.id === review.device.id);
    const stable = (value: typeof current) =>
      value &&
      JSON.stringify([
        value.id,
        value.device_name,
        value.jkt,
        value.revoked_at,
        [...value.executes_agent_ids].sort(),
      ]);
    if (!current || stable(current) !== stable(review.device))
      return this.#reply(undefined, "review_expired");
    const result = {
      kind: "device_result" as const,
      operation: review.operation,
      device_id: current.id,
      ...(review.agent ? { agent_id: review.agent.id } : {}),
      confirmed: false,
      executes_here: current.is_current,
    };
    try {
      if (review.operation === "revoke") {
        z.object({
          device_id: z.literal(current.id),
          revoked_at: z.iso.datetime({ offset: true }),
          agents_left_without_executor: z.array(z.uuid()).max(200),
          sessions_revoked: z.number().int().nonnegative(),
          message: z.string().max(2048),
        }).parse(
          await this.#request("/revoke_device", {
            access: session.access,
            body: { device_id: current.id },
          }),
        );
        result.confirmed = true;
        if (current.is_current) await this.#invalidate("session_expired", session.email);
      } else if (review.agent) {
        z.object({
          agent_id: z.literal(review.agent.id),
          device_id: z.literal(current.id),
          executor_epoch: z.number().int().nonnegative(),
          transferred_from_device_id: z.uuid().nullable(),
          message: z.string().max(2048),
        }).parse(
          await this.#request("/select_executor", {
            access: session.access,
            body: { agent_id: review.agent.id, device_id: current.id },
          }),
        );
        result.confirmed = true;
      }
    } catch {
      /* An unknown transfer must be re-read, never repeated automatically. */
    }
    return this.#reply(result);
  }
  async #ownerView(command: OwnerCommand, session: OwnerCredential): Promise<OwnerReply> {
    try {
      const query = new URLSearchParams({ limit: "200" });
      if ("cursor" in command && typeof command.cursor === "string")
        query.set("cursor", command.cursor);
      let data: OwnerView;
      if (command.type === "owner_create_agent") {
        const result = z
          .object({ agent: ownedAgent, created: z.boolean() })
          .parse(await this.#request("/agents", { access: session.access, body: {} }));
        const previous =
          this.#state.status === "signed_in"
            ? this.#state.account.agents.find((agent) => agent.email === session.email)
            : undefined;
        if (
          result.agent.email !== session.email ||
          !result.agent.email_verified ||
          result.agent.is_executed_here !==
            (result.agent.executor_device_id === session.deviceId) ||
          (previous && previous.id !== result.agent.id)
        )
          throw new InvalidResponse();
        const profile = await this.#refreshAgents(session);
        const agent = profile.agents.find((agent) => agent.id === result.agent.id);
        if (!agent || agent.email !== session.email || !agent.email_verified)
          throw new InvalidResponse();
        data = { kind: "agent_setup", agent, created: result.created };
      } else if (command.type === "owner_invite") {
        const result = z.object({ invitation: invitationSchema, created: z.boolean() }).parse(
          await this.#request("/invitations", {
            access: session.access,
            body: { invitee_email: command.email },
          }),
        );
        if (
          result.invitation.other_email !== command.email ||
          ![result.invitation.inviter_email, result.invitation.invitee_email].includes(
            session.email,
          )
        )
          throw new InvalidResponse();
        data = { kind: "invitation", invitation: result.invitation };
      } else if (command.type === "owner_invitation_answer") {
        const result = z.object({ invitation: invitationSchema }).parse(
          await this.#request(`/invitations/${command.invitation_id}/${command.answer}`, {
            access: session.access,
            post: true,
          }),
        );
        if (
          result.invitation.invitation_id !== command.invitation_id ||
          result.invitation.invitee_email !== session.email ||
          result.invitation.direction !== "incoming" ||
          result.invitation.state !== (command.answer === "accept" ? "accepted" : "declined")
        )
          throw new InvalidResponse();
        data = { kind: "invitation", invitation: result.invitation };
      } else if (command.type === "owner_invitations")
        data = {
          kind: "invitations",
          ...invitationsPage.parse(
            await this.#request(`/invitations?${query}`, { access: session.access }),
          ),
        };
      else if (command.type === "owner_connections")
        data = {
          kind: "connections",
          ...connectionsPage.parse(
            await this.#request(`/connections?${query}`, { access: session.access }),
          ),
        };
      else if (command.type === "owner_history") {
        if (command.permission_id) query.set("permission_id", command.permission_id);
        data = {
          kind: "history",
          ...historyPage.parse(
            await this.#request(`/permissions/history?${query}`, { access: session.access }),
          ),
        };
      } else if (command.type === "owner_devices") {
        data = {
          kind: "devices",
          ...devicesResponse.parse(await this.#request("/devices", { access: session.access })),
        };
        await this.#refreshAgents(session);
      } else if (command.type === "owner_push_status")
        data = {
          kind: "push",
          ...pushStatus.parse(await this.#request("/push", { access: session.access })),
        };
      else if (command.type === "owner_events") {
        const page = eventsPage.parse(
          await this.#request(`/events?cursor=${command.cursor}&limit=200`, {
            access: session.access,
          }),
        );
        let previous = command.cursor;
        for (const event of page.events) {
          if (event.cursor <= previous || event.cursor > page.watermark)
            throw new InvalidResponse();
          previous = event.cursor;
        }
        if (page.next_cursor !== previous || page.caught_up !== previous >= page.watermark)
          throw new InvalidResponse();
        data = { kind: "events", ...page };
      } else throw new InvalidResponse();
      return this.#reply(redactVerboseValue(data) as OwnerView);
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 401)
        await this.#invalidate("session_expired", session.email);
      return this.#reply(
        undefined,
        error instanceof HttpFailure && error.reason === "cursor_too_old"
          ? "cursor_expired"
          : error instanceof z.ZodError || error instanceof InvalidResponse
            ? "invalid_response"
            : error instanceof HttpFailure && error.status === 429
              ? "rate_limited"
              : error instanceof HttpFailure && [400, 403, 404, 409, 422].includes(error.status)
                ? "request_unavailable"
                : "offline",
      );
    }
  }

  #mutationReply(mutation: OwnerMutation): OwnerReply {
    return this.#reply({ kind: "mutation", mutation, status: mutation.status });
  }
  async #target(
    kind: OwnerMutation["kind"],
    id: string,
    access: string,
  ): Promise<OwnerReview["target"] | undefined> {
    const raw = z.object({ item: z.unknown() }).parse(
      await this.#request(`/inbox/${kind === "input" ? "human_input" : "permission"}/${id}`, {
        access,
      }),
    );
    const target = projectInboxItem(raw.item);
    if (target.item.id !== id) throw new InvalidResponse();
    if (kind === "revoke") {
      const cached = this.#grantReviews.get(id);
      if (
        !cached ||
        target.kind !== "permission" ||
        target.item.revision !== cached.item.revision ||
        target.item.state !== "granted"
      )
        return undefined;
      return cached;
    }
    if (target.kind !== kind || target.item.state !== "pending") return undefined;
    return target;
  }
  async #decision(
    command: Extract<OwnerCommand, { type: "owner_review" | "owner_submit" }>,
    session: OwnerCredential,
  ): Promise<OwnerReply> {
    try {
      if (command.type === "owner_review") {
        const previous = this.decisions.get(session.ownerId, command.kind, command.id);
        if (previous) return this.#recoverDecision(session, previous);
        const target = await this.#target(command.kind, command.id, session.access);
        if (!target || !reviewable(target, this.#now()))
          return this.#reply(undefined, "request_unavailable");
        // Keep the comparison record intact. Only public copies are credential-redacted.
        const review = this.decisions.review(this.#context, target, this.#now());
        return this.#reply(redactVerboseValue(review) as OwnerReview);
      }
      const entry = this.decisions.reviews.get(command.review_id);
      if (!entry || entry.context !== this.#context)
        return this.#reply(undefined, "review_expired");
      const { review } = entry;
      const { target } = review;
      if (Date.parse(review.expires_at) <= this.#now())
        return this.#reply(undefined, "review_expired");
      let body: { decision?: string; value?: string; text?: string } | undefined;
      if (target.kind === "permission") {
        if (
          command.decision === undefined ||
          command.value !== undefined ||
          command.text !== undefined ||
          !permissionChoices(target.item.decision_options, target.item.offered_options).some(
            (choice) => choice.value === command.decision,
          )
        )
          return this.#reply(undefined, "request_unavailable");
        body = { decision: command.decision ?? "" };
      } else if (target.kind === "input") {
        if (command.decision !== undefined) return this.#reply(undefined, "request_unavailable");
        if (target.item.input_type === "buttons") {
          if (
            command.text !== undefined ||
            !target.item.options?.some((option) => option.value === command.value)
          )
            return this.#reply(undefined, "request_unavailable");
          body = { value: command.value ?? "" };
        } else {
          if (command.value !== undefined || !command.text?.trim())
            return this.#reply(undefined, "request_unavailable");
          body = { text: command.text };
        }
      } else if (
        command.decision !== undefined ||
        command.value !== undefined ||
        command.text !== undefined
      )
        return this.#reply(undefined, "request_unavailable");
      const submissionHash = createHash("sha256")
        .update(JSON.stringify(body ?? {}))
        .digest("hex");
      const previous = this.decisions.get(session.ownerId, target.kind, target.item.id);
      if (previous)
        return this.decisions.matches(session.ownerId, target.kind, target.item.id, submissionHash)
          ? this.#recoverDecision(session, previous)
          : this.#reply(undefined, "request_unavailable");
      const fresh = await this.#target(target.kind, target.item.id, session.access);
      if (
        Date.parse(review.expires_at) <= this.#now() ||
        !fresh ||
        !reviewable(fresh, this.#now()) ||
        JSON.stringify(fresh) !== JSON.stringify(target)
      )
        return this.#reply(undefined, "review_expired");
      if (target.item.revision === undefined) return this.#reply(undefined, "review_expired");
      const submission: OwnerSubmission = {
        key: randomUUID(),
        createdAt: this.#now(),
        body:
          target.kind === "revoke"
            ? { permission_id: target.item.id, expected_revision: target.item.revision }
            : {
                kind: target.kind === "input" ? "human_input" : "permission",
                request_id: target.item.id,
                expected_revision: target.item.revision,
                ...body,
              },
        expectedState:
          target.kind === "revoke"
            ? "revoked"
            : target.kind === "input"
              ? "answered"
              : command.decision === "deny"
                ? "denied"
                : "granted",
        expectedAnswer:
          target.kind === "permission"
            ? (command.decision ?? "")
            : target.kind === "input"
              ? (command.text?.trim() ??
                target.item.options?.find((option) => option.value === command.value)?.label ??
                "")
              : "",
      };
      const mutation: OwnerMutation = {
        kind: target.kind,
        id: target.item.id,
        action_type: target.item.action_type,
        status: "unconfirmed",
        updated_at: new Date(this.#now()).toISOString(),
      };
      try {
        this.decisions.save(session.ownerId, mutation, submissionHash, submission);
      } catch {
        this.#unavailable = true;
        throw new Error("Decision could not be saved.");
      }
      return this.#sendDecision(session, mutation, submission, false);
    } catch (error) {
      if (this.#unavailable) throw error;
      if (error instanceof HttpFailure && error.status === 401) {
        await this.#invalidate("session_expired", session.email);
        return this.#reply(undefined, "session_expired");
      }
      return this.#reply(
        undefined,
        error instanceof z.ZodError || error instanceof InvalidResponse
          ? "invalid_response"
          : "offline",
      );
    }
  }

  async #recoverDecision(session: OwnerCredential, mutation: OwnerMutation): Promise<OwnerReply> {
    const submission = this.decisions.submission(session.ownerId, mutation.kind, mutation.id);
    // Legacy unkeyed decisions and receipts outside server retention cannot be retried.
    if (
      mutation.status !== "unconfirmed" ||
      !submission ||
      this.#now() < submission.createdAt ||
      this.#now() - submission.createdAt >= 23 * 60 * 60 * 1000
    )
      return this.#mutationReply(mutation);
    return this.#sendDecision(session, mutation, submission, true);
  }
  async #sendDecision(
    session: OwnerCredential,
    mutation: OwnerMutation,
    submission: OwnerSubmission,
    recovering: boolean,
  ): Promise<OwnerReply> {
    try {
      const raw = await this.#request(
        mutation.kind === "revoke" ? "/permissions/revoke" : "/decide",
        {
          access: session.access,
          body: submission.body,
          key: submission.key,
        },
      );
      const revision = z.number().int().positive().parse(submission.body.expected_revision);
      if (mutation.kind === "revoke")
        z.object({
          permission_id: z.literal(mutation.id),
          state: z.literal("revoked"),
          revision: z.number().int().min(revision),
          already_revoked: z.boolean(),
          effect: z.string().max(2000),
          message: z.string().max(2000),
        }).parse(raw);
      else
        z.object({
          kind: z.literal(mutation.kind === "input" ? "human_input" : "permission"),
          request_id: z.literal(mutation.id),
          state: z.literal(submission.expectedState),
          revision: z.number().int().min(revision),
          answer: z.literal(submission.expectedAnswer),
          message: z.string().max(2000),
        }).parse(raw);
      mutation = {
        ...mutation,
        status: "confirmed",
        updated_at: new Date(this.#now()).toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpFailure) {
        // A 409 also means the original keyed request is still processing. Never
        // call it settled or issue a new key based on the HTTP status alone.
        if (error.status === 401) await this.#invalidate("session_expired", session.email);
        if (!recovering && [400, 403, 422, 429].includes(error.status)) {
          this.decisions.remove(session.ownerId, mutation.kind, mutation.id);
          return this.#reply(
            undefined,
            error.status === 429 ? "rate_limited" : "request_unavailable",
          );
        }
      }
    }
    try {
      this.decisions.save(session.ownerId, mutation);
    } catch {
      this.#unavailable = true;
      throw new Error("Decision confirmation could not be saved.");
    }
    return this.#mutationReply(mutation);
  }
  async #ensureSession(): Promise<boolean> {
    if (this.#state.status !== "signed_in") return false;
    const old = this.#state;
    if (old.credential.expiresAt > this.#now() + 30000) return true;
    if (
      old.credential.sessionExpiresAt <= this.#now() ||
      (old.refreshStartedAt !== undefined && this.#now() - old.refreshStartedAt >= 240000)
    ) {
      await this.#invalidate("session_expired", old.credential.email);
      return false;
    }
    const uncertain: OwnerState = { ...old, refreshStartedAt: old.refreshStartedAt ?? this.#now() };
    await this.#save(uncertain);
    try {
      const raw = await this.#request("/refresh", {
        body: { refresh_token: old.credential.refresh },
      });
      const session = credential(raw, old.credential, this.#now());
      const updated: OwnerState = {
        status: "signed_in",
        account: old.account,
        credential: session,
      };
      await this.#save(updated);
      this.#assign(updated, true);
      return true;
    } catch (error) {
      if (this.#unavailable) throw error;
      if (error instanceof HttpFailure && error.status === 401)
        await this.#invalidate("session_expired", old.credential.email);
      else if (error instanceof InvalidResponse || error instanceof z.ZodError)
        await this.#invalidate("invalid_response", old.credential.email);
      else this.#assign(uncertain, true);
      return false;
    }
  }

  async #request(
    path: string,
    options: { body?: unknown; access?: string; post?: boolean; key?: string; method?: "DELETE" },
  ): Promise<unknown> {
    const method = options.method ?? (options.body !== undefined || options.post ? "POST" : "GET");
    const started = this.#now();
    const requestId = randomUUID();
    const signal = AbortSignal.any([
      this.#abort.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 15000),
    ]);
    this.options.log?.("owner.request", {
      request_id: requestId,
      method,
      url: `${origin}/api/owner${path}`,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(`${origin}/api/owner${path}`, {
        method,
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          ...(options.key ? { "Idempotency-Key": options.key } : {}),
          "User-Agent": "Embassys Desktop",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(options.access ? { Authorization: `Bearer ${options.access}` } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      this.options.log?.("owner.response", {
        request_id: requestId,
        method,
        status: response.status,
        duration_ms: this.#now() - started,
      });
      if (!response.ok) {
        let reason: string | undefined;
        if (response.status === 409 && path.startsWith("/events?")) {
          const { readCentralJson } = await import("../central-json.js");
          const raw = await readCentralJson(response, 16384);
          const expired = z
            .object({
              detail: z.object({
                error: z.literal("cursor_too_old"),
                recovery: z.literal("resnapshot"),
                watermark: z.number().int().nonnegative(),
              }),
            })
            .safeParse(raw);
          if (expired.success) reason = "cursor_too_old";
        }
        await response.body?.cancel().catch(() => undefined);
        throw new HttpFailure(response.status, reason);
      }
      if (
        ["/verify_sign_in", "/refresh"].includes(path) &&
        (response.headers.has("set-cookie") ||
          !response.headers
            .get("cache-control")
            ?.split(",")
            .some((value) => value.trim().toLowerCase() === "no-store"))
      ) {
        await response.body?.cancel();
        throw new InvalidResponse();
      }
      if (
        !/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "") ||
        Number(response.headers.get("content-length") ?? 0) > maximumResponseBytes
      ) {
        await response.body?.cancel();
        throw new InvalidResponse();
      }
      reader = response.body?.getReader();
      if (!reader) throw new InvalidResponse();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      const abort = () => {
        void reader?.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maximumResponseBytes) throw new InvalidResponse();
          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw new InvalidResponse();
      }
      checkDepth(raw);
      return raw;
    } catch (error) {
      this.options.log?.("owner.request.failed", {
        request_id: requestId,
        method,
        duration_ms: this.#now() - started,
      });
      throw error;
    } finally {
      await reader?.cancel().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    await this.#tail;
    this.#assign({ status: "signed_out" });
    this.decisions.close();
    this.people.close();
    await this.store.close();
  }
}
