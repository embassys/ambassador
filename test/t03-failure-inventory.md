# T03 red failure inventory

Status: runnable future-v2 gateway contract; G01 credential and G02 enrollment
checks green, later gateway work intentionally red

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

The final `0.2.6` observation on 2026-08-29 was 128 red behavior vectors and
one existing closed-schema guard green. After G02, 31 of the 129 behavior
vectors remain red and 98 are green: 19 G01 credential checks, 78 newly green
G02 enrollment checks, and the shipped guard. Node reports 139 test nodes: 34
failed and 105 passed because three failing and seven passing parameterized
parents are counted in addition to their child vectors.

## Failure classification

| Test | Behavior vectors | Post-G02 observation | Required gateway behavior |
| --- | ---: | --- | --- |
| T03-R01 | 1 | Green: bootstrap catalog remains available without central MCP | Preserve gateway ownership of the three bootstrap tools |
| T03-R02 | 1 | Green: bootstrap schemas match the accepted bounds and patterns | Preserve exact closed registration, verification, and resend schemas |
| T03-R03, B01 | 2 | Green: registration uses the fixed REST request and projection | Preserve one credential-free `POST /api/register` without fallback |
| T03-R04 | 1 | Green: resend uses REST and returns the generic safe result | Preserve the token-free resend projection |
| T03-R05, S01 | 2 | Green: verification creates fresh bound proofs and persists one credential-v2 record | Preserve nonce retry, independent binding validation, and token interception |
| T03-R06 | 1 | Green: persistence failure leaves the gateway unenrolled | Preserve persistence as the issuance commit point |
| T03-R07 | 1 | The credential-v2 record loads, then protected startup stops at the isolated legacy accessor | Reload the bound key/token and use fresh token-free DPoP after restart |
| T03-B02 | 13 | Green: all invalid bootstrap inputs stop locally | Preserve exact one-over, character, and unknown-field rejection |
| T03-B02a | 1 | Green: exact maximum bootstrap fields remain accepted | Preserve the 254-byte email, 50-byte username, and 128-byte display-name boundaries |
| T03-B03 | 8 | Green: reviewed errors and unsafe outcomes use fixed local mappings | Preserve no retry or fallback after uncertainty |
| T03-B04a | 1 | Green: an exact 64 KiB valid response is projected | Preserve the body boundary before schema projection |
| T03-B04b | 3 | Green: exact structural parser limits are accepted | Preserve safe extension discard at depth, member, and element boundaries |
| T03-B04 | 13 | Green: malformed and one-over REST responses fail closed | Preserve status, media, encoding, UTF-8, duplicate-key, structure, size, and credential-extension rejection |
| T03-B05 | 1 | Green: shutdown cancels one in-flight bootstrap request | Preserve cancellation without retry or MCP fallback |
| T03-B06-B08 | 3 | Green: lost outcomes and resend rate limiting map exactly | Preserve one request with no persistence or fallback |
| T03-N01 | 11 | Green: verification failures use fixed precedence and retry bounds | Preserve exact nonce, proof, cache, safe-message, and token-free mappings |
| T03-N02 | 15 | Green: invalid issuance credentials are rejected before persistence | Preserve type, lifetime, identity, audience, binding, JWT, duplicate, reflection, media, cache, and size validation |
| T03-N03 | 1 | Green: exact 4096-byte bound token persists without local exposure | Preserve the exact token boundary and interceptor |
| T03-S02 | 14 | Green: every malformed fresh-install credential-v2 record fails before central dispatch | Preserve rejection of duplicate/missing/unknown fields, wrong version/type/algorithm, malformed JWT/JWK/DER, non-P-256 keys, missing binding, and key mismatch |
| T03-S03 | 1 | The credential-v2 record loads, then protected startup stops before G03 transport | Complete real protected operations and independently verify every fresh ES256 proof, `htm`, fixed-route `htu`, `ath`, and token-free body |
| T03-S04 | 1 | The credential-v2 record loads, but scheduled reissue cannot start before G03 transport | Reissue at 12 hours with one idempotency key, one nonce retry, the same P-256 key, and one persisted token replacement |
| T03-S05 | 1 | Green: normal artifacts and captures exclude actual enrollment and DPoP markers | Preserve scanning of runtime email, code, token, key, proof, nonce, request, and response markers |
| T03-L01 | 8 | Five one-over credential records now fail closed; the three exact-bound records load but stop before G03 protected startup | Preserve G01 credential bounds; complete exact-bound protected work and keep generated proof/auth/combined/total headers within their ceilings |
| T03-P01 | 1 | The credential-v2 record loads, then protected startup stops before central MCP initialization | Use fresh nonce-bearing proofs for initialize, notification, GET reconnect, catalog, call, cancellation, and DELETE close on fixed `/mcp` |
| T03-P02 | 1 | The credential-v2 record loads, then protected startup stops before the proof-rejection exchange | Surface a terminal protected-operation failure and never retry, reissue, replace, or use bearer after proof rejection |
| T03-U01 | 1 | The credential-v2 record loads, but reissue cannot start before G03 transport | Retry the one idempotent operation with one key, fresh proofs, and one observed publication |
| T03-U02-U05 | 4 | G01 loads and persists envelope v2; protected reissue, expiry, and invalid-token behavior remain red | Retain old token after save failure; disable at expiry; never recover on 401; persist/restart one encrypted envelope-v2 replacement and reject endpoint mismatch |
| T03-U06 | 8 | Each fixture credential loads, then stops before the G03 reissue exchange | Reject issuer, subject, ordered audience, thumbprint, signing algorithm, lifetime, reused `jti`, and nonadvancing expiry changes while retaining the old credential |
| T03-U07 | 7 | Each fixture credential loads, then stops before the G03 reissue exchange | Apply the verification interceptor's cache/media/exact-shape/token-reflection rules to reissue and scan artifacts for the rejected runtime credential markers |
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
  pre-rename crash point. POSIX temp-write, sync, pre-rename, and post-rename
  micro-boundaries remain qualification work. ADR 0033 defers the Windows
  variants with W01 rather than counting them as passed. C02 uses the
  externally observable encrypted-file digest change as a real
  post-publication barrier.
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
