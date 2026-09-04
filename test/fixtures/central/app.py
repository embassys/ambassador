from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field


FIXTURE_CLOCK_START = 1_788_220_800
TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60
VERIFICATION_CODE = "314159"
TOKEN_SECRET = b"current-python-central-fixture-hs256-secret"
CONTROL_TOKEN = os.environ.get("A2A_TEST_CONTROL_TOKEN", "central-fixture-control")
EMAIL_PATTERN = re.compile(r"^[\w.-]+@[\w.-]+\.\w+$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{1,128}$")
BASE64URL_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64url_decode(value: str) -> bytes:
    if not value or BASE64URL_PATTERN.fullmatch(value) is None:
        raise ValueError("invalid base64url")
    decoded = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    if b64url_encode(decoded) != value:
        raise ValueError("noncanonical base64url")
    return decoded


def encoded_json(value: object) -> str:
    return b64url_encode(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def decoded_json_segment(value: str) -> dict[str, Any]:
    parsed = json.loads(b64url_decode(value).decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("invalid JWT object")
    return parsed


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class PublicJwk(StrictModel):
    kty: Literal["EC"]
    crv: Literal["P-256"]
    x: str
    y: str

    def public_key(self) -> ec.EllipticCurvePublicKey:
        x = b64url_decode(self.x)
        y = b64url_decode(self.y)
        if len(x) != 32 or len(y) != 32:
            raise ValueError("invalid P-256 coordinate")
        return ec.EllipticCurvePublicNumbers(
            int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()
        ).public_key()


class RegisterRequest(StrictModel):
    email: str
    display_name: str | None = Field(default=None, min_length=1, max_length=128)


class VerifyRequest(StrictModel):
    email: str
    code: str = Field(pattern=r"^\d{6}$")
    jwk: PublicJwk


class ResendRequest(StrictModel):
    email: str


class PermissionRequest(StrictModel):
    target_email: str | None = None
    message_id: str | None = None
    action_type: str | None = Field(default=None, min_length=1, max_length=128)
    permission_type: str | None = Field(default=None, min_length=1, max_length=128)
    decision_options: Literal["accept_deny", "once_always"] = "accept_deny"
    reason: str | None = Field(default=None, max_length=500)
    scope: dict[str, Any] | None = None


class PermissionDecisionRequest(StrictModel):
    token: str
    decision: Literal["accept", "deny", "allow_once", "allow_always"]


class HumanInputOption(StrictModel):
    label: str = Field(min_length=1, max_length=64)
    value: str = Field(min_length=1, max_length=64)


class HumanInputRequest(StrictModel):
    permission_type: str | None = Field(default=None, min_length=1, max_length=128)
    action_type: str | None = Field(default=None, min_length=1, max_length=128)
    request: str = Field(min_length=1, max_length=2000)
    input_type: Literal["buttons", "text"] = "text"
    options: list[str | HumanInputOption] | None = Field(default=None, max_length=10)
    message_id: str | None = None


class HumanInputResponseRequest(StrictModel):
    token: str = Field(min_length=16, max_length=512)
    value: str | None = Field(default=None, max_length=64)
    text: str | None = Field(default=None, max_length=4000)


class ActionCall(StrictModel):
    target_email: str
    action_type: str = Field(min_length=1, max_length=128)
    payload: dict[str, Any]


class ActionResult(StrictModel):
    call_id: str
    result: dict[str, Any]
    status: Literal["success", "error"]


class MessageAck(StrictModel):
    message_id: str


@dataclass
class Identity:
    id: str
    email: str
    code: str = VERIFICATION_CODE
    verified: bool = False
    public_jwk: dict[str, str] | None = None
    thumbprint: str | None = None


@dataclass
class Permission:
    id: str
    grantor_email: str
    grantee_email: str
    action_type: str
    scope: dict[str, Any]
    decision_options: Literal["accept_deny", "once_always"] = "accept_deny"
    reason: str | None = None
    status: Literal["pending", "granted", "denied"] = "pending"
    decision: Literal["accept", "deny", "allow_once", "allow_always"] | None = None
    uses_remaining: int | None = None
    created_at: str = ""
    decided_at: str | None = None


@dataclass
class ActionCallRecord:
    id: str
    caller_email: str
    target_email: str
    action_type: str
    status: Literal["pending", "completed", "failed"] = "pending"
    result: dict[str, Any] | None = None


@dataclass
class HumanInput:
    id: str
    agent_email: str
    action_type: str
    prompt: str
    input_type: Literal["buttons", "text"]
    options: list[dict[str, str]] | None
    message_id: str | None
    status: Literal["pending", "answered"] = "pending"
    response_value: str | None = None
    response_text: str | None = None


@dataclass
class Message:
    id: str
    recipient_email: str
    sender_agent_id: str
    action_type_id: str | None
    payload: dict[str, Any]
    created_at: str
    state: Literal["queued", "delivered", "acked"] = "queued"


@dataclass
class FixtureState:
    now: int = FIXTURE_CLOCK_START
    sequence: int = 0
    identities: dict[str, Identity] = field(default_factory=dict)
    tokens: dict[str, str] = field(default_factory=dict)
    permissions: dict[str, Permission] = field(default_factory=dict)
    permission_decision_tokens: dict[str, tuple[str, int, bool]] = field(default_factory=dict)
    permission_tokens_by_id: dict[str, str] = field(default_factory=dict)
    human_inputs: dict[str, HumanInput] = field(default_factory=dict)
    human_input_tokens: dict[str, tuple[str, int, bool]] = field(default_factory=dict)
    human_input_tokens_by_id: dict[str, str] = field(default_factory=dict)
    human_input_actions: dict[str, dict[str, Any]] = field(default_factory=dict)
    action_calls: dict[str, ActionCallRecord] = field(default_factory=dict)
    messages: dict[str, Message] = field(default_factory=dict)
    replay: set[tuple[str, str]] = field(default_factory=set)
    nonces: dict[str, str] = field(default_factory=dict)
    observed_paths: list[str] = field(default_factory=list)

    def next_id(self, prefix: str) -> str:
        self.sequence += 1
        return f"{prefix}.{self.sequence:06d}"

    def timestamp(self) -> str:
        return datetime.fromtimestamp(self.now, UTC).isoformat().replace("+00:00", "Z")


ACTIONS: list[dict[str, Any]] = [
    {
        "id": "action.create_calendar_event",
        "name": "create_calendar_event",
        "description": "Create a calendar event",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "start_time": {"type": "string"},
                "end_time": {"type": "string"},
                "attendees": {"type": "array", "items": {"type": "string"}},
                "description": {"type": "string"},
            },
            "required": ["title", "start_time", "end_time"],
        },
    },
    {
        "id": "action.get_email",
        "name": "get_email",
        "description": "Request an email address",
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Reason for requesting email address",
                }
            },
            "required": ["reason"],
        },
    },
    {
        "id": "action.get_free_busy_permission",
        "name": "get_free_busy_permission",
        "description": "Request free-busy information",
        "input_schema": {
            "type": "object",
            "properties": {
                "date_from": {"type": "string"},
                "date_to": {"type": "string"},
                "calendar_id": {"type": "string"},
            },
        },
    },
    {
        "id": "action.get_phone_number",
        "name": "get_phone_number",
        "description": "Request a phone number",
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Reason for requesting phone number",
                }
            },
            "required": ["reason"],
        },
    },
    {
        "id": "action.read_calendar_event_by_title",
        "name": "read_calendar_event_by_title",
        "description": "Read a calendar event",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "date_from": {"type": "string"},
                "date_to": {"type": "string"},
            },
            "required": ["title"],
        },
    },
    {
        "id": "action.read_calendar_permission",
        "name": "read_calendar_permission",
        "description": "Request calendar read access",
        "input_schema": {
            "type": "object",
            "properties": {"calendar_id": {"type": "string"}},
        },
    },
]


