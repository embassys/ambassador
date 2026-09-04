import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CENTRAL_ORIGIN, openGatewayApplication } from "../src/gateway-application.js";
import { TestMcpClient } from "./support/mcp-client.js";

const WEBHOOK_SECRET = "abcdef0123456789abcdef0123456789";

function legacyEndpointName(kind: "API" | "MCP"): string {
  return ["A2A", "DEV", "CENTRAL", kind, "URL"].join("_");
}

test("production ignores legacy development endpoint variables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-production-origin-"));
  const requestedUrls: string[] = [];
  const application = await openGatewayApplication({
    journalPath: join(root, "notifications.sqlite3"),
    credentialPath: join(root, "central-credential.enc"),
    credentialKeyPath: join(root, "central-credential.key"),
    webhookSecretPath: join(root, "webhook-secret.json"),
    webhookSecretKeyPath: join(root, "webhook-secret.key"),
    pendingActionPath: join(root, "pending-actions.sqlite"),
    acpSessionPath: join(root, "acp-sessions.sqlite"),
    profilePath: join(root, "delivery-profile.json"),
    workingDirectory: root,
    environment: {
      [legacyEndpointName("API")]: "http://127.0.0.1:1",
      [legacyEndpointName("MCP")]: "http://127.0.0.1:2",
    },
    webhookSecretStore: {
      async load() {
        return WEBHOOK_SECRET;
      },
      async createOrLoad() {
        return WEBHOOK_SECRET;
      },
    },
    centralFetch: async (input) => {
      requestedUrls.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response(
        JSON.stringify({
          agent_id: "production-origin-agent",
          email: "production-origin@fixture.test",
          message: "Verification email sent.",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    localMcpPort: 0,
  });
  t.after(async () => {
    await application.close();
    await rm(root, { recursive: true, force: true });
  });

  const client = new TestMcpClient(application.endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "fixture" });
  assert.equal(
    (
      await client.callTool("register_agent", {
        email: "production-origin@fixture.test",
      })
    ).status,
    "input_required",
  );
  await client.callTool("register_agent", {
    email: "production-origin@fixture.test",
    delivery: {
      mode: "webhook",
      url: "https://receiver.invalid/embassys",
    },
  });

  assert.equal(CENTRAL_ORIGIN, "https://mcp.embassys.ai");
  assert.deepEqual(requestedUrls, [`${CENTRAL_ORIGIN}/api/register_agent`]);
});
