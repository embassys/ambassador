import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capabilityForKind } from "../src/agent-capabilities.js";
import { serializeCentralCredential } from "../src/central-credential.js";
import { CentralEnrollmentClient } from "../src/central-enrollment.js";
import { runCli } from "../src/cli.js";
import { createDeliveryProfile, DeliveryProfileStore } from "../src/delivery-profile.js";
import { DirectDeliveryError } from "../src/direct-delivery.js";
import { ProcessLock } from "../src/process-lock.js";
import { startFakeCentral } from "./support/fake-central.js";
import { TestMcpClient } from "./support/mcp-client.js";

const NOW_SECONDS = 1_788_220_800;

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("creates and prints one stable webhook secret without taking the gateway lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-webhook-secret-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output: string[] = [];
  const io = {
    stdout: {
      write(chunk: string | Uint8Array) {
        output.push(String(chunk));
        return true;
      },
    },
    stderr: { write: () => true },
  };
  const context = {
    io,
    env: {},
    cwd: root,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
    },
  };

  assert.equal(await runCli(["webhook-secret"], context), 0);
  assert.equal(await runCli(["webhook-secret"], context), 0);
  assert.equal(output.length, 2);
  assert.match(output[0] ?? "", /^[a-f0-9]{48}\n$/u);
  assert.equal(output[1], output[0]);
});

test("starts and serves MCP with no options or environment variables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-zero-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  let stdout = "";
  let stderr = "";
  const running = runCli(["start"], {
    io: {
      stdout: {
        write(chunk) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk) {
          stderr += String(chunk);
          return true;
        },
      },
    },
    env: {},
    cwd: root,
    signal: controller.signal,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
      localMcpPort: 0,
    },
  });

  let endpoint: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    endpoint = /MCP endpoint: (http:\/\/127\.0\.0\.1:\d+\/mcp)/u.exec(stdout)?.[1];
    if (endpoint !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(endpoint !== undefined);
  assert.match(stdout, /Connect an agent in another terminal:/u);
  assert.match(stdout, /codex mcp add ambassador --url http:\/\/127\.0\.0\.1:\d+\/mcp/u);
  assert.match(
    stdout,
    /claude mcp add --transport http --scope user ambassador http:\/\/127\.0\.0\.1:\d+\/mcp/u,
  );
  assert.match(stdout, /hermes mcp add ambassador --url http:\/\/127\.0\.0\.1:\d+\/mcp/u);
  assert.match(stdout, /openclaw mcp set ambassador/u);
  assert.match(stdout, /Register me with Embassys using my email/u);
  const client = new TestMcpClient(endpoint);
  await client.initialize({ name: "openclaw-bundle-mcp", version: "0.0.0" });
  assert.deepEqual(
    (await client.listTools()).map(({ name }) => name),
    ["register_agent", "verify_email", "resend_verification"],
  );

  controller.abort();
  assert.equal(await running, 0);
  assert.equal(stderr, "");
});

test("explains when the local MCP port is already in use", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-port-in-use-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const occupied = createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address !== null && typeof address === "object");
  const output = captureIo();

  assert.equal(
    await runCli(["start"], {
      io: output.io,
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
        localMcpPort: address.port,
      },
    }),
    7,
  );
  assert.equal(output.stdout(), "");
  assert.equal(
    output.stderr(),
    `Ambassador could not bind its local MCP endpoint because 127.0.0.1:${address.port} is already in use\n`,
  );
});

test("explains invalid local state and gives the supported reset command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-invalid-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "notifications.sqlite"), "not a database");
  const output = captureIo();

  assert.equal(
    await runCli(["start"], {
      io: output.io,
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
        localMcpPort: 0,
      },
    }),
    7,
  );
  assert.equal(output.stdout(), "");
  assert.equal(
    output.stderr(),
    "Ambassador could not open its local state. Stop Ambassador, run `npx --yes @embassys/ambassador@latest clean`, then start it again\n",
  );
});