state = FixtureState()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def reset_state() -> None:
    global state
    state = FixtureState()


def validate_email(value: str) -> str:
    if len(value) > 254 or EMAIL_PATTERN.fullmatch(value) is None:
        raise HTTPException(status_code=422, detail="Invalid email")
    return value


def exact_public_jwk(value: PublicJwk) -> dict[str, str]:
    value.public_key()
    return {"kty": value.kty, "crv": value.crv, "x": value.x, "y": value.y}


def jwk_thumbprint(value: dict[str, str]) -> str:
    canonical = json.dumps(
        {"crv": value["crv"], "kty": value["kty"], "x": value["x"], "y": value["y"]},
        separators=(",", ":"),
    ).encode("utf-8")
    return b64url_encode(hashlib.sha256(canonical).digest())


def issue_token(identity: Identity) -> str:
    if identity.thumbprint is None:
        raise RuntimeError("identity has no bound key")
    header = encoded_json({"alg": "HS256", "typ": "JWT"})
    payload = encoded_json(
        {
            "sub": identity.id,
            "email": identity.email,
            "iat": state.now,
            "exp": state.now + TOKEN_LIFETIME_SECONDS,
            "cnf": {"jkt": identity.thumbprint},
        }
    )
    signing_input = f"{header}.{payload}"
    signature = b64url_encode(hmac.new(TOKEN_SECRET, signing_input.encode("ascii"), hashlib.sha256).digest())
    token = f"{signing_input}.{signature}"
    state.tokens[token] = identity.email
    return token


