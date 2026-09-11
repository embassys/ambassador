# Native onboarding qualification, 10 September 2026

The published Embassys 0.1.1 preview 1 passed a complete native Mac onboarding
journey with the deployed central service, real verification emails and installed
Claude Code 2.1.257. The test ran on macOS 26.6.2, Apple silicon, using the
downloaded release DMG. Its checksum matched the published manifest and its
strict ad hoc signature check passed.

## Observed journey

1. A fresh isolated app installation showed Log in and Register.
2. Register sent an email through deployed central. Entering the code in the app
   completed agent verification without selecting an executor first.
3. Continue to log in preserved the email. A separate real email code established
   the owner session and opened the four-agent selection screen.
4. Connect Claude Code showed the native connection review and installed the
   Embassys discovery skill. An existing matching MCP entry was reused.
5. The real Claude agent requested a native approval for `get_my_permissions`.
   Selecting its one-time Yes option allowed a correlated read. The returned
   verified email matched the new registration, and the app showed
   **Claude Code is connected**.
6. Open Embassys showed Requests and a running local server. Account showed the
   matching owner and registered device.
7. Native Quit followed by relaunch preserved login, device registration and
   completed onboarding.
8. Cancelling a subsequent native approval preserved settings and offered a
   retry. Test connection then passed with a fresh one-time approval.
9. Sign out returned to Welcome. Native Quit stopped the isolated app.

Gateway evidence contains one registration request, one registration
verification and two successful correlated agent checks. The cancelled check
did not make its denied tool call. Both gateway and owner logs were checked:
neither contained either email code. Codes were entered without capturing their
values in screenshots.

## Evidence and cleanup

The 16 original native captures, illustrated Markdown and self-contained HTML
walkthrough are local in `.build/onboarding-2026-09-10/`. `evidence.json` records
the build identity and assertions; `sanitized-events.json` retains only relevant
lifecycle and read-only check events. No mock central service or screenshot
mockup was used.

The test-installed discovery skill was removed through the app. The pre-existing
Claude MCP entry was checked against its original value and remained unchanged.
The test owner was signed out, its verification emails removed, the test app and
temporary keep-awake process stopped, and the DMG unmounted. The isolated local
test state remains available for investigation. No provider credentials were
copied, provider model preferences changed, or central code modified.

## Limits and polish findings

- This native journey qualifies Claude Code on this Mac. It does not rerun
  Codex, OpenClaw or Hermes, nor qualify Windows/Linux. Their earlier real-agent
  checks with synthetic central data remain separate evidence.
- The existing matching MCP entry was reused, so this run does not requalify
  writing an absent provider entry. The discovery skill was newly installed and
  then removed.
- First-time signup still needs two email codes under API issue 7.
- The native provider-approval dialog displays raw tool JSON. Show a short
  explanation of the read-only check and move technical details into a secondary
  view, while preserving the provider's exact approval choices.
- The connected screen repeats its instruction to reopen existing chats. Keep
  that guidance once.
- The preview remains ad hoc signed without notarization. Running this downloaded
  artifact does not qualify signed distribution or automatic updates.

No production implementation or release changed during this test.
