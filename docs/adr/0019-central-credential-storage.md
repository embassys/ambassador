# 0019 Central credential storage

Status: accepted; key custody superseded by ADR 0039

Date: 2026-08-25

Updated: 2026-09-03

## Problem

Ambassador must survive restart without returning the central token or DPoP
private key to the local agent and without writing either value in plaintext
to configuration or SQLite.

## Decision

Store the current central token and P-256 private key together as one atomic
encrypted credential file.

ADR 0039 replaces the user-supplied local token with internally generated,
owner-only state key material. Derive a 256-bit encryption key from that
material and a fresh random salt with Node's approved scrypt parameters. Encrypt with
AES-256-GCM and a fresh IV. Persist only the format metadata, salt, IV,
authentication tag, and ciphertext. Use Node core cryptography and add no
credential-storage dependency.

The store:

- creates a private application directory;
- rejects links, unexpected file types, insecure ownership or permissions,
  malformed envelopes, authentication failures, and oversized data;
- writes a temporary file in the same directory, syncs it, publishes it
  atomically, syncs the directory, and removes recoverable temporary artifacts;
- never reports success before the complete token/key pair is durable; and
- never logs paths, plaintext, salts, IVs, tags, ciphertext, or parser errors
  that could reveal data.

The exact plaintext record is a current internal format containing the access
token, ES256 private key, and minimum format metadata. An internal format
number is not a central API version.

## No migration or replacement

The current development release starts from clean state. It does not read a
JWT-only record, convert an old encrypted envelope, replace a prior identity,
refresh a token, reissue against the same key, or run email-control recovery.

An unreadable or expired credential fails closed. A developer may intentionally
remove the complete local development state before fresh enrollment. The
Ambassador does not make that decision automatically after a `401` or parse
failure.

## Data boundary

The plaintext token and key exist only in bounded memory while decrypting,
validating, signing, or encrypting. The token may appear transiently in the
central REST Authorization header and while calculating `ath`. The key may
appear transiently only in the credential and signing code.

Neither value enters MCP arguments or results, SQLite, normal logs,
diagnostics, metrics, temporary transcripts, crash artifacts, or support
bundles.

## Approval

The user approved the Node-core encrypted-file design on 2026-08-25, the
current-only DPoP amendment through ADR 0037 on 2026-09-01. The user approved
internal key custody and removal of the local token through ADR 0039 on
2026-09-03.
