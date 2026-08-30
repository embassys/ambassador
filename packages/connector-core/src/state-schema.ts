export const OWNER_DDL = `CREATE TABLE owner_guard (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  ever_initialized INTEGER NOT NULL CHECK (ever_initialized IN (0, 1))
) STRICT`;

export const CORRELATION_DDL = `
CREATE TABLE store_meta (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  provider_kind TEXT NOT NULL
    CHECK (provider_kind IN ('codex', 'claude', 'gemini')),
  kdf_salt BLOB NOT NULL CHECK (length(kdf_salt) = 16),
  scope_hmac BLOB NOT NULL CHECK (length(scope_hmac) = 32),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999)
) STRICT;

CREATE TABLE conversations (
  conversation_hmac BLOB NOT NULL PRIMARY KEY
    CHECK (length(conversation_hmac) = 32),
  conversation_iv BLOB NOT NULL CHECK (length(conversation_iv) = 12),
  conversation_ciphertext BLOB NOT NULL
    CHECK (length(conversation_ciphertext) BETWEEN 1 AND 128),
  conversation_tag BLOB NOT NULL CHECK (length(conversation_tag) = 16),
  provider_session_hmac BLOB UNIQUE
    CHECK (provider_session_hmac IS NULL OR length(provider_session_hmac) = 32),
  provider_session_iv BLOB
    CHECK (provider_session_iv IS NULL OR length(provider_session_iv) = 12),
  provider_session_ciphertext BLOB
    CHECK (provider_session_ciphertext IS NULL OR
           length(provider_session_ciphertext) BETWEEN 1 AND 1024),
  provider_session_tag BLOB
    CHECK (provider_session_tag IS NULL OR length(provider_session_tag) = 16),
  lifecycle TEXT NOT NULL
    CHECK (lifecycle IN ('binding', 'active', 'uncertain', 'closed')),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN created_at_ms AND 253402300799999),
  CHECK (
    (provider_session_hmac IS NULL AND provider_session_iv IS NULL AND
     provider_session_ciphertext IS NULL AND provider_session_tag IS NULL) OR
    (provider_session_hmac IS NOT NULL AND provider_session_iv IS NOT NULL AND
     provider_session_ciphertext IS NOT NULL AND provider_session_tag IS NOT NULL)
  ),
  CHECK (lifecycle != 'binding' OR provider_session_hmac IS NULL),
  CHECK (lifecycle != 'active' OR provider_session_hmac IS NOT NULL)
) STRICT;

CREATE TABLE messages (
  message_hmac BLOB NOT NULL PRIMARY KEY CHECK (length(message_hmac) = 32),
  message_iv BLOB NOT NULL CHECK (length(message_iv) = 12),
  message_ciphertext BLOB NOT NULL
    CHECK (length(message_ciphertext) BETWEEN 1 AND 128),
  message_tag BLOB NOT NULL CHECK (length(message_tag) = 16),
  conversation_hmac BLOB NOT NULL CHECK (length(conversation_hmac) = 32),
  provider_turn_hmac BLOB UNIQUE
    CHECK (provider_turn_hmac IS NULL OR length(provider_turn_hmac) = 32),
  provider_turn_iv BLOB
    CHECK (provider_turn_iv IS NULL OR length(provider_turn_iv) = 12),
  provider_turn_ciphertext BLOB
    CHECK (provider_turn_ciphertext IS NULL OR
           length(provider_turn_ciphertext) BETWEEN 1 AND 1024),
  provider_turn_tag BLOB
    CHECK (provider_turn_tag IS NULL OR length(provider_turn_tag) = 16),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'received', 'binding', 'turn_starting', 'turn_running',
    'waiting_for_approval', 'central_pending', 'ack_pending',
    'uncertain', 'blocked', 'closed'
  )),
  blocked_class TEXT
    CHECK (blocked_class IS NULL OR blocked_class IN (
      'permanent_application', 'authentication', 'contract', 'cleanup'
    )),
  terminal_operation TEXT
    CHECK (terminal_operation IS NULL OR
           terminal_operation IN ('reply', 'complete')),
  completion_outcome TEXT
    CHECK (completion_outcome IS NULL OR completion_outcome IN (
      'completed_without_reply', 'unsupported', 'failed', 'cancelled', 'uncertain'
    )),
  completion_reason TEXT
    CHECK (completion_reason IS NULL OR completion_reason IN (
      'no_reply_required', 'unsupported_message_type', 'unsupported_payload',
      'provider_start_failed', 'provider_execution_failed',
      'provider_result_invalid', 'cancelled_before_execution',
      'cancelled_during_safe_wait', 'provider_outcome_unknown'
    )),
  retry_kind TEXT
    CHECK (retry_kind IS NULL OR retry_kind IN (
      'reply', 'complete', 'outcome_lookup', 'ack'
    )),
  retry_not_before_ms INTEGER
    CHECK (retry_not_before_ms IS NULL OR
           retry_not_before_ms BETWEEN 0 AND 253402300799999),
  retry_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (retry_attempt_count BETWEEN 0 AND 255),
  turn_started_at_ms INTEGER
    CHECK (turn_started_at_ms IS NULL OR
           turn_started_at_ms BETWEEN 0 AND 253402299899999),
  turn_deadline_ms INTEGER
    CHECK (turn_deadline_ms IS NULL OR
           turn_deadline_ms BETWEEN 0 AND 253402300799999),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 253402300799999),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN created_at_ms AND 253402300799999),
  FOREIGN KEY (conversation_hmac) REFERENCES conversations(conversation_hmac)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (provider_turn_hmac IS NULL AND provider_turn_iv IS NULL AND
     provider_turn_ciphertext IS NULL AND provider_turn_tag IS NULL) OR
    (provider_turn_hmac IS NOT NULL AND provider_turn_iv IS NOT NULL AND
     provider_turn_ciphertext IS NOT NULL AND provider_turn_tag IS NOT NULL)
  ),
  CHECK (
    CASE
      WHEN terminal_operation IS NULL THEN
        CASE WHEN completion_outcome IS NULL AND completion_reason IS NULL
          THEN 1 ELSE 0 END
      WHEN terminal_operation = 'reply' THEN
        CASE WHEN completion_outcome IS NULL AND completion_reason IS NULL
          THEN 1 ELSE 0 END
      WHEN terminal_operation = 'complete' THEN
        CASE
          WHEN completion_outcome = 'completed_without_reply' AND
               completion_reason = 'no_reply_required' THEN 1
          WHEN completion_outcome = 'unsupported' AND completion_reason IN
               ('unsupported_message_type', 'unsupported_payload') THEN 1
          WHEN completion_outcome = 'failed' AND completion_reason IN
               ('provider_start_failed', 'provider_execution_failed',
                'provider_result_invalid') THEN 1
          WHEN completion_outcome = 'cancelled' AND completion_reason IN
               ('cancelled_before_execution',
                'cancelled_during_safe_wait') THEN 1
          WHEN completion_outcome = 'uncertain' AND
               completion_reason = 'provider_outcome_unknown' THEN 1
          ELSE 0
        END
      ELSE 0
    END = 1
  ),
  CHECK (
    CASE
      WHEN retry_kind IS NULL THEN
        CASE WHEN retry_not_before_ms IS NULL THEN 1 ELSE 0 END
      WHEN retry_kind IN ('reply', 'complete', 'outcome_lookup', 'ack') THEN
        CASE WHEN retry_attempt_count BETWEEN 1 AND 255 THEN 1 ELSE 0 END
      ELSE 0
    END = 1
  ),
  CHECK (
    CASE
      WHEN turn_started_at_ms IS NULL THEN
        CASE WHEN turn_deadline_ms IS NULL THEN 1 ELSE 0 END
      WHEN turn_deadline_ms = turn_started_at_ms + 900000 THEN 1
      ELSE 0
    END = 1
  ),
  CHECK (
    CASE lifecycle
      WHEN 'received' THEN CASE WHEN
        provider_turn_hmac IS NULL AND terminal_operation IS NULL AND
        retry_kind IS NULL AND retry_not_before_ms IS NULL AND
        retry_attempt_count = 0 AND turn_started_at_ms IS NULL AND
        blocked_class IS NULL THEN 1 ELSE 0 END
      WHEN 'binding' THEN CASE WHEN
        provider_turn_hmac IS NULL AND terminal_operation IS NULL AND
        retry_kind IS NULL AND retry_not_before_ms IS NULL AND
        retry_attempt_count = 0 AND turn_started_at_ms IS NOT NULL AND
        blocked_class IS NULL THEN 1 ELSE 0 END
      WHEN 'turn_starting' THEN CASE WHEN
        provider_turn_hmac IS NULL AND terminal_operation IS NULL AND
        retry_kind IS NULL AND retry_not_before_ms IS NULL AND
        retry_attempt_count = 0 AND turn_started_at_ms IS NOT NULL AND
        blocked_class IS NULL THEN 1 ELSE 0 END
      WHEN 'turn_running' THEN CASE WHEN
        terminal_operation IS NULL AND retry_kind IS NULL AND
        retry_not_before_ms IS NULL AND retry_attempt_count = 0 AND
        turn_started_at_ms IS NOT NULL AND blocked_class IS NULL
        THEN 1 ELSE 0 END
      WHEN 'waiting_for_approval' THEN CASE WHEN
        terminal_operation IS NULL AND retry_kind IS NULL AND
        retry_not_before_ms IS NULL AND retry_attempt_count = 0 AND
        turn_started_at_ms IS NOT NULL AND blocked_class IS NULL
        THEN 1 ELSE 0 END
      WHEN 'uncertain' THEN CASE WHEN
        terminal_operation IS NULL AND retry_kind IS NULL AND
        retry_not_before_ms IS NULL AND turn_started_at_ms IS NOT NULL AND
        blocked_class IS NULL THEN 1 ELSE 0 END
      WHEN 'central_pending' THEN CASE WHEN
        terminal_operation IS NOT NULL AND
        (retry_kind IS NULL OR retry_kind IN
          ('reply', 'complete', 'outcome_lookup')) AND
        blocked_class IS NULL THEN 1 ELSE 0 END
      WHEN 'ack_pending' THEN CASE WHEN
        terminal_operation IS NOT NULL AND
        (retry_kind IS NULL OR retry_kind = 'ack') AND
        blocked_class IS NULL THEN 1 ELSE 0 END
      WHEN 'blocked' THEN CASE WHEN
        blocked_class IS NOT NULL AND retry_kind IS NULL AND
        retry_not_before_ms IS NULL THEN 1 ELSE 0 END
      WHEN 'closed' THEN CASE WHEN
        terminal_operation IS NOT NULL AND retry_kind IS NULL AND
        retry_not_before_ms IS NULL AND blocked_class IS NULL
        THEN 1 ELSE 0 END
      ELSE 0
    END = 1
  ),
  CHECK (
    CASE retry_kind
      WHEN 'reply' THEN CASE WHEN
        lifecycle = 'central_pending' AND terminal_operation = 'reply'
        THEN 1 ELSE 0 END
      WHEN 'complete' THEN CASE WHEN
        lifecycle = 'central_pending' AND terminal_operation = 'complete'
        THEN 1 ELSE 0 END
      WHEN 'outcome_lookup' THEN CASE WHEN
        lifecycle = 'central_pending' AND terminal_operation IS NOT NULL
        THEN 1 ELSE 0 END
      WHEN 'ack' THEN CASE WHEN lifecycle = 'ack_pending'
        THEN 1 ELSE 0 END
      ELSE CASE WHEN retry_kind IS NULL THEN 1 ELSE 0 END
    END = 1
  )
) STRICT;

CREATE UNIQUE INDEX one_message_per_conversation
  ON messages(conversation_hmac);

CREATE INDEX messages_due_retry
  ON messages(retry_not_before_ms) WHERE retry_kind IS NOT NULL;
`;