def validate_token(token: str) -> tuple[Identity, dict[str, Any]]:
    try:
        header_segment, payload_segment, signature_segment = token.split(".")
        header = decoded_json_segment(header_segment)
        if header.get("alg") != "HS256":
            raise ValueError("invalid token algorithm")
        signing_input = f"{header_segment}.{payload_segment}"
        expected = hmac.new(TOKEN_SECRET, signing_input.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, b64url_decode(signature_segment)):
            raise ValueError("invalid token signature")
        claims = decoded_json_segment(payload_segment)
        if set(claims) != {"sub", "email", "iat", "exp", "cnf"}:
            raise ValueError("invalid token claims")
        if not isinstance(claims["cnf"], dict) or set(claims["cnf"]) != {"jkt"}:
            raise ValueError("invalid confirmation")
        email = state.tokens[token]
        identity = state.identities[email]
        if (
            not identity.verified
            or claims["sub"] != identity.id
            or claims["email"] != identity.email
            or claims["exp"] <= state.now
            or claims["cnf"]["jkt"] != identity.thumbprint
        ):
            raise ValueError("invalid token identity")
        return identity, claims
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=401, detail="Invalid token") from error


def nonce_challenge(identity: Identity) -> HTTPException:
    next_nonce = b64url_encode(secrets.token_bytes(32))
    state.nonces[identity.email] = next_nonce
    return HTTPException(
        status_code=401,
        detail="DPoP nonce required",
        headers={"DPoP-Nonce": next_nonce},
    )


def validate_dpop(request: Request) -> Identity:
    authorization_values = request.headers.getlist("authorization")
    proof_values = request.headers.getlist("dpop")
    if (
        len(authorization_values) != 1
        or not authorization_values[0].startswith("Bearer ")
        or len(proof_values) != 1
    ):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization_values[0][len("Bearer ") :]
    identity, claims = validate_token(token)
    try:
        header_segment, payload_segment, signature_segment = proof_values[0].split(".")
        header = decoded_json_segment(header_segment)
        if set(header) != {"typ", "alg", "jwk"}:
            raise ValueError("invalid proof header")
        if header["typ"] != "dpop+jwt" or header["alg"] != "ES256":
            raise ValueError("invalid proof algorithm")
        public_jwk = PublicJwk.model_validate(header["jwk"])
        if jwk_thumbprint(exact_public_jwk(public_jwk)) != claims["cnf"]["jkt"]:
            raise ValueError("wrong proof key")
        signature = b64url_decode(signature_segment)
        if len(signature) != 64:
            raise ValueError("invalid signature length")
        der_signature = encode_dss_signature(
            int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
        )
        public_jwk.public_key().verify(
            der_signature,
            f"{header_segment}.{payload_segment}".encode("ascii"),
            ec.ECDSA(hashes.SHA256()),
        )
        payload = decoded_json_segment(payload_segment)
        if not {"jti", "htm", "htu", "iat", "ath"}.issubset(payload):
            raise ValueError("missing proof claim")
        if not set(payload).issubset({"jti", "htm", "htu", "iat", "ath", "nonce"}):
            raise ValueError("unknown proof claim")
        if not isinstance(payload["jti"], str) or IDENTIFIER_PATTERN.fullmatch(payload["jti"]) is None:
            raise ValueError("invalid proof ID")
        if payload["htm"] != request.method or payload["htu"] != str(request.url):
            raise ValueError("wrong request binding")
        if not isinstance(payload["iat"], int) or not state.now - 60 <= payload["iat"] <= state.now + 5:
            raise ValueError("invalid proof time")
        if payload["ath"] != b64url_encode(hashlib.sha256(token.encode("ascii")).digest()):
            raise ValueError("wrong token hash")
        expected_nonce = state.nonces.get(identity.email)
        if expected_nonce is not None and payload.get("nonce") != expected_nonce:
            raise nonce_challenge(identity)
        replay_key = (identity.id, payload["jti"])
        if replay_key in state.replay:
            raise ValueError("replayed proof")
        state.replay.add(replay_key)
    except HTTPException:
        raise
    except (InvalidSignature, TypeError, ValueError) as error:
        raise HTTPException(status_code=401, detail="Invalid DPoP proof") from error
    return identity


