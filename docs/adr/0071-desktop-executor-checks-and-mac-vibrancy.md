# 0071. Check desktop executor connections and expose native Mac vibrancy

Status: accepted under the owner's approved desktop isolation and appearance work,
2026-09-08. No dependency, public CLI, central API or release change.

## Problem

An isolated Embassys instance could launch a provider whose normal Ambassador
connection points at a different instance. Separate local ports and stores do
not establish which MCP connection that provider will use. The Mac window also
requested native sidebar vibrancy, but opaque window and CSS backgrounds hid it.

## Decision

Before a desktop direct delivery records dispatch intent, the worker asks its
Electron host to check the provider's connection. The private process message
contains a correlated request ID, the fixed provider and saved working directory.
It contains no central message or credential. The host resolves the same trusted
provider settings used by its setup helper and compares the public MCP entry
with the instance registry's loopback port.

Reuse the bounded configuration reader and desktop-only TOML/YAML parsers.
Accept the reviewed HTTP entry shape. Refuse missing, malformed, disabled,
authenticated, redirected or unsupported entries. Check Claude's local project
settings and Claude/Codex ancestor project files. Ambassador project overrides
remain unqualified and pause delivery even if their URL matches. Bound the
ancestor walk and total bytes read. Do not edit settings or copy provider profiles.

The check allows one request at a time and has a five-second deadline. A missing
host handler, disconnect, timeout or refusal leaves the message undispatched in
durable custody. Pause the delivery lane and show an actionable notice. Receipt
and local processing continue. After fixing the connection and restarting the
server, the undispatched message can run. An uncertain actual dispatch still
cannot be replayed. The existing CLI keeps its provider-configuration behavior.

This checks the configured binding at delivery time. It cannot pin a provider's
cached MCP connection or prevent the owner editing settings afterward. Separate
provider profiles and live qualification remain necessary for simultaneous
executors. Engine-version installation still requires signed compatible artifacts.

On macOS, use Electron's native `sidebar` vibrancy with a clear window background
and transparent sidebar CSS. Keep the content area opaque. Update the window
background on appearance changes. Respect Reduce Transparency with opaque
colors, and leave Windows/Linux backgrounds unchanged. No simulated blur or new
UI toolkit is needed.

App-managed enrollment guidance names the actual **Account > Set up this device**
route. Claude Code in the Mac app remains distinct from standalone Chat/Cowork.

## Validation

Tests cover each provider binding, wrong ports, malformed and linked files,
project overrides, real TOML/YAML parsing, private IPC correlation, timeout,
cancellation and worker disconnect. A gateway test proves a failed check keeps
the incoming message pending while later central messages are received, and that
repair plus restart delivers the original message once. Appearance tests cover
light/dark Mac colors and the accessibility fallback.

Native observations and the Claude onboarding screenshot sequence are recorded
in [qualification](../qualification.md). A real requesting agent with a scripted
central service and recipient is not a deployed-central or two-real-agent test.
