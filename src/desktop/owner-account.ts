import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redactVerboseValue, type VerboseLogger } from "../verbose-log.js";
import {
  communicationsSchema,
  type OwnerCommand,
  type OwnerIssue,
  type OwnerReply,
  type OwnerSnapshot,
  type OwnerView,
  ownerCommandSchema,
  ownerEmail,
  ownerProfile,
  permissionsSchema,
  requestsSchema,
} from "./owner-protocol.js";
import { type OwnerCredential, type OwnerState, OwnerStore } from "./owner-store.js";

const origin = "https://mcp.embassys.ai";
const maximumResponseBytes = 4 * 1024 * 1024;
const tokens = z.object({
  access_token: z.string().min(20).max(16384),
  refresh_token: z.string().min(10).max(512),
  token_type: z.literal("bearer"),
  expires_in: z.number().int().min(1).max(3600),
});
const claims = z.object({
  sub: z.uuid(),
  email: ownerEmail,
  sid: z.uuid(),
  aud: z.literal("embassys-app"),
  typ: z.literal("app_access"),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
});
class HttpFailure extends Error {
  constructor(readonly status: number) {
    super("Account request failed.");
  }
}
class InvalidResponse extends Error {}

// This checks realm and identity consistency, not a JWT signature. Only the fixed
// HTTPS service authenticates the session; /me checks the live session server-side.
function credential(
  raw: unknown,
  expected: { email: string; agentId?: string; sessionId?: string },
  now: number,
): OwnerCredential {
  const response = tokens.parse(raw);
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
    (expected.agentId && parsed.sub !== expected.agentId) ||
    (expected.sessionId && parsed.sid !== expected.sessionId) ||
    parsed.exp * 1000 <= now ||
    parsed.iat * 1000 > now + 60000
  )
    throw new InvalidResponse();
  return {
    access: response.access_token,
    refresh: response.refresh_token,
    expiresAt: Math.min(parsed.exp * 1000, now + response.expires_in * 1000),
    email: parsed.email,
    agentId: parsed.sub,
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
  #context = randomUUID();
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
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
  ) {
    this.#state = state;
  }

  static async open(options: OwnerAccount["options"]): Promise<OwnerAccount> {
    const store = await OwnerStore.open(options.directory);
    try {
      return new OwnerAccount(store, options, await store.load());
    } catch (error) {
      await store.close();
      throw error;
    }
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
    if (!preserveContext) this.#context = randomUUID();
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
        z.object({ status: z.literal("ok") }).parse(
          await this.#request("/login/request", { body: { email: command.email } }),
        );
        const confirmed: OwnerState = { ...state };
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
      // A crash or dropped success must not allow this one-use code to be replayed.
      const uncertain: OwnerState = {
        status: "reauth_required",
        email: challenge.email,
        issue: "verification_uncertain",
      };
      await this.#save(uncertain);
      try {
        const raw = await this.#request("/login/verify", {
          body: { email: challenge.email, code: command.code },
        });
        const identity = z.object({ email: ownerEmail, agent_id: z.uuid() }).parse(raw);
        if (identity.email !== challenge.email) throw new InvalidResponse();
        const session = credential(
          raw,
          { email: challenge.email, agentId: identity.agent_id },
          this.#now(),
        );
        const state: OwnerState = {
          status: "signed_in",
          credential: session,
          account: {
            agent_id: session.agentId,
            email: session.email,
            display_name: null,
            username: null,
          },
        };
        await this.#save(state);
        this.#assign(state);
      } catch (error) {
        if (this.#unavailable) throw error;
        if (error instanceof HttpFailure && [401, 429].includes(error.status)) {
          const rejected: OwnerState = {
            ...challenge,
            issue: error.status === 401 ? "invalid_code" : "rate_limited",
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
      this.#assign(state);
      if (session && session.expiresAt > this.#now()) {
        try {
          z.object({ status: z.literal("ok") }).parse(
            await this.#request("/session/signout", { access: session.access, post: true }),
          );
          await this.#save({ status: "signed_out" });
          this.#assign({ status: "signed_out" });
        } catch (error) {
          if (this.#unavailable) throw error;
        }
      }
      return this.#reply();
    }
    if (!(await this.#ensureSession()))
      return this.#reply(undefined, this.snapshot().issue ?? "session_expired");
    if (this.#state.status !== "signed_in") return this.#reply(undefined, "session_expired");
    const state = this.#state;
    const path =
      command.type === "owner_profile"
        ? "/me"
        : command.type === "owner_requests"
          ? "/requests"
          : command.type === "owner_permissions"
            ? `/permissions?direction=${command.direction}&limit=200`
            : command.type === "owner_communications"
              ? "/communications?limit=200"
              : undefined;
    if (!path) throw new Error("Unsupported account operation.");
    try {
      const raw = await this.#request(path, { access: state.credential.access });
      let data: OwnerView;
      if (command.type === "owner_profile") {
        const profile = ownerProfile.parse(raw);
        if (
          profile.agent_id !== state.credential.agentId ||
          profile.session_id !== state.credential.sessionId ||
          profile.email !== state.credential.email
        )
          throw new InvalidResponse();
        const { session_id: _session, ...account } = profile;
        const updated = { ...state, account };
        await this.#save(updated);
        this.#assign(updated, true);
        data = { kind: "profile", profile: account };
      } else if (command.type === "owner_requests") {
        const requests = requestsSchema.parse(raw);
        if (requests.total !== requests.permission_requests.length + requests.input_requests.length)
          throw new InvalidResponse();
        data = { kind: "requests", ...requests };
      } else if (command.type === "owner_permissions") {
        const permissions = permissionsSchema.parse(raw);
        if (
          permissions.direction !== command.direction ||
          permissions.permissions.some(
            (item) =>
              item.direction !==
              (command.direction === "granted" ? "granted_by_me" : "granted_to_me"),
          )
        )
          throw new InvalidResponse();
        data = { kind: "permissions", ...permissions };
      } else data = { kind: "communications", ...communicationsSchema.parse(raw) };
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
        error instanceof z.ZodError || error instanceof InvalidResponse
          ? "invalid_response"
          : error instanceof HttpFailure && error.status === 429
            ? "rate_limited"
            : "offline",
      );
    }
  }

  async #ensureSession(): Promise<boolean> {
    if (this.#state.status !== "signed_in") return false;
    const old = this.#state;
    if (old.credential.expiresAt > this.#now() + 30000) return true;
    const uncertain: OwnerState = {
      status: "reauth_required",
      email: old.credential.email,
      issue: "refresh_uncertain",
    };
    await this.#save(uncertain);
    try {
      const raw = await this.#request("/session/refresh", {
        body: { refresh_token: old.credential.refresh },
      });
      const session = credential(raw, old.credential, this.#now());
      const updated: OwnerState = { ...old, credential: session };
      await this.#save(updated);
      this.#assign(updated, true);
      return true;
    } catch (error) {
      if (this.#unavailable) throw error;
      if (error instanceof HttpFailure && error.status === 401)
        await this.#invalidate("session_expired", old.credential.email);
      else this.#assign(uncertain);
      return false;
    }
  }

  async #request(
    path: string,
    options: { body?: unknown; access?: string; post?: boolean },
  ): Promise<unknown> {
    const method = options.body !== undefined || options.post ? "POST" : "GET";
    const started = this.#now();
    const requestId = randomUUID();
    const signal = AbortSignal.any([
      this.#abort.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 15000),
    ]);
    this.options.log?.("owner.request", {
      request_id: requestId,
      method,
      url: `${origin}/api/app${path}`,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(`${origin}/api/app${path}`, {
        method,
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
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
        await response.body?.cancel();
        throw new HttpFailure(response.status);
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
    await this.store.close();
  }
}
