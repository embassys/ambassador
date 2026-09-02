# 0029 Connector correlation state

Status: superseded by ADR 0038; historical reference only

Date: 2026-08-30

The encryption, filesystem, quota, and retirement rules remain useful. The
conversation and paired-message state model assumes the superseded central
conversation lifecycle and must be redesigned before live use.

## Problem

ADR 0024 accepts a separate, provider-neutral connector that correlates one
A2A conversation with one provider session. That correlation must survive a
restart so the connector can resume the exact provider session and, where the
provider permits it, recover the exact prior turn instead of replaying a
prompt blindly.

The gateway journal cannot own this state. ADR 0007 restricts it to
notification IDs and relay state, and the gateway must remain unaware of
provider sessions. Plaintext provider session and turn IDs would also expose
sensitive local metadata to backups, support collection, or a copied state
file.

This record defines the connector's storage technology, location, schema,
cryptographic envelope, file protection, quota, locking, crash, corruption,
retention, and deletion behavior. It does not select a provider interface.

## Decision

### Store boundary and dependency

Use one connector-owned SQLite correlation store, separate from the gateway
notification journal and provider-native history. Use the already pinned
`better-sqlite3` 13.0.3 and `@types/better-sqlite3` 9.6.0, with no ORM and no
new dependency, only if the user explicitly approves extending ADR 0007 from
gateway notification state to this connector-state purpose.

Use one correlation connection and short synchronous transactions. Every
value uses a prepared statement. No report, full-table scan, provider call,
gateway call, cryptographic KDF, or filesystem operation runs inside a write
transaction. The only startup-wide scans are SQLite integrity, schema, quota,
and row-shape checks before the connector accepts work.

This is a fresh-install schema version 1. There is no schema migration, legacy
import, partial conversion, downgrade, or automatic reset. An unknown or
corrupt owner database, correlation database, schema, row, cryptographic
envelope, or retirement marker fails closed.

### Account-derived state root and literal artifacts

Obtain the current account home from `node:os.userInfo().homedir`, not
`HOME`, `XDG_STATE_HOME`, `USERPROFILE`, `LOCALAPPDATA`, or another inherited
environment value. Require an absolute existing directory, resolve it once
with `fs.realpath.native`, require the resolved object to remain a directory
owned by the current account, and use those exact canonical bytes for the
process lifetime. An unavailable or unverifiable account home fails startup.
The state root must also be proven to reside on a local filesystem by the
platform qualification mechanism. A network, distributed, or remotely mounted
account home, or a platform on which local residence cannot be proven without
a pathname heuristic, is unsupported and fails before any state artifact is
created or opened.

The fixed provider directories are:

