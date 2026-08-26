from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
from collections.abc import Awaitable
from typing import Annotated, Literal, TypeVar
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic import BaseModel, ConfigDict, SecretStr, StringConstraints


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
    StringConstraints(strict=True, pattern=r"^agent_[a-f0-9]{32}$"),
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


class FixtureStateError(Exception):
    pass


class AuthenticationFailed(FixtureStateError):
    pass


class RecordNotFound(FixtureStateError):
    pass


class RecordConflict(FixtureStateError):
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

    def _issue_token(self, agent_id: str) -> str:
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

    async def respond_to_permission(
        self, token: str, permission_id: str, decision: Literal["granted", "denied"]
    ) -> PermissionResponse:
        async with self.changed:
            target = self._agent_for_token(token)
            permission = self.permissions.get(permission_id)
            if permission is None or permission.target_agent_id != target.agent_id:
                raise RecordNotFound("permission not found")
            if permission.status != "pending" and permission.status != decision:
                raise RecordConflict("permission already has a different decision")
            permission.status = decision
            return PermissionResponse(permission_id=permission_id, status=decision)

    async def get_my_permissions(
        self, token: str, status_filter: str
    ) -> PermissionsResponse:
        async with self.changed:
            requester = self._agent_for_token(token)
            if status_filter not in ("all", "pending", "granted", "denied"):
                raise RecordNotFound("permission status not found")
            permissions = []
            for permission in self.permissions.values():
                if permission.requester_agent_id != requester.agent_id:
                    continue
                if status_filter != "all" and permission.status != status_filter:
                    continue
                target = self.agents[permission.target_agent_id]
                permissions.append(
                    PermissionSummary(
                        permission_id=permission.permission_id,
                        target_username=target.username,
                        action_type=permission.action_type,
                        scope=permission.scope,
                        status=permission.status,
                    )
                )
            return PermissionsResponse(permissions=permissions)

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

    async def inspect(self, request: InspectRequest) -> InspectionResponse:
        async with self.changed:
            agents = [
                AgentInspection(agent_id=agent.agent_id, verified=agent.verified)
                for agent in self.agents.values()
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

    mcp_app = mcp.http_app(path="/mcp")
    api = FastAPI(
        title="A2A central test fixture",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=mcp_app.lifespan,
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

    return state, mcp, api


fixture_state, mcp, app = create_fixture()
