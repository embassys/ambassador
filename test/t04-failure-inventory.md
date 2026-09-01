# Superseded T04 inventory

Status: superseded by ADR 0037 and I02

T04 specified activation, leased delivery, conversations, replies, outcomes,
completion, and idempotent acknowledgement. The current central server does
not expose that lifecycle.

Replace or delete the corresponding tests during I02. Current consuming poll,
message custody, webhook relay, and acknowledgement cases are listed in
[i02-failure-inventory.md](i02-failure-inventory.md).
