import type { FetchLike } from "./adapters/types.js";
import { NotImplementedError } from "./errors.js";
import type { PersistenceAcknowledgement, PollResponse, WakeReport } from "./protocol.js";

export interface ControllerClient {
  poll(cursor: string | null, signal: AbortSignal): Promise<PollResponse>;
  acknowledge(message: PersistenceAcknowledgement, signal: AbortSignal): Promise<void>;
  report(message: WakeReport, signal: AbortSignal): Promise<void>;
}

export interface HttpControllerOptions {
  baseUrl: string;
  token: string;
  waitSeconds: number;
  maxNotifications: number;
  fetch?: FetchLike;
}

export class HttpControllerClient implements ControllerClient {
  constructor(_options: HttpControllerOptions) {
    throw new NotImplementedError("HttpControllerClient.constructor");
  }

  async poll(_cursor: string | null, _signal: AbortSignal): Promise<PollResponse> {
    throw new NotImplementedError("HttpControllerClient.poll");
  }

  async acknowledge(_message: PersistenceAcknowledgement, _signal: AbortSignal): Promise<void> {
    throw new NotImplementedError("HttpControllerClient.acknowledge");
  }

  async report(_message: WakeReport, _signal: AbortSignal): Promise<void> {
    throw new NotImplementedError("HttpControllerClient.report");
  }
}
