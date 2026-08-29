import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { startFakeCentral } from "./support/fake-central.js";
import {
  V2_PROCESS_BARRIER_NAMES,
  type V2ProcessBarrierName,
} from "./support/v2-process-barriers.js";
import {
  createHttpV2FixtureClock,
  createInProcessV2FixtureClock,
} from "./support/v2-process-clock.js";
import { startV2ManagedProcess, v2NodeProcessEnvironment } from "./support/v2-process-runtime.js";
import { IndependentV2SenderClient } from "./support/v2-process-sender.js";

const BARRIER_WORKER = String.raw`
const barrierModule = process.env.T02_BARRIER_MODULE;
if (barrierModule === undefined) throw new Error("missing barrier module");
const { arriveAtV2ProcessBarrier } = await import(barrierModule);
await arriveAtV2ProcessBarrier("startup");
process.stdout.write("x".repeat(80_000));
process.stdout.write("\nT02_WORKER_READY\n");
for (const name of ["readiness", "operation", "commit", "response", "teardown"]) {
  await arriveAtV2ProcessBarrier(name);
}
`;

const HUNG_WORKER = String.raw`
process.on("SIGTERM", () => {});
process.stdout.write("T02_HUNG_READY\n");
setInterval(() => {}, 1_000);
`;

const EXITED_LEADER_WORKER = String.raw`
const { spawn } = await import("node:child_process");
const descendant = spawn(
  process.execPath,
  ["--input-type=module", "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: "ignore" },
);
if (descendant.pid === undefined) throw new Error("missing descendant PID");
process.stdout.write("T02_DESCENDANT_PID=" + String(descendant.pid) + "\n");
descendant.unref();
`;

const MULTIBYTE_WORKER = `
process.stdout.write("AAAA");
process.stdout.write(Buffer.from([0xf0, 0x9f]));
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(Buffer.from([0x98, 0x80]));
process.stdout.write("éZ");
`;

const FINAL_OUTPUT_WORKER = String.raw`
const { writeSync } = await import("node:fs");
writeSync(1, Buffer.alloc(256 * 1024, 0x71));
writeSync(1, Buffer.from("\nT02_FINAL_TAIL_", "utf8"));
writeSync(1, Buffer.from([0xf0, 0x9f]));
writeSync(1, Buffer.from([0x98, 0x80]));
writeSync(1, Buffer.from("\n", "utf8"));
process.exit(0);
`;

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

test("coordinates every process boundary and bounds captured output", async (t) => {
  const barrierModule = new URL("./support/v2-process-barriers.js", import.meta.url).href;
  const processHarness = startV2ManagedProcess(t, {
    command: process.execPath,
    args: ["--input-type=module", "--eval", BARRIER_WORKER],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({ T02_BARRIER_MODULE: barrierModule }),
    outputLimitBytes: 16_384,
    gracefulStopMs: 100,
    forcedStopMs: 1_000,
  });

  await processHarness.barriers.waitFor("startup");
  processHarness.barriers.release("startup");
  await processHarness.waitForOutput("stdout", "T02_WORKER_READY");
  assert.equal(processHarness.stdoutTruncated(), true);
  assert.ok(Buffer.byteLength(processHarness.stdout(), "utf8") <= 16_384);

  for (const name of V2_PROCESS_BARRIER_NAMES.slice(1)) {
    await processHarness.barriers.waitFor(name);
    processHarness.barriers.release(name);
  }
  assert.deepEqual(
    processHarness.barriers.arrivalOrder,
    V2_PROCESS_BARRIER_NAMES as readonly V2ProcessBarrierName[],
  );
  assert.deepEqual(await processHarness.waitForExit(), { code: 0, signal: null });
  assert.equal(processHarness.stderr(), "");
});

test("escalates an unresponsive child within the configured teardown bound", async (t) => {
  const processHarness = startV2ManagedProcess(t, {
    command: process.execPath,
    args: ["--input-type=module", "--eval", HUNG_WORKER],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment(),
    gracefulStopMs: 50,
    forcedStopMs: 1_000,
  });
  await processHarness.waitForOutput("stdout", "T02_HUNG_READY");
  const startedAt = Date.now();
  const result = await processHarness.stop();
  assert.ok(Date.now() - startedAt < 2_000);
  assert.ok(result.signal !== null || result.code !== 0);
});

