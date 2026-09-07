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
