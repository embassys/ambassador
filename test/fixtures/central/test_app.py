from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import socket
import unittest
import uuid
import warnings

import httpx
import uvicorn
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from fastmcp import Client

from app import create_fixture, normalize_htu


CONTROL_HEADERS = {"X-A2A-Test-Key": "central-fixture-control"}
BASE_URL = "http://127.0.0.1:8000"
FIXTURE_CLOCK = 1_788_000_000


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def decode_b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def decode_jwt_part(token: str, index: int) -> dict[str, object]:
    return json.loads(decode_b64url(token.split(".")[index]))


class ProofKey:
    def __init__(self) -> None:
        self.private_key = ec.generate_private_key(ec.SECP256R1())

    def public_jwk(self) -> dict[str, str]:
        numbers = self.private_key.public_key().public_numbers()
        return {
            "kty": "EC",
            "crv": "P-256",
            "x": b64url(numbers.x.to_bytes(32, "big")),
            "y": b64url(numbers.y.to_bytes(32, "big")),
        }

    def proof(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        nonce: str | None = None,
        proof_id: str | None = None,
        issued_at: int = FIXTURE_CLOCK,
        htu: str | None = None,
    ) -> str:
        header = {
            "typ": "dpop+jwt",
            "alg": "ES256",
            "jwk": self.public_jwk(),
        }
        payload: dict[str, object] = {
            "jti": proof_id or str(uuid.uuid4()),
            "htm": method,
            "htu": htu or f"{BASE_URL}{path}",
            "iat": issued_at,
        }
        if token is not None:
            payload["ath"] = b64url(hashlib.sha256(token.encode("ascii")).digest())
        if nonce is not None:
            payload["nonce"] = nonce
        encoded_header = b64url(
            json.dumps(header, separators=(",", ":"), sort_keys=True).encode()
        )
        encoded_payload = b64url(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        )
        signing_input = f"{encoded_header}.{encoded_payload}".encode("ascii")
        der_signature = self.private_key.sign(
            signing_input,
            ec.ECDSA(hashes.SHA256()),
        )
        r, s = decode_dss_signature(der_signature)
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return f"{encoded_header}.{encoded_payload}.{b64url(signature)}"


