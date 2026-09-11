# Connect your agent

In Embassys, log in or register, then choose Claude Code, Codex, OpenClaw or
Hermes and select **Connect**. The same buttons are available under the app's
agent setup settings after onboarding.

The app saves the Ambassador MCP connection, installs the Embassys skill, and
starts a short check in a fresh agent session. If a provider asks to approve a
tool, the app shows its exact choices. A successful check confirms the email
returned by the selected local instance. Existing chats may need reopening to
load the skill and connection.

**Settings saved** means setup files are in place. **Connected** means the agent
made the correlated read-only MCP call. An interrupted check leaves the settings
and registration intact. Open the provider, complete its normal login if needed,
then select **Test connection**. The check does not contact another person or
create another registration.

The skill lets ordinary requests such as "Get Alex's phone number from his
agent: alex@example.com" discover Embassys. It uses the live action catalog,
preserves the user's chosen channel and keeps pending request IDs for later
checks. Local coding subagents are outside its scope. Skills improve discovery;
they do not guarantee a model will select the integration in every conversation.

## Installation and ownership

| Agent | Default skill file |
| --- | --- |
| Codex | `~/.agents/skills/embassys/SKILL.md` |
| Claude Code | `~/.claude/skills/embassys/SKILL.md` |
| OpenClaw | `~/.openclaw/skills/embassys/SKILL.md` |
| Hermes | `~/.hermes/skills/embassys/SKILL.md` |

The app ships one skill with no account IDs, endpoints, credentials or scripts.
Connect can reuse an identical manually installed skill without taking ownership.
Repair restores missing app-owned files. Disconnect removes only unchanged
app-owned settings and skill files. Conflicting content or unsupported links
need owner review; the app preserves them and unrelated files.

The reviewed native setup gate remains Mac Apple silicon. Windows/Linux users
retain manual configuration until those installed-provider paths are qualified.
Claude Code is distinct from standalone Claude Chat/Cowork; this change does not
install a skill into those separate products.

## Verification and current limits

The device's existing agent credential is reused. First-time agent registration
and owner login still require separate email codes. Logging in on a fresh device
cannot recover a lost agent credential through the current API. That remains
[API issue 7](https://github.com/embassys/agent2agent/issues/7), with identity
recovery in issue 2.

The check uses a three-minute deadline, normal provider authentication and the
compiled ACP command. It does not change the model, bypass tool approval or
inject itself into an existing user conversation. A model text response alone
does not verify a connection. Approval dialogs close on cancellation, shutdown
or expiry. This setup deadline does not change ten-minute business waits.

The 2026-09-09 installed-agent check passed with Claude Code, OpenClaw, Hermes
and Codex. Codex required a temporary qualification preference of `gpt-5.5` with
high reasoning: the installed provider could not run its configured
`gpt-6-astra`/max preference. The original preference was restored. This is a
provider/model compatibility limit, and the app correctly left that first
attempt unverified. These checks used an isolated synthetic central fixture;
they do not establish new deployed-server guarantees.

All four checks also passed using the packaged app's Node 24.19.0 runtime.
Separate fresh conversations found the skill from an ordinary request for a
synthetic contact's phone number and returned the exact fixture result. The
OpenClaw and Hermes checks confirmed their own skill locations independently.
Test settings and the Codex model preference were restored afterward.

On September 10 the released Mac app passed native registration and owner login
against deployed central, Connect Claude Code, one-time provider approval and
visible connection confirmation. Restart, cancellation/retry and sign-out also
passed. The [illustrated qualification record](onboarding-qualification-2026-09-10.md)
describes the 16 captures and remaining dialog polish. Native walkthroughs for
the other three agents remain separate follow-ups.
The design and test boundaries are in [ADR 0077](adr/0077-guided-agent-connection-and-discovery.md).
