import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CentralMutations } from "../src/central-mutations.js";

const key = "8719e7bb-a799-4410-bb26-bbc80921d6cc";
const body = { target_email: "peer@fixture.test", payload: { private: "saved intent" } };
const receipt = { status: 200, body: { call_id: "call-1" } };

test("lost responses recover after restart without executing the mutation twice", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "embassys-mutations-"));
  const credential = { storageSecret: Buffer.alloc(32, 6), salt: "test" };
  let journal = new CentralMutations(join(root, "state.sqlite"), credential);
  t.after(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  let sends = 0;
  const send = async () => {
    sends++;
    throw new Error("lost response");
  };
  const missing = async () => undefined;
  await assert.rejects(journal.execute("call_action", key, body, send, missing));
  journal.close();
  journal = new CentralMutations(join(root, "state.sqlite"), credential);
  assert.deepEqual(journal.body("call_action", key), body);
  assert.deepEqual(
    await journal.execute("call_action", key, body, send, async () => receipt),
    receipt,
  );
  assert.equal(sends, 1);
  assert.deepEqual(await journal.execute("call_action", key, body, send, missing), receipt);
  assert.equal(sends, 1);
  await assert.rejects(journal.execute("call_action", key, { changed: true }, send, missing));
});

test("missing outcomes reuse the exact key only within retention; old and backward-clock attempts never resend", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "embassys-mutations-"));
  let now = 100_000;
  const journal = new CentralMutations(
    join(root, "state.sqlite"),
    { storageSecret: Buffer.alloc(32, 4), salt: "test" },
    () => now,
  );
  t.after(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  let sends = 0;
  const send = async () => {
    sends++;
    throw new Error("lost");
  };
  await assert.rejects(journal.execute("call_action", key, body, send, async () => undefined));
  await assert.rejects(journal.execute("call_action", key, body, send, async () => undefined));
  assert.equal(sends, 2);
  now--;
  await assert.rejects(journal.execute("call_action", key, body, send, async () => undefined));
  now += 24 * 60 * 60 * 1000;
  await assert.rejects(journal.execute("call_action", key, body, send, async () => undefined));
  assert.equal(sends, 2);
  assert.deepEqual(journal.body("call_action", key), body);
});

test("concurrent observers share one submission and operation names scope identical IDs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "embassys-mutations-"));
  const journal = new CentralMutations(join(root, "state.sqlite"), {
    storageSecret: Buffer.alloc(32, 4),
    salt: "test",
  });
  t.after(() => {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  });
  let sends = 0;
  const send = async () => {
    sends++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return receipt;
  };
  const run = () => journal.execute("call_action", key, body, send, async () => undefined);
  assert.deepEqual(await Promise.all([run(), run(), run()]), [receipt, receipt, receipt]);
  assert.equal(sends, 1);
  await journal.execute("request_permission", key, body, send, async () => undefined);
  assert.equal(sends, 2);
});

test("the REST contract resumes saved permission and action submissions with exact keys and payloads", async (t) => {
  const { CentralRestClient } = await import("../src/central-rest.js");
  const { CentralProtectedTransport } = await import("../src/central-protected-transport.js");
  const { parseCentralCredential } = await import("../src/central-credential.js");
  const { currentCredential, FIXTURE_NOW_SECONDS } = await import(
    "./support/current-credential.js"
  );
  const { OutboundActions } = await import("../src/outbound-actions.js");
  const root = mkdtempSync(join(tmpdir(), "embassys-rest-recovery-"));
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let mutations = new CentralMutations(join(root, "mutations.sqlite"), credential);
  const accepted = new Map<string, Record<string, unknown>>();
  const attempts: string[] = [];
  const transport = new CentralProtectedTransport({
    credential: () => credential,
    now: () => FIXTURE_NOW_SECONDS,
    fetch: async (url, init) => {
      const request = new URL(String(url));
      if (request.pathname === "/api/idempotency_status") {
        assert.equal(request.searchParams.get("idempotency_key"), key);
        const operation = request.searchParams.get("operation") ?? "";
        const prior = accepted.get(operation);
        assert.ok(prior);
        return Response.json({
          operation,
          idempotency_key: key,
          found: true,
          state: "accepted",
          status_code: 200,
          response: prior,
          message: "Recovered",
        });
      }
      const operation = request.pathname.slice(5);
      assert.equal(new Headers(init?.headers).get("idempotency-key"), key);
      attempts.push(operation);
      assert.equal(
        attempts.filter((item) => item === operation).length,
        1,
        "must not repeat an accepted write",
      );
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.target_email, "peer@fixture.test");
      if (operation === "request_permission") {
        assert.equal(payload.reason, "Explicit user reason");
        accepted.set(operation, {
          permission_id: "permission-1",
          status: "granted",
          message: "Granted",
        });
      } else {
        assert.deepEqual(payload.payload, { title: "Exact title" });
        accepted.set(operation, {
          call_id: "00000000-0000-4000-8000-000000000001",
          message_id: "message-1",
          status: "queued",
        });
      }
      throw new Error("connection lost after commit");
    },
  });
  const client = () =>
    new CentralRestClient({ centralOrigin: "https://central.fixture.test", transport, mutations });
  let outbound = new OutboundActions(join(root, "outbound.sqlite"), credential, client());
  t.after(() => {
    outbound.close();
    mutations.close();
    rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    outbound.request(
      {
        target_email: "peer@fixture.test",
        action_type: "lookup",
        reason: "Explicit user reason",
        action_payload: { title: "Exact title" },
      },
      undefined,
      key,
    ),
  );
  outbound.close();
  mutations.close();
  mutations = new CentralMutations(join(root, "mutations.sqlite"), credential);
  outbound = new OutboundActions(join(root, "outbound.sqlite"), credential, client());
  await outbound.continuePrepared("peer@fixture.test", "lookup", key, new AbortController().signal);
  assert.equal(outbound.get("peer@fixture.test", "lookup")?.status, "dispatch_uncertain");
  await outbound.continuePrepared("peer@fixture.test", "lookup", key, new AbortController().signal);
  assert.equal(outbound.get("peer@fixture.test", "lookup")?.status, "submitted");
  assert.deepEqual(attempts, ["request_permission", "call_action"]);
});
