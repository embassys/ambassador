# T03 red failure inventory

Status: runnable future-v2 gateway contract, intentionally red on `0.2.6`

The user accepted this classified gateway inventory on 2026-08-30. It merged
through PR `#28`. Central S01 review and enforcement remain separate gates.

T03 is separate from the shipped compatibility suite. Every case begins as a
fresh install or with a fixture-issued version 2 credential. It does not cover
version 1 conversion, legacy bearer migration, matching-identity replacement,
or an in-place upgrade.

The Node fixture supplies only the test values in
`docs/v2-fixture-profile.md`; passing T03 does not claim that production
central has deployed the target contract.

Run the suite serially because the public gateway owns one fixed loopback
port:

```text
pnpm run test:build
node --test --test-concurrency=1 --test-reporter=spec \
  .test-dist/test/t03-*.test.js
```

Final `0.2.6` observation on 2026-08-29: 129 behavior vectors, of which 128
are red and one existing closed-schema guard is green. Node reports 139 test
nodes: 138 failed and one passed because ten failing parameterized parents are
counted in addition to their child vectors.

## Failure classification

| Test | Behavior vectors | `0.2.6` observation | Required gateway behavior |
| --- | ---: | --- | --- |
| T03-R01 | 1 | Bootstrap catalog fails when central MCP is unavailable | Own and list the three bootstrap tools locally |
| T03-R02 | 1 | Bootstrap schemas omit accepted bounds and patterns | Publish exact closed registration, verification, and resend schemas |
| T03-R03, B01 | 2 | Registration uses legacy central MCP | Send one credential-free `POST /api/register` with the exact projection |
| T03-R04 | 1 | Resend uses MCP and rejects its credential-bearing result | Send `POST /api/resend_verification` and return only the generic safe result |
| T03-R05, S01 | 2 | Verification fails before REST issuance | Generate a P-256 key, perform one independently verified ES256 nonce retry, validate token binding, return no token, and save one credential-v2 string |
| T03-R06 | 1 | Verification never reaches the injected save failure | Treat persistence as the issuance commit and remain unenrolled on failure |
| T03-R07 | 1 | A credential-v2 string cannot initialize protected work | Reload the bound key/token and use fresh token-free DPoP after restart |
| T03-B02 | 13 | Twelve invalid inputs reach central or are accepted; the existing MCP schema rejects one extra verification field | Reject exact one-over/character/unknown-field inputs locally. The one green vector is not REST-v2 evidence |
| T03-B02a | 1 | Exact maximum valid bootstrap fields are not accepted on REST | Accept 254-byte email, 50-byte username, and 128-byte display name |
| T03-B03 | 8 | REST outcomes are bypassed through MCP | Emit each fixed local error identifier/data shape; reject redirects and never retry or fall back after uncertainty |
| T03-B04a | 1 | An exact 64 KiB valid response is not projected | Accept the body boundary before schema projection |
| T03-B04b | 3 | Valid depth-16, 128-member, and 128-element extensions are not projected | Accept and discard safe extensions at each parser boundary |
| T03-B04 | 13 | Malformed and one-over REST responses are bypassed | Fail closed on status, media, encoding, UTF-8, duplicate keys, depth 17, 129 members/elements, 64 KiB plus one, oversized headers, malformed error pairs, and credential-shaped extensions |
| T03-B05 | 1 | No REST request exists to cancel | Close the in-flight bootstrap transport on shutdown without retry or MCP fallback |
| T03-B06-B08 | 3 | Verification/resend never use the selected REST route | Map lost verification/resend outcomes and resend rate limiting exactly, with one request and no persistence/fallback |
| T03-N01 | 11 | Verification responses use legacy MCP error handling | Apply the exact `verification_failed`, nonce, proof, `no-store`, retry-count, safe-message, and token-free error mappings |
| T03-N02 | 15 | Invalid issuance responses never reach the v2 interceptor | Reject type/lifetime/identity/audience/binding/JWT/duplicate/reflection/media/cache and 4097/4098 token cases before persistence |
| T03-N03 | 1 | Exact 4096-byte issuance cannot complete | Accept and persist a bound 4096-byte token without exposing it locally |
| T03-S02 | 14 | Credential-v2 input is treated as an opaque bearer string | Reject duplicate/missing/unknown fields, wrong version/type/algorithm, malformed JWT/JWK/DER, non-P-256 keys, missing binding, and key mismatch before network use |
| T03-S03 | 1 | Protected REST/MCP use bearer or token-shaped arguments | Complete real protected operations and independently verify every fresh ES256 proof, `htm`, fixed-route `htu`, `ath`, and token-free body |
| T03-S04 | 1 | Scheduled reissue never starts | Reissue at 12 hours with one idempotency key, one nonce retry, the same P-256 key, and one persisted token replacement |
| T03-S05 | 1 | V2 issuance is not reached | Scan normal artifacts and captures for runtime email/code/token/key/proof/nonce/request/response markers |
| T03-L01 | 8 | Credential-v2 bounds are not parsed or enforced | Accept 4096-byte token, 1024-byte valid key, and 8192-byte record; reject raw/canonical token, malformed/valid key, and record one-over cases; keep generated proof/auth/combined/total headers within their ceilings |
| T03-P01 | 1 | Central MCP cannot initialize through DPoP | Use fresh nonce-bearing proofs for initialize, notification, GET reconnect, catalog, call, cancellation, and DELETE close on fixed `/mcp` |
| T03-P02 | 1 | Protected MCP does not send DPoP | Surface a terminal protected-operation failure and never retry, reissue, replace, or use bearer after proof rejection |
| T03-U01 | 1 | Lost reissue is never attempted | Retry the one idempotent operation with one key, fresh proofs, and one observed publication |
| T03-U02-U05 | 4 | Reissue/expiry/revocation/envelope-v2 behavior is absent | Retain old token after save failure; disable at expiry; never recover on 401; persist/restart one encrypted envelope-v2 replacement and reject endpoint mismatch |
| T03-U06 | 8 | Reissue is absent | Reject issuer, subject, ordered audience, thumbprint, signing algorithm, lifetime, reused `jti`, and nonadvancing expiry changes while retaining the old credential |
| T03-U07 | 7 | Reissue is absent | Apply the verification interceptor's cache/media/exact-shape/token-reflection rules to reissue and scan artifacts for the rejected runtime credential markers |
| T03-A01 | 1 | Enrollment fails before a verbose reissue run | Scan verbose artifacts/stdout/stderr for actual original/replacement tokens, key, proofs, nonces, code, and idempotency key after observed publication |
| T03-C01 | 1 | Credential-v2 startup is unavailable | After full-process pre-response uncertainty, retain the complete old encrypted record, retry after restart, and scan crash artifacts |
| T03-C02 | 1 | Credential-v2 startup is unavailable | Use encrypted-file digest change as the post-publication barrier, crash the process, reload exactly one complete envelope-v2 replacement, and scan artifacts |

