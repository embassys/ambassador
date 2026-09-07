import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import { EncryptedFileCredentialStore } from "../src/credential-store.js";
import { DesktopGateway } from "../src/desktop/gateway.js";
import { readLocalSummary } from "../src/desktop/local-summary.js";
import { pathsForStateDirectory } from "../src/gateway-paths.js";
import { PendingActionInbox } from "../src/pending-action-inbox.js";
import { ProcessLock } from "../src/process-lock.js";
import { VisibleTranscripts } from "../src/visible-transcripts.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

test("Clean summary identifies enrollment and counts pending calls without consuming them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-clean-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = pathsForStateDirectory(root);
  const credential = currentCredential("desktop@fixture.test");
  await new EncryptedFileCredentialStore(
    paths.credentialPath,
    paths.credentialKeyPath,
    JSON.stringify({ centralOrigin: "https://mcp.embassys.ai" }),
  ).save(credential);
  const inbox = new PendingActionInbox(
    paths.pendingActionPath,
    parseCentralCredential(credential, () => FIXTURE_NOW_SECONDS),
  );
  const callId = randomUUID();
  inbox.capture({
    sender_agent_id: "peer",
    payload: {
      type: "action_call",
      call_id: callId,
      action_type: "get_phone_number",
      payload: { reason: "private text" },
    },
    created_at: new Date().toISOString(),
  });
  inbox.close();
  const archive = new VisibleTranscripts(
    join(root, "visible-transcripts.sqlite"),
    parseCentralCredential(credential, () => FIXTURE_NOW_SECONDS),
  );
  archive.begin("offline-session", {
    id: "offline-message",
    sender_agent_id: "peer",
    payload: { type: "action_call" },
    created_at: new Date().toISOString(),
  });
  archive.update("offline-message", 1, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Saved visible response" },
  });
  archive.finish("offline-message", "complete");
  archive.close();
  const gateway = new DesktopGateway({
    id: randomUUID(),
    name: "Offline",
    stateDirectory: root,
    workingDirectory: root,
    port: 0,
    environment: {},
  });
  assert.match(JSON.stringify(await gateway.history("offline-session")), /Saved visible response/u);
  assert.equal(gateway.snapshot().state, "stopped");
  await gateway.deleteHistory("offline-session");
  assert.doesNotMatch(
    JSON.stringify(await gateway.history("offline-session")),
    /Saved visible response/u,
  );
  const lock = await ProcessLock.acquire(paths.lockPath);
  try {
    const summary = await readLocalSummary(paths);
    assert.equal(summary.enrollment.email, "desktop@fixture.test");
    assert.equal(summary.pendingCalls, 1);
    assert.equal(summary.receivedResults, 0);
    assert.doesNotMatch(JSON.stringify(summary), /private text|private_key|access_token/u);
    assert.equal((await readLocalSummary(paths)).pendingCalls, 1);
  } finally {
    await lock.release();
  }
});

test("Clean preview holds exclusive custody; cancellation and stale confirmation preserve data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-clean-preview-"));
  const gateway = new DesktopGateway({
    id: randomUUID(),
    name: "Test",
    stateDirectory: root,
    workingDirectory: join(root, "workspace"),
    port: 0,
    environment: {},
  });
  t.after(async () => {
    await gateway.stop();
    await rm(root, { recursive: true, force: true });
  });
  const marker = join(root, "keep.txt");
  await writeFile(marker, "keep");
  const first = await gateway.prepareClean();
  await assert.rejects(ProcessLock.acquire(join(root, "ambassador.lock")));
  await assert.rejects(gateway.clean(randomUUID()), /preview/u);
  assert.equal(await readFile(marker, "utf8"), "keep");
  await gateway.cancelClean(first.previewId);
  await assert.rejects(gateway.clean(first.previewId), /preview/u);
  const second = await gateway.prepareClean();
  await gateway.clean(second.previewId);
  await assert.rejects(readFile(marker));
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  await lock.release();
});
