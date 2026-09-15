import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient } from "../src/central-enrollment.js";
import { CentralProtectedTransport } from "../src/central-protected-transport.js";
import { CentralRestClient } from "../src/central-rest.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

function client(reply: (url: URL, init: RequestInit) => Response) {
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  return new CentralRestClient({
    centralOrigin: "https://central.fixture.test",
    transport: new CentralProtectedTransport({
      credential: () => credential,
      now: () => FIXTURE_NOW_SECONDS,
      fetch: async (url, init) => reply(new URL(String(url)), init ?? {}),
    }),
  });
}

test("current registration requires a username and retains its canonical server value", async () => {
  let calls = 0;
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: "https://central.fixture.test",
    fetch: async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: "owner@fixture.test",
        username: "alice7",
      });
      return Response.json({
        agent_id: "agent.1",
        email: "owner@fixture.test",
        username: "alice7",
        message: "Code sent",
      });
    },
  });
  for (const username of [undefined, "amin", "has-dash", "a.bcd", "a".repeat(33), "аlice"])
    await assert.rejects(enrollment.register({ email: "owner@fixture.test", username }));
  assert.equal(calls, 0);
  assert.equal(
    (await enrollment.register({ email: "owner@fixture.test", username: " Alice7 " })).username,
    "alice7",
  );
});

test("catalog accepts reviewed metadata and empty schemas without erasing review status", async () => {
  const rows = [
    {
      id: "action.1",
      name: "get_phone_number",
      description: "Phone",
      input_schema: { type: "object" },
      result_schema: null,
      verified: true,
    },
    {
      id: "action.2",
      name: "custom lookup",
      description: "Custom",
      input_schema: {},
      result_schema: null,
      verified: false,
    },
  ];
  const central = client(() => Response.json(rows));
  assert.deepEqual(await central.listActionTypes(), rows);
});

test("reviewed catalog filtering signs the query and leaves normal catalog reads complete", async () => {
  const reviewed = {
    id: "action.1",
    name: "get_email",
    description: "Email",
    input_schema: {},
    verified: true,
  };
  const custom = { ...reviewed, id: "action.2", name: "custom", verified: false };
  const seen: string[] = [];
  const central = client((url, init) => {
    seen.push(url.search);
    const proof = new Headers(init.headers).get("DPoP");
    assert.ok(proof);
    const claims = proof.split(".")[1];
    assert.ok(claims);
    assert.equal(JSON.parse(Buffer.from(claims, "base64url").toString()).htu, url.href);
    return Response.json(
      url.searchParams.get("verified_only") === "true" ? [reviewed] : [reviewed, custom],
    );
  });
  assert.deepEqual(await central.listActionTypes(undefined, { verified_only: true }), [reviewed]);
  assert.deepEqual(await central.listActionTypes(), [reviewed, custom]);
  assert.deepEqual(seen, ["?verified_only=true", ""]);
  await assert.rejects(central.listActionTypes(undefined, { verified_only: "true" } as never));
  assert.equal(seen.length, 2);
  await assert.rejects(
    client(() => Response.json([custom])).listActionTypes(undefined, { verified_only: true }),
  );
});

const progressCall = "10000000-0000-4000-8000-000000000001";
const progressEvent = {
  event_id: "10000000-0000-4000-8000-000000000002",
  sequence: 1,
  state: "working",
  note: null,
  reported_at: "2026-09-15T12:00:00Z",
};

test("progress snapshots keep call status separate from events and never acknowledge the queue", async () => {
  const snapshot = { call_id: progressCall, call_status: "completed", events: [progressEvent] };
  let calls = 0;
  const central = client((url, init) => {
    calls++;
    assert.equal(init.method, "GET");
    assert.equal(url.pathname, "/api/action_progress");
    assert.equal(url.searchParams.get("call_id"), progressCall);
    return Response.json(snapshot);
  });
  assert.deepEqual(await central.getActionProgress(progressCall), snapshot);
  await assert.rejects(central.getActionProgress("bad-id"));
  assert.equal(calls, 1);
});

