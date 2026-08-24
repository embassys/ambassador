import { type AgentConfig, resolveSecret } from "../config.js";
import { GenericWebhookAdapter } from "./generic.js";
import { HermesWebhookAdapter } from "./hermes.js";
import { OpenClawWebhookAdapter } from "./openclaw.js";
import type { WakeAdapter } from "./types.js";

export interface AdapterFactoryOptions {
  env: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createWakeAdapter(agent: AgentConfig, options: AdapterFactoryOptions): WakeAdapter {
  const common = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };

  switch (agent.adapter.type) {
    case "generic":
      return new GenericWebhookAdapter({
        ...common,
        url: agent.adapter.url,
        ...(agent.adapter.health_url === undefined ? {} : { healthUrl: agent.adapter.health_url }),
        secret: resolveSecret(agent.adapter.secret, options.env),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    case "hermes":
      return new HermesWebhookAdapter({
        ...common,
        url: agent.adapter.url,
        ...(agent.adapter.health_url === undefined ? {} : { healthUrl: agent.adapter.health_url }),
        secret: resolveSecret(agent.adapter.secret, options.env),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    case "openclaw":
      return new OpenClawWebhookAdapter({
        ...common,
        url: agent.adapter.url,
        ...(agent.adapter.health_url === undefined ? {} : { healthUrl: agent.adapter.health_url }),
        token: resolveSecret(agent.adapter.token, options.env),
        agentId: agent.adapter.agent_id,
      });
  }
}
