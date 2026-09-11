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
    const changed = await override?.(path, init);
    if (changed) return changed;
    if (path === "/api/app/login/request")
      return Response.json({ status: "ok", expires_in_minutes: 10 });
    if (path === "/api/app/login/verify") {
      if (JSON.parse(String(init?.body)).code !== "314159")
        return Response.json({}, { status: 401 });
      return Response.json({
        access_token: token(now),
        refresh_token: "fixture-refresh-original",
        token_type: "bearer",
        expires_in: 900,
        agent_id: agentId,
        email,
      });
    }
    assert.equal(new Headers(init?.headers).has("DPoP"), false);
    if (path === "/api/app/session/refresh") {
      rotated++;
      return Response.json({
        access_token: token(now),
        refresh_token: `fixture-refresh-rotated-${rotated}`,
        token_type: "bearer",
        expires_in: 900,
      });
    }
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Bearer /u);
    if (path === "/api/app/me")
      return Response.json({
        agent_id: agentId,
        email,
        display_name: "Fixture owner",
        username: null,
        session_id: sessionId,
      });
    if (path === "/api/app/requests")
      return Response.json({ permission_requests: [], input_requests: [], total: 0 });
    if (path.startsWith("/api/app/permissions?"))
      return Response.json({ direction: url.searchParams.get("direction"), permissions: [] });
    if (path === "/api/app/communications?limit=200") return Response.json({ communications: [] });
    if (path === "/api/app/session/signout") return Response.json({ status: "ok" });
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
    path === "/api/app/requests"
      ? Response.json({
          total: 2,
          permission_requests: [
            {
              id: randomUUID(),
              decision_options: "unknown_future_menu",
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
    Response.json({ direction: "received", permissions: [] }),
    Response.json({ direction: "granted", permissions: Array(201).fill({}) }),
    Response.json({ direction: "granted", permissions: [{ id: "not-a-uuid" }] }),
    new Response("<h1>proxy error, secret=private</h1>", {
      headers: { "content-type": "text/html" },
    }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "5000000" },
    }),
  ]) {
    s.f.override((path) => (path.startsWith("/api/app/permissions") ? reply : undefined));
    const result = await s.request({ type: "owner_permissions", direction: "granted" });
    assert.equal(result.state, "unavailable");
    assert.equal(result.issue, "invalid_response");
    assert.equal(result.data, undefined);
  }
});

test("expired challenges and authentication throttles are not reported as successful sign-in", async (t) => {
  const s = await setup(t);
  s.f.override((path) =>
    path === "/api/app/login/request" ? Response.json({}, { status: 429 }) : undefined,
  );
  await s.request({ type: "owner_request_code", email });
  assert.equal(s.service.snapshot().issue, "rate_limited");
  s.f.advance(601000);
  await s.request({ type: "owner_verify", code: "314159" });
  assert.equal(s.service.snapshot().issue, "code_expired");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/login/verify").length, 0);
});

test("a failed credential save after successful login keeps the no-replay marker", async (t) => {
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
  assert.equal(s.service.snapshot().status, "reauth_required");
  await assert.rejects(s.request({ type: "owner_verify", code: "314159" }));
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/login/verify").length, 1);
});

test("saving uncertainty must finish before any one-use refresh is sent", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.advance(901000);
  s.service.store.save = async () => {
    throw new Error("read only");
  };
  await assert.rejects(s.request({ type: "owner_requests" }));
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/session/refresh").length, 0);
});

test("a body that stalls after HTTP headers is cancelled within the account deadline", async (t) => {
  const s = await setup(t);
  await s.login();
  s.service.options.timeoutMs = 30;
  let cancelled = false;
  s.f.override((path) =>
    path === "/api/app/requests"
      ? new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
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
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/requests").length, 0);
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
    path === "/api/app/login/request"
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
  assert.doesNotMatch(JSON.stringify(reply), /access_token|refresh_token|314159|fixture-refresh/u);
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/login/request").length, 1);
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
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/session/refresh").length, 1);
  assert.doesNotMatch(JSON.stringify(replies), /Bearer|fixture-refresh/u);
  for (const name of await readdir(s.options.directory)) {
    const bytes = await readFile(join(s.options.directory, name));
    assert.ok(!bytes.includes(Buffer.from("fixture-refresh")), name);
    assert.ok(!bytes.includes(Buffer.from(email)), name);
    assert.ok(!bytes.includes(Buffer.from("314159")), name);
  }
});

test("lost refresh response requires a new login and is never replayed after restart", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.advance(901_000);
  s.f.override((path) => {
    if (path === "/api/app/session/refresh") throw new Error("lost fixture-refresh-secret");
  });
  const result = await s.request({ type: "owner_requests" });
  assert.doesNotMatch(JSON.stringify(result), /fixture-refresh-secret/u);
  assert.equal(s.service.snapshot().status, "reauth_required");
  await s.restart();
  await s.request({ type: "owner_requests" });
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/session/refresh").length, 1);
});

