import { NotImplementedError } from "./errors.js";
import type { PollResponse, WakeReportStatus } from "./protocol.js";

export type DeliveryState =
  | "pending"
  | "waking"
  | "retry_wait"
  | "accepted"
  | "failed"
  | "expired"
  | "uncertain";

export interface DeliveryRecord {
  notificationId: string;
  deliveryId: string;
  bindingId: string;
  bindingFingerprint?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  state: DeliveryState;
  attemptCount: number;
  nextAttemptAtMs: number;
  runtimeSessionId?: string;
  mayHaveReachedRuntime: boolean;
  reportSequence: number;
}

export type OutboxRecord =
  | {
      id: string;
      kind: "ack";
      notificationId: string;
      deliveryId: string;
      persistedAt: string;
    }
  | {
      id: string;
      kind: "report";
      notificationId: string;
      deliveryId: string;
      sequence: number;
      status: WakeReportStatus;
      reason?: string;
      observedAt: string;
      nextAttemptAt?: string;
    };

export interface IngestResult {
  inserted: number;
  duplicates: number;
}

export interface ClaimResult {
  status: "claimed" | "not_due" | "binding_changed";
  delivery?: DeliveryRecord;
}

export interface RecordedWakeResult {
  status: WakeReportStatus;
  reason?: string;
  nextAttemptAtMs?: number;
  sessionId?: string;
  mayHaveReachedRuntime?: boolean;
}

export class Journal {
  constructor(_path: string, _idGenerator: () => string = crypto.randomUUID) {
    throw new NotImplementedError("Journal.constructor");
  }

  close(): void {
    throw new NotImplementedError("Journal.close");
  }

  ingestPoll(_response: PollResponse, _capacity: number, _persistedAtMs: number): IngestResult {
    throw new NotImplementedError("Journal.ingestPoll");
  }

  getCursor(): string | null {
    throw new NotImplementedError("Journal.getCursor");
  }

  getDelivery(_deliveryId: string): DeliveryRecord | undefined {
    throw new NotImplementedError("Journal.getDelivery");
  }

  listDue(_nowMs: number, _limit: number): DeliveryRecord[] {
    throw new NotImplementedError("Journal.listDue");
  }

  claimDelivery(_deliveryId: string, _fingerprint: string, _nowMs: number): ClaimResult {
    throw new NotImplementedError("Journal.claimDelivery");
  }

  recordWakeResult(_deliveryId: string, _result: RecordedWakeResult, _observedAtMs: number): void {
    throw new NotImplementedError("Journal.recordWakeResult");
  }

  expireDue(_nowMs: number): number {
    throw new NotImplementedError("Journal.expireDue");
  }

  recoverInFlight(_nowMs: number): number {
    throw new NotImplementedError("Journal.recoverInFlight");
  }

  listOutbox(_limit: number): OutboxRecord[] {
    throw new NotImplementedError("Journal.listOutbox");
  }

  confirmOutbox(_id: string, _confirmedAtMs: number): void {
    throw new NotImplementedError("Journal.confirmOutbox");
  }

  activeCount(): number {
    throw new NotImplementedError("Journal.activeCount");
  }
}