def find_action(name: str) -> dict[str, Any] | None:
    return next((action for action in ACTIONS if action["name"] == name), None) or state.human_input_actions.get(name)


def queue_message(
    recipient_email: str,
    sender_email: str,
    payload: dict[str, Any],
    action_type: str | None = None,
) -> str:
    recipient = state.identities[recipient_email]
    sender = state.identities[sender_email]
    action = find_action(action_type) if action_type is not None else None
    message_id = str(uuid4())
    state.messages[message_id] = Message(
        id=message_id,
        recipient_email=recipient.email,
        sender_agent_id=sender.id,
        action_type_id=action["id"] if action is not None else None,
        payload=payload,
        created_at=state.timestamp(),
    )
    return message_id


@app.middleware("http")
async def record_path(request: Request, call_next: Any) -> Response:
    state.observed_paths.append(request.url.path)
    return await call_next(request)


@app.exception_handler(HTTPException)
async def safe_http_error(_request: Request, error: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"detail": error.detail},
        headers={"Cache-Control": "no-store", **(error.headers or {})},
    )


@app.get("/readyz")
async def ready() -> dict[str, bool]:
    return {"ready": True}


@app.get("/__test__/verification-code/{email}")
async def verification_code(
    email: str,
    x_a2a_test_control: str | None = Header(default=None),
) -> dict[str, str]:
    if x_a2a_test_control != CONTROL_TOKEN:
        raise HTTPException(status_code=404, detail="Not found")
    identity = state.identities.get(email)
    if identity is None:
        raise HTTPException(status_code=404, detail="Not found")
    return {"code": identity.code}


@app.get("/__test__/permission-token/{permission_id}")
async def permission_token(
    permission_id: str,
    x_a2a_test_control: str | None = Header(default=None),
) -> dict[str, str]:
    if x_a2a_test_control != CONTROL_TOKEN:
        raise HTTPException(status_code=404, detail="Not found")
    token = state.permission_tokens_by_id.get(permission_id)
    if token is None:
        raise HTTPException(status_code=404, detail="Not found")
    return {"token": token}


@app.post("/api/register_agent")
async def register_agent(input: RegisterRequest) -> dict[str, str]:
    email = validate_email(input.email)
    existing = state.identities.get(email)
    if existing is not None and existing.verified:
        raise HTTPException(status_code=409, detail="Agent already registered")
    identity = Identity(id=state.next_id("agent"), email=email)
    state.identities[email] = identity
    return {
        "agent_id": identity.id,
        "email": identity.email,
        "message": "Verification code sent to your email. Please verify to complete registration.",
    }


@app.post("/api/resend_verification")
async def resend_verification(input: ResendRequest) -> dict[str, str]:
    identity = state.identities.get(validate_email(input.email))
    if identity is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if identity.verified:
        raise HTTPException(status_code=400, detail="Agent already verified")
    identity.code = VERIFICATION_CODE
    return {"message": "Verification code sent to your email."}


