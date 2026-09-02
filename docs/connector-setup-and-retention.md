# Historical connector setup

Status: superseded by ADR 0038

The separate Codex, Claude, and Gemini connector design is not part of the
accepted product. Its startup commands, correlation database, provider-specific
transports, polling workflow, and retirement process must not be used for new
work.

Direct agent invocation now belongs inside Embassys Ambassador and uses ACP v1.
Webhook receivers accept the complete message without calling delivery-control
MCP tools. The old connector packages will be removed during the delivery
cutover.

The detailed design diary remains in superseded ADRs 0024 and 0028 through
0031. Current work is in [the implementation plan](implementation-plan.md), and
the accepted replacement is [ADR 0038](adr/0038-ambassador-delivery-modes.md).