class BoundCredential:
    def __init__(self, token: str, key: ProofKey) -> None:
        self.token = token
        self.key = key
        self.nonce: str | None = None

    def headers(
        self,
        method: str,
        path: str,
        *,
        nonce: str | None = None,
        proof_id: str | None = None,
        issued_at: int = FIXTURE_CLOCK,
        htu: str | None = None,
    ) -> dict[str, str]:
        return {
            "Authorization": f"DPoP {self.token}",
            "DPoP": self.key.proof(
                method,
                path,
                token=self.token,
                nonce=self.nonce if nonce is None else nonce,
                proof_id=proof_id,
                issued_at=issued_at,
                htu=htu,
            ),
        }


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
            base_url=BASE_URL,
        )
        self.v2_now = FIXTURE_CLOCK

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

    async def v2_control(
        self, path: str, body: dict[str, object] | None = None
    ) -> httpx.Response:
        response = await self.http.post(
            path,
            headers=CONTROL_HEADERS,
            json=body,
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response

    async def v2_issue(
        self, email: str, *, code: str = "123456"
    ) -> tuple[dict[str, object], BoundCredential]:
        key = ProofKey()
        path = "/api/verify_email"
        body = {"email": email, "code": code}
        challenge = await self.http.post(
            path,
            headers={
                "DPoP": key.proof("POST", path, issued_at=self.v2_now),
            },
            json=body,
        )
        self.assertEqual(challenge.status_code, 400, challenge.text)
        self.assertEqual(challenge.json(), {"error": "use_dpop_nonce"})
        self.assertIn("no-store", challenge.headers.get("cache-control", ""))
        nonce = challenge.headers["dpop-nonce"]
        self.assertEqual(len(nonce), 76)
        verified = await self.http.post(
            path,
            headers={
                "DPoP": key.proof(
                    "POST",
                    path,
                    nonce=nonce,
                    issued_at=self.v2_now,
                ),
            },
            json=body,
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertIn("no-store", verified.headers.get("cache-control", ""))
        result = verified.json()
        self.assertEqual(result["token_type"], "DPoP")
        self.assertEqual(result["expires_in"], 86_400)
        return result, BoundCredential(result["token"], key)

    async def v2_seed_credential(
        self, username: str
    ) -> tuple[dict[str, object], BoundCredential]:
        email = f"{username}@fixture.invalid"
        resent = await self.http.post(
            "/api/resend_verification",
            json={"email": email},
        )
        self.assertEqual(resent.status_code, 200, resent.text)
        code_response = await self.v2_control(
            "/__test/v2/verification-code", {"email": email}
        )
        self.assertEqual(code_response.json(), {"code": "123456"})
        return await self.v2_issue(email, code=code_response.json()["code"])

    async def v2_protected(
        self,
        credential: BoundCredential,
        method: str,
        path: str,
        *,
        params: dict[str, object] | None = None,
        body: dict[str, object] | None = None,
        content: bytes | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        def headers() -> dict[str, str]:
            result = credential.headers(
                method,
                path,
                issued_at=self.v2_now,
            )
            if extra_headers is not None:
                result.update(extra_headers)
            return result

        response = await self.http.request(
            method,
            path,
            headers=headers(),
            params=params,
            json=body,
            content=content,
        )
        if (
            response.status_code == 401
            and 'error="use_dpop_nonce"'
            in response.headers.get("www-authenticate", "")
        ):
            credential.nonce = response.headers["dpop-nonce"]
            self.assertEqual(len(credential.nonce), 76)
            self.assertIn("no-store", response.headers.get("cache-control", ""))
            response = await self.http.request(
                method,
                path,
                headers=headers(),
                params=params,
                json=body,
                content=content,
            )
        replacement_nonce = response.headers.get("dpop-nonce")
        if replacement_nonce is not None:
            credential.nonce = replacement_nonce
        return response

    async def advance_v2_clock(self, seconds: int) -> None:
        response = await self.v2_control(
            "/__test/v2/clock", {"seconds": seconds}
        )
        self.v2_now += seconds
        self.assertEqual(response.json(), {"now": self.v2_now})

    async def test_v2_rest_enrollment_and_dpop_issuance_are_deterministic(
        self,
    ) -> None:
        registration_body = {
            "email": "new-agent@fixture.invalid",
            "username": "new_agent",
            "display_name": "New fixture agent",
        }
        registered = await self.http.post("/api/register", json=registration_body)
        self.assertEqual(registered.status_code, 200, registered.text)
        self.assertEqual(
            registered.json(),
            {
                "agent_id": "agent_fixture_0005",
                "username": "new_agent",
                "email": "new-agent@fixture.invalid",
                "message": "Verification code sent.",
            },
        )
        conflict = await self.http.post("/api/register", json=registration_body)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(
            conflict.json(), {"error": {"code": "registration_conflict"}}
        )

        unknown_resend = await self.http.post(
            "/api/resend_verification",
            json={"email": "absent@fixture.invalid"},
        )
        known_resend = await self.http.post(
            "/api/resend_verification",
            json={"email": "new-agent@fixture.invalid"},
        )
        self.assertEqual(unknown_resend.status_code, 200)
        self.assertEqual(unknown_resend.json(), known_resend.json())
        self.assertEqual(
            known_resend.json(), {"message": "Verification code resent."}
        )

        code = await self.v2_control(
            "/__test/v2/verification-code",
            {"email": "new-agent@fixture.invalid"},
        )
        result, credential = await self.v2_issue(
            "new-agent@fixture.invalid", code=code.json()["code"]
        )
        self.assertEqual(result["agent_id"], "agent_fixture_0005")
        self.assertEqual(result["username"], "new_agent")
        token = credential.token
        self.assertEqual(decode_jwt_part(token, 0), {"alg": "ES256", "typ": "JWT"})
        claims = decode_jwt_part(token, 1)
        self.assertEqual(claims["iss"], "urn:a2a:fixture:issuer:v2")
        self.assertEqual(
            claims["aud"],
            [
                "urn:a2a:fixture:resource:api:v2",
                "urn:a2a:fixture:resource:mcp:v2",
            ],
        )
        self.assertEqual(claims["sub"], "agent_fixture_0005")
        self.assertEqual(claims["iat"], FIXTURE_CLOCK)
        self.assertEqual(claims["exp"], FIXTURE_CLOCK + 86_400)
        thumbprint_input = {
            name: credential.key.public_jwk()[name]
            for name in ("crv", "kty", "x", "y")
        }
        expected_thumbprint = b64url(
            hashlib.sha256(
                json.dumps(
                    thumbprint_input,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode()
            ).digest()
        )
        self.assertEqual(claims["cnf"], {"jkt": expected_thumbprint})

        consumed_key = ProofKey()
        consumed_path = "/api/verify_email"
        consumed_body = {
            "email": "new-agent@fixture.invalid",
            "code": "123456",
        }
        consumed_challenge = await self.http.post(
            consumed_path,
            headers={
                "DPoP": consumed_key.proof(
                    "POST", consumed_path, issued_at=self.v2_now
                )
            },
            json=consumed_body,
        )
        consumed = await self.http.post(
            consumed_path,
            headers={
                "DPoP": consumed_key.proof(
                    "POST",
                    consumed_path,
                    nonce=consumed_challenge.headers["dpop-nonce"],
                    issued_at=self.v2_now,
                )
            },
            json=consumed_body,
        )
        self.assertEqual(consumed.status_code, 400)
        self.assertEqual(
            consumed.json(), {"error": {"code": "verification_failed"}}
        )
        self.assertIn("no-store", consumed.headers.get("cache-control", ""))

    async def test_v2_verification_nonce_checks_precede_body_parsing(self) -> None:
        email = "nonce-order@fixture.invalid"
        registered = await self.http.post(
            "/api/register",
            json={"email": email, "username": "nonce_order"},
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        path = "/api/verify_email"
        key = ProofKey()

        malformed_challenge = await self.http.post(
            path,
            headers={
                "Content-Type": "application/json",
                "DPoP": key.proof("POST", path, issued_at=self.v2_now),
            },
            content=b"{not-json",
        )
        self.assertEqual(malformed_challenge.status_code, 400)
        self.assertEqual(
            malformed_challenge.json(), {"error": "use_dpop_nonce"}
        )
        self.assertEqual(len(malformed_challenge.headers["dpop-nonce"]), 76)

        oversized_challenge = await self.http.post(
            path,
            headers={
                "Content-Type": "application/json",
                "DPoP": key.proof(
                    "POST",
                    path,
                    nonce="A" * 76,
                    issued_at=self.v2_now,
                ),
            },
            content=b"{" + b" " * 2048 + b"}",
        )
        self.assertEqual(oversized_challenge.status_code, 400)
        self.assertEqual(
            oversized_challenge.json(), {"error": "use_dpop_nonce"}
        )
        nonce = oversized_challenge.headers["dpop-nonce"]
        self.assertEqual(len(nonce), 76)

        code = await self.v2_control(
            "/__test/v2/verification-code", {"email": email}
        )
        verified = await self.http.post(
            path,
            headers={
                "DPoP": key.proof(
                    "POST",
                    path,
                    nonce=nonce,
                    issued_at=self.v2_now,
                )
            },
            json={"email": email, "code": code.json()["code"]},
        )
        self.assertEqual(verified.status_code, 200, verified.text)
        self.assertEqual(verified.json()["token_type"], "DPoP")

    async def test_v2_verification_code_expires_at_its_exact_deadline(
        self,
    ) -> None:
        email = "expired-code@fixture.invalid"
        registered = await self.http.post(
            "/api/register",
            json={"email": email, "username": "expired_code"},
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        await self.advance_v2_clock(600)

        expired_control = await self.http.post(
            "/__test/v2/verification-code",
            headers=CONTROL_HEADERS,
            json={"email": email},
        )
        self.assertEqual(expired_control.status_code, 404)

        path = "/api/verify_email"
        key = ProofKey()
        body = {"email": email, "code": "123456"}
        challenge = await self.http.post(
            path,
            headers={
                "DPoP": key.proof("POST", path, issued_at=self.v2_now)
            },
            json=body,
        )
        self.assertEqual(challenge.status_code, 400, challenge.text)
        self.assertEqual(challenge.json(), {"error": "use_dpop_nonce"})
        expired_verification = await self.http.post(
            path,
            headers={
                "DPoP": key.proof(
                    "POST",
                    path,
                    nonce=challenge.headers["dpop-nonce"],
                    issued_at=self.v2_now,
                )
            },
            json=body,
        )
        self.assertEqual(expired_verification.status_code, 400)
        self.assertEqual(
            expired_verification.json(),
            {"error": {"code": "verification_failed"}},
        )
        self.assertIn(
            "no-store", expired_verification.headers.get("cache-control", "")
        )

    async def test_v2_bootstrap_routes_isolate_authorization_and_proof_headers(
        self,
    ) -> None:
        rejected_registrations = (
            (
                "authorization@fixture.invalid",
                {"Authorization": "Bearer must-not-reach-bootstrap"},
            ),
            (
                "proof@fixture.invalid",
                {"DPoP": "must-not-reach-bootstrap"},
            ),
        )
        for email, headers in rejected_registrations:
            with self.subTest(route="register", email=email):
                response = await self.http.post(
                    "/api/register",
                    headers=headers,
                    json={"email": email, "username": email.split("@")[0]},
                )
                self.assertEqual(response.status_code, 422)
                self.assertEqual(
                    response.json(), {"error": {"code": "invalid_request"}}
                )
                absent_code = await self.http.post(
                    "/__test/v2/verification-code",
                    headers=CONTROL_HEADERS,
                    json={"email": email},
                )
                self.assertEqual(absent_code.status_code, 404)

        for headers in (
            {"Authorization": "Bearer must-not-reach-bootstrap"},
            {"DPoP": "must-not-reach-bootstrap"},
        ):
            with self.subTest(route="resend", headers=tuple(headers)):
                response = await self.http.post(
                    "/api/resend_verification",
                    headers=headers,
                    json={"email": "absent@fixture.invalid"},
                )
                self.assertEqual(response.status_code, 422)
                self.assertEqual(
                    response.json(), {"error": {"code": "invalid_request"}}
                )

        email = "verify-headers@fixture.invalid"
        registered = await self.http.post(
            "/api/register",
            json={"email": email, "username": "verify_headers"},
        )
        self.assertEqual(registered.status_code, 200, registered.text)
        body = {"email": email, "code": "123456"}
        path = "/api/verify_email"
        key = ProofKey()
        proof = key.proof("POST", path, issued_at=self.v2_now)

        missing_proof = await self.http.post(path, json=body)
        self.assertEqual(missing_proof.status_code, 400)
        self.assertEqual(missing_proof.json(), {"error": "invalid_dpop_proof"})
        with_authorization = await self.http.post(
            path,
            headers={
                "Authorization": "Bearer must-not-reach-verification",
                "DPoP": proof,
            },
            json=body,
        )
        self.assertEqual(with_authorization.status_code, 400)
        self.assertEqual(
            with_authorization.json(), {"error": "invalid_dpop_proof"}
        )
        repeated_proof = await self.http.post(
            path,
            headers=[("DPoP", proof), ("DPoP", proof)],
            json=body,
        )
        self.assertEqual(repeated_proof.status_code, 400)
        self.assertEqual(repeated_proof.json(), {"error": "invalid_dpop_proof"})

        result, _credential = await self.v2_issue(email)
        self.assertEqual(result["agent_id"], registered.json()["agent_id"])

    async def test_v2_dpop_rejects_bearer_wrong_key_replay_nonce_and_old_time(
        self,
    ) -> None:
        _identity, credential = await self.v2_seed_credential("fixture_sender")
        path = "/api/v2/delivery/activate"
        activated = await self.v2_protected(
            credential, "POST", path, content=b""
        )
        self.assertEqual(
            activated.json(), {"delivery_version": "v2", "status": "active"}
        )

        bearer = await self.http.post(
            path,
            headers={
                "Authorization": f"Bearer {credential.token}",
                "DPoP": credential.key.proof(
                    "POST",
                    path,
                    token=credential.token,
                    nonce=credential.nonce,
                    issued_at=self.v2_now,
                ),
            },
            content=b"",
        )
        self.assertEqual(bearer.status_code, 401)
        self.assertIn('error="invalid_token"', bearer.headers["www-authenticate"])
        legacy_bearer = await self.http.get(
            "/api/poll_messages",
            headers={"Authorization": f"Bearer {credential.token}"},
            params={"timeout": 0},
        )
        self.assertEqual(legacy_bearer.status_code, 401)

        wrong_key = ProofKey()
        wrong_key_response = await self.http.post(
            path,
            headers={
                "Authorization": f"DPoP {credential.token}",
                "DPoP": wrong_key.proof(
                    "POST",
                    path,
                    token=credential.token,
                    nonce=credential.nonce,
                    issued_at=self.v2_now,
                ),
            },
            content=b"",
        )
        self.assertEqual(wrong_key_response.status_code, 401)
        self.assertIn(
            'error="invalid_dpop_proof"',
            wrong_key_response.headers["www-authenticate"],
        )

        replay_id = "11111111-1111-4111-8111-111111111111"
        replay_headers = credential.headers(
            "POST",
            path,
            proof_id=replay_id,
            issued_at=self.v2_now,
        )
        first = await self.http.post(path, headers=replay_headers, content=b"")
        second = await self.http.post(path, headers=replay_headers, content=b"")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 401)
        self.assertIn(
            'error="invalid_dpop_proof"', second.headers["www-authenticate"]
        )

        before_invalid_nonce = await self.v2_control("/__test/v2/inspect", {})
        invalid_nonce = await self.http.post(
            path,
            headers=credential.headers(
                "POST",
                path,
                nonce="A" * 76,
                issued_at=self.v2_now,
            ),
            content=b"",
        )
        self.assertEqual(invalid_nonce.status_code, 401)
        self.assertIn(
            'error="use_dpop_nonce"', invalid_nonce.headers["www-authenticate"]
        )
        after_invalid_nonce = await self.v2_control("/__test/v2/inspect", {})
        self.assertEqual(
            before_invalid_nonce.json()["replay_entries"],
            after_invalid_nonce.json()["replay_entries"],
        )

        stale = await self.http.post(
            path,
            headers=credential.headers(
                "POST",
                path,
                issued_at=self.v2_now - 61,
            ),
            content=b"",
        )
        self.assertEqual(stale.status_code, 401)
        self.assertIn('error="invalid_dpop_proof"', stale.headers["www-authenticate"])

    async def test_v2_spoofed_proxy_headers_do_not_change_htu(self) -> None:
        _identity, credential = await self.v2_seed_credential("fixture_sender")
        path = "/api/v2/delivery/activate"
        primed = await self.v2_protected(credential, "POST", path, content=b"")
        self.assertEqual(primed.status_code, 200, primed.text)

        proxy_origin = "https://fixture-proxy.invalid"
        spoofed_origin_proof = await self.http.post(
            path,
            headers={
                **credential.headers(
                    "POST",
                    path,
                    issued_at=self.v2_now,
                    htu=f"{proxy_origin}{path}",
                ),
                "X-A2A-Test-Proxy": "trusted-fixture-proxy",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "fixture-proxy.invalid",
            },
            content=b"",
        )
        self.assertEqual(spoofed_origin_proof.status_code, 401)
        self.assertIn(
            'error="invalid_dpop_proof"',
            spoofed_origin_proof.headers["www-authenticate"],
        )

        spoofed_marker_and_forwarding = await self.http.post(
            path,
            headers={
                **credential.headers("POST", path, issued_at=self.v2_now),
                "X-A2A-Test-Proxy": "trusted-fixture-proxy",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "attacker.invalid",
            },
            content=b"",
        )
        self.assertEqual(
            spoofed_marker_and_forwarding.status_code,
            200,
            spoofed_marker_and_forwarding.text,
        )

        spoofed_forwarding = await self.http.post(
            path,
            headers={
                **credential.headers("POST", path, issued_at=self.v2_now),
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "attacker.invalid",
            },
            content=b"",
        )
        self.assertEqual(spoofed_forwarding.status_code, 200, spoofed_forwarding.text)

    async def test_v2_dpop_uri_normalization_uses_the_raw_request_path(
        self,
    ) -> None:
        self.assertEqual(
            normalize_htu("HTTP://Example.COM:80/a//b/./c/../"),
            "http://example.com/a//b/",
        )
        self.assertEqual(
            normalize_htu("https://Example.COM:443/a/%2f/%3f/"),
            "https://example.com/a/%2F/%3F/",
        )

        _identity, credential = await self.v2_seed_credential("fixture_sender")
        activation_path = "/api/v2/delivery/activate"
        primed = await self.v2_protected(
            credential, "POST", activation_path, content=b""
        )
        self.assertEqual(primed.status_code, 200, primed.text)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://LOCALHOST:80",
        ) as normalized_origin:
            normalized = await normalized_origin.post(
                activation_path,
                headers=credential.headers(
                    "POST",
                    activation_path,
                    issued_at=self.v2_now,
                    htu=(
                        "HTTP://LOCALHOST:80/api/v2/ignored/../delivery/activate"
                    ),
                ),
                content=b"",
            )
        self.assertEqual(normalized.status_code, 200, normalized.text)

        encoded_path = "/api/v2/delivery%2Factivate"
        decoded_path_proof = await self.http.post(
            encoded_path,
            headers=credential.headers(
                "POST",
                encoded_path,
                issued_at=self.v2_now,
                htu=f"{BASE_URL}{activation_path}",
            ),
            content=b"",
        )
        self.assertEqual(decoded_path_proof.status_code, 401)
        self.assertEqual(
            decoded_path_proof.json(), {"error": "invalid_dpop_proof"}
        )
        encoded_path_proof = await self.http.post(
            encoded_path,
            headers=credential.headers(
                "POST",
                encoded_path,
                issued_at=self.v2_now,
                htu=f"{BASE_URL}/api/v2/delivery%2factivate",
            ),
            content=b"",
        )
        self.assertEqual(encoded_path_proof.status_code, 200, encoded_path_proof.text)

        query_path = "/api/v2/messages/receive"
        query_excluded = await self.http.get(
            query_path,
            headers=credential.headers(
                "GET",
                query_path,
                issued_at=self.v2_now,
            ),
            params={"timeout": 0, "limit": 1},
        )
        self.assertEqual(query_excluded.status_code, 200, query_excluded.text)
        self.assertEqual(query_excluded.json(), {"messages": []})

    async def test_v2_rest_and_mcp_auth_header_cardinality(self) -> None:
        _identity, credential = await self.v2_seed_credential("fixture_sender")
        rest_path = "/api/v2/delivery/activate"
        primed = await self.v2_protected(
            credential, "POST", rest_path, content=b""
        )
        self.assertEqual(primed.status_code, 200, primed.text)

        def proof(path: str) -> str:
            return credential.key.proof(
                "POST",
                path,
                token=credential.token,
                nonce=credential.nonce,
                issued_at=self.v2_now,
            )

        authorization = ("Authorization", f"DPoP {credential.token}")
        rest_cases = (
            ("missing_authorization", [("DPoP", proof(rest_path))], "invalid_token"),
            (
                "repeated_authorization",
                [authorization, authorization, ("DPoP", proof(rest_path))],
                "invalid_token",
            ),
            (
                "bad_authorization",
                [
                    ("Authorization", f"Bearer {credential.token}"),
                    ("DPoP", proof(rest_path)),
                ],
                "invalid_token",
            ),
            ("missing_dpop", [authorization], "invalid_dpop_proof"),
            (
                "repeated_dpop",
                [
                    authorization,
                    ("DPoP", proof(rest_path)),
                    ("DPoP", proof(rest_path)),
                ],
                "invalid_dpop_proof",
            ),
        )
        for name, headers, error in rest_cases:
            with self.subTest(transport="rest", case=name):
                response = await self.http.post(
                    rest_path, headers=headers, content=b""
                )
                self.assertEqual(response.status_code, 401, response.text)
                self.assertEqual(response.json(), {"error": error})

        mcp_path = "/mcp"
        mcp_authorization = ("Authorization", f"DPoP {credential.token}")
        mcp_proof = lambda: credential.key.proof(
            "POST",
            mcp_path,
            token=credential.token,
            nonce=credential.nonce,
            issued_at=self.v2_now,
        )
        mcp_cases = (
            ("missing_authorization", [("DPoP", mcp_proof())], "invalid_token"),
            (
                "repeated_authorization",
                [mcp_authorization, mcp_authorization, ("DPoP", mcp_proof())],
                "invalid_token",
            ),
            (
                "bad_authorization",
                [
                    ("Authorization", f"Bearer {credential.token}"),
                    ("DPoP", mcp_proof()),
                ],
                "invalid_token",
            ),
            ("missing_dpop", [mcp_authorization], "invalid_dpop_proof"),
            (
                "repeated_dpop",
                [
                    mcp_authorization,
                    ("DPoP", mcp_proof()),
                    ("DPoP", mcp_proof()),
                ],
                "invalid_dpop_proof",
            ),
        )
        for name, security_headers, error in mcp_cases:
            with self.subTest(transport="mcp", case=name):
                response = await self.http.post(
                    mcp_path,
                    headers=[
                        ("Accept", "application/json, text/event-stream"),
                        ("Content-Type", "application/json"),
                        *security_headers,
                    ],
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {},
                    },
                )
                self.assertEqual(response.status_code, 401, response.text)
                self.assertEqual(response.json(), {"error": error})

    async def test_trailing_slash_contract_paths_never_redirect(self) -> None:
        bootstrap = await self.http.post(
            "/api/register/",
            json={
                "email": "no-redirect@fixture.invalid",
                "username": "no_redirect",
            },
            follow_redirects=False,
        )
        self.assertEqual(bootstrap.status_code, 404, bootstrap.text)
        self.assertNotIn("location", bootstrap.headers)

        _identity, credential = await self.v2_seed_credential("fixture_sender")
        activation_path = "/api/v2/delivery/activate"
        primed = await self.v2_protected(
            credential, "POST", activation_path, content=b""
        )
        self.assertEqual(primed.status_code, 200, primed.text)
        protected_path = f"{activation_path}/"
        protected = await self.http.post(
            protected_path,
            headers=credential.headers(
                "POST", protected_path, issued_at=self.v2_now
            ),
            content=b"",
            follow_redirects=False,
        )
        self.assertEqual(protected.status_code, 404, protected.text)
        self.assertNotIn("location", protected.headers)

        mcp_path = "/mcp/"
        mcp = await self.http.post(
            mcp_path,
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
                **credential.headers("POST", mcp_path, issued_at=self.v2_now),
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {},
            },
            follow_redirects=False,
        )
        self.assertEqual(mcp.status_code, 404, mcp.text)
        self.assertNotIn("location", mcp.headers)

    async def test_v2_nonce_key_rotation_is_explicit(self) -> None:
        _identity, credential = await self.v2_seed_credential("fixture_sender")
        path = "/api/v2/delivery/activate"
        primed = await self.v2_protected(credential, "POST", path, content=b"")
        self.assertEqual(primed.status_code, 200, primed.text)

        rotated = await self.http.post(
            "/__test/v2/nonce-key/rotate", headers=CONTROL_HEADERS
        )
        self.assertEqual(rotated.status_code, 200, rotated.text)
        previous_key_nonce = await self.http.post(
            path,
            headers=credential.headers("POST", path, issued_at=self.v2_now),
            content=b"",
        )
        self.assertEqual(previous_key_nonce.status_code, 200, previous_key_nonce.text)
        await self.advance_v2_clock(306)
        expired_previous_nonce = await self.http.post(
            path,
            headers=credential.headers("POST", path, issued_at=self.v2_now),
            content=b"",
        )
        self.assertEqual(expired_previous_nonce.status_code, 401)
        self.assertIn(
            'error="use_dpop_nonce"',
            expired_previous_nonce.headers["www-authenticate"],
        )
        self.assertEqual(len(expired_previous_nonce.headers["dpop-nonce"]), 76)

        profile = await self.http.get(
            "/__test/v2/profile", headers=CONTROL_HEADERS
        )
        self.assertEqual(profile.status_code, 200, profile.text)
        self.assertEqual(
            profile.json()["audience"],
            [
                "urn:a2a:fixture:resource:api:v2",
                "urn:a2a:fixture:resource:mcp:v2",
            ],
        )
        self.assertNotIn("d", profile.json()["issuer_public_jwk"])
        self.assertNotIn("private", profile.text.lower())

    async def test_v2_activation_lease_completion_outcome_and_acknowledgement(
        self,
    ) -> None:
        _identity, recipient = await self.v2_seed_credential("fixture_recipient")
        activation = await self.v2_protected(
            recipient,
            "POST",
            "/api/v2/delivery/activate",
            content=b"",
        )
        self.assertEqual(activation.status_code, 200, activation.text)

        injected = await self.v2_control(
            "/__test/v2/messages",
            {
                "sender_username": "fixture_sender",
                "recipient_username": "fixture_recipient",
                "text": "leased fixture message",
            },
        )
        message_id = injected.json()["message_id"]
        conversation_id = injected.json()["conversation_id"]
        receive_path = "/api/v2/messages/receive"
        received = await self.v2_protected(
            recipient,
            "GET",
            receive_path,
            params={"timeout": 0, "limit": 100},
        )
        self.assertEqual(received.status_code, 200, received.text)
        expected_message = {
            "id": message_id,
            "conversation_id": conversation_id,
            "sender_agent_id": "agent_fixture_0001",
            "message_type": "conversation_turn",
            "in_reply_to_message_id": None,
            "payload": {"text": "leased fixture message"},
            "created_at": "2026-08-29T10:40:00.000Z",
        }
        self.assertEqual(received.json(), {"messages": [expected_message]})
        hidden_during_lease = await self.v2_protected(
            recipient,
            "GET",
            receive_path,
            params={"timeout": 0, "limit": 100},
        )
        self.assertEqual(hidden_during_lease.json(), {"messages": []})

        ack_path = f"/api/v2/messages/{message_id}/ack"
        premature_ack = await self.v2_protected(
            recipient, "POST", ack_path, content=b""
        )
        self.assertEqual(premature_ack.status_code, 409)
        self.assertEqual(
            premature_ack.json(),
            {"error": {"code": "message_not_terminal", "retry_after_ms": None}},
        )

        await self.advance_v2_clock(60)
        redelivered = await self.v2_protected(
            recipient,
            "GET",
            receive_path,
            params={"timeout": 0, "limit": 100},
        )
        self.assertEqual(redelivered.json(), {"messages": [expected_message]})

        complete_path = f"/api/v2/messages/{message_id}/complete"
        completion_body = {
            "outcome": "unsupported",
            "reason_code": "unsupported_payload",
        }
        completion = await self.v2_protected(
            recipient, "POST", complete_path, body=completion_body
        )
        repeated_completion = await self.v2_protected(
            recipient, "POST", complete_path, body=completion_body
        )
        self.assertEqual(completion.status_code, 200, completion.text)
        self.assertEqual(completion.json(), repeated_completion.json())
        self.assertEqual(
            completion.json(),
            {"message_id": message_id, "outcome": "unsupported", "status": "recorded"},
        )
        conflicting_completion = await self.v2_protected(
            recipient,
            "POST",
            complete_path,
            body={
                "outcome": "unsupported",
                "reason_code": "unsupported_message_type",
            },
        )
        self.assertEqual(conflicting_completion.status_code, 409)
        self.assertEqual(
            conflicting_completion.json()["error"]["code"],
            "idempotency_conflict",
        )
        different_outcome = await self.v2_protected(
            recipient,
            "POST",
            complete_path,
            body={
                "outcome": "failed",
                "reason_code": "provider_execution_failed",
            },
        )
        self.assertEqual(different_outcome.status_code, 409)
        self.assertEqual(
            different_outcome.json()["error"]["code"],
            "idempotency_conflict",
        )

        outcome = await self.v2_protected(
            recipient,
            "GET",
            f"/api/v2/messages/{message_id}/outcome",
        )
        self.assertEqual(
            outcome.json(),
            {
                "message_id": message_id,
                "conversation_id": conversation_id,
                "status": "terminal",
                "outcome": "unsupported",
                "reply_message_id": None,
            },
        )
        acknowledged = await self.v2_protected(
            recipient, "POST", ack_path, content=b""
        )
        repeated_ack = await self.v2_protected(
            recipient, "POST", ack_path, content=b""
        )
        self.assertEqual(
            acknowledged.json(), {"message_id": message_id, "status": "acked"}
        )
        self.assertEqual(repeated_ack.json(), acknowledged.json())
        await self.advance_v2_clock(60)
        after_ack = await self.v2_protected(
            recipient,
            "GET",
            receive_path,
            params={"timeout": 0, "limit": 100},
        )
        self.assertEqual(after_ack.json(), {"messages": []})

    async def test_v2_conversation_start_reply_lookup_and_authorization(
        self,
    ) -> None:
        _sender_identity, sender = await self.v2_seed_credential("fixture_sender")
        _recipient_identity, recipient = await self.v2_seed_credential(
            "fixture_recipient"
        )
        for credential in (sender, recipient):
            activated = await self.v2_protected(
                credential,
                "POST",
                "/api/v2/delivery/activate",
                content=b"",
            )
            self.assertEqual(activated.status_code, 200, activated.text)

        request_id = "22222222-2222-4222-8222-222222222222"
        start_body = {
            "recipient_username": "fixture_recipient",
            "payload": {"text": "Please review this fixture change."},
        }
        start_headers = {"Idempotency-Key": request_id}
        started = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body=start_body,
            extra_headers=start_headers,
        )
        self.assertEqual(started.status_code, 201, started.text)
        repeated_start = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body=start_body,
            extra_headers=start_headers,
        )
        self.assertEqual(repeated_start.status_code, 200, repeated_start.text)
        self.assertEqual(repeated_start.json(), started.json())
        message_id = started.json()["message_id"]
        conversation_id = started.json()["conversation_id"]

        conflicting_start = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "Different text under one request ID."},
            },
            extra_headers=start_headers,
        )
        self.assertEqual(conflicting_start.status_code, 409)
        self.assertEqual(
            conflicting_start.json()["error"]["code"], "idempotency_conflict"
        )
        lookup = await self.v2_protected(
            sender,
            "GET",
            f"/api/v2/conversation-starts/{request_id}",
        )
        self.assertEqual(
            lookup.json(),
            {
                "request_id": request_id,
                "status": "accepted",
                "message_id": message_id,
                "conversation_id": conversation_id,
            },
        )
        absent_request_id = "33333333-3333-4333-8333-333333333333"
        absent_lookup = await self.v2_protected(
            sender,
            "GET",
            f"/api/v2/conversation-starts/{absent_request_id}",
        )
        self.assertEqual(absent_lookup.json()["status"], "not_found")
        self.assertIsNone(absent_lookup.json()["message_id"])

        denial_id = "44444444-4444-4444-8444-444444444444"
        missing_recipient = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "missing_recipient",
                "payload": {"text": "Must not enumerate."},
            },
            extra_headers={"Idempotency-Key": denial_id},
        )
        denied_recipient = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_denied",
                "payload": {"text": "Must not enumerate."},
            },
            extra_headers={
                "Idempotency-Key": "55555555-5555-4555-8555-555555555555"
            },
        )
        self.assertEqual(missing_recipient.status_code, 404)
        self.assertEqual(missing_recipient.content, denied_recipient.content)

        received = await self.v2_protected(
            recipient,
            "GET",
            "/api/v2/messages/receive",
            params={"timeout": 0, "limit": 100},
        )
        self.assertEqual(len(received.json()["messages"]), 1)
        inbound = received.json()["messages"][0]
        self.assertEqual(inbound["id"], message_id)
        self.assertEqual(inbound["conversation_id"], conversation_id)
        self.assertIsNone(inbound["in_reply_to_message_id"])

        reply_path = f"/api/v2/messages/{message_id}/reply"
        reply_key = "reply.v1." + b64url(
            hashlib.sha256(message_id.encode("utf-8")).digest()
        )
        reply_body = {"payload": {"text": "The fixture change is ready."}}
        replied = await self.v2_protected(
            recipient,
            "POST",
            reply_path,
            body=reply_body,
            extra_headers={"Idempotency-Key": reply_key},
        )
        repeated_reply = await self.v2_protected(
            recipient,
            "POST",
            reply_path,
            body=reply_body,
            extra_headers={"Idempotency-Key": reply_key},
        )
        self.assertEqual(replied.status_code, 200, replied.text)
        self.assertEqual(repeated_reply.json(), replied.json())
        reply_message_id = replied.json()["message_id"]
        self.assertEqual(replied.json()["conversation_id"], conversation_id)
        conflicting_reply = await self.v2_protected(
            recipient,
            "POST",
            reply_path,
            body={"payload": {"text": "A second logical reply."}},
            extra_headers={"Idempotency-Key": reply_key},
        )
        self.assertEqual(conflicting_reply.status_code, 409)
        self.assertEqual(
            conflicting_reply.json()["error"]["code"], "idempotency_conflict"
        )
        completion_after_reply = await self.v2_protected(
            recipient,
            "POST",
            f"/api/v2/messages/{message_id}/complete",
            body={
                "outcome": "completed_without_reply",
                "reason_code": "no_reply_required",
            },
        )
        self.assertEqual(completion_after_reply.status_code, 409)
        self.assertEqual(
            completion_after_reply.json()["error"]["code"],
            "message_already_terminal",
        )

        sender_outcome = await self.v2_protected(
            sender,
            "GET",
            f"/api/v2/messages/{message_id}/outcome",
        )
        self.assertEqual(
            sender_outcome.json(),
            {
                "message_id": message_id,
                "conversation_id": conversation_id,
                "status": "terminal",
                "outcome": "replied",
                "reply_message_id": reply_message_id,
            },
        )
        acked = await self.v2_protected(
            recipient,
            "POST",
            f"/api/v2/messages/{message_id}/ack",
            content=b"",
        )
        self.assertEqual(acked.status_code, 200, acked.text)
        sender_receive = await self.v2_protected(
            sender,
            "GET",
            "/api/v2/messages/receive",
            params={"timeout": 0, "limit": 100},
        )
        self.assertEqual(len(sender_receive.json()["messages"]), 1)
        outbound = sender_receive.json()["messages"][0]
        self.assertEqual(outbound["id"], reply_message_id)
        self.assertEqual(outbound["conversation_id"], conversation_id)
        self.assertEqual(outbound["in_reply_to_message_id"], message_id)

    async def test_v2_exact_start_retry_survives_grant_revocation(self) -> None:
        _identity, sender = await self.v2_seed_credential("fixture_sender")
        request_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        body = {
            "recipient_username": "fixture_recipient",
            "payload": {"text": "Retry this exact accepted start."},
        }
        headers = {"Idempotency-Key": request_id}
        accepted = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body=body,
            extra_headers=headers,
        )
        self.assertEqual(accepted.status_code, 201, accepted.text)

        await self.v2_control(
            "/__test/v2/grants",
            {
                "sender_username": "fixture_sender",
                "recipient_username": "fixture_recipient",
                "active": False,
            },
        )
        exact_retry = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body=body,
            extra_headers=headers,
        )
        self.assertEqual(exact_retry.status_code, 200, exact_retry.text)
        self.assertEqual(exact_retry.json(), accepted.json())

        changed_retry = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "Changed after acceptance."},
            },
            extra_headers=headers,
        )
        self.assertEqual(changed_retry.status_code, 409)
        self.assertEqual(
            changed_retry.json()["error"]["code"], "idempotency_conflict"
        )

    async def test_v2_idempotency_namespaces_reject_unsafe_collisions(
        self,
    ) -> None:
        _sender_identity, sender = await self.v2_seed_credential(
            "fixture_sender"
        )
        _recipient_identity, recipient = await self.v2_seed_credential(
            "fixture_recipient"
        )
        _other_identity, other_sender = await self.v2_seed_credential(
            "fixture_denied"
        )
        await self.v2_control(
            "/__test/v2/grants",
            {
                "sender_username": "fixture_denied",
                "recipient_username": "fixture_recipient",
                "active": True,
            },
        )

        start_then_reissue_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        accepted_start = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "Reserve this ID for start.v1."},
            },
            extra_headers={"Idempotency-Key": start_then_reissue_id},
        )
        self.assertEqual(accepted_start.status_code, 201, accepted_start.text)
        start_id_as_reissue = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/token/reissue",
            body={},
            extra_headers={"Idempotency-Key": start_then_reissue_id},
        )
        self.assertEqual(start_id_as_reissue.status_code, 409)
        self.assertEqual(
            start_id_as_reissue.json()["error"]["code"],
            "idempotency_conflict",
        )

        await self.advance_v2_clock(1)
        reissue_then_start_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        accepted_reissue = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/token/reissue",
            body={},
            extra_headers={"Idempotency-Key": reissue_then_start_id},
        )
        self.assertEqual(accepted_reissue.status_code, 200, accepted_reissue.text)
        reissue_id_as_start = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "Must conflict with reissue.v1."},
            },
            extra_headers={"Idempotency-Key": reissue_then_start_id},
        )
        self.assertEqual(reissue_id_as_start.status_code, 409)
        self.assertEqual(
            reissue_id_as_start.json()["error"]["code"],
            "idempotency_conflict",
        )
        cross_subject_reissue = await self.v2_protected(
            recipient,
            "POST",
            "/api/v2/token/reissue",
            body={},
            extra_headers={"Idempotency-Key": reissue_then_start_id},
        )
        self.assertEqual(cross_subject_reissue.status_code, 409)
        self.assertEqual(
            cross_subject_reissue.json()["error"]["code"],
            "idempotency_conflict",
        )

        shared_start_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        for credential, text in (
            (sender, "First subject under start.v1."),
            (other_sender, "Second subject under start.v1."),
        ):
            with self.subTest(subject=text):
                response = await self.v2_protected(
                    credential,
                    "POST",
                    "/api/v2/conversations",
                    body={
                        "recipient_username": "fixture_recipient",
                        "payload": {"text": text},
                    },
                    extra_headers={"Idempotency-Key": shared_start_id},
                )
                self.assertEqual(response.status_code, 201, response.text)

    async def test_v2_reissue_recovery_revocation_and_legacy_activation(
        self,
    ) -> None:
        identity, credential = await self.v2_seed_credential("fixture_sender")
        original_token = credential.token
        request_id = "66666666-6666-4666-8666-666666666666"
        reissue_path = "/api/v2/token/reissue"
        too_early = await self.v2_protected(
            credential,
            "POST",
            reissue_path,
            body={},
            extra_headers={"Idempotency-Key": request_id},
        )
        self.assertEqual(too_early.status_code, 429, too_early.text)
        self.assertEqual(
            too_early.json(),
            {"error": {"code": "rate_limited", "retry_after_ms": 1_000}},
        )
        await self.advance_v2_clock(1)
        reissued = await self.v2_protected(
            credential,
            "POST",
            reissue_path,
            body={},
            extra_headers={"Idempotency-Key": request_id},
        )
        repeated_reissue = await self.v2_protected(
            credential,
            "POST",
            reissue_path,
            body={},
            extra_headers={"Idempotency-Key": request_id},
        )
        self.assertEqual(reissued.status_code, 200, reissued.text)
        self.assertEqual(reissued.json(), repeated_reissue.json())
        self.assertNotEqual(reissued.json()["token"], original_token)
        self.assertEqual(reissued.json()["token_type"], "DPoP")
        self.assertEqual(reissued.json()["expires_in"], 86_400)
        self.assertIn("no-store", reissued.headers.get("cache-control", ""))
        replacement_claims = decode_jwt_part(reissued.json()["token"], 1)
        original_claims = decode_jwt_part(original_token, 1)
        self.assertEqual(replacement_claims["sub"], identity["agent_id"])
        self.assertEqual(replacement_claims["cnf"], original_claims["cnf"])
        self.assertNotEqual(replacement_claims["jti"], original_claims["jti"])
        self.assertGreater(replacement_claims["exp"], original_claims["exp"])
        self.assertEqual(
            replacement_claims["exp"] - replacement_claims["iat"], 86_400
        )

        replacement = BoundCredential(reissued.json()["token"], credential.key)
        replacement.nonce = credential.nonce
        revoke = await self.v2_protected(
            replacement,
            "POST",
            "/api/v2/token/revoke",
            body={"scope": "identity"},
        )
        self.assertEqual(revoke.status_code, 204, revoke.text)
        for revoked in (credential, replacement):
            rejected = await self.v2_protected(
                revoked,
                "POST",
                "/api/v2/delivery/activate",
                content=b"",
            )
            self.assertEqual(rejected.status_code, 401)
            self.assertIn(
                'error="invalid_token"', rejected.headers["www-authenticate"]
            )

        _legacy_identity, legacy = await self.v2_seed_credential("fixture_legacy")
        legacy_activation = await self.v2_protected(
            legacy,
            "POST",
            "/api/v2/delivery/activate",
            content=b"",
        )
        self.assertEqual(legacy_activation.status_code, 409)
        self.assertEqual(
            legacy_activation.json()["error"]["code"], "migration_incomplete"
        )

    async def test_legacy_email_recovery_invalidates_every_old_credential(
        self,
    ) -> None:
        email = "fixture_legacy@fixture.invalid"
        v1_code = await self.http.post(
            "/__test/verification-code",
            headers=CONTROL_HEADERS,
            json={"email": email},
        )
        self.assertEqual(v1_code.status_code, 200, v1_code.text)
        self.assertEqual(v1_code.json(), {"code": "246810"})
        async with Client(self.mcp) as client:
            verified = await client.call_tool(
                "verify_email",
                {"email": email, "code": v1_code.json()["code"]},
            )
        legacy_token = verified.structured_content["token"]
        self.assertEqual(
            decode_jwt_part(legacy_token, 0), {"alg": "ES256", "typ": "JWT"}
        )
        legacy_claims = decode_jwt_part(legacy_token, 1)
        self.assertEqual(legacy_claims["iss"], "urn:a2a:fixture:issuer:v2")
        self.assertEqual(legacy_claims["sub"], "agent_fixture_0004")
        self.assertEqual(
            legacy_claims["aud"],
            [
                "urn:a2a:fixture:resource:api:v2",
                "urn:a2a:fixture:resource:mcp:v2",
            ],
        )
        self.assertNotIn("cnf", legacy_claims)
        legacy_poll = await self.http.get(
            "/api/poll_messages",
            headers={"Authorization": f"Bearer {legacy_token}"},
            params={"timeout": 0},
        )
        self.assertEqual(legacy_poll.status_code, 200, legacy_poll.text)
        self.assertEqual(legacy_poll.json(), {"messages": []})

        recovery_identity, old_credential = await self.v2_seed_credential(
            "fixture_legacy"
        )
        recovery_claims = decode_jwt_part(old_credential.token, 1)
        self.assertEqual(recovery_identity["agent_id"], legacy_claims["sub"])
        for claim_name in ("iss", "sub", "aud"):
            self.assertEqual(
                recovery_claims[claim_name], legacy_claims[claim_name]
            )
        self.assertIn("cnf", recovery_claims)
        invalidated_legacy = await self.http.get(
            "/api/poll_messages",
            headers={"Authorization": f"Bearer {legacy_token}"},
            params={"timeout": 0},
        )
        self.assertEqual(invalidated_legacy.status_code, 401)

        await self.advance_v2_clock(1)
        reissued = await self.v2_protected(
            old_credential,
            "POST",
            "/api/v2/token/reissue",
            body={},
            extra_headers={
                "Idempotency-Key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            },
        )
        self.assertEqual(reissued.status_code, 200, reissued.text)
        old_reissued_credential = BoundCredential(
            reissued.json()["token"], old_credential.key
        )
        old_reissued_credential.nonce = old_credential.nonce

        _identity, new_credential = await self.v2_seed_credential(
            "fixture_legacy"
        )
        for old in (old_credential, old_reissued_credential):
            rejected = await self.v2_protected(
                old,
                "POST",
                "/api/v2/delivery/activate",
                content=b"",
            )
            self.assertEqual(rejected.status_code, 401, rejected.text)
            self.assertEqual(rejected.json(), {"error": "invalid_token"})

        newly_authenticated = await self.v2_protected(
            new_credential,
            "POST",
            "/api/v2/delivery/activate",
            content=b"",
        )
        self.assertEqual(newly_authenticated.status_code, 409)
        self.assertEqual(
            newly_authenticated.json()["error"]["code"],
            "migration_incomplete",
        )

        inspection = await self.v2_control("/__test/v2/inspect", {})
        self.assert_control_omits(
            inspection,
            email,
            "246810",
            legacy_token,
            old_credential.token,
            old_reissued_credential.token,
            new_credential.token,
        )

    async def test_v2_controls_faults_bounds_and_reset_are_content_safe(
        self,
    ) -> None:
        unauthenticated = await self.http.post("/__test/v2/inspect", json={})
        self.assertEqual(unauthenticated.status_code, 401)
        invalid_control = await self.http.post(
            "/__test/v2/messages",
            headers=CONTROL_HEADERS,
            json={
                "sender_username": "fixture_sender",
                "recipient_username": "fixture_recipient",
                "text": "bounded control text",
                "unexpected": True,
            },
        )
        self.assertEqual(invalid_control.status_code, 422)

        invalid_registration = await self.http.post(
            "/api/register",
            json={
                "email": "bad@fixture.invalid",
                "username": " bad-name ",
                "unexpected": True,
            },
        )
        self.assertEqual(invalid_registration.status_code, 422)
        self.assertEqual(
            invalid_registration.json(), {"error": {"code": "invalid_request"}}
        )

        await self.v2_control(
            "/__test/v2/faults",
            {"operation": "register", "mode": "drop_after_commit"},
        )
        lost = await self.http.post(
            "/api/register",
            json={
                "email": "lost-response@fixture.invalid",
                "username": "lost_response",
            },
        )
        self.assertEqual(lost.status_code, 503)
        repeated = await self.http.post(
            "/api/register",
            json={
                "email": "lost-response@fixture.invalid",
                "username": "lost_response",
            },
        )
        self.assertEqual(repeated.status_code, 409)

        injected = await self.v2_control(
            "/__test/v2/messages",
            {
                "sender_username": "fixture_sender",
                "recipient_username": "fixture_recipient",
                "text": "control-secret-message",
            },
        )
        inspection = await self.v2_control("/__test/v2/inspect", {})
        self.assert_control_omits(
            inspection,
            "control-secret-message",
            "lost-response@fixture.invalid",
            "123456",
        )
        self.assertIn(
            injected.json()["message_id"],
            [message["message_id"] for message in inspection.json()["messages"]],
        )

        reset = await self.http.post("/__test/reset", headers=CONTROL_HEADERS)
        self.assertEqual(reset.status_code, 200)
        reset_inspection = await self.v2_control("/__test/v2/inspect", {})
        self.assertEqual(reset_inspection.json()["now"], FIXTURE_CLOCK)
        self.assertEqual(len(reset_inspection.json()["agents"]), 4)
        self.assertEqual(reset_inspection.json()["messages"], [])
        deterministic = await self.http.post(
            "/api/register",
            json={
                "email": "after-reset@fixture.invalid",
                "username": "after_reset",
            },
        )
        self.assertEqual(deterministic.status_code, 200, deterministic.text)
        self.assertEqual(deterministic.json()["agent_id"], "agent_fixture_0005")

    async def test_v2_request_bounds_and_authentication_precede_body_parsing(
        self,
    ) -> None:
        explicit_null = await self.http.post(
            "/api/register",
            json={
                "email": "null-display@fixture.invalid",
                "username": "null_display",
                "display_name": None,
            },
        )
        self.assertEqual(explicit_null.status_code, 422)
        self.assertEqual(
            explicit_null.json(), {"error": {"code": "invalid_request"}}
        )
        duplicate_json = await self.http.post(
            "/api/register",
            headers={"Content-Type": "application/json"},
            content=(
                b'{"email":"first@fixture.invalid",'
                b'"email":"second@fixture.invalid","username":"duplicate"}'
            ),
        )
        self.assertEqual(duplicate_json.status_code, 422)
        self.assertEqual(
            duplicate_json.json(), {"error": {"code": "invalid_request"}}
        )
        oversized_bootstrap = await self.http.post(
            "/api/register",
            headers={"Content-Type": "application/json"},
            content=b"{" + b" " * 2048 + b"}",
        )
        self.assertEqual(oversized_bootstrap.status_code, 422)

        malformed_before_auth = await self.http.post(
            "/api/v2/conversations",
            headers={"Content-Type": "application/json"},
            content=b"{not-json",
        )
        self.assertEqual(malformed_before_auth.status_code, 401)
        self.assertEqual(malformed_before_auth.json(), {"error": "invalid_token"})

        _identity, sender = await self.v2_seed_credential("fixture_sender")
        activated = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/delivery/activate",
            content=b"",
        )
        self.assertEqual(activated.status_code, 200, activated.text)

        for params in (
            {"timeout": -1, "limit": 1},
            {"timeout": 31, "limit": 1},
            {"timeout": 0, "limit": 0},
            {"timeout": 0, "limit": 101},
        ):
            response = await self.v2_protected(
                sender,
                "GET",
                "/api/v2/messages/receive",
                params=params,
            )
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(
                response.json(),
                {"error": {"code": "invalid_request", "retry_after_ms": None}},
            )

        missing_request_id = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "Missing request ID."},
            },
        )
        self.assertEqual(missing_request_id.status_code, 400)
        invalid_request_id = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "Invalid request ID."},
            },
            extra_headers={"Idempotency-Key": "not-a-uuid"},
        )
        self.assertEqual(invalid_request_id.status_code, 400)

        oversized_text = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            body={
                "recipient_username": "fixture_recipient",
                "payload": {"text": "x" * 262_145},
            },
            extra_headers={
                "Idempotency-Key": "77777777-7777-4777-8777-777777777777"
            },
        )
        self.assertEqual(oversized_text.status_code, 400)
        self.assertEqual(oversized_text.json()["error"]["code"], "invalid_request")
        over_wire_limit = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            content=b"{" + b" " * 524_288 + b"}",
            extra_headers={
                "Content-Type": "application/json",
                "Idempotency-Key": "88888888-8888-4888-8888-888888888888",
            },
        )
        self.assertEqual(over_wire_limit.status_code, 413)
        self.assertEqual(
            over_wire_limit.json()["error"]["code"], "request_too_large"
        )

    async def test_v2_streaming_body_limits_stop_before_the_unread_tail(
        self,
    ) -> None:
        bootstrap_chunks_read = 0

        async def oversized_bootstrap_stream():
            nonlocal bootstrap_chunks_read
            bootstrap_chunks_read += 1
            yield b"{" + b" " * 2_048
            bootstrap_chunks_read += 1
            yield (
                b'"email":"streamed@fixture.invalid",'
                b'"username":"streamed"}'
            )

        bootstrap_request = self.http.build_request(
            "POST",
            "/api/register",
            headers={"Content-Type": "application/json"},
            content=oversized_bootstrap_stream(),
        )
        self.assertNotIn("Content-Length", bootstrap_request.headers)
        self.assertEqual(
            bootstrap_request.headers.get("Transfer-Encoding"), "chunked"
        )
        oversized_bootstrap = await self.http.send(bootstrap_request)
        self.assertEqual(oversized_bootstrap.status_code, 422)
        self.assertEqual(
            oversized_bootstrap.json(), {"error": {"code": "invalid_request"}}
        )
        self.assertEqual(bootstrap_chunks_read, 1)
        bootstrap_state = await self.v2_control("/__test/v2/inspect", {})
        self.assertEqual(len(bootstrap_state.json()["agents"]), 4)

        unauthenticated_chunks_read = 0

        async def unauthenticated_stream():
            nonlocal unauthenticated_chunks_read
            unauthenticated_chunks_read += 1
            yield b"{not-json"

        unauthenticated_request = self.http.build_request(
            "POST",
            "/api/v2/conversations",
            headers={"Content-Type": "application/json"},
            content=unauthenticated_stream(),
        )
        self.assertNotIn("Content-Length", unauthenticated_request.headers)
        self.assertEqual(
            unauthenticated_request.headers.get("Transfer-Encoding"), "chunked"
        )
        unauthenticated = await self.http.send(unauthenticated_request)
        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(unauthenticated.json(), {"error": "invalid_token"})
        self.assertEqual(unauthenticated_chunks_read, 0)

        _identity, sender = await self.v2_seed_credential("fixture_sender")
        activated = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/delivery/activate",
            content=b"",
        )
        self.assertEqual(activated.status_code, 200, activated.text)

        protected_chunks_read = 0

        async def oversized_protected_stream():
            nonlocal protected_chunks_read
            protected_chunks_read += 1
            yield b"{" + b" " * 524_288
            protected_chunks_read += 1
            yield (
                b'"recipient_username":"fixture_recipient",'
                b'"payload":{"text":"must remain unread"}}'
            )

        protected_path = "/api/v2/conversations"
        protected_request = self.http.build_request(
            "POST",
            protected_path,
            headers={
                **sender.headers(
                    "POST",
                    protected_path,
                    issued_at=self.v2_now,
                ),
                "Content-Type": "application/json",
                "Idempotency-Key": "99999999-9999-4999-8999-999999999999",
            },
            content=oversized_protected_stream(),
        )
        self.assertNotIn("Content-Length", protected_request.headers)
        self.assertEqual(
            protected_request.headers.get("Transfer-Encoding"), "chunked"
        )
        oversized_protected = await self.http.send(protected_request)
        self.assertEqual(oversized_protected.status_code, 413)
        self.assertEqual(
            oversized_protected.json()["error"]["code"], "request_too_large"
        )
        self.assertEqual(protected_chunks_read, 1)
        protected_state = await self.v2_control("/__test/v2/inspect", {})
        self.assertEqual(protected_state.json()["messages"], [])

    async def test_v2_escaped_lone_surrogates_return_safe_invalid_request(
        self,
    ) -> None:
        bootstrap = await self.http.post(
            "/api/register",
            headers={"Content-Type": "application/json"},
            content=(
                b'{"email":"surrogate\\ud800@fixture.invalid",'
                b'"username":"surrogate"}'
            ),
        )
        self.assertEqual(bootstrap.status_code, 422, bootstrap.text)
        self.assertEqual(
            bootstrap.json(), {"error": {"code": "invalid_request"}}
        )

        _identity, sender = await self.v2_seed_credential("fixture_sender")
        activated = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/delivery/activate",
            content=b"",
        )
        self.assertEqual(activated.status_code, 200, activated.text)
        protected = await self.v2_protected(
            sender,
            "POST",
            "/api/v2/conversations",
            content=(
                b'{"recipient_username":"fixture_recipient",'
                b'"payload":{"text":"\\ud800"}}'
            ),
            extra_headers={
                "Content-Type": "application/json",
                "Idempotency-Key": "99999999-9999-4999-8999-999999999999",
            },
        )
        self.assertEqual(protected.status_code, 400, protected.text)
        self.assertEqual(
            protected.json(),
            {"error": {"code": "invalid_request", "retry_after_ms": None}},
        )

    async def test_v2_resource_authentication_validates_access_token_signature_and_claims(
        self,
    ) -> None:
        _identity, credential = await self.v2_seed_credential("fixture_sender")
        path = "/api/v2/delivery/activate"
        activated = await self.v2_protected(
            credential, "POST", path, content=b""
        )
        self.assertEqual(activated.status_code, 200, activated.text)
        record = self.state.v2_tokens[credential.token]

        token_parts = credential.token.split(".")
        signature = bytearray(decode_b64url(token_parts[2]))
        signature[0] ^= 1
        tampered_token = ".".join(
            (token_parts[0], token_parts[1], b64url(bytes(signature)))
        )
        self.state.v2_tokens[tampered_token] = record.model_copy(deep=True)
        try:
            tampered = BoundCredential(tampered_token, credential.key)
            tampered.nonce = credential.nonce
            rejected_signature = await self.v2_protected(
                tampered, "POST", path, content=b""
            )
        finally:
            del self.state.v2_tokens[tampered_token]
        self.assertEqual(rejected_signature.status_code, 401)
        self.assertEqual(rejected_signature.json(), {"error": "invalid_token"})

        original_jti = record.token_jti
        record.token_jti = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        try:
            rejected_claims = await self.v2_protected(
                credential, "POST", path, content=b""
            )
        finally:
            record.token_jti = original_jti
        self.assertEqual(rejected_claims.status_code, 401)
        self.assertEqual(rejected_claims.json(), {"error": "invalid_token"})

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

    async def test_v2_mcp_uses_dpop_transport_and_token_free_tools(self) -> None:
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

        _identity, credential = await self.v2_seed_credential("fixture_sender")
        _recipient_identity, recipient_credential = await self.v2_seed_credential(
            "fixture_recipient"
        )
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        htu = f"{origin}/mcp"
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
            base_headers = {
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            }
            initialize_body = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "fixture-v2-test", "version": "1"},
                },
            }

            def dpop_headers(
                bound: BoundCredential,
                method: str,
                nonce: str | None,
            ) -> dict[str, str]:
                return {
                    **base_headers,
                    "Authorization": f"DPoP {bound.token}",
                    "DPoP": bound.key.proof(
                        method,
                        "/mcp",
                        token=bound.token,
                        nonce=nonce,
                        issued_at=self.v2_now,
                        htu=htu,
                    ),
                }

            async with httpx.AsyncClient(base_url=origin) as http:
                challenge = await http.post(
                    "/mcp",
                    headers=dpop_headers(credential, "POST", None),
                    json=initialize_body,
                )
                self.assertEqual(challenge.status_code, 401, challenge.text)
                self.assertIn(
                    'error="use_dpop_nonce"',
                    challenge.headers["www-authenticate"],
                )
                mcp_nonce = challenge.headers["dpop-nonce"]
                initialized = await http.post(
                    "/mcp",
                    headers=dpop_headers(credential, "POST", mcp_nonce),
                    json=initialize_body,
                )
                self.assertEqual(initialized.status_code, 200, initialized.text)
                self.assertIn("no-store", initialized.headers["cache-control"])
                session_id = initialized.headers["mcp-session-id"]
                protocol_version = rpc_result(initialized)["result"][
                    "protocolVersion"
                ]
                session_headers = {
                    "Mcp-Session-Id": session_id,
                    "MCP-Protocol-Version": protocol_version,
                }

                missing_transport_auth = await http.post(
                    "/mcp",
                    headers={**base_headers, **session_headers},
                    json={
                        "jsonrpc": "2.0",
                        "id": 2,
                        "method": "tools/list",
                        "params": {},
                    },
                )
                self.assertNotEqual(missing_transport_auth.status_code, 200)

                notification = await http.post(
                    "/mcp",
                    headers={
                        **dpop_headers(credential, "POST", mcp_nonce),
                        **session_headers,
                    },
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                    },
                )
                self.assertEqual(notification.status_code, 202, notification.text)
                listed = await http.post(
                    "/mcp",
                    headers={
                        **dpop_headers(credential, "POST", mcp_nonce),
                        **session_headers,
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 3,
                        "method": "tools/list",
                        "params": {},
                    },
                )
                self.assertEqual(listed.status_code, 200, listed.text)
                tools = rpc_result(listed)["result"]["tools"]
                self.assertEqual(
                    {tool["name"] for tool in tools},
                    {
                        "list_action_types",
                        "request_permission",
                        "respond_to_permission",
                        "call_action",
                        "get_my_permissions",
                        "start_conversation",
                        "get_conversation_start",
                        "receive_messages",
                        "reply_message",
                        "complete_message",
                        "get_message_outcome",
                        "ack_message",
                        "health_check",
                    },
                )
                for tool in tools:
                    self.assertNotIn("token", tool["inputSchema"]["properties"])
                    self.assertNotIn(
                        "token", tool["inputSchema"].get("required", [])
                    )

                health = await http.post(
                    "/mcp",
                    headers={
                        **dpop_headers(credential, "POST", mcp_nonce),
                        **session_headers,
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 4,
                        "method": "tools/call",
                        "params": {"name": "health_check", "arguments": {}},
                    },
                )
                self.assertEqual(health.status_code, 200, health.text)
                self.assertEqual(
                    rpc_result(health)["result"]["structuredContent"],
                    {"status": "ok"},
                )

                recipient_initialize_body = {
                    **initialize_body,
                    "id": 6,
                    "params": {
                        **initialize_body["params"],
                        "clientInfo": {
                            "name": "fixture-v2-recipient-test",
                            "version": "1",
                        },
                    },
                }
                recipient_challenge = await http.post(
                    "/mcp",
                    headers=dpop_headers(recipient_credential, "POST", None),
                    json=recipient_initialize_body,
                )
                self.assertEqual(recipient_challenge.status_code, 401)
                recipient_nonce = recipient_challenge.headers["dpop-nonce"]
                recipient_initialized = await http.post(
                    "/mcp",
                    headers=dpop_headers(
                        recipient_credential, "POST", recipient_nonce
                    ),
                    json=recipient_initialize_body,
                )
                self.assertEqual(
                    recipient_initialized.status_code,
                    200,
                    recipient_initialized.text,
                )
                recipient_session_headers = {
                    "Mcp-Session-Id": recipient_initialized.headers[
                        "mcp-session-id"
                    ],
                    "MCP-Protocol-Version": rpc_result(recipient_initialized)[
                        "result"
                    ]["protocolVersion"],
                }
                recipient_notification = await http.post(
                    "/mcp",
                    headers={
                        **dpop_headers(
                            recipient_credential, "POST", recipient_nonce
                        ),
                        **recipient_session_headers,
                    },
                    json={
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                    },
                )
                self.assertEqual(recipient_notification.status_code, 202)

                async def call_tool(
                    bound: BoundCredential,
                    nonce: str,
                    transport_session_headers: dict[str, str],
                    rpc_id: int,
                    name: str,
                    arguments: dict[str, object],
                ) -> tuple[httpx.Response, dict[str, object]]:
                    response = await http.post(
                        "/mcp",
                        headers={
                            **dpop_headers(bound, "POST", nonce),
                            **transport_session_headers,
                        },
                        json={
                            "jsonrpc": "2.0",
                            "id": rpc_id,
                            "method": "tools/call",
                            "params": {"name": name, "arguments": arguments},
                        },
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    return response, rpc_result(response)["result"]

                _rejected_token_argument_response, rejected_token_argument = (
                    await call_tool(
                        credential,
                        mcp_nonce,
                        session_headers,
                        7,
                        "list_action_types",
                        {"token": "must-not-be-a-tool-argument"},
                    )
                )
                self.assertTrue(rejected_token_argument["isError"])

                _requested_response, requested = await call_tool(
                    credential,
                    mcp_nonce,
                    session_headers,
                    8,
                    "request_permission",
                    {
                        "target_username": "fixture_recipient",
                        "action_type": "fixture.echo",
                        "scope": {"resource": "v2-private-record"},
                    },
                )
                permission_id = requested["structuredContent"]["permission_id"]
                self.assertEqual(
                    requested["structuredContent"]["status"], "pending"
                )

                _wrong_response, wrong_responder = await call_tool(
                    credential,
                    mcp_nonce,
                    session_headers,
                    9,
                    "respond_to_permission",
                    {"permission_id": permission_id, "decision": "granted"},
                )
                self.assertTrue(wrong_responder["isError"])

                _pending_response, pending = await call_tool(
                    credential,
                    mcp_nonce,
                    session_headers,
                    10,
                    "get_my_permissions",
                    {"status": "pending"},
                )
                self.assertEqual(
                    pending["structuredContent"]["permissions"][0][
                        "permission_id"
                    ],
                    permission_id,
                )

                _granted_response, granted = await call_tool(
                    recipient_credential,
                    recipient_nonce,
                    recipient_session_headers,
                    11,
                    "respond_to_permission",
                    {"permission_id": permission_id, "decision": "granted"},
                )
                self.assertEqual(granted["structuredContent"]["status"], "granted")

                action_arguments = {
                    "target_username": "fixture_recipient",
                    "action_type": "fixture.echo",
                    "payload": {"value": "v2-private-action"},
                }
                _wrong_action_response, wrong_action = await call_tool(
                    recipient_credential,
                    recipient_nonce,
                    recipient_session_headers,
                    12,
                    "call_action",
                    action_arguments,
                )
                self.assertTrue(wrong_action["isError"])
                _called_response, called = await call_tool(
                    credential,
                    mcp_nonce,
                    session_headers,
                    13,
                    "call_action",
                    action_arguments,
                )
                self.assertEqual(called["structuredContent"]["status"], "queued")

                inspection = await self.http.post(
                    "/__test/inspect", headers=CONTROL_HEADERS, json={}
                )
                self.assertEqual(inspection.status_code, 200, inspection.text)
                self.assertEqual(
                    inspection.json()["permissions"][0]["status"], "granted"
                )
                self.assertEqual(
                    inspection.json()["actions"][0]["status"], "queued"
                )
                self.assert_control_omits(
                    inspection,
                    "v2-private-record",
                    "v2-private-action",
                    credential.token,
                    recipient_credential.token,
                )

                bearer = await http.post(
                    "/mcp",
                    headers={
                        **base_headers,
                        **session_headers,
                        "Authorization": f"Bearer {credential.token}",
                        "DPoP": credential.key.proof(
                            "POST",
                            "/mcp",
                            token=credential.token,
                            nonce=mcp_nonce,
                            issued_at=self.v2_now,
                            htu=htu,
                        ),
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 5,
                        "method": "tools/list",
                        "params": {},
                    },
                )
                self.assertEqual(bearer.status_code, 401)
                self.assertIn('error="invalid_token"', bearer.headers["www-authenticate"])

                terminated = await http.delete(
                    "/mcp",
                    headers={
                        **dpop_headers(credential, "DELETE", mcp_nonce),
                        **session_headers,
                    },
                )
                self.assertEqual(terminated.status_code, 200, terminated.text)
                recipient_terminated = await http.delete(
                    "/mcp",
                    headers={
                        **dpop_headers(
                            recipient_credential, "DELETE", recipient_nonce
                        ),
                        **recipient_session_headers,
                    },
                )
                self.assertEqual(
                    recipient_terminated.status_code,
                    200,
                    recipient_terminated.text,
                )
        finally:
            server.should_exit = True
            await asyncio.wait_for(server_task, timeout=5)
            listener.close()


if __name__ == "__main__":
    unittest.main()