@app.post("/api/verify_email")
async def verify_email(input: VerifyRequest, response: Response) -> dict[str, str]:
    identity = state.identities.get(validate_email(input.email))
    if identity is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if identity.verified or input.code != identity.code:
        raise HTTPException(status_code=400, detail="Verification failed")
    try:
        identity.public_jwk = exact_public_jwk(input.jwk)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid JWK") from error
    identity.thumbprint = jwk_thumbprint(identity.public_jwk)
    identity.verified = True
    token = issue_token(identity)
    response.headers["Cache-Control"] = "no-store"
    return {
        "agent_id": identity.id,
        "email": identity.email,
        "token": token,
        "jkt": identity.thumbprint,
        "message": "Email verified successfully. Store this token securely - it will not be shown again.",
    }


@app.get("/api/list_action_types")
async def list_action_types(request: Request) -> list[dict[str, Any]]:
    validate_dpop(request)
    return [*ACTIONS, *state.human_input_actions.values()]


@app.post("/api/get_human_input")
async def get_human_input(input: HumanInputRequest, request: Request) -> dict[str, Any]:
    identity = validate_dpop(request)
    if input.permission_type is None and input.action_type is None:
        raise HTTPException(status_code=422, detail="Choose one human input type")
    if (
        input.permission_type is not None
        and input.action_type is not None
        and input.permission_type != input.action_type
    ):
        raise HTTPException(status_code=422, detail="Human input types do not match")
    action_type = input.permission_type or input.action_type
    assert action_type is not None
    options = [
        {"label": value, "value": value}
        if isinstance(value, str)
        else {"label": value.label, "value": value.value}
        for value in (input.options or [])
    ]
    if input.input_type == "buttons" and not options:
        raise HTTPException(status_code=422, detail="Buttons require options")
    if input.input_type == "text" and options:
        raise HTTPException(status_code=422, detail="Text input rejects options")
    if len({value["value"] for value in options}) != len(options):
        raise HTTPException(status_code=422, detail="Option values must be unique")
    source_message_id = None
    if input.message_id is not None:
        try:
            source_message_id = str(UUID(input.message_id))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(status_code=400, detail="message_id must be a UUID") from None
        source = state.messages.get(source_message_id)
        sender = next(
            (
                value
                for value in state.identities.values()
                if value.id == getattr(source, "sender_agent_id", None)
            ),
            None,
        )
        if source is None:
            raise HTTPException(status_code=404, detail="Message not found")
        if source.recipient_email != identity.email and getattr(sender, "email", None) != identity.email:
            raise HTTPException(status_code=403, detail="Not a party to message")
    if find_action(action_type) is None:
        state.human_input_actions[action_type] = {
            "id": state.next_id("action.human_input"),
            "name": action_type,
            "description": f"Auto-created from a human input request by {identity.email}",
            "input_schema": {},
        }
    request_id = str(uuid4())
    state.human_inputs[request_id] = HumanInput(
        id=request_id,
        agent_email=identity.email,
        action_type=action_type,
        prompt=input.request,
        input_type=input.input_type,
        options=options or None,
        message_id=source_message_id,
    )
    token = secrets.token_urlsafe(32)
    state.human_input_tokens[token] = (request_id, state.now + 72 * 60 * 60, False)
    state.human_input_tokens_by_id[request_id] = token
    return {
        "request_id": request_id,
        "status": "pending",
        "input_type": input.input_type,
        "message": f"Question emailed to {identity.email}",
        "options": options or None,
    }


