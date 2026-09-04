from __future__ import annotations

import hashlib
import unittest
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

import app as fixture


class CurrentCentralFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        fixture.reset_state()
        self.client = TestClient(fixture.app, raise_server_exceptions=False)

    def protected_headers(
        self,
        private_key: ec.EllipticCurvePrivateKey,
        public_jwk: dict[str, str],
        token: str,
        method: str,
        path: str,
        **proof_options: object,
    ) -> dict[str, str]:
        proof = fixture.create_test_proof(
            private_key,
            public_jwk,
            token,
            method,
            f"http://testserver{path}",
            **proof_options,
        )
        return {"Authorization": f"Bearer {token}", "DPoP": proof}

    def test_enrollment_uses_email_and_public_jwk(self) -> None:
        email = "python-enrollment@fixture.test"
        registered = self.client.post(
            "/api/register_agent",
            json={"email": email, "display_name": "Python fixture"},
        )
        self.assertEqual(registered.status_code, 200)
        self.assertEqual(set(registered.json()), {"agent_id", "email", "message"})

        private_key = ec.generate_private_key(ec.SECP256R1())
        numbers = private_key.public_key().public_numbers()
        jwk = {
            "kty": "EC",
            "crv": "P-256",
            "x": fixture.b64url_encode(numbers.x.to_bytes(32, "big")),
            "y": fixture.b64url_encode(numbers.y.to_bytes(32, "big")),
        }
        verified = self.client.post(
            "/api/verify_email",
            json={"email": email, "code": fixture.VERIFICATION_CODE, "jwk": jwk},
        )
        self.assertEqual(verified.status_code, 200)
        self.assertIn("no-store", verified.headers["cache-control"])
        result = verified.json()
        claims = fixture.decoded_json_segment(result["token"].split(".")[1])
        self.assertEqual(set(claims), {"sub", "email", "iat", "exp", "cnf"})
        self.assertEqual(claims["email"], email)
        self.assertEqual(claims["exp"] - claims["iat"], fixture.TOKEN_LIFETIME_SECONDS)
        self.assertEqual(claims["cnf"], {"jkt": result["jkt"]})

    def test_protected_route_rejects_invalid_dpop_bindings(self) -> None:
        identity, private_key, token = fixture.seed_verified_identity("proofs@fixture.test")
        assert identity.public_jwk is not None
        path = "/api/poll_messages?timeout=0"
        valid_headers = self.protected_headers(
            private_key, identity.public_jwk, token, "GET", path
        )
        self.assertEqual(self.client.get(path, headers=valid_headers).status_code, 200)

        self.assertEqual(
            self.client.get(path, headers={"Authorization": f"Bearer {token}"}).status_code,
            401,
        )
        self.assertEqual(
            self.client.get(
                path,
                headers={**valid_headers, "Authorization": f"DPoP {token}"},
            ).status_code,
            401,
        )

        other_key = ec.generate_private_key(ec.SECP256R1())
        other_numbers = other_key.public_key().public_numbers()
        other_jwk = {
            "kty": "EC",
            "crv": "P-256",
            "x": fixture.b64url_encode(other_numbers.x.to_bytes(32, "big")),
            "y": fixture.b64url_encode(other_numbers.y.to_bytes(32, "big")),
        }
        wrong_key = self.protected_headers(other_key, other_jwk, token, "GET", path)
        self.assertEqual(self.client.get(path, headers=wrong_key).status_code, 401)

        for options in [
            {"now": fixture.state.now - 61},
            {"now": fixture.state.now + 6},
            {"ath": fixture.b64url_encode(hashlib.sha256(b"wrong").digest())},
        ]:
            headers = self.protected_headers(
                private_key,
                identity.public_jwk,
                token,
                "GET",
                path,
                **options,
            )
            self.assertEqual(self.client.get(path, headers=headers).status_code, 401)

        replay_id = str(uuid4())
        replay = self.protected_headers(
            private_key,
            identity.public_jwk,
            token,
            "GET",
            path,
            jti=replay_id,
        )
        self.assertEqual(self.client.get(path, headers=replay).status_code, 200)
        self.assertEqual(self.client.get(path, headers=replay).status_code, 401)

    def test_nonce_challenge_requires_the_server_value(self) -> None:
        identity, private_key, token = fixture.seed_verified_identity("nonce@fixture.test")
        assert identity.public_jwk is not None
        fixture.state.nonces[identity.email] = "fixture-initial-nonce"
        path = "/api/list_action_types"
        challenged = self.client.get(
            path,
            headers=self.protected_headers(
                private_key, identity.public_jwk, token, "GET", path
            ),
        )
        self.assertEqual(challenged.status_code, 401)
        supplied = challenged.headers["dpop-nonce"]
        accepted = self.client.get(
            path,
            headers=self.protected_headers(
                private_key,
                identity.public_jwk,
                token,
                "GET",
                path,
                nonce=supplied,
            ),
        )
        self.assertEqual(accepted.status_code, 200)

    def test_permission_action_poll_and_ack_lifecycle(self) -> None:
        requester, requester_key, requester_token = fixture.seed_verified_identity(
            "requester@fixture.test"
        )
        target, target_key, target_token = fixture.seed_verified_identity(
            "target@fixture.test"
        )
        assert requester.public_jwk is not None
        assert target.public_jwk is not None

        permission_path = "/api/request_permission"
        requested = self.client.post(
            permission_path,
            headers=self.protected_headers(
                requester_key,
                requester.public_jwk,
                requester_token,
                "POST",
                permission_path,
            ),
            json={
                "target_email": target.email,
                "action_type": "get_email",
                "scope": {"use": "fixture"},
            },
        )
        self.assertEqual(requested.status_code, 200)
        permission_id = requested.json()["permission_id"]

        poll_path = "/api/poll_messages?timeout=0"
        target_poll = self.client.get(
            poll_path,
            headers=self.protected_headers(
                target_key, target.public_jwk, target_token, "GET", poll_path
            ),
        )
        self.assertEqual(target_poll.json(), {"messages": []})

        response_path = "/api/respond_to_permission"
        decided = self.client.post(
            response_path,
            headers=self.protected_headers(
                target_key, target.public_jwk, target_token, "POST", response_path
            ),
            json={"permission_id": permission_id, "decision": "granted"},
        )
        self.assertEqual(decided.status_code, 200)

        requester_poll = self.client.get(
            poll_path,
            headers=self.protected_headers(
                requester_key,
                requester.public_jwk,
                requester_token,
                "GET",
                poll_path,
            ),
        )
        messages = requester_poll.json()["messages"]
        self.assertEqual(len(messages), 1)
        permission_message_id = messages[0]["id"]
        self.assertEqual(
            messages[0]["payload"],
            {
                "type": "permission_response",
                "permission_id": permission_id,
                "decision": "granted",
            },
        )

        ack_path = "/api/ack_message"
        acknowledged = self.client.post(
            ack_path,
            headers=self.protected_headers(
                requester_key,
                requester.public_jwk,
                requester_token,
                "POST",
                ack_path,
            ),
            json={"message_id": permission_message_id},
        )
        self.assertEqual(acknowledged.status_code, 200)
        repeated = self.client.post(
            ack_path,
            headers=self.protected_headers(
                requester_key,
                requester.public_jwk,
                requester_token,
                "POST",
                ack_path,
            ),
            json={"message_id": permission_message_id},
        )
        self.assertEqual(repeated.status_code, 404)

        call_path = "/api/call_action"
        called = self.client.post(
            call_path,
            headers=self.protected_headers(
                requester_key,
                requester.public_jwk,
                requester_token,
                "POST",
                call_path,
            ),
            json={
                "target_email": target.email,
                "action_type": "get_email",
                "payload": {"reason": "fixture qualification"},
            },
        )
        self.assertEqual(called.status_code, 200)
        self.assertEqual(fixture.state.messages[called.json()["message_id"]].state, "queued")

    def test_fixed_action_schemas_match_the_live_inventory(self) -> None:
        identity, private_key, token = fixture.seed_verified_identity("catalog@fixture.test")
        assert identity.public_jwk is not None
        path = "/api/list_action_types"
        response = self.client.get(
            path,
            headers=self.protected_headers(
                private_key, identity.public_jwk, token, "GET", path
            ),
        )
        self.assertEqual(response.status_code, 200)
        by_name = {action["name"]: action for action in response.json()}
        expected_email = {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Reason for requesting email address",
                }
            },
            "required": ["reason"],
        }
        expected_phone = {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Reason for requesting phone number",
                }
            },
            "required": ["reason"],
        }
        self.assertEqual(by_name["get_email"]["input_schema"], expected_email)
        self.assertEqual(by_name["get_phone_number"]["input_schema"], expected_phone)


if __name__ == "__main__":
    unittest.main()