test("removes a detached process-group descendant after its leader exits", {
  skip: process.platform === "win32",
}, async (t) => {
  const processHarness = startV2ManagedProcess(t, {
    command: process.execPath,
    args: ["--input-type=module", "--eval", EXITED_LEADER_WORKER],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment(),
    gracefulStopMs: 50,
    forcedStopMs: 1_000,
  });
  await processHarness.waitForOutput("stdout", "T02_DESCENDANT_PID=");
  assert.deepEqual(await processHarness.waitForExit(), { code: 0, signal: null });
  const match = /T02_DESCENDANT_PID=([1-9][0-9]*)/u.exec(processHarness.stdout());
  assert.ok(match?.[1] !== undefined);
  const descendantPid = Number(match[1]);
  assert.ok(Number.isSafeInteger(descendantPid));
  assert.equal(pidExists(descendantPid), true);

  assert.deepEqual(await processHarness.stop(), { code: 0, signal: null });
  assert.equal(await waitForPidExit(descendantPid, 1_000), true);
});

test("keeps a truncated multibyte capture valid and byte-bounded", async (t) => {
  const processHarness = startV2ManagedProcess(t, {
    command: process.execPath,
    args: ["--input-type=module", "--eval", MULTIBYTE_WORKER],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment(),
    outputLimitBytes: 7,
  });
  assert.deepEqual(await processHarness.waitForExit(), { code: 0, signal: null });
  assert.equal(processHarness.stdout(), "😀éZ");
  assert.equal(Buffer.byteLength(processHarness.stdout(), "utf8"), 7);
  assert.equal(processHarness.stdout().includes("�"), false);
  assert.equal(processHarness.stdoutTruncated(), true);
});

test("waits for final output to drain before reporting process completion", async (t) => {
  const processHarness = startV2ManagedProcess(t, {
    command: process.execPath,
    args: ["--input-type=module", "--eval", FINAL_OUTPUT_WORKER],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment(),
    outputLimitBytes: 512 * 1_024,
  });
  assert.deepEqual(await processHarness.waitForExit(), { code: 0, signal: null });
  assert.equal(processHarness.stdout().endsWith("\nT02_FINAL_TAIL_😀\n"), true);
  assert.equal(processHarness.stdout().includes("�"), false);
  assert.ok(Buffer.byteLength(processHarness.stdout(), "utf8") > 256 * 1_024);
});

test("controls direct and HTTP fixture clocks without sleeping", async (t) => {
  const central = await startFakeCentral(t);
  const directClock = createInProcessV2FixtureClock(central);
  assert.equal(directClock.now(), 1_788_000_000);
  assert.equal(await directClock.advance(60), 1_788_000_060);
  assert.equal(central.clock(), 1_788_000_060);

  let httpNow = 1_788_000_000;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/__test/v2/clock");
      assert.equal(request.headers["x-a2a-test-key"], "central-fixture-control");
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { seconds: number };
      httpNow += input.seconds;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ now: httpNow }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const httpClock = createHttpV2FixtureClock({
    fixtureOrigin: `http://127.0.0.1:${port}`,
  });
  assert.equal(await httpClock.advance(65), 1_788_000_065);
  assert.equal(httpClock.now(), 1_788_000_065);
  assert.deepEqual(
    await Promise.all([httpClock.advance(5), httpClock.advance(7)]),
    [1_788_000_070, 1_788_000_077],
  );
  await assert.rejects(httpClock.advance(604_801), /invalid fixture clock advancement/u);
});

test("uses an independent DPoP sender through the public v2 fixture boundary", async (t) => {
  const central = await startFakeCentral(t);
  const clock = createInProcessV2FixtureClock(central);
  const sender = new IndependentV2SenderClient({
    apiOrigin: central.apiUrl,
    clock,
    keyScalar: 701,
  });
  const identity = await sender.enroll({
    email: "t02-sender@fixture.invalid",
    username: "t02_sender",
    displayName: "T02 sender",
    code: "123456",
  });
  assert.equal(identity.username, "t02_sender");
  assert.equal(identity.keyThumbprint, sender.keyThumbprint);

  const activation = await sender.request("/api/v2/delivery/activate", { method: "POST" });
  assert.equal(activation.status, 200);
  assert.deepEqual(await activation.json(), { delivery_version: "v2", status: "active" });

  central.setConversationGrant("fixture_recipient", "t02_sender", true);
  const start = await sender.request("/api/v2/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": "00000000-0000-4000-8000-000000000702",
    },
    body: JSON.stringify({
      recipient_username: "fixture_recipient",
      payload: { text: "T02 sender boundary check." },
    }),
  });
  assert.equal(start.status, 201);
  const accepted = (await start.json()) as Record<string, unknown>;
  assert.equal(accepted.status, "accepted");
  assert.equal(typeof accepted.message_id, "string");
  assert.equal(typeof accepted.conversation_id, "string");
});
