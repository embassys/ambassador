#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { observeAgentVersion } from "./agent-version-probes.mjs";

const CONFIRMATION = "run-installed-supported-agents";
const FIXTURE_ORIGIN = process.env.AMBASSADOR_QUALIFICATION_CENTRAL ?? "http://127.0.0.1:8000";
const TARBALL = process.env.AMBASSADOR_CANDIDATE_TARBALL;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

async function runBounded(command, args, capture = false) {
  const child = spawn(command, args, {
    shell: false,
    stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
  });
  const chunks = [];
  let size = 0;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, 10_000);
  timeout.unref();
  if (capture) {
    child.stdout.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size <= 64 * 1024) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
  }
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  }).finally(() => clearTimeout(timeout));
  if (expired || code !== 0 || size > 64 * 1024) {
    throw new Error("candidate archive failed");
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadCandidate(candidatePath) {
  const listing = await runBounded("tar", ["-tzf", candidatePath], true);
  const entries = listing.trim().split("\n");
  if (
    entries.length < 2 ||
    entries.length > 256 ||
    entries.some(
      (entry) =>
        !entry.startsWith("package/") ||
        entry.includes("..") ||
        entry.includes("\\") ||
        entry.includes("\u0000"),
    )
  ) {
    throw new Error("candidate archive failed");
  }
  const candidateRoot = await mkdtemp(
    join(process.cwd(), "node_modules", ".ambassador-qualification-"),
  );
  try {
    await runBounded("tar", ["-xzf", candidatePath, "-C", candidateRoot]);
    const packageRoot = join(candidateRoot, "package");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "@embassys/ambassador" || manifest.bin?.ambassador !== "dist/cli.js") {
      throw new Error("candidate archive failed");
    }
    const moduleUrl = (name) => pathToFileURL(join(packageRoot, "dist", name)).href;
    const [capabilities, direct, localMcp, sessionStore, webhook] = await Promise.all([
      import(moduleUrl("agent-capabilities.js")),
      import(moduleUrl("direct-delivery.js")),
      import(moduleUrl("local-mcp.js")),
      import(moduleUrl("acp-session-store.js")),
      import(moduleUrl("webhook-delivery.js")),
    ]);
    return {
      capabilities,
      direct,
      localMcp,
      sessionStore,
      webhook,
      async close() {
        await rm(candidateRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true });
    throw error;
  }
}

async function fixtureReady() {
  const url = new URL("/readyz", FIXTURE_ORIGIN);
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("fixture must be local");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error("fixture unavailable");
}

async function fixtureRevision() {
  const digest = createHash("sha256");
  for (const name of ["Dockerfile", "app.py", "requirements.lock"]) {
    digest.update(name, "utf8");
    digest.update("\u0000", "utf8");
    digest.update(await readFile(join(process.cwd(), "test", "fixtures", "central", name)));
  }
  return digest.digest("hex");
}

if (process.env.AMBASSADOR_QUALIFY_CONFIRM !== CONFIRMATION) {
  fail(`Set AMBASSADOR_QUALIFY_CONFIRM=${CONFIRMATION} to run paid real-agent qualification.`);
} else if (TARBALL === undefined) {
  fail("Set AMBASSADOR_CANDIDATE_TARBALL to the packed candidate.");
} else {
  const candidatePath = resolve(TARBALL);
  const candidateBytes = await readFile(candidatePath).catch(() => undefined);
  if (candidateBytes === undefined) {
    fail("The packed candidate could not be read.");
  } else {
    const candidate = await loadCandidate(candidatePath).catch(() => undefined);
    if (candidate === undefined) {
      fail("The packed candidate is invalid.");
    } else {
      const { PRODUCTION_AGENT_CAPABILITIES } = candidate.capabilities;
      const { resolveAgentCapability } = candidate.capabilities;
      const { AcpSessionController, DirectDeliveryTarget } = candidate.direct;
      const { AcpSessionStore } = candidate.sessionStore;
      const { LocalMcpServer } = candidate.localMcp;
      const { WebhookDeliveryTarget } = candidate.webhook;
      const report = {
        schema: 2,
        platform: platform(),
        architecture: arch(),
        candidate_sha256: createHash("sha256").update(candidateBytes).digest("hex"),
        fixture: "local-central",
        fixture_revision: await fixtureRevision(),
        profiles: [],
        cases: [],
      };
      let fixture = false;
      try {
        await fixtureReady();
        fixture = true;
      } catch {
        report.cases.push({ name: "local-central-fixture", status: "failed" });
      }

      const qualificationRoot = await realpath(
        await mkdtemp(join(tmpdir(), "ambassador-agent-qualification-")),
      );
      const observedMcpProfiles = new Set();
      const mcp = new LocalMcpServer({
        async listTools() {
          return [
            {
              name: "get_my_permissions",
              description: "Qualification probe for the configured Ambassador MCP channel.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
          ];
        },
        async callTool(name, arguments_, _signal, clientInfo) {
          const resolved = resolveAgentCapability(clientInfo, PRODUCTION_AGENT_CAPABILITIES);
          if (
            name !== "get_my_permissions" ||
            Object.keys(arguments_).length !== 0 ||
            resolved.status !== "matched"
          ) {
            throw new Error("qualification MCP call failed");
          }
          observedMcpProfiles.add(resolved.profile.kind);
          return { permissions: [] };
        },
      });
      try {
        await mcp.listen();
        for (const profile of PRODUCTION_AGENT_CAPABILITIES) {
          const workingDirectory = join(qualificationRoot, profile.kind);
          await mkdir(workingDirectory, { mode: 0o700 });
          const versionProbe = await observeAgentVersion(profile.kind);
          report.profiles.push({
            kind: profile.kind,
            version_probe: versionProbe,
            acp_agent_name: profile.direct?.agentInfo.name ?? "unavailable",
            acp_command: [profile.direct?.command ?? "", ...(profile.direct?.args ?? [])],
            mcp: profile.direct?.mcp ?? "unavailable",
          });

          if (profile.modes.includes("webhook")) {
            const prefix = `AMBASSADOR_${profile.kind.toUpperCase()}_WEBHOOK`;
            try {
              const url = process.env[`${prefix}_URL`];
              const secret = process.env[`${prefix}_SECRET`];
              if (url === undefined || secret === undefined || profile.webhook === undefined) {
                throw new Error("webhook unavailable");
              }
              const target = new WebhookDeliveryTarget({
                url,
                secret,
                contract: profile.webhook,
              });
              await target.deliver(
                {
                  id: `qualification-${profile.kind}-webhook`,
                  sender_agent_id: "qualification.sender",
                  action_type_id: "qualification",
                  payload: { synthetic: true },
                  created_at: new Date().toISOString(),
                },
                new AbortController().signal,
              );
              await target.close();
              report.cases.push({ name: `${profile.kind}-webhook`, status: "passed" });
            } catch {
              report.cases.push({ name: `${profile.kind}-webhook`, status: "failed" });
            }
          }

          let directTarget;
          let sessionStore;
          try {
            if (profile.direct === undefined) throw new Error("direct unavailable");
            const marker = `synthetic-${randomUUID()}`;
            let recalling = false;
            let recalled = false;
            let recentText = "";
            sessionStore = new AcpSessionStore(join(workingDirectory, "acp-sessions.sqlite"));
            directTarget = new DirectDeliveryTarget({
              identityScope: "local-provider-qualification",
              agentKind: profile.kind,
              capability: profile.direct,
              workingDirectory,
              environment: process.env,
              sessionStore,
              // Synthetic read-only qualification never grants an unexpected provider tool.
              approvePermission: async () => "deny",
              log(event, value) {
                if (
                  recalling &&
                  event === "acp.update" &&
                  value?.update?.sessionUpdate === "agent_message_chunk" &&
                  value.update.content?.type === "text"
                ) {
                  recentText = (recentText + value.update.content.text).slice(-8192);
                  recalled ||= recentText.includes(marker);
                }
              },
            });
            await directTarget.deliver(
              {
                id: `qualification-${profile.kind}-direct`,
                sender_agent_id: "qualification.sender",
                action_type_id: "qualification",
                payload: {
                  synthetic: true,
                  qualification_request: `Call the configured Ambassador get_my_permissions MCP tool exactly once, then remember this synthetic marker for our next message: ${marker}.`,
                },
                created_at: new Date().toISOString(),
              },
              new AbortController().signal,
            );
            recalling = true;
            await directTarget.deliver(
              {
                id: `qualification-${profile.kind}-second-turn`,
                sender_agent_id: "qualification.sender",
                payload: {
                  synthetic: true,
                  qualification_request:
                    "Repeat the exact synthetic marker from our preceding message. Do not call tools.",
                },
                created_at: new Date().toISOString(),
              },
              new AbortController().signal,
            );
            if (sessionStore.list().length !== 1) throw new Error("peer session was not reused");
            if (!recalled) throw new Error("peer context was not recalled");
            if (!observedMcpProfiles.has(profile.kind)) {
              throw new Error("qualification MCP call was not observed");
            }
            report.cases.push({ name: `${profile.kind}-direct`, status: "passed" });
          } catch {
            report.cases.push({ name: `${profile.kind}-direct`, status: "failed" });
          } finally {
            await directTarget?.close().catch(() => undefined);
            if (sessionStore !== undefined && profile.direct !== undefined) {
              const controller = new AcpSessionController({
                capability: profile.direct,
                environment: process.env,
              });
              for (const record of sessionStore.list()) {
                const status = await controller
                  .delete(record, AbortSignal.timeout(20_000))
                  .catch(() => "failed");
                report.cases.push({ name: `${profile.kind}-history-cleanup`, status });
              }
            }
            sessionStore?.close();
          }
        }
      } catch {
        report.cases.push({ name: "qualification-runtime", status: "failed" });
      } finally {
        await mcp.close();
        await candidate.close();
        await rm(qualificationRoot, { recursive: true, force: true });
      }
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (
        !fixture ||
        report.cases.some(({ status }) => !["passed", "deleted", "unsupported"].includes(status))
      )
        process.exitCode = 1;
    }
  }
}
