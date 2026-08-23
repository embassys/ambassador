import { NotImplementedError } from "../errors.js";
import type { WakeResponse } from "../protocol.js";
import type { FetchLike, HealthResult, WakeAdapter, WakeInput } from "./types.js";

export interface HermesWebhookOptions {
  url: string;
  healthUrl?: string;
  secret: string;
  fetch?: FetchLike;
  now?: () => number;
}

export class HermesWebhookAdapter implements WakeAdapter {
  constructor(_options: HermesWebhookOptions) {
    throw new NotImplementedError("HermesWebhookAdapter.constructor");
  }

  async health(_signal: AbortSignal): Promise<HealthResult> {
    throw new NotImplementedError("HermesWebhookAdapter.health");
  }

  async wake(_input: WakeInput, _signal: AbortSignal): Promise<WakeResponse> {
    throw new NotImplementedError("HermesWebhookAdapter.wake");
  }
}