| Platform | Provider state directory |
| --- | --- |
| Linux | `<account-home>/.local/state/a2a-connectors/<provider>/` |
| macOS | `<account-home>/Library/Application Support/a2a-connectors/<provider>/` |
| Windows | `<account-home>\AppData\Local\a2a-connectors\<provider>\` |

`<provider>` is exactly `codex`, `claude`, or `gemini`, fixed by the
provider-specific binary. Production accepts no state-path option, environment
override, alternate basename, discovered location, or path derived from A2A
or provider data. Tests may inject a private temporary root only through an
internal constructor absent from packaged runtime code.

The provider directory permits only these literal leaf names:

| Leaf | Purpose | `retire-state` behavior |
| --- | --- | --- |
| `owner.sqlite3` | Permanent provider-wide singleton database | Retain |
| `owner.sqlite3-journal` | SQLite rollback journal for owner initialization or recovery | Retain and let SQLite recover |
| `correlation.sqlite3` | Correlation database | Delete after retirement is durable |
| `correlation.sqlite3-wal` | Correlation WAL | Delete after the database is closed |
| `correlation.sqlite3-shm` | Correlation shared-memory index | Delete after the database is closed |
| `correlation.sqlite3-journal` | Rollback journal possible only during initial creation or recovery | Delete after the database is closed |
| `retired.v1` | Permanent content-free retirement tombstone | Retain permanently |

Set `temp_store=MEMORY`; do not use `ATTACH`, a super-journal, a disk-backed
temporary database, or another SQLite basename. Any other leaf, directory,
socket, pipe, device, link, backup, retired copy, or temporary name in the
provider directory makes startup and `retire-state` fail closed. The root may
contain the other two fixed provider directories; one provider command never
opens or deletes them.

There is one store and one singleton per provider and OS account. Changing the
working directory requires ADR 0028's explicit whole-provider `retire-state`.
Startup never creates a second store selected by a working-directory digest,
token, sender value, environment variable, or fallback root.

### Canonical working-directory scope

ADR 0028 alone validates and canonicalizes `--working-directory`. Pass the
exact canonical-directory UTF-8 bytes supplied by that contract into the state
component. On POSIX these are the exact `fs.realpath.native` result bytes; on
Windows they are the normalized real-path bytes with on-disk casing that ADR
0028 defines. The state component does not re-resolve the caller's spelling,
apply another case or separator rule, or impose a stricter cross-platform
comparison.

Those bytes are the canonical-working-directory scope for the process
lifetime. The store never contains the path. It contains only the keyed scope
fingerprint defined below. A provider, token, or canonical-directory mismatch
fails before wake acceptance, gateway MCP access, or provider work and never
creates an empty overlay.

### Exact KDF, indexes, and encryption

Validate the webhook token as exactly 48 lowercase ASCII hexadecimal
characters. Decode it to 24 bytes, require re-encoding to reproduce the input,
and pass those 24 bytes—not the hexadecimal text—to Node core `scrypt`.

For a new store, generate a random 16-byte salt. Derive exactly 64 bytes with:

```text
N      = 131072
r      = 8
p      = 1
keylen = 64
maxmem = 268435456 bytes
```

Use output bytes 0 through 31 only as the AES key and bytes 32 through 63 only
as the HMAC key. The 16-byte salt is public `store_meta` data. KDF parameters
are fixed schema constants, not mutable columns. Neither key nor the token is
passed to SQLite or persisted. Keep keys only for the foreground process and
zero their buffers on best-effort shutdown.

All cryptographic inputs use this one binary framing. `u32(x)` is an unsigned
four-byte big-endian integer. `field(x)` is `u32(byteLength(x)) || x`. `frame`
is:

```text
ASCII("A2A-CONNECTOR-STATE") || 0x00 || 0x01 || <one-byte-domain> ||
field(part-1) || ... || field(part-n)
```

The first byte after the NUL is both the schema and cryptographic format
version and is exactly `0x01`. The domains and parts are:

| Domain | Byte | Parts |
| --- | ---: | --- |
| Scope fingerprint | `0x01` | provider ASCII, canonical-directory UTF-8 |
| Conversation index | `0x02` | raw conversation-ID ASCII |
| Message index | `0x03` | raw message-ID ASCII |
| Provider-session index | `0x04` | raw provider-session UTF-8 |
| Provider-turn index | `0x05` | raw provider-session UTF-8, raw provider-turn UTF-8 |
| Conversation AAD | `0x11` | provider ASCII, canonical-directory UTF-8, conversation HMAC |
| Message AAD | `0x12` | provider ASCII, canonical-directory UTF-8, conversation HMAC, message HMAC |
| Provider-session AAD | `0x13` | provider ASCII, canonical-directory UTF-8, conversation HMAC, provider-session HMAC |
| Provider-turn AAD | `0x14` | provider ASCII, canonical-directory UTF-8, conversation HMAC, message HMAC, provider-session HMAC, provider-turn HMAC |

The scope fingerprint and equality indexes are full 32-byte HMAC-SHA-256
values over their complete frame. HMAC domains prevent cross-category
correlation. Including the session in the turn index avoids assuming provider
turn IDs are globally unique. Do not use an unkeyed digest or truncate an
index. Including every parent HMAC in child AAD prevents an authenticated
message, session, or turn envelope from being transplanted to another parent
row in the same valid store.

Encrypt every raw A2A conversation ID, A2A message ID, provider session or
thread ID, and provider turn ID separately with AES-256-GCM. Use a fresh
random 12-byte IV, the matching AAD frame above, and a 16-byte tag. Ciphertext
contains the exact unnormalized raw bytes and therefore has the same byte
length. A2A IDs retain ADR 0025's 1-to-128-byte URI-unreserved ASCII grammar.
Provider IDs are Unicode-scalar strings of 1 through 1,024 UTF-8 bytes. A
provider ADR may narrow but not widen that bound.

The provider-turn envelope is nullable. A qualified adapter whose provider has
a stable session but no stable per-turn ID may enter `turn_running`,
`waiting_for_approval`, `central_pending`, and completion states with all four
turn-envelope columns NULL. Live results remain usable, but after any crash
that execution is not exactly recoverable: it moves to `uncertain`, never calls
`start` or `resume` again, and cannot use the recovered-reply transition.

On every read, authenticate GCM, validate the raw grammar and bound, recompute
the HMAC index, and compare it in constant time before use. Authentication,
index, duplicate-correlation, or envelope-shape failure makes the whole store
unavailable. Errors never include a path, identifier, ciphertext, HMAC, salt,
token, or principal.

Changing the webhook token changes both keys. Changing provider or canonical
directory changes the scope fingerprint and AAD. Either change fails closed.
It does not authorize retirement, rekeying, row conversion, or replacement. The
only recovery is the original token and scope or ADR 0028's separately invoked
whole-provider retirement, which permanently blocks later startup.

This protects against accidental plaintext disclosure and a copied state file
without the webhook token. It does not protect against a same-user attacker
who can read the token or process memory, nor can it detect rollback or
deletion of an otherwise valid complete database without an external
monotonic store.

Encryption does not hide metadata. A reader of the artifacts can observe exact
ciphertext lengths, row and page counts, equality within each keyed-index
domain, provider kind, lifecycle and blocked classes, retry counters and
times, creation and update times, WAL growth, and filesystem access timing.
The store contains no message or reply body, but this length, count, timing,
and access-pattern leakage remains part of the approval decision.

### Exact SQLite constants and schema version 1

The correlation database uses these exact settings. Creation sets `page_size`
and `journal_mode=WAL` before schema objects. Immediately after every
connection opens and before it reads schema or rows, it sets the
connection-local or connection-effective values `synchronous=FULL`,
`foreign_keys=ON`, `trusted_schema=OFF`,
`temp_store=MEMORY`, `busy_timeout=1000`, `wal_autocheckpoint=256`,
`journal_size_limit=4194304`, and `max_page_count=65536`. It then reads back
and requires every value below, including persistent `application_id`,
`user_version`, `page_size`, and `journal_mode`. Failure to set or read back a
value closes the connection and fails closed; a pooled or reopened connection
never inherits another connection's validation.

```text
application_id       = 0x41324353  (ASCII "A2CS")
user_version         = 1
page_size            = 4096
journal_mode         = WAL
synchronous          = FULL
foreign_keys         = ON
trusted_schema       = OFF
temp_store           = MEMORY
busy_timeout         = 1000 milliseconds
wal_autocheckpoint   = 256 pages
journal_size_limit   = 4194304 bytes
max_page_count       = 65536 pages
```

No trigger or view is permitted. SQLite-owned autoindexes are allowed only
when implied by the following DDL. Validate the project-owned object names,
`PRAGMA table_xinfo`, foreign keys, indexes, and normalized DDL before reading
rows:

```sql
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
```

`store_meta` contains exactly one row with `singleton=1`. Unknown project
objects or columns, a missing object, mismatched pragma, invalid row,
`PRAGMA integrity_check` returning anything other than exactly one `ok` row,
or nonempty `PRAGMA foreign_key_check` is corruption. Do not repair, select a
subset, or open read-write after such a result.

### Quotas, timestamps, and WAL bounds

The store admits at most 100,000 lifetime conversation rows and at most two
message rows, including `blocked` rows and `closed` rows awaiting deletion. In
the same transaction that would insert a new conversation, use a bounded
indexed existence probe at offset 99,999 and reject before insertion when that
row exists. Use the corresponding offset-1 probe for messages. Do not run an
unbounded foreground count. Clean up a valid `closed` message before
considering message admission. Never evict an active, uncertain, blocked, or
closed conversation tombstone or an open message.

Conversation capacity applies only to a previously absent conversation. At
100,000 rows, already mapped `active` conversations may continue to admit their
next linear message, and an existing message may continue recovery or central
delivery-control work, subject to the two-message limit. A new conversation is
refused with only `connector_state_capacity` and starts no provider work. The
first release has no pruning, reuse, reset, or capacity-recovery operation.
`retire-state` is not recovery: it permanently retires this provider location.
Approval therefore accepts a lifetime ceiling of 100,000 retained active,
uncertain, blocked, and closed conversation rows.

With 4,096-byte pages and `max_page_count=65536`, the main database is limited
to 256 MiB. Require the page count to remain within that value at open and
after each write.

The WAL target is 4 MiB and the action-boundary hard limit is 16 MiB.
Autocheckpoint every 256 pages. After a write that leaves the WAL above 4 MiB,
run `wal_checkpoint(PASSIVE)` outside the transaction. If it remains above
16 MiB, run `wal_checkpoint(TRUNCATE)`. Do not accept a wake, call the gateway,
or call a provider while the WAL is above 16 MiB. Failure to reduce it below
that limit closes the store and fails the connector. A single short bounded
transaction may cross the limit transiently; no external side effect may occur
until the post-transaction check succeeds.

All stored times are nonnegative whole Unix epoch milliseconds no later than
`9999-12-31T23:59:59.999Z` (`253402300799999`). They come only from the
connector clock, never remote content. `created_at_ms` is immutable and
`updated_at_ms` changes on every committed lifecycle or retry transition. If
the current wall clock is earlier than any row's `updated_at_ms`, startup fails
closed before external work; a clock rollback never extends a deadline or
accelerates retry.

Before the first provider `start` or `resume`, atomically set
`turn_started_at_ms=now` and `turn_deadline_ms=now+900000`. That absolute
15-minute deadline never changes. Restart, `recover`, approval wait, retry,
or another wake does not grant another 15 minutes. At the deadline, apply ADR
0030's 10-second cancellation grace against the same turn, ending at the
absolute instant `turn_deadline_ms+10000`. Recovery may inspect the exact
existing turn but may not submit input, resume execution, or create a new
deadline.

### Exact lifecycle and transitions

No trigger mutates lifecycle. Every transition is one prepared `UPDATE ...
WHERE lifecycle=<expected>` followed by a row-count check inside a short
transaction. A zero or multirow result is corruption or a concurrency failure.
The only permitted message transitions are:

| From | To | Durable meaning |
| --- | --- | --- |
| insert | `received` | Correlation is durable; no provider call has begun |
| `received` | `binding` | A new provider session handshake is about to begin; absolute deadline is set |
| `received` | `turn_starting` | A mapped session exists and a new turn handshake is about to begin; absolute deadline is set |
| `received` | `central_pending` | A fixed pre-provider completion tuple is ready for central |
| `binding` | `turn_starting` | Session binding is encrypted and the conversation is `active` |
| `binding` | `central_pending` | The adapter gave positive evidence that provider work did not begin and an exact permitted pre-execution completion tuple is ready; never a reply |
| `turn_starting` | `central_pending` | Either the same proven pre-execution completion is ready, or the live no-turn branch returned one exact ADR 0030 reply or post-dispatch terminal result; the latter may be a reply and keeps the turn envelope null |
| `binding` | `uncertain` | A crash or invalid binding leaves provider activity unknowable |
| `turn_starting` | `turn_running` | Either the exact encrypted turn ID is durable, or the qualified adapter has declared that this provider supplies no per-turn ID and the session-only dispatch barrier is durable |
| `turn_starting` | `waiting_for_approval` | The live no-turn branch returned its first valid approval request; publish the wait with a null turn envelope before another pull |
| `turn_starting` | `uncertain` | A turn may have started without a durable exact handle |
| `turn_running` | `waiting_for_approval` | The current provider execution is open at a provider-native approval wait |
| `waiting_for_approval` | `turn_running` | The same provider execution resumed after an approved provider-native decision |
| `turn_running` or `waiting_for_approval` | `central_pending` | An exact valid live reply or fixed completion tuple is ready; the turn envelope may be absent |
| `turn_running` or `waiting_for_approval` | `uncertain` | Exact result cannot be recovered and no replay is permitted |
| `uncertain` | `central_pending` | Either exact-turn recovery returned the exact prior valid terminal reply or completion from the same authenticated non-null turn, or provider survival is disproved and the fixed `complete/uncertain/provider_outcome_unknown` tuple is ready |
| `central_pending` with `reply` | `uncertain` | Outcome lookup proved `open`, the in-memory reply is unavailable, and exact-turn recovery could not recover it; clear the terminal and retry plan |
| `central_pending` | `ack_pending` | Central outcome lookup or exact response proves one terminal result |
| Any state other than `blocked` or `closed` | `blocked` | One reviewed permanent application, authentication, contract, or cleanup stop was durably classified; clear the retry schedule and make no automatic request |
| `ack_pending` | `closed` | Exact `acked` result was observed |
| `closed` | delete | Remove the message row in a later short transaction |

An unchanged lifecycle may update only the retry triple under ADR 0030's exact
schedule. It may not change an identifier, correlation, terminal tuple, turn
deadline, blocked class, or prior timestamp. The sole terminal-plan exception
is the `central_pending(reply) -> uncertain` transition above. It is permitted
only after an authenticated `get_message_outcome` result proves the message is
still `open`, the process no longer has the exact reply bytes, and recovery of
the same authenticated non-null provider turn ID cannot reproduce the exact
prior terminal reply. In that transaction set `terminal_operation`,
`completion_outcome`, `completion_reason`, `retry_kind`, and
`retry_not_before_ms` to NULL; preserve the lifetime attempt count and absolute
turn deadline. It never follows an uncertain outcome lookup.

The reverse `uncertain -> central_pending` transition requires authenticated
recovery of the same encrypted provider session and non-null provider turn ID
already bound to the row, and one exact valid terminal result from that turn.
An exact reply sets only the reply terminal plan. An exact completion sets only
the matching permitted completion tuple. In either case the conversation stays
`uncertain` until central accepts and acknowledges the result. Session-only
lookup, a new turn, regenerated text, or a provider result that cannot be bound
to the exact turn cannot take this transition.

A repeated raw ID must decrypt to the same bytes and correlation. An HMAC
collision with different decrypted bytes is corruption.

`blocked_class` is content-free and has only these meanings:

| Value | Durable stop |
| --- | --- |
| `permanent_application` | An ADR 0030 permanent central application result |
| `authentication` | A local gateway authentication result or central DPoP, credential, or key failure surfaced through the gateway |
| `contract` | An unknown, malformed, mismatched, or otherwise invalid gateway contract result |
| `cleanup` | Required provider containment or cleanup could not be proved |

The transition to `blocked` preserves identifiers, any terminal tuple, the
lifetime attempt count, and the absolute turn deadline, clears
`retry_kind`/`retry_not_before_ms`, and sets exactly one class. A valid blocked
row causes startup to make no provider or central request for that row and stop
with only `connector_message_blocked`. There is no automatic unblock, retry,
credential recovery, row deletion, or reset. A failure that prevents the store
itself from being updated is a store failure, not a fabricated blocked row. A
failure before strict content retrieval has supplied a validated conversation
and message pair also inserts no guessed blocked row; it stops before provider
work under ADR 0030's fixed pre-admission error contract.

`retry_attempt_count` is ADR 0030's one lifetime central-request count for the
message, not a per-operation or per-restart count. It starts at zero, increments
atomically immediately before every central request, and saturates at 255 using
`min(previous + 1, 255)`; it never wraps, resets, or decreases. Changing
`retry_kind`, a successful intermediate result, an `open` outcome, a wake, or a
restart preserves the count. A non-null `retry_not_before_ms` is the absolute
earliest next request time and therefore requires a non-null `retry_kind` and a
count of at least one. A pending first request may have a non-null `retry_kind`
and null `retry_not_before_ms` after its durable pre-dispatch increment.

Conversation transitions are only `insert -> binding`, `binding -> active`,
`binding|active -> uncertain`, `binding|active|uncertain -> closed`, and
`uncertain -> active` after central accepts and acknowledges an exactly
recovered reply for the original message. `closed` is terminal and retains the
encrypted conversation ID and any encrypted session mapping as a permanent
local tombstone. A successful reply otherwise leaves an `active` conversation
unchanged. Acceptance of any `complete_message` outcome closes the linear
conversation because ADR 0025 permits no later append after a no-reply terminal
outcome. A pre-provider completion may close a `binding` conversation without a
provider session. An uncertain provider result first marks the conversation
`uncertain`; central acceptance of that completion changes it to `closed`.

Every operation that changes a message and its conversation is one SQLite
transaction. It first performs indexed reads of both HMAC keys and requires one
exact allowed old pair. Each `UPDATE` names both the HMAC key and expected old
lifecycle, and each changed row count must be one. Before commit, read the pair
again and require one exact allowed new pair. A missing, additional, stale, or
disallowed row rolls back the whole transaction. No provider or gateway call,
cryptographic operation, or filesystem operation occurs between those reads
and commit. A transition that leaves the conversation lifecycle unchanged
still validates that conversation in the same transaction.

The only valid message/conversation pairs are:

| Message state and terminal plan | Conversation lifecycle |
| --- | --- |
| `received` | `binding` for a new conversation; `active` for a mapped continuation |
| `binding` | `binding` |
| `turn_starting`, `turn_running`, or `waiting_for_approval` | `active` |
| `uncertain` | `uncertain` |
| `central_pending(reply)` | `active` or `uncertain` |
| `central_pending(complete)` | `binding`, `active`, or `uncertain` |
| `ack_pending(reply)` | `active` or `uncertain` |
| `ack_pending(complete)` | `closed` |
| `blocked` with no terminal plan | `binding`, `active`, or `uncertain` |
| `blocked` with `reply` | `active` or `uncertain` |
| `blocked` with `complete` | `binding`, `active`, `uncertain`, or `closed` |
| `closed(reply)` | `active` |
| `closed(complete)` | `closed` |

Startup validates this join for every message before recovery. A `binding` or
`uncertain` conversation must have its one matching message. An `active`
conversation may have zero or one message between turns. A `closed`
conversation may have zero messages or one completion message in
`ack_pending`, valid `blocked(complete)`, or acknowledged `closed` state.
No conversation may have more than one message row in any lifecycle. A
non-null provider-turn envelope, or any reply terminal plan, also requires a
non-null authenticated provider-session envelope on the parent conversation;
all parent HMACs used by AAD must match that joined row.

Admission also uses one transaction. An absent conversation is inserted as
`binding` together with its `received` message only when the strict inbound
message has `in_reply_to_message_id: null` and the new-conversation quota has
room. An absent conversation with a non-null predecessor is not recreated. An
existing `active` conversation with no message accepts one continuation only
when the predecessor is non-null. An existing `binding`, `uncertain`, or
`closed` conversation never accepts a different message. A repeated wake may
address only the exact already stored message ID after authenticated decryption
and comparison. Every other case starts no provider work, inserts no row, and
returns only `connector_conversation_unavailable`. The predecessor check is
defense in depth; the retained keyed `closed` conversation tombstone is the
authority that prevents an acknowledged conversation from becoming a new
first turn after central or local replay.

The `ack_pending -> closed` transaction records exact acknowledgement and makes
the paired conversation `closed` for a completion, or `active` for a reply,
including an exactly recovered reply from an `uncertain` conversation. Delete
the `closed` message only in a later transaction. A crash therefore leaves a
durable content-free acknowledged row that startup may delete safely. Message
rows are never deleted before exact acknowledgement. Conversation rows,
including `closed` tombstones, never expire or delete during normal operation;
only whole-provider `retire-state` removes them and permanently retires the
location.

### Active-work crash recovery

After the singleton and state validation, inspect every non-`closed` message
before accepting a wake. Recovery is fixed by durable lifecycle:

- `received`: no provider call began. Wait for gateway redelivery of the body,
  then perform the one allowed initial transition.
- `binding`: after a process crash, do not call `start` or `resume`. No durable
  provider session exists. Positive provider-specific evidence that no work
  began permits only the exact reviewed pre-execution completion; otherwise
  mark message and conversation `uncertain`. Neither result permits a later
  dispatch.
- `turn_starting`: do not call `start` or `resume`. When the parent has its
  authenticated session mapping and the provider ADR proves a non-creating,
  unambiguous session-only lookup of the one prior turn, call only
  `recover(..., provider_turn_id:null)`. Its first event must bind that exact
  prior turn before output; atomically publish the turn and enter
  `turn_running`. Without that proof, positive evidence that no work began
  permits only the reviewed pre-execution completion; otherwise mark the
  message and conversation `uncertain`.
- `turn_running` or `waiting_for_approval`: with a non-null authenticated turn
  envelope, call only `recover` for that exact encrypted session and turn and
  continue observing it only within the original absolute deadline. With a
  null turn envelope, make no recovery call: the provider execution is not
  exactly recoverable, so atomically move the message and conversation to
  `uncertain`. Neither path submits input or calls `start` or `resume` again.
- `central_pending`: call `get_message_outcome` first. A terminal result moves
  to `ack_pending`. An open result permits the same completion tuple, or the
  same reply only after exact-turn `recover` returns the exact prior terminal
  response. If the outcome is exactly open and that reply cannot be recovered,
  take the gated `central_pending(reply) -> uncertain` transition above before
  considering the fixed uncertain completion.
- `ack_pending`: repeat only idempotent `ack_message` until the exact `acked`
  result is observed. It never changes to outcome lookup; an impossible
  `message_not_terminal` result follows ADR 0030's blocked contract path.
- `uncertain`: start no provider work. Move to the fixed uncertain completion
  only after the adapter or platform containment proves that no old provider
  process can still act. Alternatively, tightly gated recovery of the same
  authenticated non-null provider turn may publish that turn's exact valid
  reply or completion plan. It cannot publish a result from session-only lookup
  or another turn.
- `blocked`: make no provider or central request and stop with only
  `connector_message_blocked`.
- `closed`: delete the acknowledged message row before admitting new work;
  retain its conversation tombstone.

If an old provider process may have survived the connector crash and cannot be
contained or proven stopped, atomically mark the valid message `blocked` with
class `cleanup`, leave it unacknowledged, make no central terminal call, and
stop with ADR 0030's `connector_provider_cleanup_incomplete`. A later startup
observes the valid blocked row and stops with `connector_message_blocked`.
State alone is not proof that a process stopped. Provider-specific ADRs must
prove exact-turn recovery and process-survival behavior before an adapter
qualifies.

### Exact owner database and singleton

`owner.sqlite3` is a separate content-free SQLite database with:

```text
application_id     = 0x4132434f  (ASCII "A2CO")
user_version       = 1
page_size          = 4096
journal_mode       = DELETE
synchronous        = FULL
trusted_schema     = OFF
temp_store         = MEMORY
busy_timeout       = 1000 milliseconds
max_page_count     = 64 pages
journal_size_limit = 65536 bytes
```

Creation sets `page_size` and `journal_mode=DELETE` before the owner schema.
Immediately after every owner connection opens, set
`synchronous=FULL`, `trusted_schema=OFF`, `temp_store=MEMORY`,
`busy_timeout=1000`, `max_page_count=64`, and
`journal_size_limit=65536`, then read them back. Also read back and require the
persistent `application_id`, `user_version`, `page_size`, and `journal_mode`
before reading owner rows. A reopened owner connection repeats this sequence.

Its complete schema and data are:

```sql
CREATE TABLE owner_guard (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  ever_initialized INTEGER NOT NULL CHECK (ever_initialized IN (0, 1))
) STRICT;
INSERT INTO owner_guard(singleton, ever_initialized) VALUES (1, 0);
```

It contains no provider value, token, scope, timestamp, process ID, hostname,
or correlation data. `ever_initialized` is only a deletion/rollback tripwire;
it is not an identity, generation, retry count, or permission. Create and
validate the owner before resolving the webhook token. Acquire `BEGIN
EXCLUSIVE` with ADR 0014's one-second busy timeout and normally hold that
transaction and connection for the process lifetime. The correlation database
uses a different connection and short transactions. The owner rollback journal
is part of the literal file set and is recovered only by SQLite. Owner
corruption blocks both `start` and `retire-state`; neither may replace it while
another owner could exist.

The first correlation-store creation uses this one fail-closed ceremony:

1. Under the exclusive owner transaction, require `ever_initialized=0`, no
   correlation leaf, and no retirement marker. A zero flag with any correlation
   leaf is corruption.
2. Set `ever_initialized=1` and commit with `synchronous=FULL` before creating
   any correlation leaf. Sync `owner.sqlite3` and the provider directory on
   POSIX, or use the platform-qualified Windows durability sequence.
3. Reacquire `BEGIN EXCLUSIVE` within one second, revalidate the complete leaf
   set, the one flag, and absence of `retired.v1`, and only then use the same
   process's one-shot initialization authority to create the correlation
   database. Another process that observes the committed one flag and missing
   database has no such authority and fails closed.
4. Commit the correlation schema and `store_meta`, apply the same file and
   directory durability checks, validate the complete store, and only then
   proceed to webhook binding or external work. Keep the reacquired exclusive
   owner transaction for the remaining process lifetime.

A crash after step 2 intentionally leaves `ever_initialized=1` without a
correlation database. On every later startup, a one flag plus missing
`correlation.sqlite3` and no valid `retired.v1` is `connector_state_unavailable`;
startup never recreates the store. A one flag plus a partial or corrupt
correlation artifact also fails closed. A valid retirement marker continues to
block `start` and permits only ADR 0028's idempotent retirement cleanup.

This tripwire detects removal of the correlation database while the permanent
owner survives. It cannot detect a same-user attacker or external restore that
rolls both valid owner and correlation artifacts back to one earlier mutually
consistent snapshot. Such a rollback can restore old lifecycle state and is
outside this proposal's no-replay guarantee without an external monotonic
anchor. Accepting that residual rollback risk is an explicit approval item.

### Filesystem checks and implementable threat model

Create project-owned directories one component at a time. On POSIX require the
current effective UID, mode `0700` on connector directories, mode `0600` on
regular artifacts, no project-owned symlink, and `nlink=1` on every regular
artifact. On Windows remove inheritance and require a protected DACL granting
only the current user SID and `SYSTEM`; reject reparse points, unexpected
owners, and unexpected hard links. Database, WAL, SHM, owner journal, and
retirement marker share the same checks.

Before each open, create, or delete, use `lstat` on every project-owned path
component and leaf, require the canonical provider directory to remain below
the canonical account home using a relative-path check that also rejects an
absolute result, and repeat leaf type, owner, mode or DACL, and link checks
immediately afterward. An existing leaf is never followed deliberately. An
exclusive POSIX marker open uses `O_CREAT|O_EXCL|O_NOFOLLOW`; platforms without
that primitive must prove an equivalent or remain unsupported.

`better-sqlite3` accepts a pathname rather than an already verified file
descriptor. These checks therefore defend against accidents, inherited weak
permissions, pre-positioned links, and mutation by another account that lacks
write access to the private directory. They do not claim race resistance
against a malicious same-user process that can rewrite the directory between
checks. Such a process can also read the webhook token and process memory and
is outside the at-rest threat model. Qualification must test the stated checks;
it must not describe them as a no-follow SQLite open.

If a platform cannot set and verify the exact permissions, DACL, reparse,
hard-link, identity, and retirement behavior, that connector platform remains
unsupported. It must not silently weaken the checks.

### Permanent tombstone and whole-provider retirement

The final `retired.v1` contains exactly these 28 ASCII bytes and no other byte:

```text
a2a-connector-retirement-v1\n
```

It has no timestamp, provider, path, token, identity, or identifier. `start`
always refuses while the marker exists, including when every correlation
database artifact is already gone. An exact marker is a permanent retired
state, not a cleanup-in-progress flag. A nonexact marker is
`connector_state_unavailable` for `start` and never permits initialization.

ADR 0028's `retire-state` first validates its exact arguments and the
account-derived root. It preflights every existing provider-directory and
owner-database component, the literal leaf set, types, ownership, permissions
or DACLs, and links. For a location at which no state has ever existed, it
creates the missing connector root, provider directory, and owner database
with their final protections, then acquires the permanent owner lock.
Otherwise it validates and acquires the existing owner lock. It closes any
correlation connection. The command does not resolve a webhook token or a
working directory.

Retirement always follows this exact crash-safe sequence, even when no
correlation database artifact exists:

1. If no marker exists, create it exclusively with its final permissions,
   write the exact 28 bytes, sync the file, and on POSIX sync the provider
   directory before deleting anything. If a protected regular marker with the
   exact final owner, permissions or DACL, link count, and no reparse or
   symbolic-link property contains from zero through 27 bytes that are an exact
   prefix of the final bytes, `retire-state` treats it only as an interrupted
   marker publication. While holding the owner lock, it revalidates the leaf,
   truncates it, writes all 28 final bytes, syncs the file, syncs the provider
   directory on POSIX or applies the qualified Windows equivalent, and
   revalidates the exact final marker before deletion. A valid marker resumes
   interrupted deletion. Any other nonexact marker refuses `retire-state`
   without deletion. `start` never repairs any marker.
2. Revalidate each present correlation leaf immediately before unlinking it.
   Delete only, and in this order,
   `correlation.sqlite3-shm`, `correlation.sqlite3-wal`,
   `correlation.sqlite3-journal`, then `correlation.sqlite3`.
3. On POSIX, sync the provider directory. On Windows, flush each opened file
   before close and require the platform deletion sequence to pass its abrupt
   process and power-interruption qualification; Windows remains unsupported
   if equivalent metadata durability cannot be demonstrated. If any deletion
   or sync is failed or uncertain, retain the marker, write no success stdout,
   and report `connector_state_retire_refused` with exit `7`. A later `start`
   remains blocked and a later `retire-state` resumes.

ADR 0033 defers the complete Windows state path for the initial release.
Satisfying this durability condition alone does not restore support; a new
approved plan, the complete native qualification, and restored CI are also
required.

4. Revalidate `retired.v1`, sync the provider directory on POSIX or apply the
   same qualified Windows flush sequence, and retain `retired.v1` and
   `owner.sqlite3` permanently. SQLite alone creates, recovers, and removes
   `owner.sqlite3-journal` as needed.

The marker converts every partial deletion into a fail-closed retired state;
startup never interprets missing database pieces as a fresh install. No glob,
recursive deletion, caller path, partial conversation deletion, repair,
migration, import, or automatic reset is permitted. Deletion never touches the
gateway, central service, project files, provider credentials, or
provider-native history and makes no secure-erasure claim.

`retire-state` is idempotent: when the exact valid marker already exists, it
revalidates the literal set and completes any remaining allowlisted correlation
artifact deletion without replacing or removing the marker. The provider
location is never reused and the marker is never deleted. A future, separately
approved design could allocate a different location only after proving that the
paired gateway has a newly enrolled central identity; it must preserve this
marker and cannot reinterpret the retired location. No such operation exists
in the first connector release.

### Corruption and retention

Validate filesystem protections, owner schema, correlation pragmas and schema,
`integrity_check`, foreign keys, quotas, scope, and every row required for
recovery before the corresponding work. Any detected invalid state makes the
whole store unavailable. Do not quarantine a row, rename the database aside,
import readable rows, recreate over artifacts, or fall back to memory-only
mapping.

Retain unacknowledged, blocked, and uncertain message rows indefinitely. Delete
a message only after its durable `closed` transition proves the exact central
acknowledgement. Retain every conversation row indefinitely, including active
mappings and uncertain or closed tombstones. Acknowledgement deletes no
conversation row. Only the explicit whole-provider `retire-state` sequence
removes them and permanently retires the location.

### Required acceptance cases

These cases use the exact DDL above, real transactions, deterministic clocks,
and abrupt process barriers. Their implementation remains ordered behind G04
and K01.

| ID | Case | Required result |
| --- | --- | --- |
| S01 | Insert terminal tuples with a null operation plus an outcome or reason, `reply` plus either completion field, `complete` plus a null field, and every mismatched outcome/reason pair | Reject every insert with a constraint failure; no nullable expression may pass as SQL NULL |
| S02 | Insert `received` with a retry, nonzero attempt count, deadline, turn envelope, terminal plan, or blocked class; insert `blocked` without a valid class; attach a blocked class to another lifecycle | Reject every invalid shape and leave both tables unchanged |
| S03 | Insert each valid no-terminal, reply, completion, blocked, retry, deadline, and null-turn boundary tuple | Accept only the documented lifecycle shapes, including running, approval, reply, and completion rows with no provider-turn envelope |
| S04 | Transplant an authenticated message envelope to another conversation, a session envelope to another conversation, or a turn envelope to another message or session | GCM authentication fails because child AAD includes every parent HMAC |
| S05 | Crash before either row update, between message and conversation updates, and before commit for every paired transition | Roll back to the complete old pair or commit the complete new pair; startup accepts no mixed pair |
| S06 | Present every message/conversation lifecycle combination outside the allowed-pair table | Fail startup before webhook binding, provider recovery, or a central request |
| S07 | Deliver a different message while a conversation is `binding`, `uncertain`, `blocked`, or `closed`; then present a non-null predecessor for an absent conversation | Insert no row, start no provider operation, and return only `connector_conversation_unavailable` |
| S08 | Crash after acknowledgement, after the message becomes `closed`, and after message deletion | Delete only the acknowledged message on recovery; retain the active mapping or closed conversation tombstone exactly once |
| S09 | Crash before and after `ever_initialized=1` commits and before and after correlation creation | Recreate only before the flag commit; after it, missing or partial correlation state fails closed and never initializes again |
| S10 | Restore only correlation artifacts, then restore owner and correlation to an older mutually valid snapshot | Detect inconsistent presence with the owner flag; document that a mutually consistent rollback is not detected or covered by the no-replay claim |
| S11 | Reach 100,000 conversations, then deliver a new conversation and a continuation for an existing active mapping | Refuse only the new conversation with `connector_state_capacity`; allow the mapped continuation subject to message capacity |
| S12 | Place the account home on each claimed local filesystem and on a network or unproven filesystem | Qualify only proven local filesystems; create or open no state on the rejected cases |
| S13 | Crash after creating `retired.v1`, after every partial-prefix write length, after final write, after file sync, after directory sync, and after each allowlisted deletion | `start` always fails closed; confirmed `retire-state` finishes an exact protected prefix to the final 28 bytes, resumes deletion, and returns success only after all required syncs complete |

## Dependency, license, packaging, and platform impact

This accepted record adds no package version and no ORM. It extends the already
pinned `better-sqlite3` 13.0.3 and
`@types/better-sqlite3` 9.6.0 to connector state. Both packages use MIT;
SQLite is public domain. AES-GCM, HMAC, random generation, constant-time
comparison, scrypt, filesystem checks, and account lookup use Node core and
add no license or package dependency.

The extension carries ADR 0007's native-binary obligation into every connector
artifact containing the store. Each claimed platform must load the exact
native package and pass clean-install, account-root, permissions or DACL,
link, WAL and SHM, singleton, schema, quota, corruption, token-change,
scope-change, absolute-deadline, active-crash, retirement-resume, and artifact
scan tests. A passing gateway SQLite job is not connector evidence.

This record does not approve package layout, distribution tooling,
installation, publication, or a platform support claim.

## Alternatives

- **Keep all correlation in memory.** Rejected because restart would lose the
  conversation-to-session mapping and could create a new session or blind
  replay.
- **Put provider correlation in the gateway journal.** Rejected because it
  violates ADRs 0007, 0017, and 0024 and makes the gateway provider-aware.
- **Store opaque IDs as plaintext SQLite values.** Rejected because copied
  state, WAL, SHM, and backups would expose sensitive local session metadata.
- **Use unkeyed digests as indexes.** Rejected because likely or leaked IDs
  could be tested offline and equal values would correlate across categories.
- **Encrypt the whole database with SQLCipher.** Rejected because it adds an
  unapproved native dependency and does not remove schema, locking, crash, or
  deletion work.
- **Use JSON, an append-only file, or one encrypted file per mapping.**
  Rejected because the connector would have to recreate transactions,
  uniqueness, locking, recovery, and relational consistency.
- **Use an operating-system credential vault for every identifier.** Deferred
  because it needs three platform implementations and does not naturally
  provide transactional correlation and lifecycle indexes. A future
  vault-backed wrapping key requires a new ADR and fresh-install decision.
- **Treat provider-native history as the correlation store.** Rejected because
  it couples common recovery to provider discovery, may scan content-bearing
  history, and cannot prove central message lifecycle.
- **Store the working directory.** Rejected because the path is sensitive
  local metadata; authenticated AAD and a keyed fingerprint are sufficient.

## Costs and risks

Per-identifier encryption, exact transitions, checkpoints, and validations add
code and startup work. Indefinite active, uncertain, blocked, and closed
conversation retention can exhaust the 100,000-row lifetime quota. At that
point existing mappings continue but no new conversation can be admitted. The
first release has no reset or reclamation path; `retire-state` permanently
retires the location rather than recovering capacity.

SQLite WAL and native binaries require platform-specific tests. The webhook
token is an existing root secret, not hardware-backed custody; losing or
changing it makes state unreadable, and possession defeats the at-rest
separation. Same-user filesystem races and valid database rollback remain
outside what this local encrypted store can detect. The encrypted store also
exposes the length, count, timing, lifecycle, and access-pattern metadata
listed above.

## Approval

Approved by the user on 2026-08-30. This approval explicitly extends ADR
0007's `better-sqlite3` scope to connector correlation state and accepts the
account-derived location, literal file set, 100,000-row lifetime ceiling,
256 MiB database bound, cryptographic encoding and metadata leakage, access
control, network-home exclusion, locking, crash and paired-rollback limits,
retirement, indefinite tombstone retention, dependency, license, packaging,
and platform impact.

The accepted design is fresh-install-only and adds no migration. Public
publication and provider or platform support claims remain behind ADR 0031's
qualification gates. The conversation-oriented schema must be replaced or
amended as part of the pending permission and action workflow redesign.
