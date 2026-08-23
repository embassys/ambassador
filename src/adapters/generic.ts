import { NotImplementedError } from "../errors.js";
import type { WakeResponse } from "../protocol.js";
import type { FetchLike, HealthResult, WakeAdapter, WakeInput } from "./types.js";

export interface GenericWebhookOptions {
  url: string;
  healthUrl?: string;
  secret: string;
  fetch?: FetchLike;
  now?: () => number;
}

export class GenericWebhookAdapter implements WakeAdapter {
  constructor(_options: GenericWebhookOptions) {
    throw new NotImplementedError("GenericWebhookAdapter.constructor");
  }

  async health(_signal: AbortSignal): Promise<HealthResult> {
    throw new NotImplementedError("GenericWebhookAdapter.health");
  }

  async wake(_input: WakeInput, _signal: AbortSignal): Promise<WakeResponse> {
    throw new NotImplementedError("GenericWebhookAdapter.wake");
  }
}
