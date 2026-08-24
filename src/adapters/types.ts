import type { WakeResponse } from "../protocol.js";

export interface WakeInput {
  deliveryId: string;
}

export interface HealthResult {
  healthy: boolean;
  detailCode?: string;
}

export interface WakeAdapter {
  health(signal: AbortSignal): Promise<HealthResult>;
  wake(input: WakeInput, signal: AbortSignal): Promise<WakeResponse>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
