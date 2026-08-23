import { NotImplementedError } from "./errors.js";

export interface SecretReference {
  source: "env";
  name: string;
}

export interface GenericAdapterConfig {
  type: "generic";
  url: string;
  health_url?: string;
  secret: SecretReference;
}

export interface HermesAdapterConfig {
  type: "hermes";
  url: string;
  health_url?: string;
  secret: SecretReference;
}

export interface OpenClawAdapterConfig {
  type: "openclaw";
  url: string;
  health_url?: string;
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

export function parseConfig(_input: unknown): SidecarConfig {
  throw new NotImplementedError("parseConfig");
}

export function resolveSecret(_reference: SecretReference, _env: NodeJS.ProcessEnv): string {
  throw new NotImplementedError("resolveSecret");
}

export function bindingFingerprint(_agent: AgentConfig): string {
  throw new NotImplementedError("bindingFingerprint");
}
