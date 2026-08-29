from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import struct
from collections.abc import Awaitable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Annotated, Literal, TypeVar
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from uuid import uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)
from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.exceptions import RequestValidationError
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
    model_validator,
)
from starlette.responses import JSONResponse


Username = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=3,
        max_length=50,
    ),
]
DisplayName = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=128),
]
Email = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        to_lower=True,
        min_length=3,
        max_length=254,
        pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$",
    ),
]
AgentId = Annotated[
    str,
    StringConstraints(
        strict=True,
        pattern=r"^(?:agent_[a-f0-9]{32}|agent_fixture_[0-9]{4})$",
    ),
]
MessageId = Annotated[
    str,
    StringConstraints(
        strict=True,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9._~-]+$",
    ),
]
PermissionId = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^permission_[a-f0-9]{32}$"),
]
ActionId = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^action_[a-f0-9]{32}$"),
]
Token = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4096)]
VerificationCode = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^[0-9]{6}$"),
]
Content = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=32_768)]
ActionType = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=1024),
]


FIXTURE_ISSUER = "urn:a2a:fixture:issuer:v2"
FIXTURE_API_AUDIENCE = "urn:a2a:fixture:resource:api:v2"
FIXTURE_MCP_AUDIENCE = "urn:a2a:fixture:resource:mcp:v2"
FIXTURE_CLOCK_START = 1_788_000_000
FIXTURE_V2_CODE = "123456"
UUID_V4_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
URI_ID_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{1,128}$")
BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
UNRESERVED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
)


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64url_decode(value: str, *, exact_length: int | None = None) -> bytes:
    if not value or "=" in value or BASE64URL_PATTERN.fullmatch(value) is None:
        raise ValueError("invalid base64url")
    try:
        decoded = base64.b64decode(
            value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("invalid base64url") from error
    if b64url_encode(decoded) != value:
        raise ValueError("non-canonical base64url")
    if exact_length is not None and len(decoded) != exact_length:
        raise ValueError("invalid decoded length")
    return decoded


def json_without_duplicates(value: bytes) -> object:
    def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate JSON member")
            result[key] = item
        return result

    try:
        text = value.decode("utf-8", errors="strict")
        parsed = json.loads(
            text,
            object_pairs_hook=unique_object,
            parse_constant=lambda _constant: (_ for _ in ()).throw(
                ValueError("non-finite number")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid JSON") from error
    return parsed


def compact_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _normalize_percent_encoding(path: str) -> str:
    def replace(match: re.Match[str]) -> str:
        octet = int(match.group(0)[1:], 16)
        character = chr(octet)
        if character in UNRESERVED:
            return character
        return f"%{octet:02X}"

    invalid = re.search(r"%(?![0-9A-Fa-f]{2})", path)
    if invalid is not None:
        raise ValueError("invalid percent encoding")
    return re.sub(r"%[0-9A-Fa-f]{2}", replace, path)


def _remove_dot_segments(path: str) -> str:
    absolute = path.startswith("/")
    trailing = path.endswith("/") or path.endswith("/.") or path.endswith("/..")
    output: list[str] = []
    for segment in path.split("/"):
        if segment == ".":
            continue
        if segment == "..":
            if output and output[-1] not in ("", ".."):
                output.pop()
            continue
        output.append(segment)
    normalized = "/".join(output)
    if absolute and not normalized.startswith("/"):
        normalized = f"/{normalized}"
    if trailing and not normalized.endswith("/"):
        normalized = f"{normalized}/"
    return normalized or "/"


def normalize_htu(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError("invalid URI scheme")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URI credentials are forbidden")
    if parsed.query:
        raise ValueError("URI query is forbidden")
    if parsed.fragment:
        raise ValueError("URI fragment is forbidden")
    host = parsed.hostname
    if host is None:
        raise ValueError("URI host is required")
    scheme = parsed.scheme.lower()
    port = parsed.port
    if ":" in host:
        authority = f"[{host.lower()}]"
    else:
        authority = host.lower()
    if port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    ):
        authority = f"{authority}:{port}"
    path = _remove_dot_segments(_normalize_percent_encoding(parsed.path or "/"))
    return urlunsplit((scheme, authority, path, "", ""))


def request_external_htu(request: Request) -> str:
    raw_path = request.scope.get("raw_path")
    if not isinstance(raw_path, bytes):
        raise ValueError("raw request path is unavailable")
    try:
        encoded_path = raw_path.decode("ascii", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError("raw request path is not ASCII") from error
    base = urlsplit(str(request.base_url))
    origin = urlunsplit((base.scheme, base.netloc, "", "", ""))
    return normalize_htu(f"{origin}{encoded_path}")


def fixture_timestamp(numeric_date: int) -> str:
    return datetime.fromtimestamp(numeric_date, tz=UTC).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, validate_assignment=True)


class AgentRecord(StrictModel):
    agent_id: AgentId
    username: Username
    display_name: DisplayName | None = None
    email: Email
    verified: bool = False
    token: SecretStr | None = None


class VerificationRecord(StrictModel):
    agent_id: AgentId
    code: SecretStr


class MessageRecord(StrictModel):
    id: MessageId
    recipient_agent_id: AgentId
    sender_agent_id: str
    kind: Literal["message", "permission", "action"]
    content: Content
    status: Literal["queued", "delivered", "acked"] = "queued"


class PermissionRecord(StrictModel):
    permission_id: PermissionId
    requester_agent_id: AgentId
    target_agent_id: AgentId
    action_type: ActionType
    scope: dict[str, object] | None = None
    status: Literal["pending", "granted", "denied"] = "pending"


class ActionRecord(StrictModel):
    action_id: ActionId
    caller_agent_id: AgentId
    target_agent_id: AgentId
    action_type: ActionType
    payload: dict[str, object]
    status: Literal["queued"] = "queued"


class RegistrationResponse(StrictModel):
    agent_id: AgentId
    username: Username
    email: Email
    message: str


class VerificationResponse(StrictModel):
    agent_id: AgentId
    username: Username
    token: Token
    message: str


class StatusResponse(StrictModel):
    status: Literal["ok"] = "ok"


class MessageIdResponse(StrictModel):
    id: MessageId


class AcknowledgementResponse(StrictModel):
    message_id: MessageId
    status: Literal["acked"] = "acked"


class ContentMessage(StrictModel):
    id: MessageId
    sender_agent_id: str
    kind: Literal["message", "permission", "action"]
    content: Content


class ContentPollResponse(StrictModel):
    messages: list[ContentMessage]


class ActionTypesResponse(StrictModel):
    action_types: list[ActionType]


class PermissionResponse(StrictModel):
    permission_id: PermissionId
    status: Literal["pending", "granted", "denied"]


class PermissionSummary(StrictModel):
    permission_id: PermissionId
    target_username: Username
    action_type: ActionType
    scope: dict[str, object] | None = None
    status: Literal["pending", "granted", "denied"]


class PermissionsResponse(StrictModel):
    permissions: list[PermissionSummary]


class ActionResponse(StrictModel):
    action_id: ActionId
    status: Literal["queued"] = "queued"


class AckMessageRequest(StrictModel):
    message_id: MessageId


class VerificationCodeRequest(StrictModel):
    email: Email


class VerificationCodeResponse(StrictModel):
    code: VerificationCode


class InjectMessageRequest(StrictModel):
    recipient_agent_id: AgentId
    sender_agent_id: Annotated[
        str,
        StringConstraints(strict=True, min_length=1, max_length=128),
    ] = "test_sender"
    kind: Literal["message", "permission", "action"] = "message"
    content: Content
    message_id: MessageId | None = None


class InspectRequest(StrictModel):
    agent_id: AgentId | None = None
    message_id: MessageId | None = None


class AgentInspection(StrictModel):
    agent_id: AgentId
    verified: bool


class MessageInspection(StrictModel):
    id: MessageId
    recipient_agent_id: AgentId
    status: Literal["queued", "delivered", "acked"]


class PermissionInspection(StrictModel):
    permission_id: PermissionId
    status: Literal["pending", "granted", "denied"]


class ActionInspection(StrictModel):
    action_id: ActionId
    status: Literal["queued"]


class InspectionResponse(StrictModel):
    agents: list[AgentInspection]
    messages: list[MessageInspection]
    permissions: list[PermissionInspection]
    actions: list[ActionInspection]


def validate_v2_email(value: str) -> str:
    if (
        len(value) < 3
        or len(value) > 254
        or len(value.encode("utf-8")) > 254
        or value != value.strip()
        or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) is None
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid email")
    return value


def validate_v2_username(value: str) -> str:
    if (
        len(value) < 3
        or len(value) > 50
        or len(value.encode("utf-8")) > 200
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid username")
    return value


def validate_display_name(value: str) -> str:
    if (
        len(value) < 1
        or len(value) > 128
        or len(value.encode("utf-8")) > 512
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ValueError("invalid display name")
    return value


def validate_text(value: str) -> str:
    if not value or len(value.encode("utf-8")) > 262_144:
        raise ValueError("invalid message text")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("invalid message text")
    return value


class RestRegistrationRequest(StrictModel):
    email: str
    username: str
    display_name: str | None = None

    _email = field_validator("email")(validate_v2_email)
    _username = field_validator("username")(validate_v2_username)
    _display_name = field_validator("display_name")(lambda value: (
        None if value is None else validate_display_name(value)
    ))

    @model_validator(mode="before")
    @classmethod
    def reject_explicit_null_display_name(cls, value: object) -> object:
        if isinstance(value, dict) and value.get("display_name", ...) is None:
            raise ValueError("display name cannot be null")
        return value


class RestVerificationRequest(StrictModel):
    email: str
    code: str

    _email = field_validator("email")(validate_v2_email)

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if re.fullmatch(r"[A-Za-z0-9]{6}", value) is None:
            raise ValueError("invalid verification code")
        return value


class RestResendRequest(StrictModel):
    email: str

    _email = field_validator("email")(validate_v2_email)


class TextPayload(StrictModel):
    text: str

    _text = field_validator("text")(validate_text)


class ConversationStartRequest(StrictModel):
    recipient_username: str
    payload: TextPayload

    _recipient = field_validator("recipient_username")(validate_v2_username)


class ReplyRequest(StrictModel):
    payload: TextPayload


class CompletionRequest(StrictModel):
    outcome: Literal[
        "completed_without_reply",
        "unsupported",
        "failed",
        "cancelled",
        "uncertain",
    ]
    reason_code: Literal[
        "no_reply_required",
        "unsupported_message_type",
        "unsupported_payload",
        "provider_start_failed",
        "provider_execution_failed",
        "provider_result_invalid",
        "cancelled_before_execution",
        "cancelled_during_safe_wait",
        "provider_outcome_unknown",
    ]

    @field_validator("reason_code")
    @classmethod
    def reason_matches_outcome(cls, value: str, info: object) -> str:
        data = getattr(info, "data", {})
        allowed = {
            "completed_without_reply": {"no_reply_required"},
            "unsupported": {"unsupported_message_type", "unsupported_payload"},
            "failed": {
                "provider_start_failed",
                "provider_execution_failed",
                "provider_result_invalid",
            },
            "cancelled": {
                "cancelled_before_execution",
                "cancelled_during_safe_wait",
            },
            "uncertain": {"provider_outcome_unknown"},
        }
        if value not in allowed.get(data.get("outcome"), set()):
            raise ValueError("reason code does not match outcome")
        return value


class EmptyRequest(StrictModel):
    pass


class RevokeRequest(StrictModel):
    scope: Literal["identity"]


class V2AgentRecord(StrictModel):
    agent_id: str
    username: str
    email: SecretStr
    display_name: SecretStr | None = None
    verified: bool = False
    delivery_version: Literal["v1", "v2"] = "v1"
    inbound_enabled: bool = False
    has_legacy_rows: bool = False


class V2CodeRecord(StrictModel):
    agent_id: str
    code: SecretStr
    purpose: Literal["enrollment", "recovery"]
    expires_at: int


class V2TokenRecord(StrictModel):
    token: SecretStr
    agent_id: str
    jkt: str
    issued_at: int
    expires_at: int
    token_jti: str
    revoked: bool = False


class V2MessageRecord(StrictModel):
    message_id: str
    conversation_id: str
    sender_agent_id: str
    recipient_agent_id: str
    in_reply_to_message_id: str | None
    text: SecretStr
    created_at: int
    is_conversation_start: bool = False
    lease_until: int | None = None
    terminal_outcome: str | None = None
    terminal_reason: str | None = None
    terminal_fingerprint: bytes | None = None
    reply_message_id: str | None = None
    acknowledged: bool = False


class StartIdempotencyRecord(StrictModel):
    sender_agent_id: str
    request_id: str
    request_fingerprint: bytes
    created_at: int
    message_id: str
    conversation_id: str


class ReissueIdempotencyRecord(StrictModel):
    agent_id: str
    request_id: str
    created_at: int
    token: SecretStr


class IdempotencyClaimRecord(StrictModel):
    operation: Literal["start.v1", "reissue.v1"]
    agent_id: str
    request_id: str
    created_at: int


class AdvanceClockRequest(StrictModel):
    seconds: Annotated[int, Field(strict=True, ge=0, le=604_800)]


class V2GrantRequest(StrictModel):
    sender_username: str
    recipient_username: str
    active: bool = True

    _sender = field_validator("sender_username")(validate_v2_username)
    _recipient = field_validator("recipient_username")(validate_v2_username)


class V2InjectMessageRequest(StrictModel):
    sender_username: str
    recipient_username: str
    text: str
    conversation_id: str | None = None
    in_reply_to_message_id: str | None = None

    _sender = field_validator("sender_username")(validate_v2_username)
    _recipient = field_validator("recipient_username")(validate_v2_username)
    _text = field_validator("text")(validate_text)

    @field_validator("conversation_id", "in_reply_to_message_id")
    @classmethod
    def validate_optional_id(cls, value: str | None) -> str | None:
        if value is not None and URI_ID_PATTERN.fullmatch(value) is None:
            raise ValueError("invalid fixture ID")
        return value


class V2FaultRequest(StrictModel):
    operation: Literal[
        "register",
        "verify",
        "resend",
        "activate",
        "start",
        "receive",
        "reply",
        "complete",
        "ack",
        "reissue",
        "revoke",
    ]
    mode: Literal[
        "none",
        "unavailable_before",
        "drop_after_commit",
        "nonce_once",
        "invalid_success",
    ]


class V2InspectRequest(StrictModel):
    agent_id: str | None = None
    message_id: str | None = None

    @field_validator("agent_id", "message_id")
    @classmethod
    def validate_filter_id(cls, value: str | None) -> str | None:
        if value is not None and URI_ID_PATTERN.fullmatch(value) is None:
            raise ValueError("invalid fixture ID")
        return value


class FixtureStateError(Exception):
    pass


class AuthenticationFailed(FixtureStateError):
    pass


class RecordNotFound(FixtureStateError):
    pass


class RecordConflict(FixtureStateError):
    pass


class ApplicationFailure(FixtureStateError):
    def __init__(
        self,
        status_code: int,
        code: str,
        *,
        retry_after_ms: int | None = None,
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.retry_after_ms = retry_after_ms


class DPoPFailure(FixtureStateError):
    def __init__(
        self,
        status_code: int,
        error: str,
        *,
        nonce: str | None = None,
        issuance: bool = False,
    ) -> None:
        super().__init__(error)
        self.status_code = status_code
        self.error = error
        self.nonce = nonce
        self.issuance = issuance


class DropAfterCommit(FixtureStateError):
    pass


class FixtureState:
    verification_code = "246810"
    action_types = ("fixture.echo",)

    def __init__(self) -> None:
        self.agents: dict[str, AgentRecord] = {}
        self.agent_ids_by_username: dict[str, str] = {}
        self.agent_ids_by_email: dict[str, str] = {}
        self.agent_ids_by_token: dict[str, str] = {}
        self.verifications: dict[str, VerificationRecord] = {}
        self.messages: dict[str, MessageRecord] = {}
        self.permissions: dict[str, PermissionRecord] = {}
        self.actions: dict[str, ActionRecord] = {}
        self.signing_key = secrets.token_bytes(32)
        self.changed = asyncio.Condition()
        self._reset_v2_unlocked()

    def _reset_v2_unlocked(self) -> None:
        curve_order = int(
            "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
            16,
        )
        scalar = int.from_bytes(
            hashlib.sha256(b"a2a-python-fixture-issuer-v2").digest(), "big"
        )
        self.v2_issuer_key = ec.derive_private_key(
            scalar % (curve_order - 1) + 1, ec.SECP256R1()
        )
        self.v2_clock = FIXTURE_CLOCK_START
        self.v2_agents: dict[str, V2AgentRecord] = {}
        self.v2_agent_ids_by_username: dict[str, str] = {}
        self.v2_agent_ids_by_email: dict[str, str] = {}
        self.v2_codes: dict[str, V2CodeRecord] = {}
        self.v2_tokens: dict[str, V2TokenRecord] = {}
        self.v2_messages: dict[str, V2MessageRecord] = {}
        self.v2_starts: dict[tuple[str, str], StartIdempotencyRecord] = {}
        self.v2_reissue_results: dict[
            tuple[str, str], ReissueIdempotencyRecord
        ] = {}
        self.v2_idempotency_claims: dict[
            tuple[str, str, str], IdempotencyClaimRecord
        ] = {}
        self.v2_reissue_attempts: dict[str, list[int]] = {}
        self.v2_request_times: dict[str, list[int]] = {}
        self.v2_start_times_by_sender: dict[str, list[int]] = {}
        self.v2_start_times_by_pair: dict[tuple[str, str], list[int]] = {}
        self.v2_registration_rates: dict[bytes, list[int]] = {}
        self.v2_resend_rates: dict[bytes, list[int]] = {}
        self.v2_verification_rates: dict[bytes, list[int]] = {}
        self.v2_grants: set[tuple[str, str]] = set()
        self.v2_replay: dict[bytes, tuple[int, str, str]] = {}
        self.v2_revoked_token_ids: set[str] = set()
        self.v2_receive_active: set[str] = set()
        self.v2_faults: dict[str, str] = {}
        self.v2_nonce_key = hashlib.sha256(
            b"a2a-python-fixture-nonce-current-v2"
        ).digest()
        self.v2_previous_nonce_key: bytes | None = None
        self.v2_previous_nonce_key_until = 0
        self.v2_fingerprint_key = hashlib.sha256(
            b"a2a-python-fixture-fingerprint-v2"
        ).digest()
        self.v2_counters = {
            "agent": 5,
            "conversation": 1,
            "message": 1,
            "nonce": 1,
            "token": 1,
        }
        seeds = (
            (
                "agent_fixture_0001",
                "fixture_sender",
                "fixture_sender@fixture.invalid",
                "v2",
                True,
                False,
            ),
            (
                "agent_fixture_0002",
                "fixture_recipient",
                "fixture_recipient@fixture.invalid",
                "v2",
                True,
                False,
            ),
            (
                "agent_fixture_0003",
                "fixture_denied",
                "fixture_denied@fixture.invalid",
                "v2",
                True,
                False,
            ),
            (
                "agent_fixture_0004",
                "fixture_legacy",
                "fixture_legacy@fixture.invalid",
                "v1",
                False,
                True,
            ),
        )
        for agent_id, username, email, version, inbound, legacy_rows in seeds:
            agent = V2AgentRecord(
                agent_id=agent_id,
                username=username,
                email=SecretStr(email),
                verified=True,
                delivery_version=version,
                inbound_enabled=inbound,
                has_legacy_rows=legacy_rows,
            )
            self.v2_agents[agent_id] = agent
            self.v2_agent_ids_by_username[username] = agent_id
            self.v2_agent_ids_by_email[email] = agent_id
        self.v2_grants.add(("agent_fixture_0001", "agent_fixture_0002"))
        legacy_v1_agent = AgentRecord(
            agent_id="agent_fixture_0004",
            username="fixture_legacy",
            email="fixture_legacy@fixture.invalid",
        )
        self.agents[legacy_v1_agent.agent_id] = legacy_v1_agent
        self.agent_ids_by_username[legacy_v1_agent.username] = legacy_v1_agent.agent_id
        self.agent_ids_by_email[legacy_v1_agent.email] = legacy_v1_agent.agent_id
        self.verifications[legacy_v1_agent.email] = VerificationRecord(
            agent_id=legacy_v1_agent.agent_id,
            code=SecretStr(self.verification_code),
        )
        self.hidden_seeded_v1_agent_ids = {legacy_v1_agent.agent_id}

    def _v2_id(self, kind: Literal["agent", "conversation", "message"]) -> str:
        value = self.v2_counters[kind]
        self.v2_counters[kind] = value + 1
        if kind == "agent":
            return f"agent_fixture_{value:04d}"
        if kind == "conversation":
            return f"conv_fixture_{value:06d}"
        return f"msg_fixture_{value:06d}"

    def _v2_uuid(self, kind: Literal["token"] = "token") -> str:
        value = self.v2_counters[kind]
        self.v2_counters[kind] = value + 1
        return f"00000000-0000-4000-8000-{value:012x}"

    def _issue_token(self, agent_id: str) -> str:
        if agent_id == "agent_fixture_0004":
            return self._sign_compact_jwt(
                self.v2_issuer_key,
                {"alg": "ES256", "typ": "JWT"},
                {
                    "iss": FIXTURE_ISSUER,
                    "aud": [FIXTURE_API_AUDIENCE, FIXTURE_MCP_AUDIENCE],
                    "sub": agent_id,
                    "iat": self.v2_clock,
                    "exp": self.v2_clock + 86_400,
                    "jti": "00000000-0000-4000-8000-ffffffffffff",
                },
            )

        def encode(value: dict[str, str]) -> str:
            raw = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
            return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

        header = encode({"alg": "HS256", "typ": "JWT"})
        payload = encode(
            {
                "iss": "a2a-central-test-fixture",
                "jti": uuid4().hex,
                "sub": agent_id,
            }
        )
        signature = hmac.new(
            self.signing_key,
            f"{header}.{payload}".encode(),
            hashlib.sha256,
        ).digest()
        encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
        return f"{header}.{payload}.{encoded_signature}"

    def _agent_for_token(self, token: str) -> AgentRecord:
        agent_id = self.agent_ids_by_token.get(token)
        if agent_id is None:
            raise AuthenticationFailed("authentication failed")
        return self.agents[agent_id]

    def _agent_for_username(self, username: str) -> AgentRecord:
        agent_id = self.agent_ids_by_username.get(username)
        if agent_id is None:
            raise RecordNotFound("agent not found")
        return self.agents[agent_id]

    def _queued_messages(self, agent_id: str) -> list[MessageRecord]:
        return [
            message
            for message in self.messages.values()
            if message.recipient_agent_id == agent_id
            and message.status == "queued"
        ]

    def _deliver_queued_messages(self, agent_id: str) -> list[ContentMessage]:
        messages: list[ContentMessage] = []
        for message in self._queued_messages(agent_id):
            message.status = "delivered"
            messages.append(
                ContentMessage(
                    id=message.id,
                    sender_agent_id=message.sender_agent_id,
                    kind=message.kind,
                    content=message.content,
                )
            )
        return messages

    async def reset(self) -> None:
        async with self.changed:
            self.agents.clear()
            self.agent_ids_by_username.clear()
            self.agent_ids_by_email.clear()
            self.agent_ids_by_token.clear()
            self.verifications.clear()
            self.messages.clear()
            self.permissions.clear()
            self.actions.clear()
            self.signing_key = secrets.token_bytes(32)
            self._reset_v2_unlocked()
            self.changed.notify_all()

    async def register(
        self, username: str, email: str, display_name: str | None
    ) -> RegistrationResponse:
        async with self.changed:
            if username in self.agent_ids_by_username or email in self.agent_ids_by_email:
                raise RecordConflict("username or email is already registered")
            agent_id = f"agent_{uuid4().hex}"
            agent = AgentRecord(
                agent_id=agent_id,
                username=username,
                display_name=display_name,
                email=email,
            )
            self.agents[agent_id] = agent
            self.agent_ids_by_username[username] = agent_id
            self.agent_ids_by_email[email] = agent_id
            self.verifications[email] = VerificationRecord(
                agent_id=agent_id,
                code=SecretStr(self.verification_code),
            )
            return RegistrationResponse(
                agent_id=agent_id,
                username=username,
                email=email,
                message="Registration successful. Check the verification code.",
            )

    async def resend(self, email: str) -> StatusResponse:
        async with self.changed:
            agent_id = self.agent_ids_by_email.get(email)
            if agent_id is None:
                raise RecordNotFound("registration not found")
            if self.agents[agent_id].verified:
                raise RecordConflict("email is already verified")
            self.verifications[email] = VerificationRecord(
                agent_id=agent_id,
                code=SecretStr(self.verification_code),
            )
            return StatusResponse()

    async def verification_code_for(self, email: str) -> VerificationCodeResponse:
        async with self.changed:
            record = self.verifications.get(email)
            if record is None:
                raise RecordNotFound("verification code not found")
            return VerificationCodeResponse(code=record.code.get_secret_value())

    async def verify(self, email: str, code: str) -> VerificationResponse:
        async with self.changed:
            record = self.verifications.get(email)
            if record is None or not secrets.compare_digest(
                record.code.get_secret_value(), code
            ):
                raise AuthenticationFailed("verification failed")
            agent = self.agents[record.agent_id]
            if agent.token is None:
                raw_token = self._issue_token(agent.agent_id)
                agent.token = SecretStr(raw_token)
                agent.verified = True
                self.agent_ids_by_token[raw_token] = agent.agent_id
            token = agent.token.get_secret_value()
            return VerificationResponse(
                agent_id=agent.agent_id,
                username=agent.username,
                token=token,
                message="Email verified successfully.",
            )

    async def inject(self, request: InjectMessageRequest) -> MessageIdResponse:
        async with self.changed:
            recipient = self.agents.get(request.recipient_agent_id)
            if recipient is None or not recipient.verified:
                raise RecordNotFound("verified recipient not found")
            message_id = request.message_id or f"msg_{uuid4().hex}"
            if message_id in self.messages:
                raise RecordConflict("message ID already exists")
            self.messages[message_id] = MessageRecord(
                id=message_id,
                recipient_agent_id=request.recipient_agent_id,
                sender_agent_id=request.sender_agent_id,
                kind=request.kind,
                content=request.content,
            )
            self.changed.notify_all()
            return MessageIdResponse(id=message_id)

    async def poll_messages(self, token: str, timeout: int) -> ContentPollResponse:
        async with self.changed:
            agent = self._agent_for_token(token)
            if timeout < 0 or timeout > 30:
                raise RecordConflict("timeout must be between 0 and 30")
            messages = self._deliver_queued_messages(agent.agent_id)
            if messages or timeout == 0:
                return ContentPollResponse(messages=messages)
            try:
                await asyncio.wait_for(
                    self.changed.wait_for(
                        lambda: bool(self._queued_messages(agent.agent_id))
                        or token not in self.agent_ids_by_token
                    ),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                return ContentPollResponse(messages=[])
            agent = self._agent_for_token(token)
            return ContentPollResponse(
                messages=self._deliver_queued_messages(agent.agent_id)
            )

    async def ack_message(
        self, token: str, message_id: str
    ) -> AcknowledgementResponse:
        async with self.changed:
            agent = self._agent_for_token(token)
            message = self.messages.get(message_id)
            if (
                message is None
                or message.recipient_agent_id != agent.agent_id
                or message.status != "delivered"
            ):
                raise RecordNotFound("message not found")
            message.status = "acked"
            self.changed.notify_all()
            return AcknowledgementResponse(message_id=message_id)

    async def list_action_types(self, token: str) -> ActionTypesResponse:
        async with self.changed:
            self._agent_for_token(token)
            return ActionTypesResponse(action_types=list(self.action_types))

    def _business_username(self, agent_id: str) -> str:
        if agent_id in self.v2_agents:
            return self.v2_agents[agent_id].username
        return self.agents[agent_id].username

    def _request_permission_unlocked(
        self,
        requester: AgentRecord | V2AgentRecord,
        target: AgentRecord | V2AgentRecord,
        action_type: str,
        scope: dict[str, object] | None,
    ) -> PermissionResponse:
        if not target.verified:
            raise RecordNotFound("verified target not found")
        if action_type not in self.action_types:
            raise RecordNotFound("action type not found")
        permission_id = f"permission_{uuid4().hex}"
        self.permissions[permission_id] = PermissionRecord(
            permission_id=permission_id,
            requester_agent_id=requester.agent_id,
            target_agent_id=target.agent_id,
            action_type=action_type,
            scope=scope,
        )
        message_id = f"msg_{uuid4().hex}"
        self.messages[message_id] = MessageRecord(
            id=message_id,
            recipient_agent_id=target.agent_id,
            sender_agent_id=requester.agent_id,
            kind="permission",
            content=json.dumps(
                {
                    "action_type": action_type,
                    "permission_id": permission_id,
                    "requester_username": requester.username,
                    "scope": scope,
                    "type": "permission_request",
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
        self.changed.notify_all()
        return PermissionResponse(permission_id=permission_id, status="pending")

    def _respond_to_permission_unlocked(
        self,
        target_agent_id: str,
        permission_id: str,
        decision: Literal["granted", "denied"],
    ) -> PermissionResponse:
        permission = self.permissions.get(permission_id)
        if permission is None or permission.target_agent_id != target_agent_id:
            raise RecordNotFound("permission not found")
        if permission.status != "pending" and permission.status != decision:
            raise RecordConflict("permission already has a different decision")
        permission.status = decision
        return PermissionResponse(permission_id=permission_id, status=decision)

    def _get_my_permissions_unlocked(
        self, requester_agent_id: str, status_filter: str
    ) -> PermissionsResponse:
        if status_filter not in ("all", "pending", "granted", "denied"):
            raise RecordNotFound("permission status not found")
        permissions = []
        for permission in self.permissions.values():
            if permission.requester_agent_id != requester_agent_id:
                continue
            if status_filter != "all" and permission.status != status_filter:
                continue
            permissions.append(
                PermissionSummary(
                    permission_id=permission.permission_id,
                    target_username=self._business_username(
                        permission.target_agent_id
                    ),
                    action_type=permission.action_type,
                    scope=permission.scope,
                    status=permission.status,
                )
            )
        return PermissionsResponse(permissions=permissions)

    def _call_action_unlocked(
        self,
        caller: AgentRecord | V2AgentRecord,
        target: AgentRecord | V2AgentRecord,
        action_type: str,
        payload: dict[str, object],
    ) -> ActionResponse:
        permission = next(
            (
                record
                for record in self.permissions.values()
                if record.requester_agent_id == caller.agent_id
                and record.target_agent_id == target.agent_id
                and record.action_type == action_type
                and record.status == "granted"
            ),
            None,
        )
        if permission is None:
            raise RecordNotFound("granted permission not found")
        action_id = f"action_{uuid4().hex}"
        self.actions[action_id] = ActionRecord(
            action_id=action_id,
            caller_agent_id=caller.agent_id,
            target_agent_id=target.agent_id,
            action_type=action_type,
            payload=payload,
        )
        message_id = f"msg_{uuid4().hex}"
        self.messages[message_id] = MessageRecord(
            id=message_id,
            recipient_agent_id=target.agent_id,
            sender_agent_id=caller.agent_id,
            kind="action",
            content=json.dumps(
                {
                    "action_id": action_id,
                    "action_type": action_type,
                    "caller_username": caller.username,
                    "payload": payload,
                    "type": "action_call",
                },
                separators=(",", ":"),
                sort_keys=True,
            ),
        )
        self.changed.notify_all()
        return ActionResponse(action_id=action_id)

    async def request_permission(
        self,
        token: str,
        target_username: str,
        action_type: str,
        scope: dict[str, object] | None,
    ) -> PermissionResponse:
        async with self.changed:
            requester = self._agent_for_token(token)
            target = self._agent_for_username(target_username)
            return self._request_permission_unlocked(
                requester, target, action_type, scope
            )

    async def respond_to_permission(
        self, token: str, permission_id: str, decision: Literal["granted", "denied"]
    ) -> PermissionResponse:
        async with self.changed:
            target = self._agent_for_token(token)
            return self._respond_to_permission_unlocked(
                target.agent_id, permission_id, decision
            )

    async def get_my_permissions(
        self, token: str, status_filter: str
    ) -> PermissionsResponse:
        async with self.changed:
            requester = self._agent_for_token(token)
            return self._get_my_permissions_unlocked(
                requester.agent_id, status_filter
            )

    async def call_action(
        self,
        token: str,
        target_username: str,
        action_type: str,
        payload: dict[str, object],
    ) -> ActionResponse:
        async with self.changed:
            caller = self._agent_for_token(token)
            target = self._agent_for_username(target_username)
            return self._call_action_unlocked(
                caller, target, action_type, payload
            )

    async def list_action_types_v2(
        self, agent: V2AgentRecord
    ) -> ActionTypesResponse:
        async with self.changed:
            self._charge_application_request(agent.agent_id)
            return ActionTypesResponse(action_types=list(self.action_types))

    async def request_permission_v2(
        self,
        agent: V2AgentRecord,
        target_username: str,
        action_type: str,
        scope: dict[str, object] | None,
    ) -> PermissionResponse:
        async with self.changed:
            self._charge_application_request(agent.agent_id)
            target_id = self.v2_agent_ids_by_username.get(target_username)
            if target_id is None:
                raise RecordNotFound("verified target not found")
            return self._request_permission_unlocked(
                agent, self.v2_agents[target_id], action_type, scope
            )

    async def respond_to_permission_v2(
        self,
        agent: V2AgentRecord,
        permission_id: str,
        decision: Literal["granted", "denied"],
    ) -> PermissionResponse:
        async with self.changed:
            self._charge_application_request(agent.agent_id)
            return self._respond_to_permission_unlocked(
                agent.agent_id, permission_id, decision
            )

    async def get_my_permissions_v2(
        self, agent: V2AgentRecord, status_filter: str
    ) -> PermissionsResponse:
        async with self.changed:
            self._charge_application_request(agent.agent_id)
            return self._get_my_permissions_unlocked(
                agent.agent_id, status_filter
            )

    async def call_action_v2(
        self,
        agent: V2AgentRecord,
        target_username: str,
        action_type: str,
        payload: dict[str, object],
    ) -> ActionResponse:
        async with self.changed:
            self._charge_application_request(agent.agent_id)
            target_id = self.v2_agent_ids_by_username.get(target_username)
            if target_id is None:
                raise RecordNotFound("verified target not found")
            return self._call_action_unlocked(
                agent, self.v2_agents[target_id], action_type, payload
            )

    async def inspect(self, request: InspectRequest) -> InspectionResponse:
        async with self.changed:
            agents = [
                AgentInspection(agent_id=agent.agent_id, verified=agent.verified)
                for agent in self.agents.values()
                if (
                    request.agent_id is not None
                    or agent.agent_id not in self.hidden_seeded_v1_agent_ids
                )
                if request.agent_id is None or agent.agent_id == request.agent_id
            ]
            messages = [
                MessageInspection(
                    id=message.id,
                    recipient_agent_id=message.recipient_agent_id,
                    status=message.status,
                )
                for message in self.messages.values()
                if (request.agent_id is None or message.recipient_agent_id == request.agent_id)
                and (request.message_id is None or message.id == request.message_id)
            ]
            permissions = [
                PermissionInspection(
                    permission_id=permission.permission_id,
                    status=permission.status,
                )
                for permission in self.permissions.values()
                if request.agent_id is None
                or request.agent_id
                in (permission.requester_agent_id, permission.target_agent_id)
            ]
            actions = [
                ActionInspection(action_id=action.action_id, status=action.status)
                for action in self.actions.values()
                if request.agent_id is None
                or request.agent_id in (action.caller_agent_id, action.target_agent_id)
            ]
            return InspectionResponse(
                agents=agents,
                messages=messages,
                permissions=permissions,
                actions=actions,
            )

    @staticmethod
    def _public_jwk(public_key: ec.EllipticCurvePublicKey) -> dict[str, str]:
        numbers = public_key.public_numbers()
        return {
            "kty": "EC",
            "crv": "P-256",
            "x": b64url_encode(numbers.x.to_bytes(32, "big")),
            "y": b64url_encode(numbers.y.to_bytes(32, "big")),
        }

    @staticmethod
    def _jwk_thumbprint(jwk: dict[str, str]) -> str:
        canonical = compact_json(
            {key: jwk[key] for key in ("crv", "kty", "x", "y")}
        )
        return b64url_encode(hashlib.sha256(canonical).digest())

    @staticmethod
    def _public_key_from_jwk(jwk: object) -> ec.EllipticCurvePublicKey:
        if not isinstance(jwk, dict) or set(jwk) != {"kty", "crv", "x", "y"}:
            raise ValueError("invalid public JWK")
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
            raise ValueError("invalid public JWK")
        x = int.from_bytes(b64url_decode(str(jwk.get("x")), exact_length=32), "big")
        y = int.from_bytes(b64url_decode(str(jwk.get("y")), exact_length=32), "big")
        return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()

    @staticmethod
    def _sign_compact_jwt(
        private_key: ec.EllipticCurvePrivateKey,
        header: dict[str, object],
        payload: dict[str, object],
    ) -> str:
        encoded_header = b64url_encode(compact_json(header))
        encoded_payload = b64url_encode(compact_json(payload))
        signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
        signature_der = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(signature_der)
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return f"{encoded_header}.{encoded_payload}.{b64url_encode(signature)}"

    @staticmethod
    def _parse_compact_jwt(value: str) -> tuple[dict[str, object], dict[str, object], bytes, bytes]:
        if len(value.encode("ascii", errors="strict")) > 4096:
            raise ValueError("JWT is too large")
        parts = value.split(".")
        if len(parts) != 3:
            raise ValueError("invalid compact JWT")
        header = json_without_duplicates(b64url_decode(parts[0]))
        payload = json_without_duplicates(b64url_decode(parts[1]))
        signature = b64url_decode(parts[2], exact_length=64)
        if not isinstance(header, dict) or not isinstance(payload, dict):
            raise ValueError("invalid compact JWT")
        return header, payload, signature, f"{parts[0]}.{parts[1]}".encode("ascii")

    def _parse_dpop_proof(
        self,
        proof: str,
        *,
        method: str,
        htu: str,
        access_token: str | None,
    ) -> tuple[dict[str, object], str]:
        header, payload, signature, signing_input = self._parse_compact_jwt(proof)
        if set(header) != {"typ", "alg", "jwk"}:
            raise ValueError("invalid DPoP header")
        if header.get("typ") != "dpop+jwt" or header.get("alg") != "ES256":
            raise ValueError("invalid DPoP header")
        public_key = self._public_key_from_jwk(header.get("jwk"))
        try:
            public_key.verify(
                encode_dss_signature(
                    int.from_bytes(signature[:32], "big"),
                    int.from_bytes(signature[32:], "big"),
                ),
                signing_input,
                ec.ECDSA(hashes.SHA256()),
            )
        except InvalidSignature as error:
            raise ValueError("invalid DPoP signature") from error
        required = {"jti", "htm", "htu", "iat", "nonce"}
        if access_token is not None:
            required.add("ath")
        allowed_without_nonce = required - {"nonce"}
        if set(payload) not in (required, allowed_without_nonce):
            raise ValueError("invalid DPoP claims")
        if (
            not isinstance(payload.get("jti"), str)
            or UUID_V4_PATTERN.fullmatch(str(payload["jti"])) is None
            or payload.get("htm") != method
            or not isinstance(payload.get("htu"), str)
            or normalize_htu(str(payload["htu"])) != htu
            or isinstance(payload.get("iat"), bool)
            or not isinstance(payload.get("iat"), int)
            or payload["iat"] < self.v2_clock - 60
            or payload["iat"] > self.v2_clock + 5
        ):
            raise ValueError("invalid DPoP claims")
        if access_token is not None:
            expected_ath = b64url_encode(hashlib.sha256(access_token.encode("ascii")).digest())
            if payload.get("ath") != expected_ath:
                raise ValueError("invalid access token hash")
        jwk = header["jwk"]
        if not isinstance(jwk, dict):
            raise ValueError("invalid public JWK")
        return payload, self._jwk_thumbprint({key: str(value) for key, value in jwk.items()})

    def _validate_v2_access_token(
        self, token: str, record: V2TokenRecord
    ) -> None:
        header, payload, signature, signing_input = self._parse_compact_jwt(token)
        if header != {"alg": "ES256", "typ": "JWT"}:
            raise ValueError("invalid access-token header")
        try:
            self.v2_issuer_key.public_key().verify(
                encode_dss_signature(
                    int.from_bytes(signature[:32], "big"),
                    int.from_bytes(signature[32:], "big"),
                ),
                signing_input,
                ec.ECDSA(hashes.SHA256()),
            )
        except InvalidSignature as error:
            raise ValueError("invalid access-token signature") from error
        if set(payload) != {
            "iss",
            "aud",
            "sub",
            "iat",
            "exp",
            "jti",
            "cnf",
        }:
            raise ValueError("invalid access-token claims")
        issued_at = payload.get("iat")
        expires_at = payload.get("exp")
        token_jti = payload.get("jti")
        confirmation = payload.get("cnf")
        if (
            payload.get("iss") != FIXTURE_ISSUER
            or payload.get("aud")
            != [FIXTURE_API_AUDIENCE, FIXTURE_MCP_AUDIENCE]
            or payload.get("sub") != record.agent_id
            or isinstance(issued_at, bool)
            or not isinstance(issued_at, int)
            or issued_at != record.issued_at
            or issued_at > self.v2_clock + 5
            or isinstance(expires_at, bool)
            or not isinstance(expires_at, int)
            or expires_at != record.expires_at
            or expires_at - issued_at != 86_400
            or expires_at <= self.v2_clock
            or not isinstance(token_jti, str)
            or token_jti != record.token_jti
            or UUID_V4_PATTERN.fullmatch(token_jti) is None
            or confirmation != {"jkt": record.jkt}
        ):
            raise ValueError("invalid access-token claims")

    @staticmethod
    def _nonce_mac_input(
        scope: str, security_domain: str, bindings: tuple[str, ...], prefix: bytes
    ) -> bytes:
        values = ("a2a-dpop-nonce-v1", scope, security_domain, *bindings)
        encoded = bytearray()
        for value in values:
            raw = value.encode("utf-8")
            encoded.extend(struct.pack(">I", len(raw)))
            encoded.extend(raw)
        encoded.extend(prefix)
        return bytes(encoded)

    def _mint_nonce(
        self, scope: str, security_domain: str, bindings: tuple[str, ...]
    ) -> str:
        counter = self.v2_counters["nonce"]
        self.v2_counters["nonce"] = counter + 1
        random_bytes = hashlib.sha256(
            f"a2a-fixture-nonce-{counter}".encode("ascii")
        ).digest()[:16]
        prefix = b"\x01" + self.v2_clock.to_bytes(8, "big") + random_bytes
        tag = hmac.new(
            self.v2_nonce_key,
            self._nonce_mac_input(scope, security_domain, bindings, prefix),
            hashlib.sha256,
        ).digest()
        return b64url_encode(prefix + tag)

    def _valid_nonce(
        self,
        nonce: object,
        scope: str,
        security_domain: str,
        bindings: tuple[str, ...],
    ) -> bool:
        if not isinstance(nonce, str) or len(nonce) != 76:
            return False
        try:
            decoded = b64url_decode(nonce, exact_length=57)
        except ValueError:
            return False
        if decoded[0] != 1:
            return False
        issued_at = int.from_bytes(decoded[1:9], "big")
        if issued_at < self.v2_clock - 300 or issued_at > self.v2_clock + 5:
            return False
        prefix, supplied_tag = decoded[:25], decoded[25:]
        mac_input = self._nonce_mac_input(scope, security_domain, bindings, prefix)
        keys = [self.v2_nonce_key]
        if (
            self.v2_previous_nonce_key is not None
            and self.v2_clock <= self.v2_previous_nonce_key_until
        ):
            keys.append(self.v2_previous_nonce_key)
        return any(
            hmac.compare_digest(
                supplied_tag, hmac.new(key, mac_input, hashlib.sha256).digest()
            )
            for key in keys
        )

    @staticmethod
    def _nonce_issued_at(nonce: object) -> int | None:
        if not isinstance(nonce, str):
            return None
        try:
            decoded = b64url_decode(nonce, exact_length=57)
        except ValueError:
            return None
        return int.from_bytes(decoded[1:9], "big")

    def _claim_replay(
        self,
        *,
        security_domain: str,
        jkt: str,
        method: str,
        htu: str,
        jti: str,
        issuance: bool = False,
    ) -> None:
        self.v2_replay = {
            digest: record
            for digest, record in self.v2_replay.items()
            if record[0] > self.v2_clock
        }
        replay_key = hashlib.sha256(
            security_domain.encode("utf-8")
            + b"\x00"
            + jkt.encode("ascii")
            + b"\x00"
            + method.encode("ascii")
            + b"\x00"
            + htu.encode("ascii")
            + b"\x00"
            + jti.encode("ascii")
        ).digest()
        if replay_key in self.v2_replay:
            raise DPoPFailure(
                400 if issuance else 401,
                "invalid_dpop_proof",
                issuance=issuance,
            )
        per_key = sum(
            1
            for _expires_at, record_jkt, domain in self.v2_replay.values()
            if record_jkt == jkt and domain == security_domain
        )
        if per_key >= 256:
            raise DPoPFailure(429, "dpop_rate_limited", issuance=issuance)
        per_domain = sum(
            1
            for _expires_at, _record_jkt, domain in self.v2_replay.values()
            if domain == security_domain
        )
        if per_domain >= 1_000_000:
            raise DPoPFailure(503, "temporarily_unavailable", issuance=issuance)
        self.v2_replay[replay_key] = (self.v2_clock + 65, jkt, security_domain)

    def authenticate_issuance(
        self, proof: str | None, *, method: str, htu: str
    ) -> tuple[str, str | None]:
        if proof is None:
            raise DPoPFailure(400, "invalid_dpop_proof", issuance=True)
        try:
            payload, jkt = self._parse_dpop_proof(
                proof, method=method, htu=htu, access_token=None
            )
        except (UnicodeEncodeError, ValueError):
            raise DPoPFailure(400, "invalid_dpop_proof", issuance=True) from None
        domain = "a2a-fixture-issuance-v2"
        if self.v2_faults.get("verify") == "nonce_once":
            self.v2_faults["verify"] = "none"
            raise DPoPFailure(
                400,
                "use_dpop_nonce",
                nonce=self._mint_nonce("issuance", domain, (jkt,)),
                issuance=True,
            )
        nonce = payload.get("nonce")
        if not self._valid_nonce(nonce, "issuance", domain, (jkt,)):
            raise DPoPFailure(
                400,
                "use_dpop_nonce",
                nonce=self._mint_nonce("issuance", domain, (jkt,)),
                issuance=True,
            )
        self._claim_replay(
            security_domain=domain,
            jkt=jkt,
            method=method,
            htu=htu,
            jti=str(payload["jti"]),
            issuance=True,
        )
        issued_at = self._nonce_issued_at(nonce)
        replacement = (
            self._mint_nonce("issuance", domain, (jkt,))
            if issued_at is not None and issued_at <= self.v2_clock - 240
            else None
        )
        return jkt, replacement

    def authenticate_resource(
        self,
        *,
        authorization: str | None,
        proof: str | None,
        method: str,
        htu: str,
        security_domain: Literal["api", "mcp"] = "api",
        operation: str = "resource",
    ) -> tuple[V2AgentRecord, str | None]:
        if authorization is None:
            raise DPoPFailure(401, "invalid_token")
        try:
            scheme, token = authorization.split(" ", 1)
            authorization_bytes = authorization.encode("ascii", errors="strict")
            token_bytes = token.encode("ascii", errors="strict")
        except (ValueError, UnicodeEncodeError):
            raise DPoPFailure(401, "invalid_token") from None
        if (
            scheme != "DPoP"
            or not token
            or len(token_bytes) > 4096
            or len(authorization_bytes) > 4101
        ):
            raise DPoPFailure(401, "invalid_token")
        if proof is None:
            raise DPoPFailure(401, "invalid_dpop_proof")
        try:
            proof_bytes = proof.encode("ascii", errors="strict")
        except UnicodeEncodeError:
            raise DPoPFailure(401, "invalid_dpop_proof") from None
        if len(proof_bytes) > 4096 or len(token_bytes) + len(proof_bytes) + 5 > 8197:
            raise DPoPFailure(401, "invalid_dpop_proof")
        record = self.v2_tokens.get(token)
        if record is None:
            raise DPoPFailure(401, "invalid_token")
        try:
            self._validate_v2_access_token(token, record)
        except (UnicodeEncodeError, ValueError):
            raise DPoPFailure(401, "invalid_token") from None
        if (
            record.revoked
            or record.token_jti in self.v2_revoked_token_ids
            or record.expires_at <= self.v2_clock
        ):
            raise DPoPFailure(401, "invalid_token")
        try:
            payload, jkt = self._parse_dpop_proof(
                proof, method=method, htu=htu, access_token=token
            )
        except (UnicodeEncodeError, ValueError):
            raise DPoPFailure(401, "invalid_dpop_proof") from None
        if jkt != record.jkt:
            raise DPoPFailure(401, "invalid_dpop_proof")
        domain = (
            "a2a-fixture-api-v2"
            if security_domain == "api"
            else "a2a-fixture-mcp-v2"
        )
        if self.v2_faults.get(operation) == "nonce_once":
            self.v2_faults[operation] = "none"
            raise DPoPFailure(
                401,
                "use_dpop_nonce",
                nonce=self._mint_nonce(
                    "resource", domain, (record.agent_id, record.jkt)
                ),
            )
        nonce = payload.get("nonce")
        if not self._valid_nonce(
            nonce, "resource", domain, (record.agent_id, record.jkt)
        ):
            raise DPoPFailure(
                401,
                "use_dpop_nonce",
                nonce=self._mint_nonce(
                    "resource", domain, (record.agent_id, record.jkt)
                ),
            )
        self._claim_replay(
            security_domain=domain,
            jkt=jkt,
            method=method,
            htu=htu,
            jti=str(payload["jti"]),
        )
        issued_at = self._nonce_issued_at(nonce)
        replacement = (
            self._mint_nonce(
                "resource", domain, (record.agent_id, record.jkt)
            )
            if issued_at is not None and issued_at <= self.v2_clock - 240
            else None
        )
        return self.v2_agents[record.agent_id], replacement

    def _issue_v2_token(self, agent: V2AgentRecord, jkt: str) -> str:
        token_jti = self._v2_uuid()
        header: dict[str, object] = {"alg": "ES256", "typ": "JWT"}
        payload: dict[str, object] = {
            "iss": FIXTURE_ISSUER,
            "aud": [FIXTURE_API_AUDIENCE, FIXTURE_MCP_AUDIENCE],
            "sub": agent.agent_id,
            "iat": self.v2_clock,
            "exp": self.v2_clock + 86_400,
            "jti": token_jti,
            "cnf": {"jkt": jkt},
        }
        token = self._sign_compact_jwt(self.v2_issuer_key, header, payload)
        self.v2_tokens[token] = V2TokenRecord(
            token=SecretStr(token),
            agent_id=agent.agent_id,
            jkt=jkt,
            issued_at=self.v2_clock,
            expires_at=self.v2_clock + 86_400,
            token_jti=token_jti,
        )
        return token

    def _fault_before(self, operation: str) -> None:
        if self.v2_faults.get(operation) == "unavailable_before":
            raise ApplicationFailure(503, "temporarily_unavailable")

    def _fault_after(self, operation: str) -> None:
        if self.v2_faults.get(operation) == "drop_after_commit":
            self.v2_faults[operation] = "none"
            raise DropAfterCommit("fixture dropped response after commit")

    def _email_rate_key(self, purpose: str, email: str) -> bytes:
        return hmac.new(
            self.v2_fingerprint_key,
            purpose.encode("ascii") + b"\x00" + email.encode("utf-8"),
            hashlib.sha256,
        ).digest()

    def _charge_email_rate(
        self,
        bucket: dict[bytes, list[int]],
        purpose: str,
        email: str,
        limit: int,
    ) -> None:
        rate_stores = (
            self.v2_registration_rates,
            self.v2_resend_rates,
            self.v2_verification_rates,
        )
        for store in rate_stores:
            for existing_key, timestamps in list(store.items()):
                live_timestamps = [
                    timestamp
                    for timestamp in timestamps
                    if timestamp + 3_600 > self.v2_clock
                ]
                if live_timestamps:
                    store[existing_key] = live_timestamps
                else:
                    del store[existing_key]
        key = self._email_rate_key(purpose, email)
        recent = list(bucket.get(key, []))
        if len(recent) >= limit:
            retry_after_ms = max(1_000, (recent[0] + 3_600 - self.v2_clock) * 1_000)
            raise ApplicationFailure(
                429, "rate_limited", retry_after_ms=retry_after_ms
            )
        live_key_count = sum(len(store) for store in rate_stores)
        if key not in bucket and live_key_count >= 1_000_000:
            raise ApplicationFailure(503, "temporarily_unavailable")
        recent.append(self.v2_clock)
        bucket[key] = recent

    def _charge_application_request(self, agent_id: str) -> None:
        recent = [
            timestamp
            for timestamp in self.v2_request_times.get(agent_id, [])
            if timestamp + 60 > self.v2_clock
        ]
        if len(recent) >= 120:
            retry_after_ms = max(1_000, (recent[0] + 60 - self.v2_clock) * 1_000)
            raise ApplicationFailure(
                429, "rate_limited", retry_after_ms=retry_after_ms
            )
        recent.append(self.v2_clock)
        self.v2_request_times[agent_id] = recent

    def _ensure_mailbox_capacity(self, recipient_id: str, text: str) -> None:
        messages = [
            message
            for message in self.v2_messages.values()
            if message.recipient_agent_id == recipient_id and not message.acknowledged
        ]
        byte_count = sum(
            len(message.text.get_secret_value().encode("utf-8"))
            for message in messages
        )
        text_bytes = len(text.encode("utf-8"))
        if len(messages) >= 10_000 or byte_count + text_bytes > 1_073_741_824:
            raise ApplicationFailure(429, "mailbox_full")

    def _charge_start_limits(
        self, sender_id: str, recipient_id: str, text: str
    ) -> None:
        pair = (sender_id, recipient_id)
        pair_times = [
            timestamp
            for timestamp in self.v2_start_times_by_pair.get(pair, [])
            if timestamp + 60 > self.v2_clock
        ]
        sender_times = [
            timestamp
            for timestamp in self.v2_start_times_by_sender.get(sender_id, [])
            if timestamp + 60 > self.v2_clock
        ]
        if len(pair_times) >= 10 or len(sender_times) >= 60:
            oldest = min(
                pair_times[0] if pair_times else self.v2_clock,
                sender_times[0] if sender_times else self.v2_clock,
            )
            raise ApplicationFailure(
                429,
                "rate_limited",
                retry_after_ms=max(1_000, (oldest + 60 - self.v2_clock) * 1_000),
            )
        active_pair = [
            message
            for message in self.v2_messages.values()
            if message.is_conversation_start
            and message.sender_agent_id == sender_id
            and message.recipient_agent_id == recipient_id
            and not message.acknowledged
        ]
        active_sender = [
            message
            for message in self.v2_messages.values()
            if message.is_conversation_start
            and message.sender_agent_id == sender_id
            and not message.acknowledged
        ]
        text_bytes = len(text.encode("utf-8"))
        pair_bytes = sum(
            len(message.text.get_secret_value().encode("utf-8"))
            for message in active_pair
        )
        sender_bytes = sum(
            len(message.text.get_secret_value().encode("utf-8"))
            for message in active_sender
        )
        if (
            len(active_pair) >= 32
            or pair_bytes + text_bytes > 8_388_608
            or len(active_sender) >= 1_000
            or sender_bytes + text_bytes > 268_435_456
        ):
            raise ApplicationFailure(429, "mailbox_full")
        self._ensure_mailbox_capacity(recipient_id, text)
        pair_times.append(self.v2_clock)
        sender_times.append(self.v2_clock)
        self.v2_start_times_by_pair[pair] = pair_times
        self.v2_start_times_by_sender[sender_id] = sender_times

    async def register_v2(self, request: RestRegistrationRequest) -> dict[str, object]:
        async with self.changed:
            self._fault_before("register")
            self._charge_email_rate(
                self.v2_registration_rates,
                "registration",
                request.email,
                3,
            )
            if (
                request.username in self.v2_agent_ids_by_username
                or request.email in self.v2_agent_ids_by_email
            ):
                raise ApplicationFailure(409, "registration_conflict")
            agent_id = self._v2_id("agent")
            agent = V2AgentRecord(
                agent_id=agent_id,
                username=request.username,
                email=SecretStr(request.email),
                display_name=(
                    None
                    if request.display_name is None
                    else SecretStr(request.display_name)
                ),
            )
            self.v2_agents[agent_id] = agent
            self.v2_agent_ids_by_username[agent.username] = agent_id
            self.v2_agent_ids_by_email[request.email] = agent_id
            self.v2_codes[request.email] = V2CodeRecord(
                agent_id=agent_id,
                code=SecretStr(FIXTURE_V2_CODE),
                purpose="enrollment",
                expires_at=self.v2_clock + 600,
            )
            self._fault_after("register")
            return {
                "agent_id": agent.agent_id,
                "username": agent.username,
                "email": request.email,
                "message": "Verification code sent.",
            }

    async def resend_v2(self, request: RestResendRequest) -> dict[str, str]:
        async with self.changed:
            self._fault_before("resend")
            self._charge_email_rate(
                self.v2_resend_rates, "resend", request.email, 5
            )
            agent_id = self.v2_agent_ids_by_email.get(request.email)
            if agent_id is not None:
                agent = self.v2_agents[agent_id]
                self.v2_codes[request.email] = V2CodeRecord(
                    agent_id=agent.agent_id,
                    code=SecretStr(FIXTURE_V2_CODE),
                    purpose="recovery" if agent.verified else "enrollment",
                    expires_at=self.v2_clock + 600,
                )
            self._fault_after("resend")
            return {"message": "Verification code resent."}

    async def verification_code_for_v2(self, email: str) -> dict[str, str]:
        validate_v2_email(email)
        async with self.changed:
            record = self.v2_codes.get(email)
            if record is None or record.expires_at <= self.v2_clock:
                raise RecordNotFound("verification code not found")
            return {"code": record.code.get_secret_value()}

    async def verify_v2(
        self, request: RestVerificationRequest, jkt: str
    ) -> dict[str, object]:
        async with self.changed:
            self._fault_before("verify")
            self._charge_email_rate(
                self.v2_verification_rates,
                "verification",
                request.email,
                10,
            )
            record = self.v2_codes.get(request.email)
            if (
                record is None
                or record.expires_at <= self.v2_clock
                or not secrets.compare_digest(
                    record.code.get_secret_value(), request.code
                )
            ):
                raise ApplicationFailure(400, "verification_failed")
            agent = self.v2_agents[record.agent_id]
            if record.purpose == "recovery":
                for token_record in self.v2_tokens.values():
                    if token_record.agent_id == agent.agent_id:
                        token_record.revoked = True
                        self.v2_revoked_token_ids.add(token_record.token_jti)
                legacy_tokens = [
                    (token, legacy_agent_id)
                    for token, legacy_agent_id in self.agent_ids_by_token.items()
                    if self.agents[legacy_agent_id].email == request.email
                ]
                for legacy_token, legacy_agent_id in legacy_tokens:
                    del self.agent_ids_by_token[legacy_token]
                    self.agents[legacy_agent_id].token = None
                self.verifications.pop(request.email, None)
            elif agent.verified:
                raise ApplicationFailure(400, "verification_failed")
            del self.v2_codes[request.email]
            agent.verified = True
            token = self._issue_v2_token(agent, jkt)
            self._fault_after("verify")
            return {
                "agent_id": agent.agent_id,
                "username": agent.username,
                "token": token,
                "token_type": "DPoP",
                "expires_in": 86_400,
                "message": "Email verified successfully.",
            }

    def _require_active(
        self, agent: V2AgentRecord, *, charge_request: bool = True
    ) -> None:
        if agent.delivery_version != "v2":
            raise ApplicationFailure(409, "protocol_mismatch")
        if charge_request:
            self._charge_application_request(agent.agent_id)

    async def activate_v2(self, agent: V2AgentRecord) -> dict[str, str]:
        async with self.changed:
            self._fault_before("activate")
            current = self.v2_agents[agent.agent_id]
            self._charge_application_request(current.agent_id)
            if current.has_legacy_rows:
                raise ApplicationFailure(409, "migration_incomplete")
            current.delivery_version = "v2"
            current.inbound_enabled = True
            self._fault_after("activate")
            return {"delivery_version": "v2", "status": "active"}

    def _start_fingerprint(self, recipient_agent_id: str, text: str) -> bytes:
        recipient = recipient_agent_id.encode("utf-8")
        content = text.encode("utf-8")
        return hmac.new(
            self.v2_fingerprint_key,
            struct.pack(">I", len(recipient))
            + recipient
            + struct.pack(">I", len(content))
            + content,
            hashlib.sha256,
        ).digest()

    def _terminal_fingerprint(self, *values: str) -> bytes:
        encoded = bytearray()
        for value in values:
            raw = value.encode("utf-8")
            encoded.extend(struct.pack(">I", len(raw)))
            encoded.extend(raw)
        return hmac.new(
            self.v2_fingerprint_key, bytes(encoded), hashlib.sha256
        ).digest()

    def _prune_v2_records(self) -> None:
        self.v2_starts = {
            key: record
            for key, record in self.v2_starts.items()
            if record.created_at + 172_800 > self.v2_clock
        }
        self.v2_reissue_results = {
            key: record
            for key, record in self.v2_reissue_results.items()
            if record.created_at + 172_800 > self.v2_clock
        }
        self.v2_idempotency_claims = {
            key: record
            for key, record in self.v2_idempotency_claims.items()
            if record.created_at + 172_800 > self.v2_clock
        }

    def _ensure_idempotency_key_available(
        self, operation: Literal["start.v1", "reissue.v1"], agent_id: str, request_id: str
    ) -> None:
        for claim in self.v2_idempotency_claims.values():
            if claim.request_id != request_id:
                continue
            if operation == "start.v1" and claim.operation == "start.v1":
                continue
            if (
                operation == "reissue.v1"
                and claim.operation == "reissue.v1"
                and claim.agent_id == agent_id
            ):
                continue
            raise ApplicationFailure(409, "idempotency_conflict")

    def _claim_idempotency_key(
        self, operation: Literal["start.v1", "reissue.v1"], agent_id: str, request_id: str
    ) -> None:
        self.v2_idempotency_claims[(operation, agent_id, request_id)] = (
            IdempotencyClaimRecord(
                operation=operation,
                agent_id=agent_id,
                request_id=request_id,
                created_at=self.v2_clock,
            )
        )

    def _message_body(self, message: V2MessageRecord) -> dict[str, object]:
        return {
            "id": message.message_id,
            "conversation_id": message.conversation_id,
            "sender_agent_id": message.sender_agent_id,
            "message_type": "conversation_turn",
            "in_reply_to_message_id": message.in_reply_to_message_id,
            "payload": {"text": message.text.get_secret_value()},
            "created_at": fixture_timestamp(message.created_at),
        }

    def _queue_message(
        self,
        *,
        sender_agent_id: str,
        recipient_agent_id: str,
        text: str,
        conversation_id: str | None = None,
        in_reply_to_message_id: str | None = None,
        is_conversation_start: bool = False,
    ) -> V2MessageRecord:
        message_id = self._v2_id("message")
        record = V2MessageRecord(
            message_id=message_id,
            conversation_id=conversation_id or self._v2_id("conversation"),
            sender_agent_id=sender_agent_id,
            recipient_agent_id=recipient_agent_id,
            in_reply_to_message_id=in_reply_to_message_id,
            text=SecretStr(text),
            created_at=self.v2_clock,
            is_conversation_start=is_conversation_start,
        )
        self.v2_messages[message_id] = record
        self.changed.notify_all()
        return record

    async def start_conversation_v2(
        self,
        agent: V2AgentRecord,
        request_id: str,
        request: ConversationStartRequest,
    ) -> tuple[dict[str, str], bool]:
        async with self.changed:
            self._fault_before("start")
            self._require_active(agent)
            self._prune_v2_records()
            key = (agent.agent_id, request_id)
            recipient_id = self.v2_agent_ids_by_username.get(
                request.recipient_username
            )
            recipient = (
                None if recipient_id is None else self.v2_agents[recipient_id]
            )
            prior = self.v2_starts.get(key)
            if prior is not None:
                if recipient is None:
                    raise ApplicationFailure(409, "idempotency_conflict")
                fingerprint = self._start_fingerprint(
                    recipient.agent_id, request.payload.text
                )
                if not hmac.compare_digest(prior.request_fingerprint, fingerprint):
                    raise ApplicationFailure(409, "idempotency_conflict")
                return (
                    {
                        "message_id": prior.message_id,
                        "conversation_id": prior.conversation_id,
                        "status": "accepted",
                    },
                    True,
                )
            if (
                recipient is None
                or recipient.delivery_version != "v2"
                or not recipient.inbound_enabled
                or (agent.agent_id, recipient.agent_id) not in self.v2_grants
            ):
                raise ApplicationFailure(404, "recipient_unavailable")
            self._ensure_idempotency_key_available(
                "start.v1", agent.agent_id, request_id
            )
            fingerprint = self._start_fingerprint(
                recipient.agent_id, request.payload.text
            )
            self._charge_start_limits(
                agent.agent_id, recipient.agent_id, request.payload.text
            )
            message = self._queue_message(
                sender_agent_id=agent.agent_id,
                recipient_agent_id=recipient.agent_id,
                text=request.payload.text,
                is_conversation_start=True,
            )
            self.v2_starts[key] = StartIdempotencyRecord(
                sender_agent_id=agent.agent_id,
                request_id=request_id,
                request_fingerprint=fingerprint,
                created_at=self.v2_clock,
                message_id=message.message_id,
                conversation_id=message.conversation_id,
            )
            self._claim_idempotency_key("start.v1", agent.agent_id, request_id)
            self._fault_after("start")
            return (
                {
                    "message_id": message.message_id,
                    "conversation_id": message.conversation_id,
                    "status": "accepted",
                },
                False,
            )

    async def conversation_start_v2(
        self, agent: V2AgentRecord, request_id: str
    ) -> dict[str, object]:
        async with self.changed:
            self._require_active(agent)
            self._prune_v2_records()
            prior = self.v2_starts.get((agent.agent_id, request_id))
            if prior is None:
                return {
                    "request_id": request_id,
                    "status": "not_found",
                    "message_id": None,
                    "conversation_id": None,
                }
            return {
                "request_id": request_id,
                "status": "accepted",
                "message_id": prior.message_id,
                "conversation_id": prior.conversation_id,
            }

    def _eligible_messages(self, agent_id: str) -> list[V2MessageRecord]:
        return sorted(
            (
                message
                for message in self.v2_messages.values()
                if message.recipient_agent_id == agent_id
                and not message.acknowledged
                and (
                    message.lease_until is None
                    or message.lease_until <= self.v2_clock
                )
            ),
            key=lambda message: (message.created_at, message.message_id),
        )

    def _lease_message_prefix(
        self, agent_id: str, limit: int
    ) -> list[dict[str, object]]:
        selected: list[dict[str, object]] = []
        selected_records: list[V2MessageRecord] = []
        for message in self._eligible_messages(agent_id):
            body = self._message_body(message)
            candidate = {"messages": [*selected, body]}
            if len(compact_json(candidate)) > 524_288:
                if not selected:
                    raise ApplicationFailure(503, "temporarily_unavailable")
                break
            selected.append(body)
            selected_records.append(message)
            if len(selected) == limit:
                break
        for message in selected_records:
            message.lease_until = self.v2_clock + 60
        return selected

    async def receive_messages_v2(
        self, agent: V2AgentRecord, timeout: int, limit: int
    ) -> dict[str, object]:
        async with self.changed:
            self._fault_before("receive")
            self._require_active(agent, charge_request=False)
            if agent.agent_id in self.v2_receive_active:
                raise ApplicationFailure(409, "receive_in_progress")
            self.v2_receive_active.add(agent.agent_id)
            try:
                messages = self._lease_message_prefix(agent.agent_id, limit)
                if not messages and timeout:
                    try:
                        await asyncio.wait_for(
                            self.changed.wait_for(
                                lambda: bool(
                                    self._eligible_messages(agent.agent_id)
                                )
                            ),
                            timeout=timeout,
                        )
                    except asyncio.TimeoutError:
                        pass
                    messages = self._lease_message_prefix(agent.agent_id, limit)
                self._fault_after("receive")
                return {"messages": messages}
            finally:
                self.v2_receive_active.discard(agent.agent_id)

    def _owned_message(
        self, agent: V2AgentRecord, message_id: str
    ) -> V2MessageRecord:
        message = self.v2_messages.get(message_id)
        if message is None or message.recipient_agent_id != agent.agent_id:
            raise ApplicationFailure(404, "message_not_found")
        return message

    async def reply_message_v2(
        self,
        agent: V2AgentRecord,
        message_id: str,
        request: ReplyRequest,
    ) -> dict[str, str]:
        async with self.changed:
            self._fault_before("reply")
            self._require_active(agent)
            message = self._owned_message(agent, message_id)
            fingerprint = self._terminal_fingerprint("reply", request.payload.text)
            if message.terminal_outcome is not None:
                if (
                    message.terminal_outcome == "replied"
                    and message.terminal_fingerprint is not None
                    and hmac.compare_digest(
                        message.terminal_fingerprint, fingerprint
                    )
                    and message.reply_message_id is not None
                ):
                    reply = self.v2_messages[message.reply_message_id]
                    return {
                        "message_id": reply.message_id,
                        "conversation_id": message.conversation_id,
                        "status": "accepted",
                    }
                if message.terminal_outcome == "replied":
                    raise ApplicationFailure(409, "idempotency_conflict")
                raise ApplicationFailure(409, "message_already_terminal")
            self._ensure_mailbox_capacity(
                message.sender_agent_id, request.payload.text
            )
            reply = self._queue_message(
                sender_agent_id=agent.agent_id,
                recipient_agent_id=message.sender_agent_id,
                text=request.payload.text,
                conversation_id=message.conversation_id,
                in_reply_to_message_id=message.message_id,
            )
            message.terminal_outcome = "replied"
            message.terminal_fingerprint = fingerprint
            message.reply_message_id = reply.message_id
            self._fault_after("reply")
            return {
                "message_id": reply.message_id,
                "conversation_id": message.conversation_id,
                "status": "accepted",
            }

    async def complete_message_v2(
        self,
        agent: V2AgentRecord,
        message_id: str,
        request: CompletionRequest,
    ) -> dict[str, str]:
        async with self.changed:
            self._fault_before("complete")
            self._require_active(agent)
            message = self._owned_message(agent, message_id)
            fingerprint = self._terminal_fingerprint(
                "complete", request.outcome, request.reason_code
            )
            if message.terminal_outcome is not None:
                if (
                    message.terminal_outcome == request.outcome
                    and message.terminal_reason == request.reason_code
                    and message.terminal_fingerprint is not None
                    and hmac.compare_digest(
                        message.terminal_fingerprint, fingerprint
                    )
                ):
                    return {
                        "message_id": message.message_id,
                        "outcome": request.outcome,
                        "status": "recorded",
                    }
                if message.terminal_outcome == "replied":
                    raise ApplicationFailure(409, "message_already_terminal")
                raise ApplicationFailure(409, "idempotency_conflict")
            message.terminal_outcome = request.outcome
            message.terminal_reason = request.reason_code
            message.terminal_fingerprint = fingerprint
            self._fault_after("complete")
            return {
                "message_id": message.message_id,
                "outcome": request.outcome,
                "status": "recorded",
            }

    async def message_outcome_v2(
        self, agent: V2AgentRecord, message_id: str
    ) -> dict[str, object]:
        async with self.changed:
            self._require_active(agent)
            message = self.v2_messages.get(message_id)
            if message is None or agent.agent_id not in (
                message.sender_agent_id,
                message.recipient_agent_id,
            ):
                raise ApplicationFailure(404, "message_not_found")
            return {
                "message_id": message.message_id,
                "conversation_id": message.conversation_id,
                "status": (
                    "terminal" if message.terminal_outcome is not None else "open"
                ),
                "outcome": message.terminal_outcome,
                "reply_message_id": message.reply_message_id,
            }

    async def acknowledge_message_v2(
        self, agent: V2AgentRecord, message_id: str
    ) -> dict[str, str]:
        async with self.changed:
            self._fault_before("ack")
            self._require_active(agent)
            message = self._owned_message(agent, message_id)
            if message.terminal_outcome is None:
                raise ApplicationFailure(409, "message_not_terminal")
            message.acknowledged = True
            message.lease_until = None
            message.text = SecretStr("")
            self.changed.notify_all()
            self._fault_after("ack")
            return {"message_id": message_id, "status": "acked"}

    async def reissue_token_v2(
        self,
        agent: V2AgentRecord,
        current_token: str,
        request_id: str,
    ) -> dict[str, object]:
        async with self.changed:
            self._fault_before("reissue")
            self._charge_application_request(agent.agent_id)
            self._prune_v2_records()
            key = (agent.agent_id, request_id)
            prior = self.v2_reissue_results.get(key)
            if prior is not None:
                return {
                    "token": prior.token.get_secret_value(),
                    "token_type": "DPoP",
                    "expires_in": 86_400,
                }
            self._ensure_idempotency_key_available(
                "reissue.v1", agent.agent_id, request_id
            )
            recent = [
                timestamp
                for timestamp in self.v2_reissue_attempts.get(agent.agent_id, [])
                if timestamp + 86_400 > self.v2_clock
            ]
            if len(recent) >= 4:
                raise ApplicationFailure(429, "rate_limited", retry_after_ms=60_000)
            current = self.v2_tokens[current_token]
            if self.v2_clock <= current.issued_at:
                raise ApplicationFailure(
                    429, "rate_limited", retry_after_ms=1_000
                )
            active_same_key = sum(
                1
                for token in self.v2_tokens.values()
                if token.agent_id == agent.agent_id
                and token.jkt == current.jkt
                and not token.revoked
                and token.expires_at > self.v2_clock
            )
            if active_same_key >= 3:
                raise ApplicationFailure(429, "rate_limited", retry_after_ms=60_000)
            retained = sum(
                1
                for (agent_id, _request_id) in self.v2_reissue_results
                if agent_id == agent.agent_id
            )
            if retained >= 8:
                raise ApplicationFailure(429, "rate_limited", retry_after_ms=60_000)
            token = self._issue_v2_token(agent, current.jkt)
            self.v2_reissue_results[key] = ReissueIdempotencyRecord(
                agent_id=agent.agent_id,
                request_id=request_id,
                created_at=self.v2_clock,
                token=SecretStr(token),
            )
            self._claim_idempotency_key("reissue.v1", agent.agent_id, request_id)
            recent.append(self.v2_clock)
            self.v2_reissue_attempts[agent.agent_id] = recent
            self._fault_after("reissue")
            return {"token": token, "token_type": "DPoP", "expires_in": 86_400}

    async def revoke_tokens_v2(self, agent: V2AgentRecord) -> None:
        async with self.changed:
            self._fault_before("revoke")
            self._charge_application_request(agent.agent_id)
            for record in self.v2_tokens.values():
                if record.agent_id == agent.agent_id:
                    record.revoked = True
                    self.v2_revoked_token_ids.add(record.token_jti)
            self._fault_after("revoke")

    async def advance_v2_clock(self, seconds: int) -> dict[str, int]:
        async with self.changed:
            self.v2_clock += seconds
            self._prune_v2_records()
            self.changed.notify_all()
            return {"now": self.v2_clock}

    async def set_v2_grant(self, request: V2GrantRequest) -> dict[str, str]:
        async with self.changed:
            sender_id = self.v2_agent_ids_by_username.get(request.sender_username)
            recipient_id = self.v2_agent_ids_by_username.get(
                request.recipient_username
            )
            if sender_id is None or recipient_id is None:
                raise RecordNotFound("fixture agent not found")
            key = (sender_id, recipient_id)
            if request.active:
                self.v2_grants.add(key)
            else:
                self.v2_grants.discard(key)
            return {"status": "ok"}

    async def inject_v2_message(
        self, request: V2InjectMessageRequest
    ) -> dict[str, str]:
        async with self.changed:
            sender_id = self.v2_agent_ids_by_username.get(request.sender_username)
            recipient_id = self.v2_agent_ids_by_username.get(
                request.recipient_username
            )
            if sender_id is None or recipient_id is None:
                raise RecordNotFound("fixture agent not found")
            message = self._queue_message(
                sender_agent_id=sender_id,
                recipient_agent_id=recipient_id,
                text=request.text,
                conversation_id=request.conversation_id,
                in_reply_to_message_id=request.in_reply_to_message_id,
            )
            return {
                "message_id": message.message_id,
                "conversation_id": message.conversation_id,
            }

    async def set_v2_fault(self, request: V2FaultRequest) -> dict[str, str]:
        async with self.changed:
            self.v2_faults[request.operation] = request.mode
            return {"status": "ok"}

    async def inspect_v2(self, request: V2InspectRequest) -> dict[str, object]:
        async with self.changed:
            agents = [
                {
                    "agent_id": agent.agent_id,
                    "verified": agent.verified,
                    "delivery_version": agent.delivery_version,
                    "inbound_enabled": agent.inbound_enabled,
                }
                for agent in self.v2_agents.values()
                if request.agent_id is None or request.agent_id == agent.agent_id
            ]
            messages = [
                {
                    "message_id": message.message_id,
                    "conversation_id": message.conversation_id,
                    "recipient_agent_id": message.recipient_agent_id,
                    "leased": (
                        message.lease_until is not None
                        and message.lease_until > self.v2_clock
                    ),
                    "terminal": message.terminal_outcome is not None,
                    "acknowledged": message.acknowledged,
                }
                for message in self.v2_messages.values()
                if request.message_id is None
                or request.message_id == message.message_id
            ]
            return {
                "now": self.v2_clock,
                "agents": agents,
                "messages": messages,
                "replay_entries": len(self.v2_replay),
            }


T = TypeVar("T")


async def for_mcp(operation: Awaitable[T]) -> T:
    try:
        return await operation
    except FixtureStateError as error:
        raise ToolError(str(error)) from None


def as_http_error(error: FixtureStateError) -> HTTPException:
    if isinstance(error, AuthenticationFailed):
        code = status.HTTP_401_UNAUTHORIZED
    elif isinstance(error, RecordConflict):
        code = status.HTTP_409_CONFLICT
    else:
        code = status.HTTP_404_NOT_FOUND
    return HTTPException(status_code=code, detail=str(error))


def create_fixture() -> tuple[FixtureState, FastMCP, FastAPI]:
    state = FixtureState()
    mcp = FastMCP("A2A central test fixture")

    @mcp.tool
    async def register_agent(
        username: Username, email: str, display_name: str | None = None
    ) -> RegistrationResponse:
        """Register an agent and queue its deterministic verification code."""
        return await for_mcp(state.register(username, email, display_name))

    @mcp.tool
    async def verify_email(email: str, code: str) -> VerificationResponse:
        """Verify a registered email and issue its in-memory central token."""
        return await for_mcp(state.verify(email, code))

    @mcp.tool
    async def resend_verification(email: str) -> StatusResponse:
        """Restore the deterministic code for an unverified registration."""
        return await for_mcp(state.resend(email))

    @mcp.tool
    async def list_action_types(token: str) -> ActionTypesResponse:
        """List action types supported by the fixture."""
        return await for_mcp(state.list_action_types(token))

    @mcp.tool
    async def request_permission(
        token: str,
        target_username: str,
        action_type: str,
        scope: dict | None = None,
    ) -> PermissionResponse:
        """Request permission to call an action on another verified agent."""
        return await for_mcp(
            state.request_permission(token, target_username, action_type, scope)
        )

    @mcp.tool
    async def respond_to_permission(
        token: str,
        permission_id: str,
        decision: Literal["granted", "denied"],
    ) -> PermissionResponse:
        """Grant or deny a permission request addressed to this agent."""
        return await for_mcp(
            state.respond_to_permission(token, permission_id, decision)
        )

    @mcp.tool
    async def call_action(
        token: str,
        target_username: str,
        action_type: str,
        payload: dict,
    ) -> ActionResponse:
        """Queue an action call covered by a granted permission."""
        return await for_mcp(
            state.call_action(token, target_username, action_type, payload)
        )

    @mcp.tool
    async def poll_messages(token: str, timeout: int = 30) -> ContentPollResponse:
        """Return queued messages and atomically mark them delivered."""
        return await for_mcp(state.poll_messages(token, timeout))

    @mcp.tool
    async def get_my_permissions(
        token: str, status: str = "all"
    ) -> PermissionsResponse:
        """List permissions requested by the authenticated agent."""
        return await for_mcp(state.get_my_permissions(token, status))

    @mcp.tool
    async def ack_message(token: str, message_id: str) -> AcknowledgementResponse:
        """Acknowledge a delivered message."""
        return await for_mcp(state.ack_message(token, message_id))

    @mcp.tool
    async def health_check() -> StatusResponse:
        """Return fixture health without a central token argument."""
        return StatusResponse()

    current_v2_agent_id: ContextVar[str | None] = ContextVar(
        "a2a_fixture_v2_agent_id", default=None
    )
    mcp_v2 = FastMCP("A2A central version 2 test fixture")

    def current_v2_agent() -> V2AgentRecord:
        agent_id = current_v2_agent_id.get()
        if agent_id is None:
            raise ToolError("authentication failed")
        return state.v2_agents[agent_id]

    async def for_mcp_v2(operation: Awaitable[T]) -> T:
        try:
            return await operation
        except ApplicationFailure as error:
            raise ToolError(error.code) from None
        except FixtureStateError:
            raise ToolError("central_contract_failed") from None

    @mcp_v2.tool
    async def list_action_types() -> ActionTypesResponse:
        """List action types after transport authentication."""
        return await for_mcp_v2(
            state.list_action_types_v2(current_v2_agent())
        )

    @mcp_v2.tool
    async def request_permission(
        target_username: Username,
        action_type: ActionType,
        scope: dict | None = None,
    ) -> PermissionResponse:
        """Request permission using the transport-authenticated identity."""
        return await for_mcp_v2(
            state.request_permission_v2(
                current_v2_agent(), target_username, action_type, scope
            )
        )

    @mcp_v2.tool
    async def respond_to_permission(
        permission_id: PermissionId,
        decision: Literal["granted", "denied"],
    ) -> PermissionResponse:
        """Grant or deny a permission addressed to this identity."""
        return await for_mcp_v2(
            state.respond_to_permission_v2(
                current_v2_agent(), permission_id, decision
            )
        )

    @mcp_v2.tool
    async def call_action(
        target_username: Username,
        action_type: ActionType,
        payload: dict,
    ) -> ActionResponse:
        """Queue an authorized action using the transport identity."""
        return await for_mcp_v2(
            state.call_action_v2(
                current_v2_agent(), target_username, action_type, payload
            )
        )

    @mcp_v2.tool
    async def get_my_permissions(
        status: Literal["all", "pending", "granted", "denied"] = "all",
    ) -> PermissionsResponse:
        """List permissions requested by the transport identity."""
        return await for_mcp_v2(
            state.get_my_permissions_v2(current_v2_agent(), status)
        )

    @mcp_v2.tool
    async def start_conversation(
        recipient_username: str,
        payload: dict,
        request_id: str,
    ) -> dict[str, str]:
        """Create one version 2 conversation turn."""
        if UUID_V4_PATTERN.fullmatch(request_id) is None:
            raise ToolError("invalid_request")
        try:
            request = ConversationStartRequest.model_validate(
                {"recipient_username": recipient_username, "payload": payload}
            )
        except ValueError:
            raise ToolError("invalid_request") from None
        result, _repeated = await for_mcp_v2(
            state.start_conversation_v2(current_v2_agent(), request_id, request)
        )
        return result

    @mcp_v2.tool
    async def get_conversation_start(request_id: str) -> dict[str, object]:
        """Resolve a conversation-start request by opaque request ID."""
        if UUID_V4_PATTERN.fullmatch(request_id) is None:
            raise ToolError("invalid_request")
        return await for_mcp_v2(
            state.conversation_start_v2(current_v2_agent(), request_id)
        )

    @mcp_v2.tool
    async def receive_messages(
        timeout_seconds: int = 30, limit: int = 100
    ) -> dict[str, object]:
        """Lease the oldest bounded version 2 message batch."""
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, int)
            or timeout_seconds < 0
            or timeout_seconds > 30
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or limit < 1
            or limit > 100
        ):
            raise ToolError("invalid_request")
        return await for_mcp_v2(
            state.receive_messages_v2(
                current_v2_agent(), timeout_seconds, limit
            )
        )

    @mcp_v2.tool
    async def reply_message(message_id: str, payload: dict) -> dict[str, str]:
        """Reply once to an inbound version 2 message."""
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ToolError("invalid_request")
        try:
            request = ReplyRequest.model_validate({"payload": payload})
        except ValueError:
            raise ToolError("invalid_request") from None
        return await for_mcp_v2(
            state.reply_message_v2(current_v2_agent(), message_id, request)
        )

    @mcp_v2.tool
    async def complete_message(
        message_id: str, outcome: str, reason_code: str
    ) -> dict[str, str]:
        """Record one terminal no-reply outcome."""
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ToolError("invalid_request")
        try:
            request = CompletionRequest.model_validate(
                {"outcome": outcome, "reason_code": reason_code}
            )
        except ValueError:
            raise ToolError("invalid_request") from None
        return await for_mcp_v2(
            state.complete_message_v2(current_v2_agent(), message_id, request)
        )

    @mcp_v2.tool
    async def get_message_outcome(message_id: str) -> dict[str, object]:
        """Inspect content-free terminal state for one message."""
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ToolError("invalid_request")
        return await for_mcp_v2(
            state.message_outcome_v2(current_v2_agent(), message_id)
        )

    @mcp_v2.tool
    async def ack_message(message_id: str) -> dict[str, str]:
        """Acknowledge one terminal version 2 message."""
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ToolError("invalid_request")
        return await for_mcp_v2(
            state.acknowledge_message_v2(current_v2_agent(), message_id)
        )

    @mcp_v2.tool
    async def health_check() -> StatusResponse:
        """Return fixture health after transport authentication."""
        current_v2_agent()
        return StatusResponse()

    mcp_app = mcp.http_app(path="/mcp")
    mcp_v2_app = mcp_v2.http_app(path="/mcp")

    @asynccontextmanager
    async def fixture_lifespan(application: FastAPI):
        async with mcp_app.lifespan(application):
            async with mcp_v2_app.lifespan(application):
                yield

    api = FastAPI(
        title="A2A central test fixture",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
        lifespan=fixture_lifespan,
        routes=[*mcp_app.routes],
    )
    bearer = HTTPBearer(auto_error=False)
    test_control_token = os.environ.get(
        "A2A_TEST_CONTROL_TOKEN", "central-fixture-control"
    )

    async def central_token(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    ) -> str:
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="authentication failed",
            )
        return credentials.credentials

    async def test_control(
        supplied: Annotated[str | None, Header(alias="X-A2A-Test-Key")] = None,
    ) -> None:
        if supplied is None or not secrets.compare_digest(supplied, test_control_token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="test control authentication failed",
            )

    def application_error_response(
        request: Request,
        status_code: int,
        code: str,
        retry_after_ms: int | None = None,
    ) -> JSONResponse:
        if request.url.path in (
            "/api/register",
            "/api/verify_email",
            "/api/resend_verification",
        ):
            body: object = {"error": {"code": code}}
        else:
            body = {"error": {"code": code, "retry_after_ms": retry_after_ms}}
        headers = {"Cache-Control": "no-store"}
        if retry_after_ms is not None:
            headers["Retry-After"] = str(max(1, (retry_after_ms + 999) // 1000))
        return JSONResponse(status_code=status_code, content=body, headers=headers)

    @api.exception_handler(ApplicationFailure)
    async def application_failure_handler(
        request: Request, error: ApplicationFailure
    ) -> JSONResponse:
        return application_error_response(
            request, error.status_code, error.code, error.retry_after_ms
        )

    def dpop_error_response(error: DPoPFailure) -> JSONResponse:
        headers = {"Cache-Control": "no-store"}
        if error.nonce is not None:
            headers["DPoP-Nonce"] = error.nonce
        if not error.issuance and error.status_code == 401:
            headers["WWW-Authenticate"] = f'DPoP error="{error.error}"'
        if error.status_code == 429:
            headers["Retry-After"] = "1"
        return JSONResponse(
            status_code=error.status_code,
            content={"error": error.error},
            headers=headers,
        )

    @api.exception_handler(DPoPFailure)
    async def dpop_failure_handler(
        _request: Request, error: DPoPFailure
    ) -> JSONResponse:
        return dpop_error_response(error)

    @api.exception_handler(DropAfterCommit)
    async def drop_after_commit_handler(
        request: Request, _error: DropAfterCommit
    ) -> JSONResponse:
        return application_error_response(
            request, 503, "temporarily_unavailable"
        )

    @api.exception_handler(RequestValidationError)
    async def validation_failure_handler(
        request: Request, _error: RequestValidationError
    ) -> JSONResponse:
        bounded = request.url.path in (
            "/api/register",
            "/api/verify_email",
            "/api/resend_verification",
        ) or request.url.path.startswith("/api/v2/")
        if not bounded:
            return JSONResponse(status_code=422, content={"detail": "invalid request"})
        status_code = (
            422
            if request.url.path
            in ("/api/register", "/api/verify_email", "/api/resend_verification")
            else 400
        )
        return application_error_response(request, status_code, "invalid_request")

    @api.middleware("http")
    async def enforce_v2_wire_bounds(request: Request, call_next: object) -> Response:
        path = request.url.path
        bootstrap = path in (
            "/api/register",
            "/api/verify_email",
            "/api/resend_verification",
        )
        bounded = bootstrap or path.startswith("/api/v2/")
        if bounded:
            raw_headers = request.scope.get("headers", [])
            header_bytes = sum(len(name) + len(value) + 4 for name, value in raw_headers)
            if header_bytes > 16_384:
                if path.startswith("/api/v2/"):
                    return dpop_error_response(DPoPFailure(401, "invalid_token"))
                return application_error_response(request, 422, "invalid_request")
            authorization_count = sum(
                1
                for name, _value in raw_headers
                if name.lower() == b"authorization"
            )
            proof_count = sum(
                1 for name, _value in raw_headers if name.lower() == b"dpop"
            )
            if path in ("/api/register", "/api/resend_verification"):
                if authorization_count != 0 or proof_count != 0:
                    return application_error_response(
                        request, 422, "invalid_request"
                    )
            elif path == "/api/verify_email":
                if authorization_count != 0 or proof_count != 1:
                    return dpop_error_response(
                        DPoPFailure(
                            400, "invalid_dpop_proof", issuance=True
                        )
                    )
                try:
                    htu = request_external_htu(request)
                    jkt, replacement_nonce = state.authenticate_issuance(
                        request.headers.get("dpop"),
                        method=request.method,
                        htu=htu,
                    )
                except ValueError:
                    return dpop_error_response(
                        DPoPFailure(
                            400, "invalid_dpop_proof", issuance=True
                        )
                    )
                except DPoPFailure as error:
                    return dpop_error_response(error)
                request.state.v2_issuance_jkt = jkt
                if replacement_nonce is not None:
                    request.state.dpop_replacement_nonce = replacement_nonce
            if path.startswith("/api/v2/"):
                if authorization_count != 1:
                    return dpop_error_response(DPoPFailure(401, "invalid_token"))
                if proof_count != 1:
                    return dpop_error_response(
                        DPoPFailure(401, "invalid_dpop_proof")
                    )
                authorization = request.headers.get("authorization")
                proof = request.headers.get("dpop")
                try:
                    htu = request_external_htu(request)
                    agent, replacement_nonce = state.authenticate_resource(
                        authorization=authorization,
                        proof=proof,
                        method=request.method,
                        htu=htu,
                        operation=operation_for_path(path),
                    )
                except ValueError:
                    return dpop_error_response(
                        DPoPFailure(401, "invalid_dpop_proof")
                    )
                except DPoPFailure as error:
                    return dpop_error_response(error)
                if authorization is None:
                    return dpop_error_response(DPoPFailure(401, "invalid_token"))
                request.state.v2_authentication = (
                    agent,
                    authorization.split(" ", 1)[1],
                )
                if replacement_nonce is not None:
                    request.state.dpop_replacement_nonce = replacement_nonce
            for checked_name in (
                b"authorization",
                b"dpop",
                b"idempotency-key",
                b"content-length",
                b"content-type",
            ):
                if sum(1 for name, _value in raw_headers if name.lower() == checked_name) > 1:
                    return application_error_response(
                        request, 422 if bootstrap else 400, "invalid_request"
                    )
            body_limit = (
                2_048
                if path
                in ("/api/register", "/api/verify_email", "/api/resend_verification")
                else 524_288
            )
            length_header = request.headers.get("content-length")
            if length_header is not None:
                try:
                    declared_length = int(length_header)
                except ValueError:
                    return application_error_response(
                        request, 422 if bootstrap else 400, "invalid_request"
                    )
                if declared_length < 0 or declared_length > body_limit:
                    return application_error_response(
                        request,
                        422 if body_limit == 2_048 else 413,
                        "invalid_request" if body_limit == 2_048 else "request_too_large",
                    )
            if request.headers.get("content-encoding") is not None:
                return application_error_response(
                    request, 422 if bootstrap else 400, "invalid_request"
                )
            body_buffer = bytearray()
            async for chunk in request.stream():
                if len(body_buffer) + len(chunk) > body_limit:
                    return application_error_response(
                        request,
                        422 if body_limit == 2_048 else 413,
                        (
                            "invalid_request"
                            if body_limit == 2_048
                            else "request_too_large"
                        ),
                    )
                body_buffer.extend(chunk)
            body = bytes(body_buffer)
            request._body = body  # type: ignore[attr-defined]
            body_forbidden = path == "/api/v2/delivery/activate" or path.endswith(
                "/ack"
            )
            if body_forbidden and body:
                return application_error_response(request, 400, "invalid_request")
            if body and not body_forbidden:
                media_type = request.headers.get("content-type", "").lower().replace(" ", "")
                if media_type not in (
                    "application/json",
                    "application/json;charset=utf-8",
                ):
                    return application_error_response(
                        request, 422 if bootstrap else 400, "invalid_request"
                    )
                try:
                    parsed = json_without_duplicates(body)
                except ValueError:
                    return application_error_response(
                        request, 422 if bootstrap else 400, "invalid_request"
                    )
                max_depth = 16 if body_limit == 2_048 else 100
                members = 0

                def inspect_json(value: object, depth: int = 0) -> None:
                    nonlocal members
                    if depth > max_depth:
                        raise ValueError("JSON is too deep")
                    if isinstance(value, dict):
                        members += len(value)
                        if members > 1_024:
                            raise ValueError("too many JSON members")
                        for key, nested in value.items():
                            if any(
                                0xD800 <= ord(character) <= 0xDFFF
                                for character in key
                            ):
                                raise ValueError("invalid Unicode scalar")
                            inspect_json(nested, depth + 1)
                    elif isinstance(value, list):
                        members += len(value)
                        if members > 1_024:
                            raise ValueError("too many JSON elements")
                        for nested in value:
                            inspect_json(nested, depth + 1)
                    elif isinstance(value, str) and any(
                        0xD800 <= ord(character) <= 0xDFFF
                        for character in value
                    ):
                        raise ValueError("invalid Unicode scalar")

                try:
                    inspect_json(parsed)
                except ValueError:
                    return application_error_response(
                        request, 422 if bootstrap else 400, "invalid_request"
                    )
        response = await call_next(request)  # type: ignore[operator]
        if bounded:
            response.headers["Cache-Control"] = "no-store"
            replacement_nonce = getattr(
                request.state, "dpop_replacement_nonce", None
            )
            if replacement_nonce is not None:
                response.headers["DPoP-Nonce"] = replacement_nonce
        return response

    def operation_for_path(path: str) -> str:
        if path == "/api/v2/delivery/activate":
            return "activate"
        if path == "/api/v2/conversations":
            return "start"
        if path.endswith("/reply"):
            return "reply"
        if path.endswith("/complete"):
            return "complete"
        if path.endswith("/ack"):
            return "ack"
        if path == "/api/v2/messages/receive":
            return "receive"
        if path == "/api/v2/token/reissue":
            return "reissue"
        if path == "/api/v2/token/revoke":
            return "revoke"
        return "resource"

    async def v2_authentication(request: Request) -> tuple[V2AgentRecord, str]:
        authenticated = getattr(request.state, "v2_authentication", None)
        if authenticated is not None:
            return authenticated
        authorization = request.headers.get("authorization")
        proof = request.headers.get("dpop")
        htu = request_external_htu(request)
        agent, replacement_nonce = state.authenticate_resource(
            authorization=authorization,
            proof=proof,
            method=request.method,
            htu=htu,
            operation=operation_for_path(request.url.path),
        )
        if replacement_nonce is not None:
            request.state.dpop_replacement_nonce = replacement_nonce
        if authorization is None:
            raise DPoPFailure(401, "invalid_token")
        return agent, authorization.split(" ", 1)[1]

    def maybe_invalid_success(operation: str, body: object) -> object:
        if state.v2_faults.get(operation) == "invalid_success":
            state.v2_faults[operation] = "none"
            return {"fixture_invalid_success": True}
        return body

    @api.post("/api/register")
    async def register_rest(request: RestRegistrationRequest) -> object:
        return maybe_invalid_success("register", await state.register_v2(request))

    @api.post("/api/resend_verification")
    async def resend_rest(request: RestResendRequest) -> object:
        return maybe_invalid_success("resend", await state.resend_v2(request))

    @api.post("/api/verify_email")
    async def verify_rest(
        request: RestVerificationRequest,
        http_request: Request,
    ) -> object:
        jkt = getattr(http_request.state, "v2_issuance_jkt", None)
        if jkt is None:
            raise DPoPFailure(400, "invalid_dpop_proof", issuance=True)
        return maybe_invalid_success("verify", await state.verify_v2(request, jkt))

    @api.post("/api/v2/delivery/activate")
    async def activate_delivery(
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        agent, _token = authentication
        return maybe_invalid_success("activate", await state.activate_v2(agent))

    @api.post("/api/v2/conversations")
    async def start_conversation_rest(
        request: ConversationStartRequest,
        idempotency_key: Annotated[
            str | None, Header(alias="Idempotency-Key")
        ] = None,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> JSONResponse:
        if idempotency_key is None or UUID_V4_PATTERN.fullmatch(idempotency_key) is None:
            raise ApplicationFailure(400, "invalid_request")
        agent, _token = authentication
        body, repeated = await state.start_conversation_v2(
            agent, idempotency_key, request
        )
        body = maybe_invalid_success("start", body)
        return JSONResponse(
            status_code=200 if repeated else 201,
            content=body,
            headers={"Cache-Control": "no-store"},
        )

    @api.get("/api/v2/conversation-starts/{request_id}")
    async def get_conversation_start_rest(
        request_id: str,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        if UUID_V4_PATTERN.fullmatch(request_id) is None:
            raise ApplicationFailure(400, "invalid_request")
        agent, _token = authentication
        return await state.conversation_start_v2(agent, request_id)

    @api.get("/api/v2/messages/receive")
    async def receive_messages_rest(
        timeout: Annotated[int, Query(ge=0, le=30)],
        limit: Annotated[int, Query(ge=1, le=100)],
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        agent, _token = authentication
        return maybe_invalid_success(
            "receive", await state.receive_messages_v2(agent, timeout, limit)
        )

    @api.post("/api/v2/messages/{message_id}/reply")
    async def reply_message_rest(
        message_id: str,
        request: ReplyRequest,
        idempotency_key: Annotated[
            str | None, Header(alias="Idempotency-Key")
        ] = None,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ApplicationFailure(400, "invalid_request")
        expected_key = "reply.v1." + b64url_encode(
            hashlib.sha256(message_id.encode("utf-8")).digest()
        )
        if idempotency_key != expected_key:
            raise ApplicationFailure(400, "invalid_request")
        agent, _token = authentication
        return maybe_invalid_success(
            "reply", await state.reply_message_v2(agent, message_id, request)
        )

    @api.post("/api/v2/messages/{message_id}/complete")
    async def complete_message_rest(
        message_id: str,
        request: CompletionRequest,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ApplicationFailure(400, "invalid_request")
        agent, _token = authentication
        return maybe_invalid_success(
            "complete", await state.complete_message_v2(agent, message_id, request)
        )

    @api.get("/api/v2/messages/{message_id}/outcome")
    async def message_outcome_rest(
        message_id: str,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ApplicationFailure(400, "invalid_request")
        agent, _token = authentication
        return await state.message_outcome_v2(agent, message_id)

    @api.post("/api/v2/messages/{message_id}/ack")
    async def acknowledge_message_rest(
        message_id: str,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        if URI_ID_PATTERN.fullmatch(message_id) is None:
            raise ApplicationFailure(400, "invalid_request")
        agent, _token = authentication
        return maybe_invalid_success(
            "ack", await state.acknowledge_message_v2(agent, message_id)
        )

    @api.post("/api/v2/token/reissue")
    async def reissue_token_rest(
        request: EmptyRequest,
        idempotency_key: Annotated[
            str | None, Header(alias="Idempotency-Key")
        ] = None,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> object:
        del request
        if idempotency_key is None or UUID_V4_PATTERN.fullmatch(idempotency_key) is None:
            raise ApplicationFailure(400, "invalid_request")
        agent, current_token = authentication
        return maybe_invalid_success(
            "reissue",
            await state.reissue_token_v2(agent, current_token, idempotency_key),
        )

    @api.post("/api/v2/token/revoke", status_code=204)
    async def revoke_token_rest(
        request: RevokeRequest,
        authentication: tuple[V2AgentRecord, str] = Depends(v2_authentication),
    ) -> Response:
        del request
        agent, _token = authentication
        await state.revoke_tokens_v2(agent)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    @api.get("/healthz", response_model=StatusResponse)
    async def health() -> StatusResponse:
        return StatusResponse()

    @api.get("/readyz", response_model=StatusResponse)
    async def readiness() -> StatusResponse:
        return StatusResponse()

    @api.get("/api/poll_messages", response_model=ContentPollResponse)
    async def poll_messages(
        timeout: Annotated[int, Query(ge=0, le=30)],
        token: str = Depends(central_token),
    ) -> ContentPollResponse:
        try:
            return await state.poll_messages(token, timeout)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post("/api/ack_message", response_model=AcknowledgementResponse)
    async def ack_message(
        request: AckMessageRequest,
        token: str = Depends(central_token),
    ) -> AcknowledgementResponse:
        try:
            return await state.ack_message(token, request.message_id)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post(
        "/__test/reset",
        response_model=StatusResponse,
        dependencies=[Depends(test_control)],
    )
    async def reset() -> StatusResponse:
        await state.reset()
        return StatusResponse()

    @api.post(
        "/__test/verification-code",
        response_model=VerificationCodeResponse,
        dependencies=[Depends(test_control)],
    )
    async def verification_code(
        request: VerificationCodeRequest,
    ) -> VerificationCodeResponse:
        try:
            return await state.verification_code_for(request.email)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post(
        "/__test/messages",
        response_model=MessageIdResponse,
        dependencies=[Depends(test_control)],
    )
    async def inject_message(request: InjectMessageRequest) -> MessageIdResponse:
        try:
            return await state.inject(request)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post(
        "/__test/inspect",
        response_model=InspectionResponse,
        dependencies=[Depends(test_control)],
    )
    async def inspect(request: InspectRequest) -> InspectionResponse:
        return await state.inspect(request)

    @api.post(
        "/__test/v2/verification-code",
        dependencies=[Depends(test_control)],
    )
    async def verification_code_v2(request: RestResendRequest) -> object:
        try:
            return await state.verification_code_for_v2(request.email)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post(
        "/__test/v2/clock",
        dependencies=[Depends(test_control)],
    )
    async def advance_clock_v2(request: AdvanceClockRequest) -> object:
        return await state.advance_v2_clock(request.seconds)

    @api.post(
        "/__test/v2/grants",
        dependencies=[Depends(test_control)],
    )
    async def grant_v2(request: V2GrantRequest) -> object:
        try:
            return await state.set_v2_grant(request)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post(
        "/__test/v2/messages",
        dependencies=[Depends(test_control)],
    )
    async def inject_message_v2(request: V2InjectMessageRequest) -> object:
        try:
            return await state.inject_v2_message(request)
        except FixtureStateError as error:
            raise as_http_error(error) from None

    @api.post(
        "/__test/v2/faults",
        dependencies=[Depends(test_control)],
    )
    async def faults_v2(request: V2FaultRequest) -> object:
        return await state.set_v2_fault(request)

    @api.post(
        "/__test/v2/inspect",
        dependencies=[Depends(test_control)],
    )
    async def inspect_state_v2(request: V2InspectRequest) -> object:
        return await state.inspect_v2(request)

    @api.get(
        "/__test/v2/profile",
        dependencies=[Depends(test_control)],
    )
    async def profile_v2() -> object:
        return {
            "issuer": FIXTURE_ISSUER,
            "audience": [FIXTURE_API_AUDIENCE, FIXTURE_MCP_AUDIENCE],
            "issuer_public_jwk": state._public_jwk(
                state.v2_issuer_key.public_key()
            ),
            "seeded_agent_ids": [
                "agent_fixture_0001",
                "agent_fixture_0002",
                "agent_fixture_0003",
                "agent_fixture_0004",
            ],
        }

    @api.post(
        "/__test/v2/nonce-key/rotate",
        dependencies=[Depends(test_control)],
    )
    async def rotate_nonce_key_v2() -> object:
        async with state.changed:
            state.v2_previous_nonce_key = state.v2_nonce_key
            state.v2_previous_nonce_key_until = state.v2_clock + 305
            state.v2_nonce_key = hashlib.sha256(
                state.v2_nonce_key + state.v2_clock.to_bytes(8, "big")
            ).digest()
            return {"status": "ok"}

    class VersionedFixtureApplication:
        async def __call__(self, scope: dict, receive: object, send: object) -> None:
            is_v2_mcp = False
            if scope.get("type") == "http" and scope.get("path") == "/mcp":
                raw_headers = scope.get("headers", [])
                authorization_values = [
                    value
                    for name, value in raw_headers
                    if name.lower() == b"authorization"
                ]
                proof_values = [
                    value for name, value in raw_headers if name.lower() == b"dpop"
                ]
                is_v2_mcp = bool(authorization_values or proof_values)
                if is_v2_mcp:
                    header_size = sum(
                        len(name) + len(value) + 4 for name, value in raw_headers
                    )
                    if header_size > 16_384 or len(authorization_values) != 1:
                        failure = DPoPFailure(401, "invalid_token")
                    elif len(proof_values) != 1:
                        failure = DPoPFailure(401, "invalid_dpop_proof")
                    else:
                        try:
                            authorization_value = authorization_values[0].decode(
                                "ascii", errors="strict"
                            )
                        except UnicodeDecodeError:
                            failure = DPoPFailure(401, "invalid_token")
                        else:
                            try:
                                proof_value = proof_values[0].decode(
                                    "ascii", errors="strict"
                                )
                            except UnicodeDecodeError:
                                failure = DPoPFailure(
                                    401, "invalid_dpop_proof"
                                )
                            else:
                                failure = None
                        if failure is None:
                            try:
                                request = Request(scope)  # type: ignore[arg-type]
                                agent, replacement_nonce = state.authenticate_resource(
                                    authorization=authorization_value,
                                    proof=proof_value,
                                    method=str(scope.get("method", "")),
                                    htu=request_external_htu(request),
                                    security_domain="mcp",
                                    operation="mcp",
                                )
                            except ValueError:
                                failure = DPoPFailure(
                                    401, "invalid_dpop_proof"
                                )
                            except DPoPFailure as error:
                                failure = error
                    if failure is not None:
                        headers = {"Cache-Control": "no-store"}
                        if failure.nonce is not None:
                            headers["DPoP-Nonce"] = failure.nonce
                        if failure.status_code == 401:
                            headers["WWW-Authenticate"] = (
                                f'DPoP error="{failure.error}"'
                            )
                        response = JSONResponse(
                            status_code=failure.status_code,
                            content={"error": failure.error},
                            headers=headers,
                        )
                        await response(scope, receive, send)  # type: ignore[arg-type]
                        return
                    mcp_receive = receive
                    if scope.get("method") == "POST":
                        request_body = bytearray()
                        while True:
                            request_message = await receive()  # type: ignore[operator]
                            if request_message.get("type") != "http.request":
                                break
                            chunk = request_message.get("body", b"")
                            if not isinstance(chunk, bytes):
                                chunk = bytes(chunk)
                            if len(request_body) + len(chunk) > 1_048_576:
                                response_headers = {"Cache-Control": "no-store"}
                                if replacement_nonce is not None:
                                    response_headers["DPoP-Nonce"] = replacement_nonce
                                response = JSONResponse(
                                    status_code=413,
                                    content={"error": "invalid_request"},
                                    headers=response_headers,
                                )
                                await response(scope, receive, send)  # type: ignore[arg-type]
                                return
                            request_body.extend(chunk)
                            if not request_message.get("more_body", False):
                                break

                        try:
                            rpc_request = json_without_duplicates(bytes(request_body))
                        except (UnicodeDecodeError, ValueError):
                            rpc_request = None
                        arguments = None
                        if (
                            isinstance(rpc_request, dict)
                            and rpc_request.get("method") == "tools/call"
                            and isinstance(rpc_request.get("params"), dict)
                        ):
                            arguments = rpc_request["params"].get("arguments")
                        if isinstance(arguments, dict) and any(
                            str(name).casefold()
                            in {"authorization", "access_token", "jwt", "token"}
                            for name in arguments
                        ):
                            response_headers = {"Cache-Control": "no-store"}
                            if replacement_nonce is not None:
                                response_headers["DPoP-Nonce"] = replacement_nonce
                            response = JSONResponse(
                                status_code=200,
                                content={
                                    "jsonrpc": "2.0",
                                    "id": rpc_request.get("id"),
                                    "result": {
                                        "content": [
                                            {"type": "text", "text": "invalid_request"}
                                        ],
                                        "isError": True,
                                    },
                                },
                                headers=response_headers,
                            )
                            await response(scope, receive, send)  # type: ignore[arg-type]
                            return

                        replayed = False

                        async def replay_receive() -> dict:
                            nonlocal replayed
                            if not replayed:
                                replayed = True
                                return {
                                    "type": "http.request",
                                    "body": bytes(request_body),
                                    "more_body": False,
                                }
                            return await receive()  # type: ignore[operator]

                        mcp_receive = replay_receive
                    token = current_v2_agent_id.set(agent.agent_id)

                    async def secure_send(message: dict) -> None:
                        if message.get("type") == "http.response.start":
                            headers = list(message.get("headers", []))
                            headers.append((b"cache-control", b"no-store"))
                            if replacement_nonce is not None:
                                headers.append(
                                    (b"dpop-nonce", replacement_nonce.encode("ascii"))
                                )
                            message["headers"] = headers
                        await send(message)  # type: ignore[operator]

                    try:
                        await mcp_v2_app(scope, mcp_receive, secure_send)  # type: ignore[arg-type]
                    finally:
                        current_v2_agent_id.reset(token)
                    return
            await api(scope, receive, send)  # type: ignore[arg-type]

    return state, mcp, VersionedFixtureApplication()  # type: ignore[return-value]


fixture_state, mcp, app = create_fixture()
