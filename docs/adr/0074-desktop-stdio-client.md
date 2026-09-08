# 0074. Local stdio client for standalone desktop hosts

Status: accepted within the owner's request to complete local client support
and qualification, September 8, 2026. Distribution remains excluded. ADR 0075 supersedes the shorter-wait recommendation
below with the owner's explicit ten-minute default; measurements remain evidence.

Standalone Claude's documented local connector launches a process. The current
Ambassador listener serves Streamable HTTP. The experimental Claude Code channel
cannot stand in for this connection: it has different client assumptions and
changes initial waits for native notifications.

Add a small stdio-to-HTTP client using the already approved MCP SDK. It connects
only to `http://127.0.0.1:<port>/mcp`, with the port selected in the owner's local
connector configuration. It does not start an instance, register an executor,
read credentials or accept an endpoint through tool arguments. Identify the
upstream connection as the Embassys desktop relay, without impersonating Claude
Code. Account registration and the saved inbound executor remain in Embassys.

Forward the existing tool catalog and exact arguments and results. Preserve
foreground waits, explicit shorter waits, cancellation, errors and receipts.
Never acknowledge, resubmit, inject or schedule on the client's behalf. A failed
connection fails visibly; no alternate endpoint, automatic mutation replay or
native-return support is added. Closing stdio cancels outstanding upstream work.

The native September 8 test measured host cancellation at 180 seconds in Cowork
and 240 seconds in Chat, despite an upstream 600-second request and a 650-second
relay budget. A subsequent 150-second wait succeeded visibly in Chat but exposed
a separate 60-second connection-to-desktop timeout in Cowork, even though the
local MCP call completed. The shared standalone connection therefore recommends
explicit `wait_seconds: 45` for waiting operations. This is the approved
known-client-timeout exception: the model supplies the shorter wait, arguments
remain unchanged, and normal pending results carry the existing continuation.
The guidance distinguishes an observation timeout from a server crash and asks
the owner to request another check. It does not schedule one automatically or
claim the host can hold ten minutes. Other direct clients retain their qualified
ten-minute configuration.

Cowork did not reliably apply initialization instructions in the live test.
Repeat this fixed client guidance in the local `message_box` description and
its wait/request ID parameter help. Keep tool names, schema validation constraints,
actions, arguments and results unchanged. This metadata adaptation does not map
catalog action names or turn a permission into action intent.

The helper is a compiled application module, not a new Ambassador CLI command.
The public CLI flags and delivery registry remain unchanged. Manual connector
instructions can use the bundled runtime; automated installation, MCPB packaging
and distribution remain outside this pass. Qualification must record the actual
Chat/Cowork behavior separately, including any host timeout or policy limit.

Use `embassys` as the standalone connector's display/configuration key so it
matches the product name in normal requests. This does not rename the public
Ambassador binary, existing provider executor connections or native hook names.

Regression tests precede implementation and cover endpoint bounds, unmodified
waits and results, error propagation, cancellation and no automatic receipt or
resubmission. No dependency or central API change is needed.
