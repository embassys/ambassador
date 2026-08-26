from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import unittest
import warnings

import httpx
import uvicorn
from fastmcp import Client

from app import create_fixture


CONTROL_HEADERS = {"X-A2A-Test-Key": "central-fixture-control"}


class CentralFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        # FastMCP 3.4.7 leaves a receive stream for a terminated session to GC.
        warnings.filterwarnings(
            "ignore",
            message=r"Unclosed <MemoryObjectReceiveStream.*",
            category=ResourceWarning,
        )
        self.state, self.mcp, self.app = create_fixture()
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://fixture.test",
        )

    async def asyncTearDown(self) -> None:
        await self.http.aclose()

    async def enroll(
        self,
        username: str = "fixture-agent",
        display_name: str | None = "Fixture Agent",
        email: str = "fixture@example.test",
    ) -> tuple[str, str]:
        async with Client(self.mcp) as client:
            registration = {
                "username": username,
                "email": email,
            }
            if display_name is not None:
                registration["display_name"] = display_name
            registered = await client.call_tool(
                "register_agent",
                registration,
            )
            self.assert_same_sensitive_text(
                registered.structured_content["email"], email
            )
            code = await self.http.post(
                "/__test/verification-code",
                headers=CONTROL_HEADERS,
                json={"email": email},
            )
            self.assertEqual(code.status_code, 200)
            verified = await client.call_tool(
                "verify_email",
                {
                    "email": email,
                    "code": code.json()["code"],
                },
            )
            return (
                registered.structured_content["agent_id"],
                verified.structured_content["token"],
            )

    def assert_same_sensitive_text(self, actual: str, expected: str) -> None:
        self.assertEqual(
            hashlib.sha256(actual.encode()).digest(),
            hashlib.sha256(expected.encode()).digest(),
        )

    def assert_control_omits(self, response: httpx.Response, *values: str) -> None:
        self.assertFalse(
            any(value in response.text for value in values),
            "test-control inspection exposed protected data",
        )

    async def test_tool_catalog_and_input_schemas_match_central(self) -> None:
        async with Client(self.mcp) as client:
            tools = {tool.name: tool for tool in await client.list_tools()}

        expected = {
            "register_agent": (
                ("username", "email", "display_name"),
                ("username", "email"),
            ),
            "verify_email": (("email", "code"), ("email", "code")),
            "resend_verification": (("email",), ("email",)),
            "list_action_types": (("token",), ("token",)),
            "request_permission": (
                ("token", "target_username", "action_type", "scope"),
                ("token", "target_username", "action_type"),
            ),
            "respond_to_permission": (
                ("token", "permission_id", "decision"),
                ("token", "permission_id", "decision"),
            ),
            "call_action": (
                ("token", "target_username", "action_type", "payload"),
                ("token", "target_username", "action_type", "payload"),
            ),
            "poll_messages": (("token", "timeout"), ("token",)),
            "get_my_permissions": (("token", "status"), ("token",)),
            "ack_message": (("token", "message_id"), ("token", "message_id")),
            "health_check": ((), ()),
        }
        self.assertEqual(set(tools), set(expected))
        for name, (property_names, required_names) in expected.items():
            schema = tools[name].inputSchema
            self.assertEqual(tuple(schema["properties"]), property_names)
            self.assertEqual(tuple(schema.get("required", ())), required_names)

        string = {"type": "string"}
        optional_string = {
            "anyOf": [{"type": "string"}, {"type": "null"}],
            "default": None,
        }
        object_schema = {"additionalProperties": True, "type": "object"}
        optional_object = {
            "anyOf": [object_schema, {"type": "null"}],
            "default": None,
        }
        expected_properties = {
            "register_agent": {
                "username": {"maxLength": 50, "minLength": 3, "type": "string"},
                "email": string,
                "display_name": optional_string,
            },
            "verify_email": {"email": string, "code": string},
            "resend_verification": {"email": string},
            "list_action_types": {"token": string},
            "request_permission": {
                "token": string,
                "target_username": string,
                "action_type": string,
                "scope": optional_object,
            },
            "respond_to_permission": {
                "token": string,
                "permission_id": string,
                "decision": {
                    "enum": ["granted", "denied"],
                    "type": "string",
                },
            },
            "call_action": {
                "token": string,
                "target_username": string,
                "action_type": string,
                "payload": object_schema,
            },
            "poll_messages": {
                "token": string,
                "timeout": {"default": 30, "type": "integer"},
            },
            "get_my_permissions": {
                "token": string,
                "status": {"default": "all", "type": "string"},
            },
            "ack_message": {"token": string, "message_id": string},
            "health_check": {},
        }
        for name, properties in expected_properties.items():
            actual = {
                property_name: {
                    key: value
                    for key, value in property_schema.items()
                    if key != "title"
                }
                for property_name, property_schema in tools[name]
                .inputSchema["properties"]
                .items()
            }
            self.assertEqual(actual, properties)

        async with Client(self.mcp) as client:
            health = await client.call_tool("health_check", {})
        self.assertEqual(health.structured_content, {"status": "ok"})

    async def test_test_endpoints_require_fixture_header_and_strict_json(self) -> None:
        missing_auth = await self.http.post("/__test/reset")
        self.assertEqual(missing_auth.status_code, 401)

        extra_field = await self.http.post(
            "/__test/verification-code",
            headers=CONTROL_HEADERS,
            json={"email": "fixture@example.test", "unexpected": True},
        )
        self.assertEqual(extra_field.status_code, 422)

    async def test_rest_and_mcp_polls_share_one_delivered_message_stream(self) -> None:
        agent_id, token = await self.enroll()
        _, other_token = await self.enroll(
            username="other-agent",
            display_name=None,
            email="other@example.test",
        )
        auth = {"Authorization": f"Bearer {token}"}
        other_auth = {"Authorization": f"Bearer {other_token}"}
        rest_content = "content delivered through REST"
        mcp_content = "content delivered through MCP"

        async def inspect_status(message_id: str) -> str:
            inspection = await self.http.post(
                "/__test/inspect",
                headers=CONTROL_HEADERS,
                json={"message_id": message_id},
            )
            self.assertEqual(inspection.status_code, 200)
            self.assert_control_omits(
                inspection, rest_content, mcp_content, token, other_token
            )
            return inspection.json()["messages"][0]["status"]

        rest_message = await self.http.post(
            "/__test/messages",
            headers=CONTROL_HEADERS,
            json={
                "recipient_agent_id": agent_id,
                "message_id": "rest_message",
                "content": rest_content,
            },
        )
        self.assertEqual(rest_message.status_code, 200)
        self.assertEqual(await inspect_status("rest_message"), "queued")

        premature_rest_ack = await self.http.post(
            "/api/ack_message",
            headers=auth,
            json={"message_id": "rest_message"},
        )
        self.assertEqual(premature_rest_ack.status_code, 404)

        rest_poll = await self.http.get(
            "/api/poll_messages",
            headers=auth,
            params={"timeout": 0},
        )
        self.assertEqual(
            rest_poll.json(),
            {
                "messages": [
                    {
                        "id": "rest_message",
                        "sender_agent_id": "test_sender",
                        "kind": "message",
                        "content": rest_content,
                    }
                ]
            },
        )
        self.assertEqual(await inspect_status("rest_message"), "delivered")

        wrong_rest_recipient = await self.http.post(
            "/api/ack_message",
            headers=other_auth,
            json={"message_id": "rest_message"},
        )
        self.assertEqual(wrong_rest_recipient.status_code, 404)

        async with Client(self.mcp) as client:
            consumed_by_rest = await client.call_tool(
                "poll_messages", {"token": token, "timeout": 0}
            )
            self.assertEqual(
                consumed_by_rest.structured_content,
                {"messages": []},
            )

        rest_ack = await self.http.post(
            "/api/ack_message",
            headers=auth,
            json={"message_id": "rest_message"},
        )
        self.assertEqual(rest_ack.status_code, 200)
        self.assertEqual(
            rest_ack.json(),
            {"message_id": "rest_message", "status": "acked"},
        )
        repeated_rest_ack = await self.http.post(
            "/api/ack_message",
            headers=auth,
            json={"message_id": "rest_message"},
        )
        self.assertEqual(repeated_rest_ack.status_code, 404)
        self.assertEqual(await inspect_status("rest_message"), "acked")

        mcp_message = await self.http.post(
            "/__test/messages",
            headers=CONTROL_HEADERS,
            json={
                "recipient_agent_id": agent_id,
                "message_id": "mcp_message",
                "content": mcp_content,
            },
        )
        self.assertEqual(mcp_message.status_code, 200)

        async with Client(self.mcp) as client:
            premature_mcp_ack = await client.call_tool(
                "ack_message",
                {"token": token, "message_id": "mcp_message"},
                raise_on_error=False,
            )
            self.assertTrue(premature_mcp_ack.is_error)
            mcp_poll = await client.call_tool(
                "poll_messages", {"token": token, "timeout": 0}
            )
            self.assertEqual(
                mcp_poll.structured_content,
                {
                    "messages": [
                        {
                            "id": "mcp_message",
                            "sender_agent_id": "test_sender",
                            "kind": "message",
                            "content": mcp_content,
                        }
                    ]
                },
            )
            consumed_by_mcp = await self.http.get(
                "/api/poll_messages",
                headers=auth,
                params={"timeout": 0},
            )
            self.assertEqual(consumed_by_mcp.json(), {"messages": []})
            wrong_mcp_recipient = await client.call_tool(
                "ack_message",
                {"token": other_token, "message_id": "mcp_message"},
                raise_on_error=False,
            )
            self.assertTrue(wrong_mcp_recipient.is_error)
            mcp_ack = await client.call_tool(
                "ack_message",
                {"token": token, "message_id": "mcp_message"},
            )
            self.assertEqual(
                mcp_ack.structured_content,
                {"message_id": "mcp_message", "status": "acked"},
            )
            repeated_mcp_ack = await client.call_tool(
                "ack_message",
                {"token": token, "message_id": "mcp_message"},
                raise_on_error=False,
            )
            self.assertTrue(repeated_mcp_ack.is_error)

        self.assertEqual(await inspect_status("mcp_message"), "acked")
        removed_ack = await self.http.post(
            "/api/ack_notification",
            headers=auth,
            json={"message_id": "mcp_message"},
        )
        self.assertEqual(removed_ack.status_code, 404)

    async def test_rest_poll_requires_bearer_and_bounded_timeout(self) -> None:
        unauthenticated = await self.http.get(
            "/api/poll_messages", params={"timeout": 0}
        )
        self.assertEqual(unauthenticated.status_code, 401)

        _, token = await self.enroll()
        auth = {"Authorization": f"Bearer {token}"}
        missing_timeout = await self.http.get("/api/poll_messages", headers=auth)
        self.assertEqual(missing_timeout.status_code, 422)
        for timeout in (-1, 31):
            outside_range = await self.http.get(
                "/api/poll_messages", headers=auth, params={"timeout": timeout}
            )
            self.assertEqual(outside_range.status_code, 422)
        poll = await self.http.get(
            "/api/poll_messages", headers=auth, params={"timeout": 0}
        )
        self.assertEqual(poll.json(), {"messages": []})

    async def test_long_poll_wakes_when_a_message_is_injected(self) -> None:
        agent_id, token = await self.enroll()
        poll = asyncio.create_task(
            self.http.get(
                "/api/poll_messages",
                headers={"Authorization": f"Bearer {token}"},
                params={"timeout": 2},
            )
        )
        await asyncio.sleep(0.01)
        await self.http.post(
            "/__test/messages",
            headers=CONTROL_HEADERS,
            json={
                "recipient_agent_id": agent_id,
                "message_id": "long_poll_message",
                "content": "wake the pending message poll",
            },
        )

        response = await asyncio.wait_for(poll, timeout=1)
        self.assertEqual(
            response.json(),
            {
                "messages": [
                    {
                        "id": "long_poll_message",
                        "sender_agent_id": "test_sender",
                        "kind": "message",
                        "content": "wake the pending message poll",
                    }
                ]
            },
        )
        inspection = await self.http.post(
            "/__test/inspect",
            headers=CONTROL_HEADERS,
            json={"message_id": "long_poll_message"},
        )
        self.assertEqual(inspection.json()["messages"][0]["status"], "delivered")
        self.assert_control_omits(inspection, "wake the pending message poll", token)

    async def test_reset_clears_state_and_invalidates_jwt(self) -> None:
        _, token = await self.enroll()
        self.assertEqual(len(token.split(".")), 3)

        reset = await self.http.post("/__test/reset", headers=CONTROL_HEADERS)
        self.assertEqual(reset.status_code, 200)
        inspection = await self.http.post(
            "/__test/inspect", headers=CONTROL_HEADERS, json={}
        )
        self.assertEqual(
            inspection.json(),
            {"agents": [], "messages": [], "permissions": [], "actions": []},
        )
        rejected = await self.http.get(
            "/api/poll_messages",
            headers={"Authorization": f"Bearer {token}"},
            params={"timeout": 0},
        )
        self.assertEqual(rejected.status_code, 401)

    async def test_permission_and_action_flow_uses_the_central_contract(self) -> None:
        _, requester_token = await self.enroll()
        _, recipient_token = await self.enroll(
            username="recipient-agent",
            display_name=None,
            email="recipient@example.test",
        )
        async with Client(self.mcp) as client:
            action_types = await client.call_tool(
                "list_action_types", {"token": requester_token}
            )
            self.assertEqual(
                action_types.structured_content,
                {"action_types": ["fixture.echo"]},
            )
            requested = await client.call_tool(
                "request_permission",
                {
                    "token": requester_token,
                    "target_username": "recipient-agent",
                    "action_type": "fixture.echo",
                    "scope": {"resource": "private fixture record"},
                },
            )
            permission_id = requested.structured_content["permission_id"]
            self.assertEqual(requested.structured_content["status"], "pending")
            pending = await client.call_tool(
                "get_my_permissions",
                {"token": requester_token, "status": "pending"},
            )
            self.assertEqual(len(pending.structured_content["permissions"]), 1)
            self.assertEqual(
                pending.structured_content["permissions"][0]["permission_id"],
                permission_id,
            )
            self.assert_same_sensitive_text(
                json.dumps(
                    pending.structured_content["permissions"][0]["scope"],
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                '{"resource":"private fixture record"}',
            )

            permission_messages = await client.call_tool(
                "poll_messages", {"token": recipient_token, "timeout": 0}
            )
            self.assertEqual(len(permission_messages.structured_content["messages"]), 1)
            permission_message = permission_messages.structured_content["messages"][0]
            self.assertEqual(permission_message["kind"], "permission")
            self.assert_same_sensitive_text(
                permission_message["content"],
                json.dumps(
                    {
                        "action_type": "fixture.echo",
                        "permission_id": permission_id,
                        "requester_username": "fixture-agent",
                        "scope": {"resource": "private fixture record"},
                        "type": "permission_request",
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            )
            await client.call_tool(
                "ack_message",
                {
                    "token": recipient_token,
                    "message_id": permission_message["id"],
                },
            )
            granted = await client.call_tool(
                "respond_to_permission",
                {
                    "token": recipient_token,
                    "permission_id": permission_id,
                    "decision": "granted",
                },
            )
            self.assertEqual(granted.structured_content["status"], "granted")
            granted_permissions = await client.call_tool(
                "get_my_permissions", {"token": requester_token}
            )
            self.assertEqual(
                granted_permissions.structured_content["permissions"][0]["status"],
                "granted",
            )
            called = await client.call_tool(
                "call_action",
                {
                    "token": requester_token,
                    "target_username": "recipient-agent",
                    "action_type": "fixture.echo",
                    "payload": {"value": "private action payload"},
                },
            )
            self.assertEqual(called.structured_content["status"], "queued")
            action_messages = await client.call_tool(
                "poll_messages", {"token": recipient_token, "timeout": 0}
            )
            self.assertEqual(len(action_messages.structured_content["messages"]), 1)
            action_message = action_messages.structured_content["messages"][0]
            self.assertEqual(action_message["kind"], "action")
            self.assert_same_sensitive_text(
                action_message["content"],
                json.dumps(
                    {
                        "action_id": called.structured_content["action_id"],
                        "action_type": "fixture.echo",
                        "caller_username": "fixture-agent",
                        "payload": {"value": "private action payload"},
                        "type": "action_call",
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            )

        inspection = await self.http.post(
            "/__test/inspect", headers=CONTROL_HEADERS, json={}
        )
        self.assertEqual(inspection.json()["permissions"][0]["status"], "granted")
        self.assertEqual(inspection.json()["actions"][0]["status"], "queued")
        self.assert_control_omits(
            inspection,
            requester_token,
            recipient_token,
            "private fixture record",
            "private action payload",
        )

    async def test_streamable_http_is_served_at_mcp_path(self) -> None:
        def rpc_result(response: httpx.Response) -> dict[str, object]:
            if response.headers.get("content-type", "").startswith(
                "text/event-stream"
            ):
                data = [
                    line.removeprefix("data: ")
                    for line in response.text.splitlines()
                    if line.startswith("data: ")
                ]
                return json.loads(data[-1])
            return response.json()

        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        server = uvicorn.Server(
            uvicorn.Config(
                self.app,
                access_log=False,
                log_level="critical",
            )
        )
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(server.started)
            async with httpx.AsyncClient(
                base_url=f"http://127.0.0.1:{port}",
                headers={
                    "Accept": "application/json, text/event-stream",
                    "Content-Type": "application/json",
                },
            ) as http:
                initialized = await http.post(
                    "/mcp",
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": {},
                            "clientInfo": {"name": "fixture-test", "version": "1"},
                        },
                    },
                )
                self.assertEqual(initialized.status_code, 200)
                session_id = initialized.headers["mcp-session-id"]
                protocol_version = rpc_result(initialized)["result"][
                    "protocolVersion"
                ]
                session_headers = {
                    "Mcp-Session-Id": session_id,
                    "MCP-Protocol-Version": protocol_version,
                }
                notification = await http.post(
                    "/mcp",
                    headers=session_headers,
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                    },
                )
                self.assertEqual(notification.status_code, 202)
                listed = await http.post(
                    "/mcp",
                    headers=session_headers,
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {},
                    },
                )
                self.assertEqual(listed.status_code, 200)
                tool_names = {
                    tool["name"] for tool in rpc_result(listed)["result"]["tools"]
                }
                self.assertIn("register_agent", tool_names)
                terminated = await http.delete("/mcp", headers=session_headers)
                self.assertEqual(terminated.status_code, 200)
        finally:
            server.should_exit = True
            await asyncio.wait_for(server_task, timeout=5)
            listener.close()


if __name__ == "__main__":
    unittest.main()