test("lost verification response cannot silently spend the same code again", async (t) => {
  const s = await setup(t);
  await s.request({ type: "owner_request_code", email });
  s.f.override((path) => {
    if (path === "/api/app/login/verify") throw new Error("unknown");
  });
  await s.request({ type: "owner_verify", code: "314159" });
  await s.restart();
  await assert.rejects(s.request({ type: "owner_verify", code: "314159" }));
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/login/verify").length, 1);
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
      path === "/api/app/login/verify"
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
    assert.equal(s.service.snapshot().status, "reauth_required");
  }
  const s = await setup(t);
  await s.login();
  s.f.advance(901_000);
  s.f.override((path) =>
    path === "/api/app/session/refresh"
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
    if (path === "/api/app/requests") throw new Error("offline");
  });
  assert.equal((await s.request({ type: "owner_requests" })).state, "unavailable");
  assert.equal(s.service.snapshot().status, "signed_in");
  s.f.override((path) =>
    path === "/api/app/requests" ? Response.json({}, { status: 401 }) : undefined,
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
    if (path === "/api/app/session/signout") throw new Error("lost");
  });
  await s.request({ type: "owner_signout" });
  assert.equal(s.service.snapshot().status, "signed_out");
  assert.equal(s.service.snapshot().issue, "signout_unconfirmed");
  assert.equal(await readFile(marker, "utf8"), "keep gateway");
  await assert.rejects(s.service.command({ type: "owner_requests", context }));
  await s.restart();
  assert.equal(s.service.snapshot().status, "signed_out");
  assert.equal(s.f.calls.filter((c) => c.path === "/api/app/session/signout").length, 1);
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
    if (path !== "/api/app/session/signout") return;
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
    if (path === "/api/app/requests") return Response.json(ownerRequests());
    if (path.endsWith("/decide")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { decision: "allow_once" });
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
  s.f.override((path) => (path === "/api/app/requests" ? Response.json(current) : undefined));
  assert.ok(current.permission_requests[0]);
  current.permission_requests[0].decision_options = "future_menu";
  assert.equal(
    (await s.request({ type: "owner_review", kind: "permission", id: permissionId })).issue,
    "request_unavailable",
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
    s.f.calls.filter((c) => c.path.endsWith("/decide") || c.path.endsWith("/answer")).length,
    0,
  );
});

test("lost owner answers survive sign-out and restart without replay or inferred success", async (t) => {
  const s = await setup(t);
  await s.login();
  let answered = false;
  s.f.override((path, init) => {
    if (path === "/api/app/requests")
      return Response.json(
        answered ? { total: 0, permission_requests: [], input_requests: [] } : ownerRequests(),
      );
    if (path.endsWith("/answer")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { value: "provider:allow-once" });
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
  assert.equal((repeat.data as unknown as { status: string }).status, "unconfirmed");
  assert.equal(s.f.calls.filter((c) => c.path.endsWith("/answer")).length, 1);
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
      if (path === "/api/app/requests") return Response.json(ownerRequests());
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
    } else
      assert.equal(
        (result.data as unknown as { status: string }).status,
        status === 409 ? "settled" : "unconfirmed",
      );
  }
});

test("owner text answers and active grant revocation use the exact owner routes", async (t) => {
  const s = await setup(t);
  await s.login();
  s.f.override((path, init) => {
    if (path === "/api/app/requests") {
      const current = ownerRequests();
      const item = current.input_requests[0];
      assert.ok(item);
      item.input_type = "text";
      item.options = [];
      return Response.json(current);
    }
    if (path.endsWith("/answer")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { text: "My exact answer" });
      return Response.json({
        status: "ok",
        request_id: inputId,
        answer: "My exact answer",
        action_type: "get_phone_number",
      });
    }
    if (path.startsWith("/api/app/permissions?"))
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
      assert.equal(init?.body, undefined);
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
      path === "/api/app/requests"
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
    path === "/api/app/requests" ? Response.json(ownerRequests()) : undefined,
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
