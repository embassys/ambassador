import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AcpSessionStore } from "../src/acp-session-store.js";
import { capabilityForKind } from "../src/agent-capabilities.js";
import { serializeCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient } from "../src/central-enrollment.js";
import { createDeliveryProfile, DeliveryProfileStore } from "../src/delivery-profile.js";
import { openGatewayApplication } from "../src/gateway-application.js";
import { startFakeCentral } from "./support/fake-central.js";

const NOW_SECONDS = 1_788_220_800;

test("startup deletes or forgets expired sessions and retains transient failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-session-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  const email = "session-cleanup@fixture.test";
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const codex = capabilityForKind("codex");
  assert.ok(codex !== undefined);
  const profile = await createDeliveryProfile(codex, { mode: "direct" }, root);
  await new DeliveryProfileStore(join(root, "delivery-profile.json")).save(profile);

  const sessionPath = join(root, "acp-sessions.sqlite");
  const seed = new AcpSessionStore(sessionPath);
  for (const sessionId of ["delete-me", "forget-me", "retry-me", "active-session"]) {
    seed.create({
      session_id: sessionId,
      agent_kind: "codex",
      working_directory: root,
      status: "active",
      created_at_ms: 1,
      last_used_at_ms: 1,
    });
    if (sessionId !== "active-session") seed.retire(sessionId, 2);
  }
  seed.close();

  const deleted: string[] = [];
  const controller = new AbortController();
  const application = await openGatewayApplication({
    journalPath: join(root, "notifications.sqlite"),
    credentialPath: join(root, "central-credential.json"),
    credentialKeyPath: join(root, "central-credential.key"),
    webhookSecretPath: join(root, "webhook-secret.json"),
    webhookSecretKeyPath: join(root, "webhook-secret.key"),
    pendingActionPath: join(root, "pending-actions.sqlite"),
    acpSessionPath: sessionPath,
    profilePath: join(root, "delivery-profile.json"),
    workingDirectory: root,
    environment: process.env,
    centralOrigin: central.apiUrl,
    credentialStore: {
      async load() {
        return serializeCentralCredential(verified.credential);
      },
      async save() {
        throw new Error("fixture identity is already enrolled");
      },
    },
    localMcpPort: 0,
    nowSeconds: () => NOW_SECONDS,
    signal: controller.signal,
    deliveryTargetFactory: () => ({
      async deliver() {
        return { status: "completed" };
      },
      async close() {},
    }),
    acpSessionControllerFactory: () => ({
      async delete(record) {
        deleted.push(record.session_id);
        if (record.session_id === "delete-me") return "deleted";
        if (record.session_id === "forget-me") return "unsupported";
        throw new Error("transient provider failure");
      },
    }),
  });

  try {
    assert.deepEqual(deleted, ["delete-me", "forget-me", "retry-me"]);
    const observed = new AcpSessionStore(sessionPath);
    assert.equal(observed.get("delete-me"), undefined);
    assert.equal(observed.get("forget-me"), undefined);
    assert.equal(observed.get("retry-me")?.status, "retired");
    assert.equal(observed.get("active-session")?.status, "active");
    observed.close();
  } finally {
    controller.abort();
    await application.close();
  }
});
