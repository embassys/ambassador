# 0069 Shared CLI installation and simpler desktop navigation

Status: accepted

Date: 2026-09-07

The owner asked for CLI and desktop to take turns running the same installation,
a simpler desktop UI using the web app's visual language, and continued local
implementation. This supersedes ADR 0064's exclusion of CLI interoperability.
It authorizes the necessary CLI startup changes. It does not authorize server
changes, a new dependency or publication.

Keep the CLI's default state location and loopback port. The app can open that
installation directly, without copying credentials or moving its files. Fresh
desktop setup uses the shared installation. Existing isolated app instances stay
available; an explicit app control adds the shared installation. Label it
"Shared with CLI". Additional instances remain separate. Only one process can
own an installation or listen on its port at a time.

Use the existing exclusive lock and authenticated process stop. An interactive
handoff names the exact running process, asks before stopping it and defaults to
Cancel. Never kill a PID or an unrelated listener. Foreground app startup can
offer the same confirmed handoff; background and login startup never interrupt
the other host. An instance stopped through the control route must stop trying
to restart and save that preference.
After a handoff, use the saved delivery profile's canonical working directory so
peer sessions do not change when the next CLI starts in another directory.
Keep visible conversation capture available in both hosts. Clean continues to
require the exclusive lock and preserves logs; it does not clear owner sign-in.

Registration progress must remain readable when switching hosts. Preserve the
selected fixed delivery profile and known email/code status, and never repeat an
uncertain registration or verification. Current state formats are shared;
unsupported formats fail explicitly. This is direct access to one installation,
not a migration or a promise that every older executable can read newer state.

Use the web app's four sections: Requests, Permissions, Messages and Account.
Keep device setup, server controls and logs in Account, with the server status
always reachable. Distinguish account snapshots from local agent activity and
conversation history. Adopt its ink backgrounds, teal accent, restrained borders
and short copy using existing CSS and React. Preserve native window controls,
system fonts, light/dark preferences, keyboard access and high-contrast support.

Also implement the deployed permission_revoked notification contract. Match the
permission, action and grantor exactly. A revocation prevents undispatched work
from starting, wakes its observer and refreshes local permission notifications.
It does not cancel completed work, replay an uncertain submission, or create a
new permission request. A stale later grant cannot reopen that revoked intent.

Write regressions before implementation. Exercise CLI to desktop to CLI using
one verified fixture identity, pending work, results and the same provider
session. Include conflicting starts, declined and stale handoffs, stopped-state
persistence, registration interruption, Clean isolation and revocation races.
Qualify the final app through native Mac controls and real process handoffs.
Keep server recovery, native push, signed distribution and unavailable native
platform/provider tests in the work plan.
