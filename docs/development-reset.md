# Reset local test state

This removes only local Ambassador test residue. It does not call the central
service or delete a registered central identity.

1. Run:

   ```sh
   npx --yes @embassys/ambassador@latest clean
   ```

   If Ambassador is running, the terminal asks whether to stop it and clear
   local state. Answer `yes` to proceed or press Enter to leave it running.
   If it cannot be reached, stop it in its terminal and retry. The command
   waits for the process lock before deleting anything. Non-interactive runs
   require Ambassador to be stopped first. It
   removes the encrypted central credential and key, encrypted webhook and
   local-control secrets and keys, delivery profile, encrypted action-call and
   action-result inboxes, ID-only notification journal, ACP session metadata,
   and interrupted state writes.
   It does not delete provider-owned session history. It retains only the empty
   owner-only state directory and its singleton lock. The next `ambassador
   start` exposes the enrollment tools.

2. If the command cannot validate the local lock artifact, inspect and remove
   the complete Ambassador state directory manually:

   | Platform | Default state directory |
   | --- | --- |
   | macOS | `~/Library/Application Support/ambassador` |
   | Linux | `${XDG_STATE_HOME:-~/.local/state}/ambassador` |
   | Windows | `%LOCALAPPDATA%\ambassador` |

   Delete the directory only after checking the exact path and confirming that
   no Ambassador process is running. Do not run `ambassador webhook-secret`
   concurrently with cleanup.

3. Remove any test-only Ambassador MCP entry or Hermes webhook route that you
   created for the run. If you enabled OpenClaw `hooks` only for this test,
   remove that block or restore its prior values. Do not remove normal provider
   credentials or unrelated hooks.
4. Start Ambassador again from the working directory you want the new direct
   profile to use.

Because this is a local-only reset, central still owns the old email identity.
Use a new disposable email when repeating registration. A `409` for the old
address is expected and is not fixed by deleting local files.