test("explains an unavailable direct agent instead of leaking a child-process error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-direct-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const central = await startFakeCentral(t);
  const enrollment = new CentralEnrollmentClient({
    centralOrigin: central.apiUrl,
    nowSeconds: () => NOW_SECONDS,
  });
  const email = "direct-unavailable@fixture.test";
  await enrollment.register({ email });
  const verified = await enrollment.verify({ email, code: central.verificationCode(email) });
  const codex = capabilityForKind("codex");
  assert.ok(codex !== undefined);
  const profile = await createDeliveryProfile(codex, { mode: "direct" }, root);
  await new DeliveryProfileStore(join(root, "delivery-profile.json")).save(profile);
  const serializedCredential = serializeCentralCredential(verified.credential);

  central.queueMessage(email, { type: "permission_request" });
  const output = captureIo();
  let deliveryAttempts = 0;
  assert.equal(
    await runCli(["start"], {
      io: output.io,
      env: {},
      cwd: root,
      signal: new AbortController().signal,
      testOverrides: {
        centralOrigin: central.apiUrl,
        stateRoot: root,
        credentialStore: {
          async load() {
            return serializedCredential;
          },
          async save() {
            throw new Error("fixture credential is already enrolled");
          },
        },
        localMcpPort: 0,
        nowSeconds: () => NOW_SECONDS,
        deliveryTargetFactory: () => ({
          async deliver() {
            deliveryAttempts += 1;
            throw new DirectDeliveryError("agent_unavailable");
          },
          async close() {},
        }),
      },
    }),
    7,
  );
  assert.equal(deliveryAttempts, 1);
  assert.match(
    output.stderr(),
    /^Ambassador could not start direct delivery for Codex\. Reinstall the latest Ambassador, then confirm Codex is installed and signed in\n$/u,
  );
  assert.doesNotMatch(output.stderr(), /ENOENT|spawn|node:events/iu);
});

test("cleans all local registration and delivery residue and leaves provider files alone", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ambassador-clean-cli-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "state", "ambassador");
  await mkdir(join(root, "stale-directory"), { recursive: true });
  for (const name of [
    "central-credential.json",
    "central-credential.key",
    "webhook-secret.json",
    "webhook-secret.key",
    "delivery-profile.json",
    "notifications.sqlite",
    "pending-actions.sqlite",
    "pending-actions.sqlite-wal",
    "pending-actions.sqlite-shm",
    "interrupted-write.tmp",
  ]) {
    await writeFile(join(root, name), `residue:${name}`);
  }
  await writeFile(join(root, "stale-directory", "artifact"), "nested residue");
  const providerFile = join(parent, "provider-config.json");
  await writeFile(providerFile, "provider state");
  if (process.platform !== "win32") {
    await symlink(providerFile, join(root, "provider-link"));
  }

  const output = captureIo();
  const context = {
    io: output.io,
    env: {},
    cwd: parent,
    testOverrides: {
      centralOrigin: "http://127.0.0.1:1",
      stateRoot: root,
    },
  };
  assert.equal(await runCli(["clean"], context), 0);
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);
  assert.equal(await readFile(providerFile, "utf8"), "provider state");
  assert.equal(output.stdout(), "Ambassador local state cleared\n");
  assert.equal(output.stderr(), "");

  assert.equal(await runCli(["clean"], context), 0);
  assert.deepEqual(await readdir(root), ["ambassador.lock"]);
  assert.equal(output.stdout(), "Ambassador local state cleared\nAmbassador local state cleared\n");
});

test("clean refuses to touch state while Ambassador owns the process lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ambassador-clean-running-"));
  const residuePath = join(root, "delivery-profile.json");
  await writeFile(residuePath, "keep while running");
  const lock = await ProcessLock.acquire(join(root, "ambassador.lock"));
  t.after(async () => {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  });
  const output = captureIo();

  assert.equal(
    await runCli(["clean"], {
      io: output.io,
      env: {},
      cwd: root,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
      },
    }),
    7,
  );
  await access(residuePath);
  assert.equal(await readFile(residuePath, "utf8"), "keep while running");
  assert.equal(output.stdout(), "");
  assert.equal(output.stderr(), "Ambassador is already running\n");
});

test("clean rejects a linked state directory without touching its target", {
  skip: process.platform === "win32",
}, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ambassador-clean-linked-root-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, "provider-state");
  const root = join(parent, "ambassador-state");
  const targetFile = join(target, "provider-config.json");
  await mkdir(target);
  await writeFile(targetFile, "provider state");
  await symlink(target, root);
  const output = captureIo();

  assert.equal(
    await runCli(["clean"], {
      io: output.io,
      env: {},
      cwd: parent,
      testOverrides: {
        centralOrigin: "http://127.0.0.1:1",
        stateRoot: root,
      },
    }),
    7,
  );
  assert.equal(await readFile(targetFile, "utf8"), "provider state");
  assert.equal(output.stdout(), "");
  assert.equal(output.stderr(), "The Ambassador lock artifact is invalid\n");
});
