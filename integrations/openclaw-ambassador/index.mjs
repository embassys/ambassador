import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

import {
  buildAmbassadorPrompt,
  classifyOpenClawExecutionError,
  createBoundedOpenClawWorkQueue,
  verifyAmbassadorWebhook,
} from "./receiver.mjs";

const MAX_BODY_BYTES = 512 * 1024;
const SECRET = /^[a-f0-9]{48}$/u;
const AGENT_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const RECEIPT_TTL_MS = 60 * 60 * 1_000;
const MAX_RECEIPTS = 1_024;
const MAX_PENDING_MODEL_TURNS = 64;

function response(res, status) {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.end();
  return true;
}

async function readBody(req) {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const value = Array.isArray(declared) ? Number.NaN : Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BODY_BYTES) return undefined;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return undefined;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

export default definePluginEntry({
  id: "embassys-ambassador",
  name: "Embassys Ambassador",
  description: "Accepts authenticated Ambassador webhooks and starts an OpenClaw model turn.",
  register(api) {
    const secret = api.pluginConfig?.secret;
    const configuredAgentId = api.pluginConfig?.agentId;
    const agentId = configuredAgentId === undefined ? "main" : configuredAgentId;
    if (secret === undefined) {
      api.logger.warn("Embassys Ambassador webhook is not configured");
      return;
    }
    if (
      !(
        (typeof secret === "string" && SECRET.test(secret)) ||
        (secret !== null && typeof secret === "object" && !Array.isArray(secret))
      )
    ) {
      throw new Error("Embassys Ambassador webhook configuration is invalid");
    }
    if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) {
      throw new Error("Embassys Ambassador webhook configuration is invalid");
    }
    const receipts = new Map();
    const workQueue = createBoundedOpenClawWorkQueue(MAX_PENDING_MODEL_TURNS);
    let acceptingWork = false;
    let activeRunController;
    let serviceLoop;

    api.registerService({
      id: "embassys-ambassador-model-turns",
      start(ctx) {
        acceptingWork = true;
        serviceLoop = (async () => {
          while (acceptingWork) {
            const work = await workQueue.next();
            if (work === undefined) return;
            const controller = new AbortController();
            activeRunController = controller;
            try {
              const config = api.runtime.config.current();
              await api.runtime.agent.runEmbeddedAgent({
                sessionId: work.requestId,
                runId: work.requestId,
                timeoutMs: api.runtime.agent.resolveAgentTimeoutMs({ cfg: config }),
                agentId,
                workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(config, agentId),
                config,
                prompt: work.prompt,
                trigger: "manual",
                initialTurnTainted: true,
                abortSignal: controller.signal,
              });
              ctx.serviceHealth?.clearFailure();
            } catch (error) {
              if (!controller.signal.aborted) {
                const classification = classifyOpenClawExecutionError(error);
                api.logger.error(`Embassys Ambassador model execution failed (${classification})`);
                ctx.serviceHealth?.reportFailure(
                  new Error(`Embassys Ambassador model execution failed (${classification})`),
                );
              }
            } finally {
              if (activeRunController === controller) activeRunController = undefined;
            }
          }
        })();
      },
      async stop() {
        acceptingWork = false;
        workQueue.close();
        activeRunController?.abort();
        await serviceLoop;
        serviceLoop = undefined;
      },
    });

    api.registerHttpRoute({
      path: "/embassys/ambassador",
      auth: "plugin",
      match: "exact",
      async handler(req, res) {
        const body = await readBody(req);
        if (body === undefined) return response(res, 413);
        const resolvedSecret = await resolveConfiguredSecretInputString({
          config: api.runtime.config.current(),
          env: process.env,
          value: secret,
          path: "plugins.entries.embassys-ambassador.config.secret",
          unresolvedReasonStyle: "generic",
        }).catch(() => ({}));
        if (typeof resolvedSecret.value !== "string" || !SECRET.test(resolvedSecret.value)) {
          return response(res, 503);
        }
        const verification = verifyAmbassadorWebhook({
          method: req.method ?? "",
          headers: requestHeaders(req),
          body,
          secret: resolvedSecret.value,
          nowSeconds: Math.floor(Date.now() / 1_000),
        });
        if (!verification.ok) return response(res, verification.status);

        const requestId = requestHeaders(req).get("idempotency-key");
        if (requestId === null) return response(res, 400);
        const now = Date.now();
        for (const [id, expiresAt] of receipts) {
          if (expiresAt <= now) receipts.delete(id);
        }
        if (receipts.has(requestId)) return response(res, 202);
        if (!acceptingWork || receipts.size >= MAX_RECEIPTS) return response(res, 503);
        const prompt = buildAmbassadorPrompt(verification.message);
        if (!workQueue.enqueue({ requestId, prompt })) return response(res, 503);
        receipts.set(requestId, now + RECEIPT_TTL_MS);
        return response(res, 202);
      },
    });
  },
});
