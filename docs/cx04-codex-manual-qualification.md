# CX04 Codex manual qualification

Status: runner implemented; no real Codex qualification has been run

This is a manual, opt-in check for one existing authenticated Codex 0.149.0
installation. It does not run in CI or the normal test command. Passing it can
support only the ADR 0034 preview candidate for the exact OS and architecture
in its result. It is not real-central evidence, publication approval, stable
support, or a cross-platform claim.

## Use a disposable account

Run CX04 only from a fresh disposable OS account with its own normal Codex
authentication. The account must have no existing Codex connector state. The
runner refuses to continue if the fixed production state directory already
exists.

This precondition matters because the packed production connector obtains its
state root from the OS account and accepts no state-path override. CX04 binds
that state to a temporary working directory. The runner does not delete or
retire the state afterward. It also does not read, copy, change, or delete
Codex credentials or history. Discard the disposable account after reviewing
the content-free result.

Codex keeps the qualification prompts and replies in its provider-owned
history because ADR 0034 requires persistent threads. The runner never copies
that history into its own artifacts. A normal account should not be used as a
shortcut around this boundary.

Provision the disposable account independently before running CX04. It needs
the approved Node 24 release, the cached Corepack pnpm 11.22.0 CLI, a complete
pnpm store for this checkout, the pnpm v11 registry metadata cache, Codex
0.149.0, and its own normal Codex authentication. Populate the checkout's pnpm
store and cache before the qualification window; the runner is offline and
does not install or download missing tooling or dependencies. Do not copy a
normal account's Codex credentials, provider history, or connector state to
satisfy this precondition.

## Run

From the repository root, with the approved Node and pnpm versions available
and Codex 0.149.0 already installed and authenticated:

```text
node scripts/cx04-qualify-codex.mjs \
  --confirm=run-authenticated-codex-0.149.0-on-disposable-account
```

The runner accepts no other argument, state path, provider path, working
directory, policy override, credential, or output path. The confirmation is
deliberately specific. Without it, the runner performs no build, schema, state,
or provider action.

## Checks

The runner performs these checks in order:

1. Require macOS or Linux, Node 24.19 or later within major 24, a fresh fixed
   connector state location, and a canonical executable named `codex` on the
   current `PATH`. Resolve only the fixed pnpm 11.22.0 Corepack-cache location,
   obtain this checkout's store from that CLI, and canonicalize and validate
   the executing Node binary, pnpm CLI, populated store, and pnpm v11 metadata
   cache. Missing or malformed prerequisites fail the precondition without
   starting packaging.
2. Build and stage only the Codex connector, then pass those exact qualified
   Node, pnpm, store, and cache paths to the repository's existing packed-file
   checker. Use the same inputs to pack the private artifact and install that
   tarball offline. Lifecycle scripts stay disabled throughout, and the clean
   install uses copy mode. CX04 does not duplicate the packed-file checker.
3. Fingerprint `~/.codex/config.toml` in memory as either absent or SHA-256.
   Require exact version output `codex-cli 0.149.0`, while retaining the exact
   canonical executable identity. Generate the stable schema
   twice into separate empty temporary directories without `--experimental`.
   Both generated files must have SHA-256
   `9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9`.
4. Repeat the config comparison after schema generation, startup, resume, both
   policy modes, recovery, and final shutdown. The config bytes and digest are
   not printed or written.
5. Run the packed connector against the local content-free gateway fixture.
   Check two turns in one Codex thread, read-only denial, one-root write,
   out-of-root denial, network denial, bounded cancellation, hard connector
   death with an active command descendant, and exact-turn recovery without a
   second side effect.
6. Prove the exact connector process group is empty after cancellation and
   hard death. This uses the process group created for that one connector run,
   not a process-name or PID search.
7. Pin the provider `TMPDIR` to the runner-owned temporary tree. Scan that tree,
   the workspace, schema outputs, connector state, and bounded process captures
   for the webhook token, prompts, replies, and probe values. Package inventory
   and clean installation are checked independently by the existing
   packed-artifact checker.

The temporary package, schema, and workspace tree is removed whether the run
passes or fails. The fixed connector state and Codex-owned history remain in
the disposable account.

## Output

A passing run writes one JSON line to stdout. It contains the platform, Node
version, Codex version, schema and tarball digests, Boolean results for the
accepted matrix, and these two explicit limits:

```json
{
  "provider_history": "codex_owned_not_scanned_or_deleted",
  "support_claim": "preview_candidate_only"
}
```

The complete line contains no token, prompt, reply, path, config digest,
provider ID, thread ID, turn ID, PID, or process output. A failed run writes
only `cx04 qualification: <phase>_failed` to stderr and exits nonzero. Inspect
the disposable account locally if deeper diagnosis is needed. Do not attach
its provider history or connector state to an issue.
