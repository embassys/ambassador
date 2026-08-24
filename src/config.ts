import { createHash } from "node:crypto";

import { z } from "zod";

export interface SecretReference {
  source: "env";
  name: string;
}

export interface GenericAdapterConfig {
  type: "generic";
  url: string;
  health_url?: string | undefined;
  secret: SecretReference;
}

export interface HermesAdapterConfig {
  type: "hermes";
  url: string;
  health_url?: string | undefined;
  secret: SecretReference;
}

export interface OpenClawAdapterConfig {
  type: "openclaw";
  url: string;
  health_url?: string | undefined;
  agent_id: string;
  token: SecretReference;
}

export type AdapterConfig = GenericAdapterConfig | HermesAdapterConfig | OpenClawAdapterConfig;

export interface AgentConfig {
  binding_id: string;
  adapter: AdapterConfig;
}

export interface SidecarConfig {
  version: 1;
  controller: {
    base_url: string;
    token: SecretReference;
    poll_wait_seconds: number;
    max_notifications: number;
    queue_capacity: number;
  };
  agents: AgentConfig[];
}

const idSchema = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const endpointUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  return (
    url.username === "" &&
    url.password === "" &&
    (url.protocol === "https:" || (url.protocol === "http:" && loopback))
  );
}, "URL must use HTTPS or loopback HTTP without embedded credentials");
const secretReferenceSchema = z.strictObject({
  source: z.literal("env"),
  name: environmentNameSchema,
});

const genericAdapterSchema = z.strictObject({
  type: z.literal("generic"),
  url: endpointUrlSchema,
  health_url: endpointUrlSchema.optional(),
  secret: secretReferenceSchema,
});

const hermesAdapterSchema = z.strictObject({
  type: z.literal("hermes"),
  url: endpointUrlSchema,
  health_url: endpointUrlSchema.optional(),
  secret: secretReferenceSchema,
});

const openClawAdapterSchema = z.strictObject({
  type: z.literal("openclaw"),
  url: endpointUrlSchema,
  health_url: endpointUrlSchema.optional(),
  agent_id: idSchema,
  token: secretReferenceSchema,
});

const agentConfigSchema = z.strictObject({
  binding_id: idSchema,
  adapter: z.discriminatedUnion("type", [
    genericAdapterSchema,
    hermesAdapterSchema,
    openClawAdapterSchema,
  ]),
});

const sidecarConfigSchema = z
  .strictObject({
    version: z.literal(1),
    controller: z.strictObject({
      base_url: endpointUrlSchema,
      token: secretReferenceSchema,
      poll_wait_seconds: z.number().int().min(1).max(300),
      max_notifications: z.number().int().min(1).max(1_000),
      queue_capacity: z.number().int().min(1).max(1_000_000),
    }),
    agents: z.array(agentConfigSchema),
  })
  .superRefine((config, context) => {
    const bindingIds = new Set<string>();

    for (const [index, agent] of config.agents.entries()) {
      if (bindingIds.has(agent.binding_id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate binding ID",
          path: ["agents", index, "binding_id"],
        });
      }
      bindingIds.add(agent.binding_id);
    }
  });

export function parseConfig(input: unknown): SidecarConfig {
  return sidecarConfigSchema.parse(input);
}

export function resolveSecret(reference: SecretReference, env: NodeJS.ProcessEnv): string {
  const parsedReference = secretReferenceSchema.parse(reference);
  const value = env[parsedReference.name];

  if (value === undefined) {
    throw new Error(`Environment variable ${parsedReference.name} is not set`);
  }

  return value;
}

export function bindingFingerprint(agent: AgentConfig): string {
  const parsedAgent = agentConfigSchema.parse(agent);
  const { adapter } = parsedAgent;
  const canonicalAdapter =
    adapter.type === "openclaw"
      ? {
          agent_id: adapter.agent_id,
          health_url: adapter.health_url ?? null,
          token: { name: adapter.token.name, source: adapter.token.source },
          type: adapter.type,
          url: adapter.url,
        }
      : {
          health_url: adapter.health_url ?? null,
          secret: { name: adapter.secret.name, source: adapter.secret.source },
          type: adapter.type,
          url: adapter.url,
        };
  const canonicalConfig = JSON.stringify({
    adapter: canonicalAdapter,
    binding_id: parsedAgent.binding_id,
  });

  return createHash("sha256").update(canonicalConfig, "utf8").digest("hex");
}
