# 0019 Central credential storage

Status: proposed

Date: 2026-08-25

## Problem

Successful email verification returns the only central agent JWT. The gateway must survive a restart without returning that JWT to the agent or writing plaintext credentials to configuration or SQLite.

## Options

- Store the JWT in each operating system's credential vault. This gives the strongest separation but needs three native implementations or a maintained cross-platform dependency.
- Encrypt the JWT with AES-256-GCM using a key derived from the supplied webhook token and store only salt, IV, authentication tag, and ciphertext in a private credential file. Node core provides the required cryptography and no second local secret is needed.
- Keep the JWT only in memory. A restart would lose an already-verified identity, and the current central service cannot reissue its token. This is not viable.

## Recommendation

Use a dedicated encrypted credential file for the first implementation. Derive the encryption key with `scrypt`, use a fresh random salt and IV, write atomically with owner-only permissions, and authenticate fixed version metadata as additional data. Never place the ciphertext in the relay journal or support bundles.

Store the file under the platform's private `a2a-gateway` state directory. The file contains no webhook URL, email, username, message ID, or MCP data.

Changing the webhook token makes the stored JWT unreadable. Until the central service supports token reissue, startup must report that condition without deleting or replacing the credential.

This encryption protects against accidental plaintext disclosure and access to the state file alone. It does not protect against a same-user attacker who can read both the webhook token and ciphertext. An OS credential vault would provide stronger separation later.

The central service marks an email verified before the gateway can confirm local persistence. If persistence fails and the process exits, the current one-time token is unrecoverable. Public use therefore requires a central reissue flow; tests still cover local persistence failure so the gateway never reports a token it did not save.

## Approval needed

This recommendation uses Node core and adds no package, but it is a security and recovery decision. Review it before production credential persistence is implemented.
