# CL04 Claude Code manual qualification

Status: runner implemented; no real Claude Code qualification has been run

CL04 is a manual, opt-in check for an existing authenticated Claude Code
`2.1.251` installation. It never runs in CI or the normal test command. A pass
applies only to the OS and architecture in the content-free result. It is not
publication approval, stable support, real-central evidence, or a claim about
another platform.

## Disposable account requirement

Run CL04 only from a fresh disposable OS account with its own normal Claude
Code authentication. The account must have no existing Claude connector state.
The runner stops before packaging if the fixed production state directory
already exists.

Do not copy credentials or Claude history from another account. Provision the
account independently, authenticate the official CLI using its normal login
flow, and discard the account after local review. The runner never reads,
copies, changes, deletes, or reports Claude credentials or provider-owned
history. It does not invoke `retire-state`.

Claude owns the qualification prompts and replies in its history. That history
is required for the resumed turn, but neither the connector nor the runner
opens the history files. The artifact scan excludes Claude-owned credential,
configuration, and history locations. It scans the packed install, connector
state, runner-owned temporary tree, bounded connector output, process
arguments, and the exact observed process units. The disposable-account
operator must also attest that the fresh account has no managed Claude hooks,
status commands, file-suggestion commands, or project settings. This is the
safe account check because entering provider-owned directories would violate
the history and credential boundary.

The account must already have:

- macOS or Linux with `ps` and `mkfifo`;
- Node `24.19.0` or a later Node 24 patch;
- the cached Corepack pnpm `11.22.0` CLI;
- this checkout's complete pnpm store and pnpm v11 metadata cache;
- the official Claude Code executable reporting exactly
  `2.1.251 (Claude Code)`; and
- working Claude Code authentication for that disposable account.

The runner uses offline packaging and disables lifecycle scripts. It does not
download, install, update, or sign in to any provider or package service.

## Run

From the repository root:

```text
node scripts/cl04-qualify-claude.mjs \
  --confirm=run-authenticated-claude-code-2.1.251-on-disposable-account
```

The runner accepts no other argument. It exposes no provider path, state path,
working-directory override, policy override, credential option, output path,
fault injection, or observation control. Without the exact confirmation it
does no build, state, executable, or provider work.

The timeout case exercises the production 15-minute provider deadline. Allow
at least 25 minutes for the procedure. Do not shorten production deadlines to
make qualification faster.

## Checks

The runner performs these checks in order:

1. Validate the platform, Node version, fresh fixed connector state, canonical
   executable identity, and exact Claude version output. The provider child
   receives only the fixed environment allowlist. Token-like environment
   fields are not copied.
2. Resolve the pinned pnpm CLI, store, and cache. Build and stage only the
   Claude connector, run the existing packed-artifact checker, pack it with
   lifecycle scripts disabled, and install it offline in copy mode.
3. Start only the packed `a2a-claude-connector` against the local gateway MCP
   fixture. Complete two linearly linked turns in one caller-generated Claude
   session. The first turn sends inert adversarial text through structured
   stdin. The second must retrieve a nonce known only through the first turn's
   provider-owned history.
4. Observe the detached packaged lifetime monitor and Claude process group
   through the OS process table. Require the fixed stream-JSON, safe,
   restricted, `dontAsk`, no-customization arguments and the policy-specific
   tool ceiling. Reject approval-granting or settings arguments and any prompt
   or reply in process arguments or the transient process environment scan.
   Retain process and group IDs only in memory.
5. Under read-only policy, allow an in-root read and deny an in-root write.
   Deny an out-of-root read. Under workspace-write policy, accept either the
   trusted provider's in-root write or its narrower denial, while still denying
   an out-of-root write. The selected tool lists contain no shell or network
   tool, and a local network probe must receive no request.
6. Ask for an unavailable Bash permission and verify that no connector grant
   or filesystem effect occurs.
7. Exercise normal provider exit, SIGINT cancellation, the full production
   timeout, connector hard death during the version probe before readiness,
   connector hard death after an active turn has made one filesystem effect,
   and externally induced monitor hard death.
8. Prove each exact observed monitor-led process group and every tracked PID
   gone before the local fixture accepts the related terminal result. The
   active hard-death restart must resolve as uncertain without spawning another
   Claude unit. When the provider permitted the earlier workspace write, its
   pre-crash file fingerprint must also remain unchanged. Together these prove
   that the connector did not replay the turn.
9. Scan connector state, runner-owned temporary files, package evidence,
   bounded connector output, process arguments, and transient process
   environments for the webhook token, prompts, replies, and probe values.
   Delete the runner-owned temporary tree on pass or failure. Leave
   Claude-owned credentials, configuration, history, and fixed connector state
   untouched in the disposable account.

CL02 and CL03 separately prove the private byte-exact monitor protocol,
session-before-input ordering, input replay, every internal process barrier,
malformed control handling, and injected fault inventory. The packed artifact
contains no qualification seam, so CL04 checks only behavior visible outside
that artifact.

## Output and review

A passing run writes one JSON line with versions, the tarball SHA-256, and
Boolean results for the closed CL04 matrix. It also states:

```json
{
  "provider_history": "claude_owned_not_scanned_or_deleted",
  "support_claim": "none_pending_review"
}
```

The line contains no credential, prompt, reply, path, provider ID, session ID,
turn ID, PID, process output, or provider-history content. A failure writes
only `cl04 qualification: <phase>_failed` and exits nonzero. Diagnose failures
inside the disposable account. Do not attach its history, connector state, or
raw process output to an issue.

After a pass, review the content-free line and the local platform details
before changing the support claim. Until that review happens, the repository
continues to report real Claude qualification as pending.
