# 0019 Central credential storage

Status: accepted

Date: 2026-08-25

Updated: 2026-08-29 for the accepted version 2 DPoP credential and replacement rules

## Problem

In shipped `0.2.6`, successful email verification returns the only central agent JWT. The gateway must survive a restart without returning that JWT to the agent or writing plaintext credentials to configuration or SQLite.

## Options

- Store the JWT in each operating system's credential vault. This gives the strongest separation but needs three native implementations or a maintained cross-platform dependency.
- Encrypt the JWT with AES-256-GCM using a key derived from the supplied webhook token and store only salt, IV, authentication tag, and ciphertext in a private credential file. Node core provides the required cryptography and no second local secret is needed.
- Keep the JWT only in memory. A restart would lose an already-verified identity, and the current central service cannot reissue its token. This is not viable.

## Shipped `0.2.6` decision

Use a dedicated encrypted credential file for the first implementation. The resolved webhook token must contain 192 random bits as exactly 48 lowercase hexadecimal characters. Reject any other token before opening the credential file or binding MCP.

Decode the validated hook token to 24 bytes, then derive a 32-byte key with `scrypt` using a fresh 16-byte salt and parameters `N=131072`, `r=8`, and `p=1`. Encrypt with AES-256-GCM using a fresh 12-byte IV and a 16-byte tag. The additional authenticated data contains the fixed version metadata and the canonical central API/MCP endpoint pair. The endpoint pair is not stored in the credential file, but changing it makes the existing credential fail authentication before any JWT can be sent upstream. The versioned file stores only the KDF parameters, salt, IV, tag, and ciphertext. Never place it in the relay journal or support bundles.

Store the file under the platform's private `a2a-gateway` state directory. The file contains no webhook URL, email, username, message ID, or MCP data.

On POSIX, require mode `0700` for directories and `0600` for files, reject symlinks and unexpected hard links, create a sibling temporary file exclusively, sync it, rename it without replacing an existing identity, and sync the parent directory before reporting verification success. On Windows, remove inherited access and restrict the state directory and credential file DACLs to the current user SID and `SYSTEM`; fail if the DACL cannot be verified. Sync the temporary file, rename it, reopen and sync the final file, and verify its DACL before reporting success.

Changing the webhook token makes the stored JWT unreadable. The shipped release reports that condition without deleting or replacing the credential.

This encryption protects against accidental plaintext disclosure and access to the state file alone. It does not protect against a same-user attacker who can read both the webhook token and ciphertext. An OS credential vault would provide stronger separation later.

An OS credential vault remains the preferred future storage boundary. DPoP is complementary because it binds a central token to a gateway-held key, but it does not remove the need to protect the key locally. ADR 0026 now accepts DPoP as the next contract.

The `0.2.6` central service marks an email verified before the gateway can confirm local persistence. If persistence fails and the process exits, the one-time token is unrecoverable. Tests still cover local persistence failure so the gateway never reports a token it did not save.

## Accepted version 2 amendment

ADR 0026 keeps the encrypted-file envelope and its KDF, AES-256-GCM,
endpoint-pair binding, permissions, link checks, and durability rules. It
sets the outer envelope and authenticated metadata version to 2 and replaces
the JWT-only plaintext payload with this strict record:

```json
{
  "credential_version": 2,
  "token_type": "DPoP",
  "access_token": "<central-jwt>",
  "dpop_alg": "ES256",
  "dpop_private_key_pkcs8": "<base64url-pkcs8-der>"
}
```

The plaintext record is at most 8 KiB. `access_token` contains at most 4,096
ASCII bytes. `dpop_private_key_pkcs8` contains at most 1,024 ASCII bytes and
encodes exactly one P-256 private key. On load, the gateway derives the public
JWK and requires its thumbprint to match the token's `cnf.jkt` before enabling
protected work.

The gateway may write the first version 2 record only after successful
email-control verification and complete response validation. It intercepts the
token before generic result handling, persists the token and private key in one
atomic transaction, and returns only token-free local state.

The first-write-only rule is superseded narrowly. Scheduled
`POST /api/v2/token/reissue` may compare and replace a valid version 2 record
when the old and new credentials have the same issuer, subject, ordered
audience, token-signing algorithm, DPoP key binding, DPoP algorithm, endpoint
pair, and 24-hour lifetime contract. The gateway starts this scheduled
same-key reissue with 12 hours remaining. It may repeat that one operation with
the same in-memory idempotency key after an uncertain outcome.

Email-control verification may replace a readable version 1 or version 2
record with the same central identity and a new P-256 key after central
atomically revokes the old tokens. This path handles version 1 migration, key
loss, expiry, revocation, and deliberate key rotation. It is not bearer-only
rebinding. An unreadable record cannot prove its identity and remains untouched
until the project approves an explicit local reset interface.

A `401`, invalid token, proof failure, key failure, ordinary tool failure, or
credential-load failure never triggers reissue, recovery, deletion, or
replacement. The gateway never activates a token from memory to work around a
failed or uncertain persistence transaction.

Version 2 replacement uses the compare-and-replace transaction in ADR 0026.
The gateway writes a complete encrypted sibling with fresh salt and IV, syncs
and validates it, confirms that the current record has not changed, then uses
an atomic platform replacement and validates the published record. A failure
before publication leaves the old record. An uncertain post-publication result
requires a full reload before protected work resumes.

The version 2 token may appear transiently only in a gateway-to-central
`Authorization: DPoP` header or while calculating `ath`. It no longer appears
in a central MCP tool argument. The private key, plaintext record, token,
proofs, nonces, and reissue idempotency key never enter SQLite, logs,
diagnostics, metrics, temporary files, crash artifacts, or support bundles.

This amendment accepts the gateway storage contract. It does not claim that
the production central service already issues or enforces DPoP credentials.
The test-only [version 2 fixture profile](../v2-fixture-profile.md) supplies
deterministic issuer, audience, key, and endpoint values. Those values are not
production constants.

## Approval

The user preferred an OS credential vault with future DPoP, but approved this faster Node-core encrypted-file design for the first implementation on 2026-08-25. On 2026-08-29, the user approved ADR 0026 and this version 2 encrypted-record amendment as the next implementation target.
