export interface ProviderStartRequest {
  kind: "start";
  execution_id: string;
  conversation_id: string;
  message_id: string;
  input_text: string;
  deadline_unix_ms: number;
}

export interface ProviderResumeRequest {
  kind: "resume";
  execution_id: string;
  conversation_id: string;
  message_id: string;
  provider_session_id: string;
  input_text: string;
  deadline_unix_ms: number;
}

export interface ProviderRecoverRequest {
  kind: "recover";
  execution_id: string;
  conversation_id: string;
  message_id: string;
  provider_session_id: string;
  provider_turn_id: string | null;
  deadline_unix_ms: number;
}

export type FakeProviderRequest =
  | ProviderStartRequest
  | ProviderResumeRequest
  | ProviderRecoverRequest;

export interface ProviderCancelRequest {
  kind: "cancel";
  execution_id: string;
  provider_session_id: string | null;
  provider_turn_id: string | null;
  reason: "deadline" | "shutdown" | "output_limit" | "contract_failure" | "state_failure";
}

export type FakeProviderStep =
  | { kind: "session"; provider_session_id: string }
  | { kind: "turn"; provider_turn_id: string }
  | { kind: "progress"; text: string }
  | { kind: "approval_required"; approval_request_id: string }
  | {
      kind: "approval_resolved";
      approval_request_id: string;
      decision: "approved" | "denied";
    }
  | { kind: "reply"; text: string }
  | { kind: "no_reply" }
  | {
      kind: "unsupported";
      reason_code: "unsupported_message_type" | "unsupported_payload";
    }
  | {
      kind: "failed";
      reason_code:
        | "provider_start_failed"
        | "provider_execution_failed"
        | "provider_result_invalid";
    }
  | { kind: "cancelled"; reason_code: "cancelled_before_execution" }
  | { kind: "uncertain" }
  | { kind: "malformed"; value: unknown }
  | { kind: "oversized"; event: "progress" | "reply"; text_bytes: number }
  | { kind: "wait_for_cancel" }
  | { kind: "close" }
  | { kind: "crash"; exit_code: number };

export type FakeProviderEvent =
  | { event: "session_bound"; execution_id: string; provider_session_id: string }
  | { event: "turn_bound"; execution_id: string; provider_turn_id: string }
  | { event: "progress"; execution_id: string; text: string }
  | { event: "approval_required"; execution_id: string; approval_request_id: string }
  | {
      event: "approval_resolved";
      execution_id: string;
      approval_request_id: string;
      decision: "approved" | "denied";
    }
  | { event: "reply"; execution_id: string; text: string }
  | { event: "completed_without_reply"; execution_id: string }
  | {
      event: "unsupported";
      execution_id: string;
      reason_code: "unsupported_message_type" | "unsupported_payload";
    }
  | {
      event: "failed";
      execution_id: string;
      reason_code:
        | "provider_start_failed"
        | "provider_execution_failed"
        | "provider_result_invalid";
    }
  | {
      event: "cancelled";
      execution_id: string;
      reason_code: "cancelled_before_execution" | "cancelled_during_safe_wait";
    }
  | { event: "uncertain"; execution_id: string; reason_code: "provider_outcome_unknown" };

export type ProviderCancelResult = {
  status: "cancel_requested" | "already_terminal" | "not_found";
};

export interface FakeProviderSpawnRecord {
  executable: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  shell: false;
}
