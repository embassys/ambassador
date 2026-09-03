# Reset local test state

This removes only local Ambassador test residue. It does not call the central
service or delete a registered central identity.

1. Stop `ambassador start`.
2. Run:

   ```sh
   npx --yes @embassys/ambassador@latest clean
   ```

   The command refuses to run while Ambassador owns the process lock. It
   removes the encrypted central credential and key, encrypted webhook secret
   and key, delivery profile, ID-only notification journal, and interrupted
   state writes. It retains only the empty owner-only state directory and its
   singleton lock. The next `ambassador start` exposes the enrollment tools.

3. If the command cannot validate the local lock artifact, inspect and remove
   the complete Ambassador state directory manually:

   | Platform | Default state directory |
   | --- | --- |
   | macOS | `~/Library/Application Support/ambassador` |
   | Linux | `${XDG_STATE_HOME:-~/.local/state}/ambassador` |
   | Windows | `%LOCALAPPDATA%\ambassador` |

   Delete the directory only after checking the exact path and confirming that
   no Ambassador process is running. Do not run `ambassador webhook-secret`
   concurrently with cleanup.

4. Remove any test-only Ambassador MCP entry or Hermes webhook route that you
   created for the run. If you enabled OpenClaw `hooks` only for this test,
   remove that block or restore its prior values. Do not remove normal provider
   credentials or unrelated hooks.
5. Start Ambassador again from the working directory you want the new direct
   profile to use.

Because this is a local-only reset, central still owns the old email identity.
Use a new disposable email when repeating registration. A `409` for the old
address is expected and is not fixed by deleting local files.
