# September 15 release follow-up

The owner requested the remaining live checks, review/merge/release, and work on
Cowork discovery, OpenClaw display and Hermes return behavior. This records what
can be completed without treating fixture checks as native or deployed tests.

## Review and fixes

The current client adopts usernames, accepted actions, catalog review metadata,
progress reads and invocation-bound approvals as recorded in
[the central audit](central-adoption-2026-09-15.md). Review also found stale
recovery guidance in MCP errors, legacy registration conflicts and the app's
Clean dialog. These now direct owners to the existing sign-in and device setup
flow. They do not promise to recover locally deleted work. Two regressions failed
against the old guidance and passed after correction.

The installed discovery skill now explicitly covers ordinary registration
checks and peer requests, and tells the host to search both Embassys and
Ambassador tools. The [standalone Claude guide](claude-desktop-local-client.md)
explains enabling the skill in Chat/Cowork separately from Claude Code.
This does not claim that the skill has been enabled or tested in the native app.

## Provider review

- OpenClaw `9069ec3cfa9eaea936161df39dd1512d50ca7e9f` still changes a retained
  message's duplicate count during display grouping. Running the same source
  function three times over two identical text fixtures produces 2, 3 and 4.
  Identity and normalization imports were stubbed for this focused reproduction.
  It is not evidence of a fresh native injection. Default foreground waits avoid
  reliance on experimental native return; the bridge does not insert another
  answer to conceal a display badge or edit provider history.
- Hermes `416a8177c25d87aa9929dfcf31f7964137d7fcdd` still sends CLI injection to
  the interrupt queue during an active turn. Gateway injection requires a known
  session key. Embassys continues to use foreground waits and durable later
  checks instead of an unqualified native return bridge.
- Cowork's fresh-chat discovery still requires native retesting after enabling
  the skill. Existing tool descriptions cannot force the host to search tools.
  The explicit "Use the Embassys connector" fallback remains documented.

The source review and reproduction are in
`.build/release-followup-2026-09-15/provider-review.json`. No third-party source
or installed provider settings were changed.

## Checks and blocked live work

- Shared core: 610 passed, four expected skips, no failures.
- Desktop: 53 checks, typecheck, production build and bundled Node/SQLite/ACP/MCP
  worker verification passed.
- The discovery skill passed the skill validator.
- Deployed OpenAPI was retrieved again. Server main remains `d5365b7` and no
  central MCP route has returned. A schema read is not live flow qualification.

The saved Mailosaur credential still returns HTTP 401. Native computer control
reports that the Mac is locked. The owner has been asked to restore mailbox
access or supply a test address, and to unlock the Mac. No new registration
email was sent to an inaccessible test inbox during this follow-up.

Fresh signup, protected accepted-list changes, account-history queue isolation
and native provider onboarding therefore remain pending. Keep package versions
unchanged while reviewing and merging the client work so the existing main
workflow cannot publish an unqualified new version automatically. The requested
desktop and npm release remains authorized, pending those live checks and the
versioned release gates. Existing public versions remain desktop 0.1.4 and CLI
0.2.21 until publication is verified.
