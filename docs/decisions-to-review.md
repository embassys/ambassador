# Decisions to review

Status: consolidated review record as of 2026-09-02

The ADRs are the decision authority. This page records the current result and
the few remaining choices. It no longer repeats every implementation judgment
from superseded plans.

## Accepted current central decision

On 2026-09-01, the user accepted aligning the gateway with the server that is
actually deployed:

- use the unversioned REST API at `https://mcp.embassys.ai`;
- pin `embassys/agent2agent` commit
  `b769896b7cfb1ee3540195be9e7a61cf777b9388` as the development source
  reference;
- use no central MCP path because REST covers the gateway flows;
- send a P-256 public JWK in the verification body;
- send the bound token as `Authorization: Bearer <token>` plus a separate DPoP
  proof header;
- follow the server's current DPoP claim and optional nonce behavior;
- use current permission, action, poll, and acknowledgement semantics;
- do not require `/api/v2`, activation, reissue, leases, conversations,
  replies, outcomes, or a proposed error envelope; and
- support no old client, credential, or state migration.

ADR 0037 records the complete decision and its evidence.

## Accepted gateway boundaries that remain

- One foreground gateway owns one webhook and one central identity.
- The public CLI remains limited to `--webhook-url` and
  `--webhook-token-env`.
- The local MCP listener is authenticated and loopback-only.
- The webhook token also authenticates local MCP.
- The central token and P-256 private key are stored together in the approved
  encrypted file.
- The notification journal is ID-only and message bodies remain in bounded
  memory.
- Redirects are rejected and side-effecting uncertain outcomes are not
  retried automatically.
- The gateway does not hold provider credentials or select a provider runtime.
- Node 24, pnpm for repository work, the accepted MCP SDK packages, SQLite,
  and the existing exact dependencies remain approved.
- Windows remains outside the first supported release under ADR 0033.

## Provider decisions that remain

ADRs 0024 and 0028 through 0031 still define useful provider separation,
startup, local policy, encrypted content-free state, process control, and
distribution boundaries where they do not rely on the removed central
conversation lifecycle.

- Codex uses the App Server interface selected in ADR 0034 for its preview
  adapter.
- Claude Code uses the headless CLI and lifetime monitor selected in ADR 0035.
- ADR 0036 rejects the reviewed Gemini CLI interface. No Gemini adapter is
  selected.

The central-facing portion of the provider execution design must now be
revisited against the qualified permission/action gateway flow. Current
connector fixture success is not live-central evidence.

## Superseded decisions

The following are historical only:

- central MCP tool discovery and token arguments;
- Python-literal central MCP result normalization;
- the development verbose transcript;
- `/api/register` instead of `/api/register_agent`;
- an issuance proof on verification;
- `Authorization: DPoP`;
- issuer, dual-audience, token-ID, token-type, and 24-hour token requirements;
- scheduled same-key reissue and email-control recovery;
- `/api/v2` activation, receive, conversation, reply, completion, outcome,
  acknowledgement, and revocation routes;
- lease redelivery and idempotent acknowledgement as current server facts;
- API version negotiation or compatibility fallback;
- old credential or mailbox migration; and
- central S01 through S07 implementation gates.

Their original rationale remains in superseded ADRs for history. It is not a
current implementation requirement.

## Decisions still open

- The provider connector workflow for actual permission and action messages.
- Any future server redelivery or token-lifecycle feature after the current
  integration works.
- Preview and stable package publication.
- Any future Windows qualification.

None of these open items authorizes a runtime probe, compatibility path, new
dependency, new CLI option, or publication workflow.