@app.post("/api/human_input_response")
async def human_input_response(input: HumanInputResponseRequest) -> dict[str, Any]:
    record = state.human_input_tokens.get(input.token)
    human_input = None if record is None else state.human_inputs.get(record[0])
    if (
        record is None
        or human_input is None
        or record[2]
        or record[1] <= state.now
        or human_input.status != "pending"
    ):
        raise HTTPException(status_code=410, detail="This link is no longer usable")
    if (input.value is None) == (input.text is None):
        raise HTTPException(status_code=422, detail="Supply exactly one answer")
    if human_input.input_type == "buttons":
        offered = {value["value"] for value in human_input.options or []}
        if input.value not in offered or input.text is not None:
            raise HTTPException(status_code=400, detail="Answer was not offered")
    elif input.text is None or input.value is not None:
        raise HTTPException(status_code=400, detail="A text answer is required")
    state.human_input_tokens[input.token] = (record[0], record[1], True)
    human_input.status = "answered"
    human_input.response_value = input.value
    human_input.response_text = input.text
    queue_message(
        human_input.agent_email,
        human_input.agent_email,
        {
            "type": "human_input_response",
            "request_id": human_input.id,
            "action_type": human_input.action_type,
            "input_type": human_input.input_type,
            "value": input.value,
            "text": input.text,
            "prompt": human_input.prompt,
            "message_id": human_input.message_id,
        },
        human_input.action_type,
    )
    return {
        "request_id": human_input.id,
        "status": "answered",
        "input_type": human_input.input_type,
        "value": input.value,
        "text": input.text,
    }