## Deliberate instrumentation boundaries

- A rejected scheduled reissue has no externally observable completion event.
  U06/U07 observe the complete server response, continued old-token work, and
  terminal gateway shutdown. The accepted inventory records that distinction.
  A later authorized implementation or qualification task may add a test-only
  completion observer if it must distinguish rejection from shutdown
  cancellation. The red specification adds no production hook.
- C01 is pre-response uncertainty, not the credential store's internal
  pre-rename crash point. The POSIX/Windows temp-write, sync, pre-rename, and
  post-rename micro-boundaries are accepted qualification deferrals. G01 or W01
  may add a test-only credential-store fault seam when those tasks are
  authorized. C02 uses the externally observable encrypted-file digest change
  as a real post-publication barrier.
- The product routes are fixed, including central `/mcp`. T03 verifies the
  canonical `htu` for URLs the gateway actually sends. The complete
  scheme/host/default-port/percent/dot/path normalization matrix belongs behind
  a future proof-builder unit seam; arbitrary configured MCP paths would
  violate the fixture profile.
- With the accepted structural scanner, the 1,024-token response limit is
  unreachable after the stricter 128-member and 128-element caps. The maximal
  otherwise-valid registration shape has 1,019 structural tokens: 20 at the
  five-member top level, 385 for a 128-element array of empty objects, and 614
  for the remaining 123 members with empty-object values. A 1,024/1,025 pair
  would therefore fail for another limit and is intentionally not faked.
- The gateway suite checks an oversized response header and ensures every
  gateway-generated protected request remains at or below the 16 KiB total.
  Exact hostile server/proxy header and DPoP-field acceptance boundaries remain
  in the T01/S01 fixture/security suites, where raw wire framing is observable.

No production file, migration path, or external deployment claim is part of
T03.
