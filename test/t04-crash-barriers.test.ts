import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { startFakeCentral } from "./support/fake-central.js";
import { startFakeWebhook } from "./support/fake-webhook.js";
import { scanT04Artifacts, T04_WEBHOOK_TOKEN } from "./support/t04-gateway-harness.js";
import {
  V2_PROCESS_BARRIER_NAMES,
  type V2ProcessBarrierName,
} from "./support/v2-process-barriers.js";
import { startV2ManagedProcess, v2NodeProcessEnvironment } from "./support/v2-process-runtime.js";

interface CrashFixture {
  readonly central: Awaited<ReturnType<typeof startFakeCentral>>;
  readonly webhook: Awaited<ReturnType<typeof startFakeWebhook>>;
  readonly artifactRoot: string;
}

async function crashFixture(t: TestContext): Promise<CrashFixture> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "a2a-t04-crash-"));
  t.after(() => rm(artifactRoot, { force: true, recursive: true }));
  const central = await startFakeCentral(t);
  const gatewayTime = Math.floor(Date.now() / 1_000);
  if (gatewayTime > central.clock()) central.advanceClock(gatewayTime - central.clock());
  return {
    central,
    webhook: await startFakeWebhook(t),
    artifactRoot,
  };
}

function startWorker(
  t: TestContext,
  fixture: CrashFixture,
  requestId: string,
  expectUncertain: boolean,
) {
  return startV2ManagedProcess(t, {
    command: process.execPath,
    args: [join(process.cwd(), ".test-dist", "test", "support", "t04-crash-worker.js")],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      T04_ARTIFACT_ROOT: fixture.artifactRoot,
      T04_CENTRAL_API_URL: fixture.central.apiUrl,
      T04_CENTRAL_MCP_URL: fixture.central.mcpUrl,
      T04_WEBHOOK_URL: fixture.webhook.url,
      T04_WEBHOOK_TOKEN,
      T04_REQUEST_ID: requestId,
      ...(expectUncertain ? { T04_EXPECT_UNCERTAIN: "1" } : {}),
    }),
    outputLimitBytes: 65_536,
    gracefulStopMs: 500,
    forcedStopMs: 2_000,
  });
}

function grantIfVersionTwo(fixture: CrashFixture): void {
  try {
    fixture.central.setConversationGrant("fixture_recipient", "t04_gateway", true);
  } catch {
    // The shipped gateway registered only in the isolated version 1 fixture state.
  }
}

async function driveToBarrier(
  fixture: CrashFixture,
  worker: ReturnType<typeof startWorker>,
  target: V2ProcessBarrierName,
  dropAfterCommit: boolean,
): Promise<void> {
  for (const name of V2_PROCESS_BARRIER_NAMES) {
    try {
      await worker.barriers.waitFor(name, 10_000);
    } catch {
      throw new Error(`[T04-X-${target}] gateway did not reach the ${name} crash barrier`);
    }
    if (name === "operation") {
      grantIfVersionTwo(fixture);
      if (dropAfterCommit) fixture.central.failNextV2("start", "drop_after_commit");
    }
    if (name === target) return;
    worker.barriers.release(name);
  }
}

async function recoverAfterCrash(
  t: TestContext,
  fixture: CrashFixture,
  requestId: string,
  caseId: string,
): Promise<ReturnType<typeof startWorker>> {
  const recovery = startWorker(t, fixture, requestId, false);
  for (const name of V2_PROCESS_BARRIER_NAMES) {
    try {
      await recovery.barriers.waitFor(name, 10_000);
    } catch {
      throw new Error(`[${caseId}] gateway did not recover through the ${name} barrier`);
    }
    if (name === "operation") grantIfVersionTwo(fixture);
    recovery.barriers.release(name);
  }
  assert.deepEqual(await recovery.waitForExit(), { code: 0, signal: null });
  assert.match(recovery.stdout(), /T04_OPERATION_ACCEPTED/u);
  assert.equal(recovery.stderr(), "");
  return recovery;
}

for (const [index, barrier] of V2_PROCESS_BARRIER_NAMES.entries()) {
  const caseId = `T04-X-${barrier}`;
  test(`${caseId} recovers an idempotent operation after a full-process crash`, async (t) => {
    const fixture = await crashFixture(t);
    const requestId = `00000000-0000-4000-8000-${(40_100 + index).toString().padStart(12, "0")}`;
    const dropAfterCommit = barrier === "commit";
    const worker = startWorker(t, fixture, requestId, dropAfterCommit);
    await driveToBarrier(fixture, worker, barrier, dropAfterCommit);
    await worker.stop();

    const recovery = await recoverAfterCrash(t, fixture, requestId, caseId);
    await scanT04Artifacts({
      root: fixture.artifactRoot,
      stdout: `${worker.stdout()}${recovery.stdout()}`,
      stderr: `${worker.stderr()}${recovery.stderr()}`,
      markers: [
        { name: "webhook-token", value: T04_WEBHOOK_TOKEN },
        { name: "verification-code", value: "123456" },
        { name: "message-text", value: "T04 crash text must remain process-only 7e2d91." },
      ],
    });
  });
}
