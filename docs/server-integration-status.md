# Central server integration status

Status: evidence snapshot as of 2026-08-31

This page tracks which central server source and deployment the gateway should
integrate with. It is evidence and planning context, not a protocol
specification. ADRs 0023, 0025, and 0026 remain authoritative until a material
server difference is reviewed and accepted.

## Server sources

The central server repository is
[`embassys/agent2agent`](https://github.com/embassys/agent2agent). GitHub
currently reports it as private. Authorized project collaborators can use it
for cross-repository implementation and review.

The hosted API base supplied for the existing service is
`https://mcp.embassys.ai`. A user-supplied API document identifies itself as
version `1.0.0`, dated 2026-08-30. That document describes bearer JWTs,
`POST /api/register_agent`, consuming `GET /api/poll_messages`, and the older
permission and action API. It may be behind the server's current work and must
not be treated as a generated contract for the next gateway.

Do not copy the snapshot's infrastructure identifiers, account details,
addresses, emails, or log locations into this repository. They are not needed
to integrate the client and may already be stale.

## Evidence observed on 2026-08-31

| Source | Observation | Meaning |
| --- | --- | --- |
| `embassys/agent2agent` default branch | `main` points to commit `4690319`, an initial FastAPI implementation using bearer JWTs, `/api/register_agent`, `/api/poll_messages`, and MCP token arguments. The tree has no DPoP or version 2 implementation and no server test directory. | This commit is an older source snapshot. It is not the DPoP integration target. |
| Hosted health route | `GET https://mcp.embassys.ai/health` returned the healthy service response. | The hostname is live, but health does not identify its source revision or contract. |
| Hosted bootstrap routes | An empty request reached `/api/register_agent`; `/api/register` returned `404`. | The accepted ADR 0023 bootstrap route was not advertised by the observed deployment. |
| Hosted version 2 receive route | `/api/v2/messages/receive` returned `404`. | The accepted ADR 0025 delivery route was not advertised by the observed deployment. |
| Hosted OpenAPI route | `/openapi.json` returned `500`. | A deployed schema could not be collected from that route. |
| Project-owner report | The central server has a DPoP implementation. | The exact source commit, branch, deployment, issuer, resource values, and conformance evidence still need to be pinned. |

The DPoP implementation may exist outside the inspected default branch or may
await deployment. Until its revision and endpoint are identified, this
repository must describe it as reported, not live-qualified.

## I01: refresh the server contract and client tests

- [ ] Obtain the exact server commit containing DPoP and the exact development
  deployment built from it.
- [ ] Record the canonical issuer, API origin and resource, MCP endpoint and
  resource, proxy path, deployment identifier, and rollout state without
  recording credentials or verification data.
- [ ] Export or inspect the exact REST OpenAPI and MCP schemas from that
  revision and deployment.
- [ ] Diff routes, methods, request and response shapes, authentication,
  errors, limits, idempotency, leases, and token lifecycle against ADRs 0023,
  0025, and 0026.
- [ ] Return any material client-visible difference for ADR review. Do not add
  a route probe, compatibility fallback, or runtime contract selection.
- [ ] Update the Node fixture, independent Python fixture, gateway integration
  clients, and reviewed test inventories to the approved latest server
  contract. Tests and CI change before production integration code.

I01 is complete when one pinned server revision, its generated schemas, the
gateway clients, both fixtures, and the gateway tests agree. A hosted health
response or an unpinned API document is not enough.

## I02: switch to DPoP and complete development E2E

- [ ] Enroll a fresh version 2 identity against the pinned development
  deployment through the fixed REST bootstrap routes.
- [ ] Prove issuance binds the token to the gateway P-256 key and that the
  server rejects the same token through bearer authentication.
- [ ] Prove nonce handling, wrong-key rejection, proof replay rejection, proxy
  URI reconstruction, and fresh proofs for protected REST and MCP requests.
- [ ] Prove the central MCP catalog and tool calls carry no token argument.
- [ ] Prove same-key reissue, activation, leased receive, reply or terminal
  completion, outcome lookup, acknowledgement, and restart recovery.
- [ ] Run the packed gateway, artifact scans, and content-boundary checks
  against that deployment without recording tokens, keys, proofs, nonces,
  email addresses, verification codes, messages, or replies.

I02 is complete when the full development flow passes against the pinned DPoP
deployment with bearer rejection. S07 and E01 through E03 still provide the
later staging, soak, and release evidence.

## Evidence rules

- Pin a source commit and a deployment identifier together. Neither one proves
  the other.
- Treat the attached API document as historical input until generated schemas
  and black-box behavior confirm it.
- Use a fresh version 2 identity. Do not convert or silently reuse a version 1
  bearer identity.
- Never weaken an accepted test to match a server implementation. Return a
  material contract difference for review.
- Never put a DPoP-bound token in an MCP argument or accept it through a bearer
  path.
