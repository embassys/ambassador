import { NotImplementedError } from "../errors.js";
import type { WakeResponse } from "../protocol.js";
import type { FetchLike, HealthResult, WakeAdapter, WakeInput } from "./types.js";

export interface OpenClawWebhookOptions {
  url: string;
  healthUrl?: string;
  token: string;
  agentId: string;
  fetch?: FetchLike;
}

export class OpenClawWebhookAdapter implements WakeAdapter {
  constructor(_options: OpenClawWebhookOptions) {
    throw new NotImplementedError("OpenClawWebhookAdapter.constructor");
  }

  async health(_signal: AbortSignal): Promise<HealthResult> {
    throw new NotImplementedError("OpenClawWebhookAdapter.health");
  }

  async wake(_input: WakeInput, _signal: AbortSignal): Promise<WakeResponse> {
    throw new NotImplementedError("OpenClawWebhookAdapter.wake");
  }
}
