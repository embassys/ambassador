import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { SidecarApplication } from "../src/application.js";
import type { SidecarConfig } from "../src/config.js";

const NOW_MS = Date.parse("2026-08-23T12:00:00Z");
const CONTROLLER_TOKEN = "controller-installation-token";
const RUNTIME_SECRET = "runtime-binding-secret";

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function temporaryPaths(t: TestContext): Promise<{ journalPath: string; lockPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "a2a-application-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return {
    journalPath: join(directory, "journal.sqlite"),
    lockPath: join(directory, "daemon.lock"),
  };
}

test("runs one durable content-blind delivery through real HTTP and SQLite", async (t) => {
  const wakeBodies: string[] = [];
  const runtimeUrl = await listen(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/wake");
    const rawBody = await body(request);
    wakeBodies.push(rawBody);
    const timestamp = request.headers["x-webhook-timestamp"];
    assert.equal(typeof timestamp, "string");
    assert.equal(
      request.headers["x-webhook-signature-v2"],
      createHmac("sha256", RUNTIME_SECRET).update(`${timestamp}.${rawBody}`).digest("hex"),
    );
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ protocol_version: 1, status: "accepted", session_id: "local-session-1" }),
    );
  });

  const acknowledgements: unknown[] = [];
  const reports: unknown[] = [];
  let polls = 0;
  const controllerUrl = await listen(t, async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${CONTROLLER_TOKEN}`);
    if (request.method === "GET" && request.url?.startsWith("/v1/sidecar/notifications?")) {
      polls += 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          protocol_version: 1,
          cursor: `cursor_${polls}`,
          server_time: new Date(NOW_MS).toISOString(),
          notifications:
            polls === 1
              ? [
                  {
                    notification_id: "notification_1",
                    delivery_id: "delivery_1",
                    binding_id: "binding_1",
                    issued_at: new Date(NOW_MS - 1_000).toISOString(),
                    expires_at: new Date(NOW_MS + 60_000).toISOString(),
                  },
                ]
              : [],
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/ack")) {
      acknowledgements.push(JSON.parse(await body(request)) as unknown);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/sidecar/wake-reports") {
      reports.push(JSON.parse(await body(request)) as unknown);
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const config: SidecarConfig = {
    version: 1,
    controller: {
      base_url: controllerUrl,
      token: { source: "env", name: "CONTROLLER_TOKEN" },
      poll_wait_seconds: 1,
      max_notifications: 10,
      queue_capacity: 10,
    },
    agents: [
      {
        binding_id: "binding_1",
        adapter: {
          type: "generic",
          url: `${runtimeUrl}/wake`,
          secret: { source: "env", name: "RUNTIME_SECRET" },
        },
      },
    ],
  };
  const paths = await temporaryPaths(t);
  let nextId = 0;
  const application = await SidecarApplication.open({
    config,
    ...paths,
    env: { CONTROLLER_TOKEN, RUNTIME_SECRET },
    now: () => NOW_MS,
    idGenerator: () => `outbox_${++nextId}`,
  });
  t.after(() => application.close());

  await application.runOnce(AbortSignal.timeout(2_000));

  assert.equal(acknowledgements.length, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    protocol_version: 1,
    report_id: "outbox_2",
    sequence: 1,
    notification_id: "notification_1",
    delivery_id: "delivery_1",
    status: "accepted",
    observed_at: new Date(NOW_MS).toISOString(),
  });
  assert.deepEqual(wakeBodies, [
    JSON.stringify({
      protocol_version: 1,
      delivery_id: "delivery_1",
      sent_at: new Date(NOW_MS).toISOString(),
    }),
  ]);

  await application.close();
  const journalBytes = await readFile(paths.journalPath);
  for (const forbidden of ["task", "prompt", "permission", CONTROLLER_TOKEN, RUNTIME_SECRET]) {
    assert.equal(journalBytes.includes(Buffer.from(forbidden)), false);
  }
});

test("refuses a second application before opening the shared journal", async (t) => {
  const controllerUrl = await listen(t, (_request, response) => {
    response.statusCode = 500;
    response.end();
  });
  const paths = await temporaryPaths(t);
  const config: SidecarConfig = {
    version: 1,
    controller: {
      base_url: controllerUrl,
      token: { source: "env", name: "CONTROLLER_TOKEN" },
      poll_wait_seconds: 1,
      max_notifications: 1,
      queue_capacity: 1,
    },
    agents: [],
  };
  const first = await SidecarApplication.open({
    config,
    ...paths,
    env: { CONTROLLER_TOKEN },
    now: () => NOW_MS,
  });
  t.after(() => first.close());

  await assert.rejects(
    SidecarApplication.open({
      config,
      ...paths,
      env: { CONTROLLER_TOKEN },
      now: () => NOW_MS,
    }),
  );
});
