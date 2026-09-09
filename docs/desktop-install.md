# Install the Embassys preview

Download the application for your computer from the
[Embassys 0.1.1 preview release](https://github.com/embassys/ambassador/releases/tag/desktop-v0.1.1-preview.1).
Choose an application file in Assets, not GitHub's source-code archives. You do
not need to install Node or build Embassys yourself. You do need an installed,
authenticated agent to handle incoming requests.

| Computer | Download | Qualification |
| --- | --- | --- |
| Mac with Apple silicon, M1 or newer | `Embassys-0.1.1-darwin-arm64-development.dmg` | Native Mac app baseline and installed-agent tests; new Connect dialogs await visual inspection |
| Windows x64 | `Embassys-0.1.1-win32-x64-development.zip` | Experimental; automated packaged-runtime tests |
| Linux x64 | `Embassys-0.1.1-linux-x64-development.tar.gz` | Experimental; automated packaged-runtime tests; sandbox setup may be required |

There is no Intel Mac or Windows/Linux ARM download in this preview. These are
unsigned development packages. Managed computers may refuse to run them.

## Mac

1. Open the DMG and drag Embassys.app into Applications.
2. Eject the disk image and open Embassys from Applications.
3. If macOS blocks the unidentified developer, use the app-specific **Open
   Anyway** option in System Settings > Privacy & Security. See
   [Apple's instructions](https://support.apple.com/en-us/102445). Do not disable
   Gatekeeper or remove quarantine from a whole downloads folder.

Launch at login is unavailable until the app is signed and notarized. If the
app is reported as damaged or the exception is unavailable, report the exact
message rather than changing system security settings.

## Windows

Extract the complete ZIP into a permanent folder and open `Embassys.exe` inside
`Embassys-win32-x64`. Keep its supporting files together; moving only the EXE
will break the app. Windows can show an unknown-publisher warning or block it
under your organization's policy. Automatic agent setup remains limited to
platforms that have passed native testing; the app provides manual guidance.

## Linux

Extract the archive and run `./Embassys` from `Embassys-linux-x64` as your normal
user. A graphical desktop, Electron's system libraries and a working Chromium
sandbox are required. Some distributions restrict unprivileged user namespaces
and require administrator setup of the bundled `chrome-sandbox` helper in a
root-owned application directory. This archive is not a system installer and
does not perform that setup. If startup reports a sandbox error, preserve the
error for your administrator or a bug report; do not use `--no-sandbox` or run
the application as root. See
[Chromium's Linux sandbox documentation](https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/README.md).

## First launch

Choose Log in or Register, enter your email and verification code, then follow
the agent connection steps. New device registration currently needs another
code for owner login. Returning-owner login and local agent enrollment are
separate, so a new computer cannot recover an old agent identity yet.

On a qualified Mac, **Connect** configures Claude Code, Codex, OpenClaw or Hermes,
installs an Embassys discovery skill and checks a real tool call. Provider
approvals appear in the app. Reopen existing agent chats to load the skill.
If the check fails, settings remain saved and **Test connection** can retry
without repeating registration. See [Connect your agent](guided-agent-connection.md).

Closing the window keeps the menu/tray app running. Quit Embassys stops its
servers. Settings contains server controls, logs and Clean. Clean removes local
enrollment and pending work; it is not sign-out or a server-side account reset.

The app and its bundled CLI can hand off the same installation. Older npm CLI
builds are not qualified to open the app's newer state. Use the app's **Use the
CLI** guidance for the matching bundled command.

## Preview limits

- Central disconnects can still lose messages or leave submissions uncertain.
  Complete remote history, identity recovery and native remote push remain open.
- Fresh Cowork chats sometimes need "Use the Embassys connector." OpenClaw
  native return remains experimental because of display defects. Hermes uses
  foreground waits. A client may end a wait early; ask it to check the same
  request later.
- Development logs include request and response bodies after credential
  redaction. They expire after seven days while the app runs or logs are next
  opened, with a 1 GiB limit per instance. Clear logs and export are in Settings.
- There are no automatic updates or a general state-migration guarantee.
- This release's four installed-agent tests used synthetic central data. Codex
  required a model supported by its installed adapter; the test used `gpt-5.5`
  with high reasoning. Embassys does not change the provider's model setting.

Checksums and dependency inventories are attached beside the downloads. See the
[work plan](implementation-plan.md) for the remaining reliability and platform
work, or [build the app yourself](desktop-distribution.md).
