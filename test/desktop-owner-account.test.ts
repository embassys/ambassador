import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopGateway } from "../src/desktop/gateway.js";
import { DesktopInstances } from "../src/desktop/instances.js";
import { OwnerAccount } from "../src/desktop/owner-account.js";
import { parseDesktopCommand } from "../src/desktop/protocol.js";
import {
  centralJwkThumbprint,
  DEVICE_ID,
  ownerSession,
  wireGrants,
  wireRequests,
} from "./support/owner-wire-fixture.js";

const email = "owner@fixture.test";
const agentId = "00000000-0000-4000-8000-000000000011";
const sessionId = "00000000-0000-4000-8000-000000000012";
function token(now: number, overrides: Record<string, unknown> = {}) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({
    sub: agentId,
    email,
    sid: sessionId,
    aud: "embassys-app",
    typ: "app_access",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 900,
    ...overrides,
  })}.Zml4dHVyZS1zaWduYXR1cmU`;
}
function fixture() {
  let now = Date.now();
  let rotated = 0;
  let jkt = "";
  let activeGrants: Record<string, unknown>[] = [];
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  let override:
    | ((path: string, init?: RequestInit) => Response | Promise<Response> | undefined)
    | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://mcp.embassys.ai");
    assert.equal(init?.redirect, "error");
    const path = url.pathname + url.search;
    calls.push({ path, init });
    const wireResponse = async (response: Response): Promise<Response> => {
      if (
        response.headers.has("content-length") ||
        response.headers.has("x-fixture-passthrough") ||
        !response.ok ||
        !response.headers.get("content-type")?.includes("application/json")
      )
        return response;
      const raw = (await response.clone().json()) as Record<string, unknown>;
      if (raw.permission_requests) return Response.json(wireRequests(raw));
      if (raw.permissions) {
        activeGrants = wireGrants(raw).items;
        return Response.json(wireGrants(raw));
      }
      if (raw.status === "ok" && raw.permission_id)
        return Response.json(
          path.endsWith("/revoke")
            ? {
                permission_id: raw.permission_id,
                state: "revoked",
                revision: 2,
                already_revoked: false,
                message: "Revoked",
                effect: "Stops future use",
              }
            : {
                kind: "permission",
                request_id: raw.permission_id,
                state: raw.decision === "deny" ? "denied" : "granted",
                revision: 2,
                answer: raw.decision,
                message: "Decided",
              },
        );
      if (raw.status === "ok" && raw.request_id)
        return Response.json({
          kind: "human_input",
          request_id: raw.request_id,
          state: "answered",
          revision: 2,
          answer: raw.answer,
          message: "Answered",
        });
      return response;
    };
    const changed = await override?.(path, init);
    if (changed) return wireResponse(changed);
    if (url.pathname.startsWith("/api/owner/inbox/")) {
      const listing = await override?.("/api/owner/inbox?limit=200", init);
      const raw = listing
        ? ((await listing.json()) as Record<string, unknown>)
        : { permission_requests: [], input_requests: [] };
      const wanted = url.pathname.split("/").at(-1);
      const item = wireRequests(raw).items.find((item) => item.request_id === wanted);
      if (item && activeGrants.some((grant) => grant.permission_id === wanted))
        item.state = "granted";
      return item ? Response.json({ item }) : Response.json({}, { status: 404 });
    }
    if (path === "/api/owner/start_sign_in")
      return Response.json({ message: "Code sent", expires_in_minutes: 10 });
    if (path === "/api/owner/verify_sign_in") {
      const input = JSON.parse(String(init?.body));
      if (input.code !== "314159") return Response.json({}, { status: 400 });
      jkt = centralJwkThumbprint(input.device.jwk);
      return Response.json(ownerSession(now, jkt), { headers: { "cache-control": "no-store" } });
    }
    assert.equal(new Headers(init?.headers).has("DPoP"), false);
    if (path === "/api/owner/refresh") {
      rotated++;
      return Response.json(
        { ...ownerSession(now, jkt), refresh_token: `fixture-refresh-rotated-${rotated}` },
        { headers: { "cache-control": "no-store" } },
      );
    }
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /u);
    if (path === "/api/owner/agents")
      return Response.json({ agents: ownerSession(now, jkt).agents, newly_attached_agent_ids: [] });
    if (path === "/api/owner/devices")
      return Response.json({
        devices: [
          {
            id: DEVICE_ID,
            device_name: "Fixture device",
            platform: "darwin",
            jkt,
            created_at: new Date(now).toISOString(),
            last_seen_at: null,
            revoked_at: null,
            executes_agent_ids: [],
            is_current: true,
          },
        ],
      });
    if (path === "/api/owner/inbox?limit=200")
      return Response.json({ items: [], next_cursor: null, has_more: false, watermark: 0 });
    if (path.startsWith("/api/owner/permissions?"))
      return Response.json({ items: [], next_cursor: null, has_more: false, watermark: 0 });
    if (path === "/api/owner/communications?limit=200")
      return Response.json({ communications: [] });
    if (path === "/api/owner/push" && init?.method === "DELETE")
      return Response.json({ removed: true, message: "Removed" });
    if (path === "/api/owner/sign_out") return Response.json({ message: "Signed out" });
    throw new Error("Unexpected fixture route");
  };
  return {
    calls,
    fetcher,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    override: (fn: typeof override) => {
      override = fn;
    },
  };
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "embassys-owner-"));
  const f = fixture();
  const options = { directory: join(root, "account"), fetch: f.fetcher, now: f.now };
  let service = await OwnerAccount.open(options);
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = (command: Record<string, unknown>) =>
    service.command({ context: service.snapshot().context, ...command });
  return {
    root,
    f,
    options,
    get service() {
      return service;
    },
    request,
    async restart() {
      await service.close();
      service = await OwnerAccount.open(options);
    },
    async login() {
      await request({ type: "owner_request_code", email });
      return await request({ type: "owner_verify", code: "314159" });
    },
  };
}

test("local people work offline, survive restart and reject signed-out or stale account contexts", async (t) => {
  const s = await setup(t);
  assert.equal((await s.request({ type: "owner_people" })).issue, "session_expired");
  await s.login();
  const oldContext = s.service.snapshot().context;
  const callsBefore = s.f.calls.length;
  s.f.override(() => {
    throw new Error("Network unavailable");
  });
  const saved = await s.request({
    type: "owner_people_save",
    contacts: [{ name: "Alex", email: "alex@example.test" }],
  });
  assert.equal(saved.data?.kind, "people");
  assert.equal(s.f.calls.length, callsBefore);
  await s.restart();
  const read = await s.request({ type: "owner_people" });
  assert.equal(read.data?.kind, "people");
  if (read.data?.kind === "people") assert.equal(read.data.contacts[0]?.name, "Alex");
  await assert.rejects(
    s.service.command({ type: "owner_people", context: oldContext }),
    /Account changed/u,
  );
  const context = s.service.snapshot().context;
  await s.request({ type: "owner_signout" });
  await assert.rejects(
    s.service.command({ type: "owner_people_remove", context, email: "alex@example.test" }),
    /Account changed/u,
  );
  assert.equal((await s.request({ type: "owner_people" })).data, undefined);
});

test("owner snapshots accept JSON columns, preserve exact labels and redact nested credentials", async (t) => {
  const s = await setup(t);
  await s.login();
  const logs: unknown[] = [];
  s.service.options.log = (event, data) => logs.push({ event, data });
  s.f.override((path) =>
    path === "/api/owner/inbox?limit=200"
      ? Response.json({
          total: 2,
          permission_requests: [
            {
              id: randomUUID(),
              decision_options: "once_always",
              scope: '{"calendar_id":"primary","refresh_token":"private-refresh"}',
              created_at: new Date().toISOString(),
              expires_at: null,
              action_type: "read_calendar_permission",
              action_description: null,
              requester_email: "peer@fixture.test",
              requester_name: "<script>doBadThings()</script>",
            },
          ],
          input_requests: [
            {
              id: randomUUID(),
              prompt: "Which calendar?",
              input_type: "buttons",
              options: '[{"label":"Only this one","value":"provider:exact-option"}]',
              created_at: new Date().toISOString(),
              action_type: "read_calendar_permission",
            },
          ],
          unexpected_token: "private-refresh",
        })
      : undefined,
  );
  const response = await s.request({ type: "owner_requests" });
  assert.equal(response.state, "ready");
  assert.equal(response.data?.kind, "requests");
  assert.match(
    JSON.stringify(response),
    /Only this one|provider:exact-option|unknown_future_menu/u,
  );
  assert.doesNotMatch(JSON.stringify([response, logs]), /private-refresh|unexpected_token/u);
  assert.equal(
    s.f.calls.filter(
      (call) =>
        call.path.includes("poll_messages") ||
        call.path.includes("decide") ||
        call.path.includes("ack"),
    ).length,
    0,
  );
});

test("owner lists reject mismatched direction, excessive rows, malformed fields and HTML errors", async (t) => {
  const s = await setup(t);
  await s.login();
  for (const reply of [
    Response.json({ direction: "granted", permissions: Array(201).fill({}) }),
    Response.json({ direction: "granted", permissions: [{ id: "not-a-uuid" }] }),
    new Response("<h1>proxy error, secret=private</h1>", {
      headers: { "content-type": "text/html" },
    }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "5000000" },
    }),
  ]) {
    s.f.override((path) => (path.startsWith("/api/owner/permissions") ? reply : undefined));
    const result = await s.request({ type: "owner_permissions", direction: "granted" });
    assert.equal(result.state, "unavailable");
    assert.equal(result.issue, "invalid_response");
    assert.equal(result.data, undefined);
  }
});

test("expired challenges and authentication throttles are not reported as successful sign-in", async (t) => {
  const s = await setup(t);
  s.f.override((path) =>
    path === "/api/owner/start_sign_in" ? Response.json({}, { status: 429 }) : undefined,
  );
  await s.request({ type: "owner_request_code", email });
  assert.equal(s.service.snapshot().issue, "rate_limited");
  s.f.advance(601000);
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().issue, "code_expired");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/verify_sign_in").length, 0);
});

test("a failed credential save after successful login retains the same-device verification challenge", async (t) => {
  const s = await setup(t);
  await s.request({ type: "owner_request_code", email });
  const save = s.service.store.save.bind(s.service.store);
  s.service.store.save = async (state) => {
    if (state.status === "signed_in") throw new Error("disk full");
    await save(state);
  };
  await assert.rejects(s.request({ type: "owner_verify", code: "314159" }));
  assert.equal(s.service.snapshot().status, "unavailable");
  await s.restart();
  assert.equal(s.service.snapshot().status, "code_sent");
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().status, "signed_in");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/verify_sign_in").length, 2);
});

test("saving uncertainty must finish before any one-use refresh is sent", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.advance(901000);
  s.service.store.save = async () => {
    throw new Error("read only");
  };
  await assert.rejects(s.request({ type: "owner_requests" }));
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/refresh").length, 0);
});

test("a body that stalls after HTTP headers is cancelled within the account deadline", async (t) => {
  const s = await setup(t);
  await s.login();
  s.service.options.timeoutMs = 30;
  let cancelled = false;
  s.f.override((path) =>
    path === "/api/owner/inbox?limit=200"
      ? new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json", "x-fixture-passthrough": "true" } },
        )
      : undefined,
  );
  // Keep the test's event loop active while AbortSignal's unreferenced timer runs.
  const keepAlive = setTimeout(() => undefined, 2000);
  try {
    const reply = await s.request({ type: "owner_requests" });
    assert.equal(reply.state, "unavailable");
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a queued read from before sign-out cannot return data for a later account", async (t) => {
  const s = await setup(t);
  await s.login();
  const context = s.service.snapshot().context;
  const signingOut = s.service.command({ type: "owner_signout", context });
  const staleRead = s.service.command({ type: "owner_requests", context });
  await signingOut;
  await assert.rejects(staleRead, /Account changed/u);
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/inbox?limit=200").length, 0);
});

test("owner IPC rejects paths, tokens, instance selection and decision commands", () => {
  const context = randomUUID();
  for (const extra of [
    { token: "secret" },
    { instanceId: randomUUID() },
    { url: "https://evil.test" },
  ])
    assert.throws(() => parseDesktopCommand({ type: "owner_requests", context, ...extra }));
  assert.throws(() => parseDesktopCommand({ type: "owner_decide", context, decision: "accept" }));
  assert.throws(() => parseDesktopCommand({ type: "owner_verify", context, code: "1234567" }));
  assert.equal(
    parseDesktopCommand({ type: "owner_permissions", context, direction: "received" }).type,
    "owner_permissions",
  );
});

test("a pending code email shows no failure until the request outcome is unknown", async (t) => {
  const s = await setup(t);
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let fail: (error: Error) => void = () => undefined;
  s.f.override((path) =>
    path === "/api/owner/start_sign_in"
      ? new Promise<Response>((_resolve, reject) => {
          fail = reject;
          entered();
        })
      : undefined,
  );
  const call = s.request({ type: "owner_request_code", email });
  await started;
  assert.equal(s.service.snapshot().status, "code_sent");
  assert.equal(s.service.snapshot().issue, undefined);
  fail(new Error("response lost"));
  await call;
  assert.equal(s.service.snapshot().issue, "code_unconfirmed");
  await s.restart();
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().status, "signed_in");
});

test("expired sign-in challenges show a new-code prompt after restart without sending email", async (t) => {
  const s = await setup(t);
  await s.request({ type: "owner_request_code", email });
  s.f.advance(599_999);
  await s.restart();
  assert.equal(s.service.snapshot().status, "code_sent");
  s.f.advance(1);
  assert.equal(s.service.snapshot().status, "reauth_required");
  assert.equal(s.service.snapshot().issue, "code_expired");
  assert.equal(s.service.snapshot().email, email);
  await s.restart();
  assert.equal(s.service.snapshot().status, "reauth_required");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/start_sign_in").length, 1);
  const verificationCalls = s.f.calls.filter((c) => c.path === "/api/owner/verify_sign_in").length;
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(
    s.f.calls.filter((c) => c.path === "/api/owner/verify_sign_in").length,
    verificationCalls,
  );
  await s.request({ type: "owner_request_code", email });
  assert.equal(s.service.snapshot().status, "code_sent");
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().status, "signed_in");
});

test("owner login rejects bad codes, bounds resend and exposes no session credentials", async (t) => {
  const s = await setup(t);
  assert.equal(s.service.snapshot().status, "signed_out");
  await s.request({ type: "owner_request_code", email: " OWNER@fixture.test " });
  assert.equal(s.service.snapshot().status, "code_sent");
  await assert.rejects(s.request({ type: "owner_request_code", email }));
  await s.request({ type: "owner_verify", code: "000000" });
  assert.equal(s.service.snapshot().status, "code_sent");
  assert.equal(s.service.snapshot().issue, "invalid_code");
  const reply = await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().status, "signed_in");
  assert.doesNotMatch(
    JSON.stringify(reply),
    /access_token|refresh_token|"314159"|fixture-refresh/u,
  );
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/start_sign_in").length, 1);
});

test("owner encrypted session survives restart and refreshes only once for concurrent reads", async (t) => {
  const s = await setup(t);
  await s.login();
  const oldContext = s.service.snapshot().context;
  await s.restart();
  assert.equal(s.service.snapshot().status, "signed_in");
  await assert.rejects(s.service.command({ type: "owner_requests", context: oldContext }));
  s.f.advance(901_000);
  const replies = await Promise.all([
    s.request({ type: "owner_requests" }),
    s.request({ type: "owner_permissions", direction: "granted" }),
    s.request({ type: "owner_communications" }),
  ]);
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/refresh").length, 1);
  assert.doesNotMatch(JSON.stringify(replies), /Bearer|fixture-refresh/u);
  for (const name of await readdir(s.options.directory)) {
    const bytes = await readFile(join(s.options.directory, name));
    assert.ok(!bytes.includes(Buffer.from("fixture-refresh")), name);
    assert.ok(!bytes.includes(Buffer.from(email)), name);
    // Codes serialize as JSON strings; their digits can occur by chance in encrypted hex.
    assert.ok(!bytes.includes(Buffer.from('"314159"')), name);
  }
});

test("lost refresh response retries within overlap after restart without exposing tokens", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.advance(901_000);
  s.f.override((path) => {
    if (path === "/api/owner/refresh") throw new Error("lost fixture-refresh-secret");
  });
  const result = await s.request({ type: "owner_requests" });
  assert.doesNotMatch(JSON.stringify(result), /fixture-refresh-secret/u);
  assert.equal(s.service.snapshot().status, "signed_in");
  await s.restart();
  s.f.override(undefined);
  await s.request({ type: "owner_requests" });
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/refresh").length, 2);
});

test("lost verification response can be retried only on the same saved device", async (t) => {
  const s = await setup(t);
  await s.request({ type: "owner_request_code", email });
  s.f.override((path) => {
    if (path === "/api/owner/verify_sign_in") throw new Error("unknown");
  });
  await s.request({ type: "owner_verify", code: "314159" });
  await s.restart();
  s.f.override(undefined);
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().status, "signed_in");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/verify_sign_in").length, 2);
});

test("owner login refuses an agent token, mismatched email or another session on refresh", async (t) => {
  for (const overrides of [
    { aud: "agent", typ: "access" },
    { email: "other@fixture.test" },
    { sub: randomUUID() },
  ]) {
    const s = await setup(t);
    await s.request({ type: "owner_request_code", email });
    s.f.override((path) =>
      path === "/api/owner/verify_sign_in"
        ? Response.json({
            access_token: token(s.f.now(), overrides),
            refresh_token: "fixture-refresh-secret",
            token_type: "bearer",
            expires_in: 900,
            agent_id: agentId,
            email,
          })
        : undefined,
    );
    await s.request({ type: "owner_verify", code: "314159" });
    assert.equal(s.service.snapshot().status, "code_sent");
    assert.equal(s.service.snapshot().account, undefined);
  }
  const s = await setup(t);
  await s.login();
  s.f.advance(901_000);
  s.f.override((path) =>
    path === "/api/owner/refresh"
      ? Response.json({
          access_token: token(s.f.now(), { sid: randomUUID() }),
          refresh_token: "fixture-refresh-secret",
          token_type: "bearer",
          expires_in: 900,
        })
      : undefined,
  );
  await s.request({ type: "owner_requests" });
  assert.equal(s.service.snapshot().status, "reauth_required");
});

test("offline reads remain distinguishable from empty views; a revoked session clears account data", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.override((path) => {
    if (path === "/api/owner/inbox?limit=200") throw new Error("offline");
  });
  assert.equal((await s.request({ type: "owner_requests" })).state, "unavailable");
  assert.equal(s.service.snapshot().status, "signed_in");
  s.f.override((path) =>
    path === "/api/owner/inbox?limit=200" ? Response.json({}, { status: 401 }) : undefined,
  );
  await s.request({ type: "owner_requests" });
  assert.equal(s.service.snapshot().status, "reauth_required");
  assert.equal(s.service.snapshot().account, undefined);
});

test("sign-out commits locally despite a lost response and never touches instance files", async (t) => {
  const s = await setup(t);
  await s.login();
  const marker = join(s.root, "instance-credential");
  await writeFile(marker, "keep gateway");
  const context = s.service.snapshot().context;
  s.f.override((path) => {
    if (path === "/api/owner/sign_out") throw new Error("lost");
  });
  await s.request({ type: "owner_signout" });
  assert.equal(s.service.snapshot().status, "signed_out");
  assert.equal(s.service.snapshot().issue, "signout_unconfirmed");
  assert.equal(await readFile(marker, "utf8"), "keep gateway");
  await assert.rejects(s.service.command({ type: "owner_requests", context }));
  await s.restart();
  assert.equal(s.service.snapshot().status, "signed_out");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/sign_out").length, 1);
});

test("sign-out does not show a failure while its confirmation is still pending", async (t) => {
  const s = await setup(t);
  await s.login();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  s.f.override((path) => {
    if (path !== "/api/owner/sign_out") return;
    entered();
    return response;
  });
  const pending = s.request({ type: "owner_signout" });
  await started;
  try {
    assert.equal(s.service.snapshot().status, "signed_out");
    assert.equal(s.service.snapshot().issue, undefined);
    assert.deepEqual(
      await s.service.store.load(),
      {
        status: "signed_out",
        issue: "signout_unconfirmed",
      },
      "A crash still records that remote sign-out was not confirmed.",
    );
  } finally {
    finish(Response.json({ status: "ok", message: "Signed out on this device." }));
    await pending;
  }
  assert.equal(s.service.snapshot().issue, undefined);
  assert.deepEqual(await s.service.store.load(), { status: "signed_out" });
});

test("account storage refuses concurrent owners and aliased session files", async (t) => {
  const s = await setup(t);
  await s.login();
  await assert.rejects(OwnerAccount.open(s.options));
  await s.service.close();
  if (process.platform !== "win32") {
    const outside = join(s.root, "outside");
    await writeFile(outside, "preserve");
    await rm(join(s.options.directory, "session.json"));
    await symlink(outside, join(s.options.directory, "session.json"));
    await assert.rejects(OwnerAccount.open(s.options));
    assert.equal(await readFile(outside, "utf8"), "preserve");
  }
});

test("cleaning a stopped local instance preserves the shared owner session and other instances", async (t) => {
  const s = await setup(t);
  await s.login();
  const instances = await DesktopInstances.open(s.root);
  const first = await instances.create({ name: "First", port: 18981 });
  const second = await instances.create({ name: "Second", port: 18982 });
  await writeFile(join(first.stateDirectory, "work-marker"), "remove");
  await writeFile(join(second.stateDirectory, "work-marker"), "keep");
  const gateway = new DesktopGateway({ ...first, environment: {} });
  t.after(() => gateway.stop());
  await gateway.clean();
  assert.equal(await readFile(join(second.stateDirectory, "work-marker"), "utf8"), "keep");
  await s.restart();
  assert.equal(s.service.snapshot().status, "signed_in");
  assert.equal((await s.request({ type: "owner_requests" })).state, "ready");
});

const permissionId = "00000000-0000-4000-8000-000000000031";
const inputId = "00000000-0000-4000-8000-000000000032";
function ownerRequests() {
  return {
    total: 2,
    permission_requests: [
      {
        id: permissionId,
        decision_options: "once_always",
        scope: { calendar_id: "primary" },
        created_at: "2026-09-08T10:00:00Z",
        expires_at: null,
        action_type: "get_phone_number",
        action_description: null,
        requester_email: "peer@fixture.test",
        requester_name: null,
      },
    ],
    input_requests: [
      {
        id: inputId,
        prompt: "Which option?",
        input_type: "buttons",
        options: [{ label: "Only this invocation", value: "provider:allow-once" }],
        created_at: "2026-09-08T10:00:00Z",
        action_type: "get_phone_number",
      },
    ],
  };
}
function reviewId(reply: Awaited<ReturnType<OwnerAccount["command"]>>) {
  assert.equal(reply.data?.kind, "review");
  return (reply.data as unknown as { review_id: string }).review_id;
}

test("owner mutations review exact options, confirm once and persist receipt across restart", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.override((path, init) => {
    if (path === "/api/owner/inbox?limit=200") return Response.json(ownerRequests());
    if (path.endsWith("/decide")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        kind: "permission",
        request_id: permissionId,
        expected_revision: 1,
        decision: "allow_once",
      });
      return Response.json({
        status: "ok",
        permission_id: permissionId,
        decision: "allow_once",
        action_type: "get_phone_number",
      });
    }
    return undefined;
  });
  const review = reviewId(
    await s.request({ type: "owner_review", kind: "permission", id: permissionId }),
  );
  const result = await s.request({
    type: "owner_submit",
    review_id: review,
    decision: "allow_once",
  });
  assert.equal((result.data as unknown as { status: string }).status, "confirmed");
  await s.request({ type: "owner_submit", review_id: review, decision: "allow_once" });
  assert.equal(
    (await s.request({ type: "owner_submit", review_id: review, decision: "deny" })).issue,
    "request_unavailable",
  );
  await s.restart();
  const repeat = await s.request({ type: "owner_review", kind: "permission", id: permissionId });
  assert.equal((repeat.data as unknown as { status: string }).status, "confirmed");
  assert.equal(s.f.calls.filter((c) => c.path.endsWith("/decide")).length, 1);
});

test("owner unknown menus, malformed options, stale and expired reviews never submit", async (t) => {
  const s = await setup(t);
  await s.login();
  let current = ownerRequests();
  s.f.override((path) =>
    path === "/api/owner/inbox?limit=200" ? Response.json(current) : undefined,
  );
  assert.ok(current.permission_requests[0]);
  current.permission_requests[0].decision_options = "future_menu";
  assert.equal(
    (await s.request({ type: "owner_review", kind: "permission", id: permissionId })).issue,
    "invalid_response",
  );
  current = ownerRequests();
  current.input_requests[0]?.options.push({
    label: "Different label",
    value: "provider:allow-once",
  });
  assert.equal(
    (await s.request({ type: "owner_review", kind: "input", id: inputId })).issue,
    "request_unavailable",
  );
  current = ownerRequests();
  let review = reviewId(
    await s.request({ type: "owner_review", kind: "permission", id: permissionId }),
  );
  assert.ok(current.permission_requests[0]);
  current.permission_requests[0].scope.calendar_id = "other";
  assert.equal(
    (await s.request({ type: "owner_submit", review_id: review, decision: "allow_once" })).issue,
    "review_expired",
  );
  review = reviewId(await s.request({ type: "owner_review", kind: "input", id: inputId }));
  assert.equal(
    (await s.request({ type: "owner_submit", review_id: review, value: "allow_once" })).issue,
    "request_unavailable",
  );
  review = reviewId(
    await s.request({ type: "owner_review", kind: "permission", id: permissionId }),
  );
  s.f.advance(300001);
  assert.equal(
    (await s.request({ type: "owner_submit", review_id: review, decision: "allow_once" })).issue,
    "review_expired",
  );
  assert.equal(
    s.f.calls.filter((c) => c.path.endsWith("/decide") || c.path.endsWith("/decide")).length,
    0,
  );
});

test("lost owner answers recover the exact idempotent receipt after sign-out and restart", async (t) => {
  const s = await setup(t);
  await s.login();
  let answered = false;
  let key: string | null = null;
  s.f.override((path, init) => {
    if (path === "/api/owner/inbox?limit=200")
      return Response.json(
        answered ? { total: 0, permission_requests: [], input_requests: [] } : ownerRequests(),
      );
    if (path.endsWith("/decide")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        kind: "human_input",
        request_id: inputId,
        expected_revision: 1,
        value: "provider:allow-once",
      });
      const currentKey = new Headers(init?.headers).get("Idempotency-Key");
      assert.ok(currentKey);
      if (answered) {
        assert.equal(currentKey, key);
        return Response.json({ status: "ok", request_id: inputId, answer: "Only this invocation" });
      }
      key = currentKey;
      answered = true;
      throw new Error("Response lost after commit");
    }
    return undefined;
  });
  const review = reviewId(await s.request({ type: "owner_review", kind: "input", id: inputId }));
  const result = await s.request({
    type: "owner_submit",
    review_id: review,
    value: "provider:allow-once",
  });
  assert.equal((result.data as unknown as { status: string }).status, "unconfirmed");
  await s.request({ type: "owner_signout" });
  await s.restart();
  await s.login();
  const feed = await s.request({ type: "owner_requests" });
  assert.match(JSON.stringify(feed.data), /unconfirmed/);
  const repeat = await s.request({ type: "owner_review", kind: "input", id: inputId });
  assert.equal((repeat.data as unknown as { status: string }).status, "confirmed");
  assert.equal(s.f.calls.filter((c) => c.path.endsWith("/decide")).length, 2);
  const files = await readdir(join(s.root, "account"));
  for (const name of files.filter((n) => n.startsWith("mutations.sqlite")))
    assert.doesNotMatch(
      (await readFile(join(s.root, "account", name))).toString(),
      /provider:allow-once|Which option|owner@fixture.test|00000000-0000-4000-8000-000000000032/,
    );
});

test("email/app conflict is settled, mismatched success is unconfirmed, and rejection permits fresh review", async (t) => {
  for (const status of [409, 400, 503, 200]) {
    const s = await setup(t);
    await s.login();
    s.f.override((path) => {
      if (path === "/api/owner/inbox?limit=200") return Response.json(ownerRequests());
      if (path.endsWith("/decide"))
        return Response.json(
          {
            status: "ok",
            permission_id: randomUUID(),
            decision: "deny",
            action_type: "get_phone_number",
          },
          { status },
        );
      return undefined;
    });
    const review = reviewId(
      await s.request({ type: "owner_review", kind: "permission", id: permissionId }),
    );
    const result = await s.request({
      type: "owner_submit",
      review_id: review,
      decision: "allow_once",
    });
    if (status === 400) {
      assert.equal(result.issue, "request_unavailable");
      reviewId(await s.request({ type: "owner_review", kind: "permission", id: permissionId }));
    } else assert.equal((result.data as unknown as { status: string }).status, "unconfirmed");
  }
});

test("owner text answers and active grant revocation use the exact owner routes", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.override((path, init) => {
    if (path === "/api/owner/inbox?limit=200") {
      const current = ownerRequests();
      const item = current.input_requests[0];
      assert.ok(item);
      item.input_type = "text";
      item.options = [];
      return Response.json(current);
    }
    if (path.endsWith("/decide")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        kind: "human_input",
        request_id: inputId,
        expected_revision: 1,
        text: "My exact answer",
      });
      return Response.json({
        status: "ok",
        request_id: inputId,
        answer: "My exact answer",
        action_type: "get_phone_number",
      });
    }
    if (path.startsWith("/api/owner/permissions?"))
      return Response.json({
        direction: "granted",
        permissions: [
          {
            id: permissionId,
            status: "granted",
            decision: "allow_always",
            decision_options: "once_always",
            uses_remaining: null,
            scope: null,
            created_at: "2026-09-08T10:00:00Z",
            decided_at: null,
            expires_at: null,
            action_type: "get_phone_number",
            action_description: null,
            grantor_email: email,
            grantor_name: null,
            grantee_email: "peer@fixture.test",
            grantee_name: null,
            direction: "granted_by_me",
          },
        ],
      });
    if (path.endsWith("/revoke")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        permission_id: permissionId,
        expected_revision: 1,
      });
      assert.equal(init?.method, "POST");
      return Response.json({
        status: "ok",
        permission_id: permissionId,
        action_type: "get_phone_number",
      });
    }
    return undefined;
  });
  for (const [kind, id, answer] of [
    ["input", inputId, { text: "My exact answer" }],
    ["revoke", permissionId, {}],
  ] as const) {
    if (kind === "revoke") await s.request({ type: "owner_permissions", direction: "granted" });
    const review = reviewId(await s.request({ type: "owner_review", kind, id }));
    const result = await s.request({ type: "owner_submit", review_id: review, ...answer });
    assert.equal((result.data as unknown as { status: string }).status, "confirmed");
  }
});

test("owner mutation must save before sending, and a failed confirmation save remains uncertain", async (t) => {
  for (const failConfirmed of [false, true]) {
    const s = await setup(t);
    await s.login();
    s.f.override((path) =>
      path === "/api/owner/inbox?limit=200"
        ? Response.json(ownerRequests())
        : path.endsWith("/decide")
          ? Response.json({
              status: "ok",
              permission_id: permissionId,
              decision: "deny",
              action_type: "get_phone_number",
            })
          : undefined,
    );
    const review = reviewId(
      await s.request({ type: "owner_review", kind: "permission", id: permissionId }),
    );
    const save = s.service.decisions.save.bind(s.service.decisions);
    s.service.decisions.save = (agent, mutation, submissionHash) => {
      if (!failConfirmed || mutation.status === "confirmed") throw new Error("disk full");
      save(agent, mutation, submissionHash);
    };
    await assert.rejects(s.request({ type: "owner_submit", review_id: review, decision: "deny" }));
    assert.equal(s.f.calls.filter((c) => c.path.endsWith("/decide")).length, failConfirmed ? 1 : 0);
    await s.restart();
    const result = await s.request({ type: "owner_review", kind: "permission", id: permissionId });
    if (failConfirmed)
      assert.equal((result.data as unknown as { status: string }).status, "unconfirmed");
    else reviewId(result);
  }
});

test("owner context changes invalidate a reviewed decision", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.override((path) =>
    path === "/api/owner/inbox?limit=200" ? Response.json(ownerRequests()) : undefined,
  );
  const context = s.service.snapshot().context;
  const review = reviewId(
    await s.request({ type: "owner_review", kind: "permission", id: permissionId }),
  );
  await s.request({ type: "owner_signout" });
  await s.login();
  await assert.rejects(
    s.service.command({ type: "owner_submit", context, review_id: review, decision: "deny" }),
  );
  assert.equal(
    (await s.request({ type: "owner_submit", review_id: review, decision: "deny" })).issue,
    "review_expired",
  );
  assert.equal(s.f.calls.filter((c) => c.path.endsWith("/decide")).length, 0);
});

test("owner verification follows the expiry returned by the server", async (t) => {
  const s = await setup(t);
  s.f.override((path) =>
    path === "/api/owner/start_sign_in"
      ? Response.json({ message: "Code sent", expires_in_minutes: 1 })
      : undefined,
  );
  await s.request({ type: "owner_request_code", email });
  s.f.advance(61000);
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().issue, "code_expired");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/owner/verify_sign_in").length, 0);
});

test("device mutation requires a current review and never repeats a lost transfer", async (t) => {
  const s = await setup(t);
  await s.login();
  let name = "Fixture device",
    mutations = 0;
  s.f.override((path) => {
    if (path === "/api/owner/devices")
      return Response.json({
        devices: [
          {
            id: DEVICE_ID,
            device_name: name,
            platform: "darwin",
            jkt: s.service.device.thumbprint,
            created_at: new Date(s.f.now()).toISOString(),
            last_seen_at: null,
            revoked_at: null,
            executes_agent_ids: [],
            is_current: true,
          },
        ],
      });
    if (path === "/api/owner/select_executor") {
      mutations++;
      throw new Error("response lost");
    }
    return undefined;
  });
  const review = async () => {
    const reply = await s.request({
      type: "owner_device_review",
      operation: "execute",
      device_id: DEVICE_ID,
      agent_id: agentId,
    });
    assert.equal(reply.data?.kind, "device_review");
    if (reply.data?.kind !== "device_review") throw new Error();
    return reply.data.review_id;
  };
  const old = await review();
  name = "Renamed device";
  assert.equal(
    (await s.request({ type: "owner_device_submit", review_id: old })).issue,
    "review_expired",
  );
  assert.equal(mutations, 0);
  const current = await review();
  const submitted = await s.request({ type: "owner_device_submit", review_id: current });
  assert.equal(submitted.data?.kind, "device_result");
  if (submitted.data?.kind === "device_result") assert.equal(submitted.data.confirmed, false);
  assert.equal(
    (await s.request({ type: "owner_device_submit", review_id: current })).issue,
    "review_expired",
  );
  assert.equal(mutations, 1);
});

test("owner profile refreshes and persists the current roster without another email code", async (t) => {
  const s = await setup(t);
  await s.login();
  const roster = ownerSession(s.f.now(), s.service.device.thumbprint).agents;
  const context = s.service.snapshot().context;
  const changed = { ...roster[0], display_name: "Registered after sign-in", executor_epoch: 4 };
  s.f.override((path) =>
    path === "/api/owner/agents"
      ? Response.json({ agents: [changed], newly_attached_agent_ids: [agentId] })
      : undefined,
  );
  const reply = await s.request({ type: "owner_profile" });
  assert.equal(reply.data?.kind, "profile");
  assert.equal(reply.snapshot.context, context);
  assert.equal(reply.snapshot.account?.agents[0]?.display_name, changed.display_name);
  await s.restart();
  assert.equal(s.service.snapshot().account?.agents[0]?.display_name, changed.display_name);
  assert.equal(s.f.calls.filter((call) => call.path === "/api/owner/start_sign_in").length, 1);
  assert.equal(s.f.calls.filter((call) => call.path === "/api/owner/verify_sign_in").length, 1);

  s.f.override((path) =>
    path === "/api/owner/agents"
      ? Response.json({ agents: [], newly_attached_agent_ids: [] })
      : undefined,
  );
  const empty = await s.request({ type: "owner_devices" });
  assert.equal(empty.data?.kind, "devices");
  assert.deepEqual(empty.snapshot.account?.agents, []);
});

test("invalid or unavailable owner rosters preserve the last confirmed profile", async (t) => {
  const s = await setup(t);
  await s.login();
  const previous = s.service.snapshot().account;
  const agent = ownerSession(s.f.now(), s.service.device.thumbprint).agents[0];
  for (const body of [
    { agents: [agent, agent], newly_attached_agent_ids: [] },
    { agents: [], newly_attached_agent_ids: [agentId] },
    { agents: [{ ...agent, is_executed_here: true }], newly_attached_agent_ids: [] },
    { agents: [{ ...agent, executor_epoch: -1 }], newly_attached_agent_ids: [] },
  ]) {
    s.f.override((path) => (path === "/api/owner/agents" ? Response.json(body) : undefined));
    assert.equal((await s.request({ type: "owner_profile" })).issue, "invalid_response");
    assert.deepEqual(s.service.snapshot().account, previous);
  }
  s.f.override((path) =>
    path === "/api/owner/agents" ? Response.json({}, { status: 503 }) : undefined,
  );
  assert.equal((await s.request({ type: "owner_profile" })).issue, "offline");
  assert.deepEqual(s.service.snapshot().account, previous);
});

test("an executor epoch change invalidates a device review even if the device is unchanged", async (t) => {
  const s = await setup(t);
  await s.login();
  let epoch = 1;
  let mutations = 0;
  const agent = ownerSession(s.f.now(), s.service.device.thumbprint).agents[0];
  s.f.override((path) => {
    if (path === "/api/owner/agents")
      return Response.json({
        agents: [{ ...agent, executor_epoch: epoch }],
        newly_attached_agent_ids: [],
      });
    if (path === "/api/owner/select_executor") {
      mutations++;
      return Response.json({});
    }
    return undefined;
  });
  const review = await s.request({
    type: "owner_device_review",
    operation: "execute",
    device_id: DEVICE_ID,
    agent_id: agentId,
  });
  assert.equal(review.data?.kind, "device_review");
  if (review.data?.kind !== "device_review") throw new Error();
  epoch++;
  assert.equal(
    (await s.request({ type: "owner_device_submit", review_id: review.data.review_id })).issue,
    "review_expired",
  );
  assert.equal(mutations, 0);
});

test("one-code setup creates the verified owner agent and survives a lost response and restart", async (t) => {
  const s = await setup(t);
  assert.equal((await s.request({ type: "owner_create_agent" })).issue, "session_expired");
  await s.login();
  const context = s.service.snapshot().context;
  const initialAgent = ownerSession(s.f.now(), "unused").agents[0];
  assert.ok(initialAgent);
  const agent = { ...initialAgent, email_verified: true };
  let created = false;
  let loseResponse = true;
  s.f.override((path, init) => {
    if (path !== "/api/owner/agents") return;
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), {});
      const wasCreated = !created;
      created = true;
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Response lost");
      }
      return Response.json({ agent, created: wasCreated });
    }
    return Response.json({ agents: created ? [agent] : [], newly_attached_agent_ids: [] });
  });
  assert.equal((await s.request({ type: "owner_create_agent" })).issue, "offline");
  await s.restart();
  const recovered = await s.request({ type: "owner_create_agent" });
  assert.equal(recovered.data?.kind, "agent_setup");
  if (recovered.data?.kind !== "agent_setup") throw new Error("Missing setup result");
  assert.equal(recovered.data.created, false);
  assert.equal(recovered.data.agent.id, agent.id);
  assert.equal(recovered.snapshot.account?.agents[0]?.id, agent.id);
  assert.equal((await s.request({ type: "owner_create_agent" })).data?.kind, "agent_setup");
  assert.equal(s.f.calls.filter((c) => c.path.endsWith("start_sign_in")).length, 1);
  assert.equal(s.f.calls.filter((c) => c.path.endsWith("verify_sign_in")).length, 1);
  assert.equal(
    s.f.calls.some((c) =>
      /register_agent|verify_email|select_executor|execution_token/.test(c.path),
    ),
    false,
  );
  await assert.rejects(s.service.command({ type: "owner_create_agent", context }));
});

test("one-code setup rejects mismatched or unverified agents and preserves the signed-in account", async (t) => {
  const s = await setup(t);
  await s.login();
  const original = s.service.snapshot();
  const agent = ownerSession(s.f.now(), "unused").agents[0];
  assert.ok(agent);
  for (const bad of [
    { ...agent, email: "other@fixture.test" },
    { ...agent, email_verified: false },
    { ...agent, id: randomUUID() },
    { ...agent, is_executed_here: true },
  ]) {
    s.f.override((path, init) =>
      path === "/api/owner/agents" && init?.method === "POST"
        ? Response.json({ agent: bad, created: false })
        : undefined,
    );
    assert.equal((await s.request({ type: "owner_create_agent" })).issue, "invalid_response");
    assert.deepEqual(s.service.snapshot().account, original.account);
  }
  assert.throws(() => s.request({ type: "owner_create_agent", email: "other@fixture.test" }));
  s.f.override((path) =>
    path === "/api/owner/agents" ? Response.json({}, { status: 409 }) : undefined,
  );
  assert.equal((await s.request({ type: "owner_create_agent" })).issue, "request_unavailable");
});

test("owner communications use only bounded read-only history and reject stale contexts", async (t) => {
  const s = await setup(t);
  await s.login();
  const payload = {
    items: [],
    has_more: false,
    next_cursor: null,
    retention: {
      complete_since: "2026-09-01T00:00:00Z",
      acked_messages_removed_after_days: 14,
      dead_messages_removed_after_days: 90,
      may_be_incomplete: true,
    },
  };
  s.f.override((path) =>
    path.startsWith("/api/owner/communications?") ? Response.json(payload) : undefined,
  );
  const start = s.f.calls.length;
  const context = s.service.snapshot().context;
  const result = await s.request({ type: "owner_communications", cursor: "a+b/c=" });
  assert.equal(result.data?.kind, "communications");
  assert.equal(s.f.calls.length, start + 1);
  assert.equal(s.f.calls.at(-1)?.path, "/api/owner/communications?limit=50&cursor=a%2Bb%2Fc%3D");
  assert.equal(s.f.calls.at(-1)?.init?.body, undefined);
  assert.equal(
    s.f.calls.some((c) => /poll_messages|ack_message/.test(c.path)),
    false,
  );
  await s.request({ type: "owner_signout" });
  await assert.rejects(s.service.command({ type: "owner_communications", context }));
});