test("progress snapshots reject miscorrelation, unordered or duplicate events and unsafe output", async () => {
  const valid = { call_id: progressCall, call_status: "pending", events: [progressEvent] };
  for (const response of [
    { ...valid, call_id: progressEvent.event_id },
    { ...valid, call_status: "invented" },
    { ...valid, events: [progressEvent, progressEvent] },
    { ...valid, events: [{ ...progressEvent, sequence: 0 }] },
    { ...valid, events: [{ ...progressEvent, state: "approved" }] },
    { ...valid, events: [{ ...progressEvent, reported_at: "yesterday" }] },
    { ...valid, events: [{ ...progressEvent, note: "x".repeat(201) }] },
    { ...valid, events: [{ ...progressEvent, token: "not-allowed" }] },
    { ...valid, events: Array(1001).fill(progressEvent) },
  ])
    await assert.rejects(client(() => Response.json(response)).getActionProgress(progressCall));
});

test("result requests reject the response-only completed status before sending", async () => {
  let calls = 0;
  const central = client(() => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    central.submitActionResult({ call_id: progressCall, status: "completed", result: {} }),
  );
  assert.equal(calls, 0);
});

test("provider questions preserve invocation identity, expiry and opaque options on the wire", async () => {
  const args = {
    permission_type: "ambassador_acp_tool_execution",
    message_id: progressCall,
    request: "May I run this tool?",
    input_type: "buttons" as const,
    options: [{ label: "Run once", value: "opaque:7" }],
    request_kind: "provider_option" as const,
    provider: { provider_key: "embassys-acp:test:codex", generation: 4, expires_in_seconds: 3600 },
    expires_in_seconds: 3600,
  };
  let calls = 0;
  const central = client((_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init.body)), args);
    return Response.json({
      request_id: progressCall,
      status: "pending",
      input_type: "buttons",
      message: "Asked",
      options: args.options,
    });
  });
  await central.requestHumanInput(args);
  for (const bad of [
    { ...args, provider: undefined },
    { ...args, request_kind: "text_answer" },
    { ...args, provider: { ...args.provider, generation: 0 } },
    { ...args, expires_in_seconds: 604801 },
  ])
    await assert.rejects(central.requestHumanInput(bad as never));
  assert.equal(calls, 1);
});

test("availability resolves legacy short usernames and preserves null versus empty", async () => {
  let list: string[] | null = null;
  const central = client((url, init) => {
    assert.equal(url.pathname, "/api/available_actions");
    if (init.method === "GET") assert.equal(url.searchParams.get("agent_email"), "amin");
    else {
      assert.equal(init.method, "PUT");
      assert.equal(url.search, "");
      list = JSON.parse(String(init.body)).available_actions;
    }
    return Response.json({
      agent_email: "peer@fixture.test",
      available_actions: list,
      restricted: list !== null,
    });
  });
  assert.deepEqual(await central.getAvailableActions(" Amin "), {
    agent_email: "peer@fixture.test",
    available_actions: null,
    restricted: false,
  });
  assert.deepEqual(
    (await central.setAvailableActions([" Get_Email ", "get_email", "custom lookup"]))
      .available_actions,
    ["get_email", "custom lookup"],
  );
  assert.deepEqual(await central.setAvailableActions([]), {
    agent_email: "peer@fixture.test",
    available_actions: [],
    restricted: true,
  });
});

test("availability rejects inconsistent responses and unsafe or oversized inputs", async () => {
  let calls = 0;
  const central = client(() => {
    calls++;
    return Response.json({
      agent_email: "peer@fixture.test",
      available_actions: [],
      restricted: false,
    });
  });
  await assert.rejects(central.getAvailableActions("../someone"));
  await assert.rejects(central.setAvailableActions(Array(501).fill("get_email")));
  await assert.rejects(central.setAvailableActions([" "]));
  assert.equal(calls, 0);
  await assert.rejects(central.getAvailableActions());
});

test("a lost availability write is sent once and remains unconfirmed", async () => {
  let calls = 0;
  const central = client(() => {
    calls++;
    throw new TypeError("lost response");
  });
  await assert.rejects(central.setAvailableActions(["get_email"]));
  assert.equal(calls, 1);
});
