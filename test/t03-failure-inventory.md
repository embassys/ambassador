# T03 red failure inventory

Status: closed local G01-G03 gateway contract; all reviewed T03 behavior green

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
one existing closed-schema guard green. G02 review added seven response-order,
case-collision, redirect, and cookie-header regression vectors. G03 closes the
remaining 31 protected-transport, reissue, publication, boundary, and artifact
vectors. All 136 behavior vectors are green. Node reports all 146 test nodes
passing because ten parameterized parents are counted in addition to their
child vectors.

## Failure classification

| Test | Behavior vectors | Post-G03 observation | Required gateway behavior |
| --- | ---: | --- | --- |
| T03-R01 | 1 | Green: bootstrap catalog remains available without central MCP | Preserve gateway ownership of the three bootstrap tools |
| T03-R02 | 1 | Green: bootstrap schemas match the accepted bounds and patterns | Preserve exact closed registration, verification, and resend schemas |
| T03-R03, B01 | 2 | Green: registration uses the fixed REST request and projection | Preserve one credential-free `POST /api/register` without fallback |
| T03-R04 | 1 | Green: resend uses REST and returns the generic safe result | Preserve the token-free resend projection |
| T03-R05, S01 | 2 | Green: verification creates fresh bound proofs and persists one credential-v2 record | Preserve nonce retry, independent binding validation, and token interception |
| T03-R06 | 1 | Green: persistence failure leaves the gateway unenrolled | Preserve persistence as the issuance commit point |
| T03-R07 | 1 | Green: restart reloads the bound key/token and uses fresh token-free DPoP | Preserve explicit version discrimination and protected restart behavior |
| T03-B02 | 13 | Green: all invalid bootstrap inputs stop locally | Preserve exact one-over, character, and unknown-field rejection |
| T03-B02a | 1 | Green: exact maximum bootstrap fields remain accepted | Preserve the 254-byte email, 50-byte username, and 128-byte display-name boundaries |
| T03-B03 | 10 | Green: reviewed errors and unsafe outcomes use fixed local mappings | Preserve no retry or fallback after uncertainty, including bodyless and non-JSON redirects |
| T03-B04a | 1 | Green: an exact 64 KiB valid response is projected | Preserve the body boundary before schema projection |
| T03-B04b | 3 | Green: exact structural parser limits are accepted | Preserve safe extension discard at depth, member, and element boundaries |
| T03-B04 | 14 | Green: malformed and one-over REST responses fail closed | Preserve status, media, encoding, UTF-8, duplicate-key, structure, size, credential-extension, and response-cookie rejection |
| T03-B05 | 1 | Green: shutdown cancels one in-flight bootstrap request | Preserve cancellation without retry or MCP fallback |
| T03-B06-B08 | 3 | Green: lost outcomes and resend rate limiting map exactly | Preserve one request with no persistence or fallback |
| T03-N01 | 13 | Green: verification failures use fixed precedence and retry bounds | Preserve missing-`no-store` precedence before media and body parsing plus exact nonce, proof, cache, safe-message, and token-free mappings |
| T03-N02 | 17 | Green: invalid issuance credentials are rejected before persistence | Preserve type, lifetime, identity, audience, binding, JWT, case-insensitive token uniqueness, response-cookie, reflection, media, cache, and size validation |
| T03-N03 | 1 | Green: exact 4096-byte bound token persists without local exposure | Preserve the exact token boundary and interceptor |
| T03-S02 | 14 | Green: every malformed fresh-install credential-v2 record fails before central dispatch | Preserve rejection of duplicate/missing/unknown fields, wrong version/type/algorithm, malformed JWT/JWK/DER, non-P-256 keys, missing binding, and key mismatch |
| T03-S03 | 1 | Green: real protected operations use independently verified fresh ES256 proofs and token-free bodies | Preserve exact `htm`, canonical `htu`, `ath`, and nonce-domain behavior |
| T03-S04 | 1 | Green: scheduled same-key reissue publishes one validated replacement | Preserve the 12-hour window, one idempotency key, one nonce retry, and persistence-before-use |
| T03-S05 | 1 | Green: normal artifacts and captures exclude actual enrollment and DPoP markers | Preserve scanning of runtime email, code, token, key, proof, nonce, request, and response markers |
| T03-L01 | 8 | Green: five one-over records fail closed and all three exact-bound records complete protected work | Preserve credential, proof, authorization, combined-authentication, and total-header ceilings |
| T03-P01 | 1 | Green: initialize, notification, GET reconnect, catalog, call cancellation, and DELETE close use fresh nonce-bearing proofs | Preserve fresh proof creation for every actual MCP HTTP request |
| T03-P02 | 1 | Green: proof rejection is terminal | Preserve no retry, reissue, replacement, or bearer fallback |
| T03-U01 | 1 | Green: one uncertain reissue repeats with the same key and fresh proof | Preserve the operation-specific idempotent exception and one publication |
| T03-U02-U05 | 4 | Green: persistence failure, expiry, invalid-token, encrypted replacement, restart, and endpoint scope behave fail closed | Preserve old-token retention only while valid, no network at expiry, and no 401 recovery |
| T03-U06 | 8 | Green: every identity, key, algorithm, lifetime, token-ID, and expiry change is rejected | Preserve exact same-key replacement invariants while retaining the old credential |
| T03-U07 | 7 | Green: strict cache, media, shape, token-reflection, and artifact rules reject every unsafe response | Preserve token interception before generic handling and zero publication |
| T03-A01 | 1 | Green: verbose enrollment and reissue artifacts contain none of the runtime secret markers | Preserve redaction of token, key, proof, nonce, code, and idempotency bytes |
| T03-C01 | 1 | Green: a full-process pre-response crash retains the old encrypted record and restart recovers | Preserve uncertainty, restart retry, and crash-artifact scanning |
| T03-C02 | 1 | Green: a post-publication crash reloads one complete envelope-v2 replacement | Preserve encrypted-file digest publication evidence and atomic reload |

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

T03 makes no migration or external deployment claim. Passing it establishes
only that the local gateway and the approved fixture contract agree; live
central qualification remains gated separately.
