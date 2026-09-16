# September 15 release follow-up

This is the September 15 checkpoint. Mailosaur access was restored and the
previously blocked live API, history and native Codex checks passed on September
16. See the [current candidate record](release-candidate-2026-09-16.md).

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
The September 16 native retest below records the enabled skill's behavior.

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
- Cowork's fresh-chat discovery passed the two September 16 tests with the
  skill enabled. Existing tool descriptions cannot force the host to search
  tools. The explicit "Use the Embassys connector" fallback remains documented.

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

The saved Mailosaur credential still returns HTTP 401. Native access was blocked
on September 15 and restored on September 16. The owner has been asked to restore
mailbox access or supply a test address. No new registration email was sent to
an inaccessible test inbox during this follow-up.

Fresh signup, protected accepted-list changes, account-history queue isolation
and native provider onboarding therefore remain pending. Keep package versions
unchanged while reviewing and merging the client work so the existing main
workflow cannot publish an unqualified new version automatically. The requested
desktop and npm release remains authorized, pending those live checks and the
versioned release gates. Existing public versions remain desktop 0.1.4 and CLI
0.2.21 until publication is verified.

## Native retest, September 16

PR [51](https://github.com/embassys/ambassador/pull/51) merged as `fe72554` after
all ten required checks passed. Both post-merge CI and desktop workflows passed.
The ten-minute MCP qualification held the original request for 600.011 seconds;
the later check used the same operation, with one permission request and one
action dispatch. This used the real MCP transport against a central fixture.
The clean-installed package checks also passed.

The isolated native Embassys app opened its welcome and email screens against
the deployed service. An old saved sign-in challenge still displayed code-entry
guidance after its expiry. A regression reproduced this, and the account snapshot
now returns `code_expired` with a fresh-code prompt. No automatic resend or
expired-code verification request is sent.
All 36 account tests pass. The rebuilt native app was also checked with a
seeded expired challenge in the isolated test profile: Register shows the expiry
notice and a fresh-code button, retaining the email. Native Stop and Start changed
the local service from Running to Paused and back. The 53 desktop checks, desktop
build and repository lint passed.

Claude Desktop 2.110.0, Sonnet 5 High, was tested through the native interface:

- Uploaded and enabled the bundled Embassys skill in Customize > Skills.
- With no connector configured, a fresh registration question loaded the skill
  and reported the missing connection instead of asking for a website.
- With the temporary local connector shown as Running, two fresh tasks used
  only "Am I registered with Embassys?" and "Can you get Alex's phone number
  from his agent?" Both loaded the skill, found `get_my_permissions`, and used
  the tool after a one-time read approval.
- Both correctly directed the unenrolled installation to the Embassys app.
  Neither collected a code in chat, sent a peer request, or claimed to have
  obtained a phone number. No model or standing tool-approval setting changed.

The temporary connector configuration was removed after the tests, preserving
other settings. The discovery skill remains enabled for the owner.

Screenshots are saved locally under `.build/release-followup-2026-09-16/`.
These checks establish discovery and the unenrolled setup boundary, not complete
production onboarding, native return delivery or an authenticated peer exchange.
