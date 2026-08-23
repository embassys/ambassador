import { NotImplementedError } from "./errors.js";

export const PROTOCOL_VERSION = 1 as const;

export interface Notification {
  notification_id: string;
  delivery_id: string;
  binding_id: string;
  issued_at: string;
  expires_at: string;
}

export interface PollResponse {
  protocol_version: 1;
  cursor: string;
  server_time: string;
  notifications: Notification[];
}

export interface PersistenceAcknowledgement {
  protocol_version: 1;
  notification_id: string;
  delivery_id: string;
  status: "persisted";
  persisted_at: string;
}

export type WakeReportStatus = "accepted" | "retrying" | "failed" | "expired" | "uncertain";

export interface WakeReport {
  protocol_version: 1;
  report_id: string;
  sequence: number;
  notification_id: string;
  delivery_id: string;
  status: WakeReportStatus;
  reason?: string;
  observed_at: string;
  next_attempt_at?: string;
}

export interface WakeRequest {
  protocol_version: 1;
  delivery_id: string;
  sent_at: string;
}

export type WakeResponse =
  | { protocol_version: 1; status: "accepted" | "duplicate"; session_id?: string }
  | {
      protocol_version: 1;
      status: "retryable_error";
      code: string;
      retry_after_ms?: number;
    }
  | { protocol_version: 1; status: "permanent_error"; code: string };

export function parsePollResponse(_input: unknown): PollResponse {
  throw new NotImplementedError("parsePollResponse");
}

export function parseWakeResponse(_input: unknown): WakeResponse {
  throw new NotImplementedError("parseWakeResponse");
}
