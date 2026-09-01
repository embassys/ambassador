# Human work queue

Status: current action view as of 2026-09-01

## Central coordination

- [x] Central owner: deploy the JSON codec and `list_action_types` fix.
- [x] Gateway owner: record the live `get_email` and `get_phone_number`
  schemas. Both accept an object with required string `reason`.
- [ ] Central owner: fix or confirm `get_my_permissions`, which has a response
  field mismatch in the pinned source.
- [ ] Central owner: optionally expose build metadata before a release claim.
  Generated OpenAPI now works.

The gateway does not ask the central team to implement the removed `/api/v2`,
central MCP, reissue, activation, lease, conversation, reply, completion, or
outcome design.

## Gateway engineering

| Task | State | Evidence needed |
| --- | --- | --- |
| I01 source and live contract pin | Complete | ADR 0037, source inventory, and live DPoP observations |
| I02 fixture and test replacement | Next | Current REST and DPoP red suite reviewed before production changes |
| I03 enrollment, credential, and DPoP simplification | Pending I02 | Replacement tests pass and old credential/MCP paths are absent |
| I04 protected tools and consuming message lifecycle | Pending I03 | REST, relay, process, package, and artifact tests pass |
| I05 two-identity live E2E | Pending I04 | Permission, action, poll, ack, and packed-install run passes |

## Provider work

- [ ] Redesign the connector's central-facing execution flow after I05. The
  current server uses permissions and action messages, not the removed
  conversation and reply API.
- [ ] Rerun real Codex qualification after that redesign.
- [ ] Rerun real Claude Code qualification after that redesign.
- [ ] Decide separately whether Gemini remains in scope. ADR 0036 rejected the
  reviewed CLI interface.

Existing provider process security and credential separation remain useful,
but no provider connector currently has a live-central support claim.

## Product and release decisions

- [ ] Approve a development package only after I05 and artifact review.
- [ ] Approve any public preview or stable publication separately.
- [ ] If Windows support is reconsidered, approve and run the separate native
  qualification plan. It remains unsupported under ADR 0033.

No decision is needed for migration or old-version support. The user has
selected a clean development cutover.

## Evidence checklist

Before a compatibility or release claim, point to evidence for:

- the pinned central source and live origin;
- successful email delivery and DPoP-bound verification;
- missing-proof, wrong-key, replay, method, URL, hash, and time rejection;
- working dynamic action schemas;
- two-identity permission and action delivery;
- current consuming-poll and acknowledgement behavior;
- no central MCP traffic;
- packed installation on each claimed platform; and
- no secrets or content in durable state, logs, temporary files, or packages.
