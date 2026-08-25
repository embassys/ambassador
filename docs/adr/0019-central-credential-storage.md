# 0019 Central credential storage

Status: accepted

Date: 2026-08-25

## Problem

Successful email verification returns the only central agent JWT. The gateway must survive a restart without returning that JWT to the agent or writing plaintext credentials to configuration or SQLite.

## Options

- Store the JWT in each operating system's credential vault. This gives the strongest separation but needs three native implementations or a maintained cross-platform dependency.
- Encrypt the JWT with AES-256-GCM using a key derived from the supplied webhook token and store only salt, IV, authentication tag, and ciphertext in a private credential file. Node core provides the required cryptography and no second local secret is needed.
- Keep the JWT only in memory. A restart would lose an already-verified identity, and the current central service cannot reissue its token. This is not viable.

## Decision

Use a dedicated encrypted credential file for the first implementation. The resolved webhook token must match OpenClaw's generated token format, exactly 48 lowercase hexadecimal characters encoding 192 random bits. Reject any other token before opening the credential file or binding MCP.

Decode the validated hook token to 24 bytes, then derive a 32-byte key with `scrypt` using a fresh 16-byte salt and parameters `N=131072`, `r=8`, and `p=1`. Encrypt with AES-256-GCM using a fresh 12-byte IV, a 16-byte tag, and fixed version metadata as additional authenticated data. The versioned file stores only the KDF parameters, salt, IV, tag, and ciphertext. Never place it in the relay journal or support bundles.

Store the file under the platform's private `a2a-gateway` state directory. The file contains no webhook URL, email, username, message ID, or MCP data.

On POSIX, require mode `0700` for directories and `0600` for files, reject symlinks and unexpected hard links, create a sibling temporary file exclusively, sync it, rename it without replacing an existing identity, and sync the parent directory before reporting verification success. On Windows, remove inherited access and restrict the state directory and credential file DACLs to the current user SID and `SYSTEM`; fail if the DACL cannot be verified. Sync the temporary file, rename it, reopen and sync the final file, and verify its DACL before reporting success.

Changing the webhook token makes the stored JWT unreadable. Until the central service supports token reissue, startup must report that condition without deleting or replacing the credential.

This encryption protects against accidental plaintext disclosure and access to the state file alone. It does not protect against a same-user attacker who can read both the webhook token and ciphertext. An OS credential vault would provide stronger separation later.

An OS credential vault remains the preferred future storage boundary. DPoP is complementary: it would bind a central token to a gateway-held key but requires central issuer and resource-server changes, and does not remove the need to protect the key locally.

The central service marks an email verified before the gateway can confirm local persistence. If persistence fails and the process exits, the current one-time token is unrecoverable. Public use therefore requires a central reissue flow; tests still cover local persistence failure so the gateway never reports a token it did not save.

## Approval

The user preferred an OS credential vault with future DPoP, but approved this faster Node-core encrypted-file design for the first implementation on 2026-08-25.