@app.get("/api/get_human_input_status")
async def get_human_input_status(request_id: str, request: Request) -> dict[str, Any]:
    identity = validate_dpop(request)
    try:
        request_id = str(UUID(request_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="request_id must be a UUID") from None
    human_input = state.human_inputs.get(request_id)
    if human_input is None or human_input.agent_email != identity.email:
        raise HTTPException(status_code=404, detail="Human input request not found")
    return {
        "request_id": human_input.id,
        "status": human_input.status,
        "input_type": human_input.input_type,
        "prompt": human_input.prompt,
        "action_type": human_input.action_type,
        "options": human_input.options,
        "response_value": human_input.response_value,
        "response_text": human_input.response_text,
        "responded_at": state.timestamp() if human_input.status == "answered" else None,
        "created_at": None,
    }


@app.post("/api/request_permission")
async def request_permission(input: PermissionRequest, request: Request) -> dict[str, Any]:
    identity = validate_dpop(request)
    if input.target_email is None and input.message_id is None:
        raise HTTPException(status_code=422, detail="Choose a target selector")
    if (input.action_type is None) == (input.permission_type is None):
        raise HTTPException(status_code=422, detail="Choose one permission name")
    target_email = validate_email(input.target_email) if input.target_email is not None else None
    if input.message_id is not None:
        message = state.messages.get(input.message_id or "")
        sender = next(
            (value for value in state.identities.values() if value.id == getattr(message, "sender_agent_id", None)),
            None,
        )
        if message is None:
            raise HTTPException(status_code=400, detail="Invalid message_id")
        if message.recipient_email == identity.email and sender is not None:
            derived_target_email = sender.email
        elif sender is not None and sender.email == identity.email:
            derived_target_email = message.recipient_email
        else:
            raise HTTPException(status_code=403, detail="Not a party to message")
        if target_email is not None and target_email != derived_target_email:
            raise HTTPException(status_code=422, detail="Target does not match message")
        target_email = derived_target_email
    assert target_email is not None
    action_type = input.action_type or input.permission_type
    assert action_type is not None
    if target_email == identity.email:
        raise HTTPException(status_code=400, detail="Cannot request permission from yourself")
    target = state.identities.get(target_email)
    if target is None or not target.verified:
        raise HTTPException(status_code=404, detail="Target not found")
    permission = next(
        (
            value
            for value in state.permissions.values()
            if value.grantor_email == target_email
            and value.grantee_email == identity.email
            and value.action_type == action_type
            and (
                value.status == "pending"
                or (
                    value.status == "granted"
                    and (value.uses_remaining is None or value.uses_remaining > 0)
                )
            )
        ),
        None,
    )
    if permission is None:
        permission = Permission(
            id=str(uuid4()),
            grantor_email=target_email,
            grantee_email=identity.email,
            action_type=action_type,
            scope=input.scope or {},
            decision_options=input.decision_options,
            reason=input.reason,
            created_at=state.timestamp(),
        )
        state.permissions[permission.id] = permission
        token = secrets.token_urlsafe(32)
        state.permission_decision_tokens[token] = (
            permission.id,
            state.now + 72 * 60 * 60,
            False,
        )
        state.permission_tokens_by_id[permission.id] = token
    elif permission.status == "granted":
        queue_message(
            permission.grantor_email,
            identity.email,
            {
                "type": "permission_already_granted",
                "permission_id": permission.id,
                "action_type": permission.action_type,
                "requester_email": identity.email,
                "decision": permission.decision,
                "scope": permission.scope,
                "reason": input.reason,
            },
            permission.action_type,
        )
    return {
        "permission_id": permission.id,
        "status": permission.status,
        "message": (
            f"Approval request emailed to {target_email}"
            if permission.status == "pending"
            else "Permission was already granted; no approval email was sent."
        ),
        "already_granted": permission.status == "granted",
        "decision": permission.decision,
    }


def apply_permission_decision(token: str, decision: str) -> Permission:
    record = state.permission_decision_tokens.get(token)
    permission = None if record is None else state.permissions.get(record[0])
    if record is None or permission is None or record[2] or record[1] <= state.now or permission.status != "pending":
        raise HTTPException(status_code=410, detail="This decision link is not valid")
    offered = (
        {"allow_once", "allow_always", "deny"}
        if permission.decision_options == "once_always"
        else {"accept", "deny"}
    )
    if decision not in offered:
        raise HTTPException(status_code=400, detail="Decision was not offered")
    state.permission_decision_tokens[token] = (record[0], record[1], True)
    permission.decision = decision  # type: ignore[assignment]
    permission.status = "denied" if decision == "deny" else "granted"
    permission.uses_remaining = 1 if decision == "allow_once" else None
    permission.decided_at = state.timestamp()
    queue_message(
        permission.grantee_email,
        permission.grantor_email,
        {
            "type": "permission_outcome",
            "permission_id": permission.id,
            "action_type": permission.action_type,
            "decision": permission.decision,
            "status": permission.status,
            "granted": permission.status == "granted",
            "single_use": permission.decision == "allow_once",
            "grantor_email": permission.grantor_email,
        },
        permission.action_type,
    )
    return permission


@app.get("/permission/decide")
async def confirm_permission_decision(token: str, choice: str) -> Response:
    record = state.permission_decision_tokens.get(token)
    permission = None if record is None else state.permissions.get(record[0])
    if record is None or permission is None or record[2] or record[1] <= state.now or permission.status != "pending":
        raise HTTPException(status_code=410, detail="This decision link is not valid")
    offered = (
        {"allow_once", "allow_always", "deny"}
        if permission.decision_options == "once_always"
        else {"accept", "deny"}
    )
    if choice not in offered:
        raise HTTPException(status_code=400, detail="Decision was not offered")
    return Response("<!doctype html><title>Confirm permission decision</title>", media_type="text/html")


@app.post("/api/permission_decision")
async def permission_decision(input: PermissionDecisionRequest) -> dict[str, Any]:
    permission = apply_permission_decision(input.token, input.decision)
    return {
        "permission_id": permission.id,
        "decision": permission.decision,
        "status": permission.status,
        "granted": permission.status == "granted",
    }


@app.post("/api/call_action")
async def call_action(input: ActionCall, request: Request) -> dict[str, str]:
    identity = validate_dpop(request)
    target_email = validate_email(input.target_email)
    action = find_action(input.action_type)
    permission = next(
        (
            value
            for value in state.permissions.values()
            if value.grantor_email == target_email
            and value.grantee_email == identity.email
            and value.action_type == input.action_type
            and value.status == "granted"
            and (value.uses_remaining is None or value.uses_remaining > 0)
        ),
        None,
    )
    required = action.get("input_schema", {}).get("required", []) if action is not None else []
    if (
        action is None
        or permission is None
        or any(not isinstance(input.payload.get(name), str) for name in required)
    ):
        raise HTTPException(status_code=403, detail="Action not permitted")
    if permission.uses_remaining is not None:
        permission.uses_remaining -= 1
    call_id = str(uuid4())
    state.action_calls[call_id] = ActionCallRecord(
        id=call_id,
        caller_email=identity.email,
        target_email=target_email,
        action_type=input.action_type,
    )
    message_id = queue_message(
        target_email,
        identity.email,
        {
            "type": "action_call",
            "call_id": call_id,
            "action_type": input.action_type,
            "payload": input.payload,
        },
        input.action_type,
    )
    return {"call_id": call_id, "message_id": message_id, "status": "delivered"}


@app.post("/api/submit_action_result")
async def submit_action_result(input: ActionResult, request: Request) -> dict[str, str]:
    identity = validate_dpop(request)
    try:
        call_id = str(UUID(input.call_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=404, detail="Action call not found") from None
    action_call = state.action_calls.get(call_id)
    if action_call is None or action_call.target_email != identity.email:
        raise HTTPException(status_code=404, detail="Action call not found")
    if action_call.status != "pending":
        raise HTTPException(status_code=409, detail="Action call already completed")
    action_call.status = "completed" if input.status == "success" else "failed"
    action_call.result = input.result
    message_id = queue_message(
        action_call.caller_email,
        identity.email,
        {
            "type": "action_response",
            "call_id": action_call.id,
            "action_type": action_call.action_type,
            "status": input.status,
            "result": input.result,
        },
        action_call.action_type,
    )
    return {"call_id": action_call.id, "status": action_call.status, "message_id": message_id}


@app.get("/api/poll_messages")
async def poll_messages(
    request: Request,
    timeout: int = Query(default=30, ge=0, le=60),
) -> dict[str, list[dict[str, Any]]]:
    del timeout
    identity = validate_dpop(request)
    messages: list[dict[str, Any]] = []
    for message in state.messages.values():
        if message.recipient_email != identity.email or message.state != "queued":
            continue
        message.state = "delivered"
        messages.append(
            {
                "id": message.id,
                "sender_agent_id": message.sender_agent_id,
                "action_type_id": message.action_type_id,
                "payload": message.payload,
                "created_at": message.created_at,
            }
        )
    return {"messages": messages}


@app.get("/api/get_my_permissions")
async def get_my_permissions(request: Request) -> list[dict[str, Any]]:
    identity = validate_dpop(request)
    return [
        {
            "id": permission.id,
            "grantor_email": permission.grantor_email,
            "grantee_email": permission.grantee_email,
            "action_type": permission.action_type,
            "status": permission.status,
            "scope": permission.scope,
            "created_at": permission.created_at,
            "decided_at": permission.decided_at,
            "expires_at": None,
        }
        for permission in state.permissions.values()
        if permission.grantor_email == identity.email or permission.grantee_email == identity.email
    ]


@app.post("/api/ack_message")
async def ack_message(input: MessageAck, request: Request) -> dict[str, str]:
    identity = validate_dpop(request)
    message = state.messages.get(input.message_id)
    if (
        message is None
        or message.recipient_email != identity.email
        or message.state != "delivered"
    ):
        raise HTTPException(status_code=404, detail="Message not found")
    message.state = "acked"
    return {"message_id": message.id, "status": "acked"}


def seed_verified_identity(email: str) -> tuple[Identity, ec.EllipticCurvePrivateKey, str]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_numbers = private_key.public_key().public_numbers()
    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": b64url_encode(public_numbers.x.to_bytes(32, "big")),
        "y": b64url_encode(public_numbers.y.to_bytes(32, "big")),
    }
    identity = Identity(
        id=state.next_id("agent"),
        email=email,
        verified=True,
        public_jwk=jwk,
        thumbprint=jwk_thumbprint(jwk),
    )
    state.identities[email] = identity
    return identity, private_key, issue_token(identity)


def create_test_proof(
    private_key: ec.EllipticCurvePrivateKey,
    public_jwk: dict[str, str],
    token: str,
    method: str,
    url: str,
    *,
    now: int | None = None,
    jti: str | None = None,
    nonce: str | None = None,
    ath: str | None = None,
) -> str:
    header = encoded_json({"typ": "dpop+jwt", "alg": "ES256", "jwk": public_jwk})
    payload = encoded_json(
        {
            "jti": jti or str(uuid4()),
            "htm": method,
            "htu": url,
            "iat": state.now if now is None else now,
            "ath": ath or b64url_encode(hashlib.sha256(token.encode("ascii")).digest()),
            **({} if nonce is None else {"nonce": nonce}),
        }
    )
    signing_input = f"{header}.{payload}"
    der = private_key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    r, s = decode_dss_signature(der)
    signature = b64url_encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return f"{signing_input}.{signature}"
