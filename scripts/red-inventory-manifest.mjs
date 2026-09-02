function reviewed(file, nesting, status, boundary, names) {
  return names.map((name) => ({
    file,
    nesting,
    status,
    skip: false,
    todo: false,
    boundary,
    name,
  }));
}

const fail = (file, nesting, boundary, names) => reviewed(file, nesting, "fail", boundary, names);

const pass = (file, nesting, names) => reviewed(file, nesting, "pass", undefined, names);
function k02Pass(file, name) {
  return {
    file,
    nesting: 0,
    status: "pass",
    skip: false,
    todo: false,
    boundary: undefined,
    name,
  };
}

const k02Groups = {
  "k02-correlation-state.test.js": [
    ["K02-K03:A01", "K02-A01 creates the exact strict schema and fixed SQLite settings"],
    [
      "K02-K03:A02",
      "K02-A02 derives full HMAC indexes and authenticates every AES-256-GCM envelope",
    ],
    ["K02-K03:A03", "K02-A03 rejects ciphertext transplanted across authenticated AAD parents"],
    ["K02-K03:A04", "K02-A04 commits paired message and conversation transitions atomically"],
    [
      "K02-K03:A05",
      "K02-A05 independently rejects ciphertext, GCM-tag, HMAC-index, and schema corruption",
    ],
    ["K02-K03:A06", "K02-A06 rejects token, provider, and canonical-directory scope changes"],
    [
      "K02-K03:A07",
      "K02-A07 deletes only an acknowledged message and retains the conversation mapping",
    ],
    [
      "K02-K03:A08",
      "K02-A08 fails closed on unexpected artifacts, weak modes, and database damage",
    ],
    [
      "K02-K03:S01-artifacts",
      "K02-S01 keeps content, credentials, approvals, and execution options out of artifacts",
    ],
  ],
  "k02-crash-matrix.test.js": [
    [
      "K02-K03:C01-matrix",
      "K02-C01 recovers all eight content-free crash barriers without duplicate work",
    ],
    [
      "K02-K03:C03",
      "K02-C03 dispatches once only from received and never from binding or turn_starting",
    ],
    [
      "K02-K03:C04",
      "K02-C04 never restores a reply plan after the durable lost-open uncertain transition",
    ],
  ],
  "k02-execution-boundaries.test.js": [
    ["K02-K03:P04", "K02-P04 keeps sender text in input_text and out of execution settings"],
    [
      "K02-K03:S01",
      "K02-S01 builds the exact child environment allowlist and removes credential names",
    ],
    ["K02-K03:P05", "K02-P05 preserves provider-owned approval and exposes no approval route"],
    ["K02-K03:P05-policy", "K02-P05 enforces a local maximum policy and never widens it"],
  ],
  "k02-limits-timeouts.test.js": [
    ["K02-K03:B00", "K02-B00 exports the accepted non-configurable connector limits"],
    ["K02-K03:P06", "K02-P06 keeps one absolute deadline and cancels a proven safe wait"],
    ["K02-K03:B01", "K02-B01 accepts 10000 normalized events and rejects event 10001"],
    [
      "K02-K03:B05",
      "K02-B05 accepts an exact reply and rejects one-over without truncation or reflection",
    ],
    ["K02-K03:B02", "K02-B02 accepts 1024-byte provider IDs and rejects each 1025-byte field"],
    [
      "K02-K03:B03",
      "K02-B03 accepts 262144-byte progress and rejects 262145 bytes without reflection",
    ],
    ["K02-K03:B04", "K02-B04 enforces independent 8 MiB stdout and stderr capture limits"],
    ["K02-K03:L01", "K02-L01 cancels one local gateway MCP request at the fixed 35-second timeout"],
    [
      "K02-K03:P07-grace",
      "K02-P07 waits one absolute grace then performs three-second qualified containment",
    ],
    ["K02-K03:SD01", "K02-SD01 bounds SIGINT and SIGTERM-style shutdown to one 15-second budget"],
  ],
  "k02-provider-automata.test.js": [
    ["K02-K03:P01", "K02-P01 enforces every start first-event and binding transition edge"],
    ["K02-K03:P02", "K02-P02 resumes only the stored session and rejects a second session binding"],
    [
      "K02-K03:P03",
      "K02-P03 binds exact recovery before output and makes no-turn crashes uncertain",
    ],
    [
      "K02-K03:P08",
      "K02-P08 foundation crash seam makes no injected-port or central recovery call",
    ],
    ["K02-K03:P09", "K02-P09 stops pulling when durable publication fails at each binding barrier"],
    [
      "K02-K03:P10",
      "K02-P10 rejects malformed, misordered, wrong-execution, and post-terminal events",
    ],
  ],
  "k02-recovery-outcomes.test.js": [
    ["K02-K03:O01", "K02-O01 sends every exact terminal mapping before one acknowledgement"],
    [
      "K02-K03:O02",
      "K02-O02 maps an unrecoverable provider result to uncertain without redispatch",
    ],
    ["K02-K03:C02", "K02-C02 recovers only the exact durable turn after a crash"],
    ["K02-K03:C01", "K02-C01 resolves a committed lost reply through outcome lookup and one ack"],
    [
      "K02-K03:P07",
      "K02-P07 blocks terminal reporting when qualified containment cannot prove cleanup",
    ],
    [
      "K02-K03:O03",
      "K02-O03 converts a lost open reply to uncertain after exact recovery cannot restore bytes",
    ],
    [
      "K02-K03:O04",
      "K02-O04 retains one mailbox-full reply in memory and retries no provider turn",
    ],
    ["K02-K03:O05", "K02-O05 follows one 1,2,4,8,16,30-second lifetime retry schedule"],
    ["K02-K03:O06", "K02-O06 blocks every permanent, authentication, and malformed gateway result"],
  ],
  "k02-state-scheduling.test.js": [
    [
      "K02-K03:S04",
      "K02-S04 persists only encrypted opaque mapping and content-free lifecycle data",
    ],
    [
      "K02-K03:Q02-conversation",
      "K02-Q02 serializes one conversation and resumes its exact mapped session",
    ],
    [
      "K02-K03:Q02-global",
      "K02-Q02 holds at most two global turns and queues a third conversation",
    ],
    ["K02-K03:Q01", "K02-Q01 retains 100 queued opaque IDs and rejects entry 101 without eviction"],
    [
      "K02-K03:Q03-closed",
      "K02-Q03 stops independently when later work targets a closed conversation",
    ],
    [
      "K02-K03:Q03-uncertain",
      "K02-Q03 stops independently when later work targets an uncertain conversation",
    ],
  ],
  "k02-startup-state-package.test.js": [
    [
      "K02-K03:D01-cli",
      "K02-D01 exposes only the exact public start and retire-state command grammar",
    ],
    [
      "K02-K03:D02-startup",
      "K02-D02 starts each exact foreground entrypoint with ordered fixed errors",
    ],
    [
      "K02-K03:S09",
      "K02-S09 initializes once and fails closed at every owner/correlation crash boundary",
    ],
    [
      "K02-K03:S10",
      "K02-S10 rejects correlation-only rollback and documents mutually valid rollback residual risk",
    ],
    ["K02-K03:S11", "K02-S11 refuses only conversation 100001 and admits a mapped continuation"],
    [
      "K02-K03:S12",
      "K02-S12 opens no state until the injected filesystem qualification proves local",
    ],
    [
      "K02-K03:S13",
      "K02-S13 distinguishes partial markers while retirement resumes every crash barrier",
    ],
    [
      "K02-K03:D03-manifests",
      "K02-D03 keeps connector-core unpackaged and fixes every private provider manifest",
    ],
    [
      "K02-K03:D04-build-stage",
      "K02-D04 runs the closed-provider build and stage gate without stale or linked output",
    ],
    [
      "K02-K03:D05-package",
      "K02-D05 gates the exact private packed and clean-installed command artifacts",
    ],
  ],
  "k02-webhook-admission.test.js": [
    ["K02-K03:W01", "K02-W01 enforces exact request-line and header-block byte boundaries"],
    ["K02-K03:W02", "K02-W02 enforces timestamp syntax and exact past and future windows"],
    ["K02-K03:W03", "K02-W03 rejects an exact live signature replay before parsing or dispatch"],
    ["K02-K03:W04", "K02-W04 retains 4096 replay pairs and admits a new pair only after expiry"],
    [
      "K02-K03:W05",
      "K02-W05 accepts exactly 1 MiB and rejects a declared one-over body before reading",
    ],
    ["K02-K03:W06", "K02-W06 verifies HMAC before strict JSON and correlation validation"],
    ["K02-K03:W07", "K02-W07 coalesces both queued and active repeats without duplicate turns"],
    ["K02-K03:W08", "K02-W08 applies non-resetting header and request deadlines to stalls"],
    ["K02-K03:W09", "K02-W09 enforces 32 socket and 16 parsed-request capacity limits"],
    ["K02-K03:W10", "K02-W10 rejects ambiguous framing, buffered surplus, and pipelining"],
    ["K02-K03:W11", "K02-W11 validates method, Host, Origin, media, bearer, and HMAC before body"],
  ],
};

const k02 = [
  ...Object.entries(k02Groups).flatMap(([file, cases]) =>
    cases.map(([, name]) => k02Pass(file, name)),
  ),
  ...pass("k02-loader-boundary.test.js", 0, [
    "K02 support classifies only the exact absent K03 entry as reviewed red",
  ]),
];

const cx02 = [
  ...fail("cx02-cancellation-recovery.test.js", 0, "CX02-CX03:X16", [
    "CX02-X16 interrupts only a bound exact turn and never extends cancellation grace",
  ]),
  ...fail("cx02-cancellation-recovery.test.js", 0, "CX02-CX03:X17", [
    "CX02-X17 recovers only one exact stored turn and makes every ambiguous thread read uncertain",
  ]),
  ...fail("cx02-cancellation-recovery.test.js", 0, "CX02-CX03:X18", [
    "CX02-X18 makes null-turn recovery uncertain before any App Server request",
  ]),
  ...fail("cx02-cancellation-recovery.test.js", 0, "CX02-CX03:X19", [
    "CX02-X19 keeps large unrelated history content memory-only while selecting the exact turn",
  ]),
  ...pass("cx02-fixture-integrity.test.js", 0, [
    "CX02 support pins the exact stable Codex 0.149.0 schema and source notice",
    "CX02 support runs a full-process fake Codex handshake, session, and turn over JSONL stdio",
  ]),
  ...pass("cx02-loader-boundary.test.js", 0, [
    "CX02 support classifies only the exact absent CX03 adapter entry as reviewed red",
  ]),
  ...fail("cx02-loader-boundary.test.js", 0, "CX02-CX03:X26", [
    "CX02-X26 rejects partial adapter modules and reviews only the exact absent entry",
  ]),
  ...fail("cx02-process-e2e.test.js", 0, "CX02-CX03:X24", [
    "CX02-X24 hard owner death closes the attached fake App Server unit",
  ]),
  ...fail("cx02-process-e2e.test.js", 0, "CX02-CX03:X25", [
    "CX02-X25 runs two turns in one thread and two conversations through the foundation",
  ]),
  ...fail("cx02-process-e2e.test.js", 0, "CX02-CX03:X27", [
    "CX02-X27 proves child and descendant teardown before releasing any terminal",
  ]),
  ...fail("cx02-raw-security.test.js", 0, "CX02-CX03:X20", [
    "CX02-X20 enforces UTF-8 JSONL record byte and depth boundaries before normalization",
  ]),
  ...fail("cx02-raw-security.test.js", 0, "CX02-CX03:X21", [
    "CX02-X21 preserves every common exact limit through valid App Server envelopes",
  ]),
  ...fail("cx02-raw-security.test.js", 0, "CX02-CX03:X22", [
    "CX02-X22 never replaces a missing mutated or unavailable stored thread",
  ]),
  ...fail("cx02-raw-security.test.js", 0, "CX02-CX03:X23", [
    "CX02-X23 excludes content auth schemas and test controls from state and staged packages",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X01", [
    "CX02-X01 pins executable identity and rejects every unavailable version preflight",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X02", [
    "CX02-X02 launches one exact direct App Server child with scrubbed sealed settings",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X03", [
    "CX02-X03 keeps the pinned stable schema test-only and out of production package surfaces",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X04", [
    "CX02-X04 enforces the exact initialize ordering and warning opt-out matrix",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X05", [
    "CX02-X05 binds one response-first or notification-first thread before turn input",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X06", [
    "CX02-X06 never writes input before session publication or replays after either crash side",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X07", [
    "CX02-X07 resumes only the stored thread and rejects missing mismatched or broader responses",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X08a", [
    "CX02-X08a sends only exact coarse thread and turn authority under both policies",
  ]),
  ...fail("cx02-startup-handshake.test.js", 0, "CX02-CX03:X08b", [
    "CX02-X08b validates every observable thread response without inventing turn sandbox evidence",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X09", [
    "CX02-X09 preserves adversarial A2A bytes only in one structured text input item",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X10", [
    "CX02-X10 emits one exact turn binding across ordering duplicates mismatches and crashes",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X11", [
    "CX02-X11 treats deltas as progress and the corroborated full terminal snapshot as authoritative",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X12", [
    "CX02-X12 selects one final_answer before phase-null and rejects remaining ambiguities",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X13", [
    "CX02-X13 maps only an exact failed turn definitely and every executed unknown to uncertainty",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X14", [
    "CX02-X14 normalizes only three supported approval requests and sends no response or grant",
  ]),
  ...fail("cx02-turn-events.test.js", 0, "CX02-CX03:X15", [
    "CX02-X15 never invents approval resolution and rejects every unsupported server control",
  ]),
].map((entry) => ({ ...entry, status: "pass" }));

function cl02Failure(file, id, name) {
  return fail(file, 0, `CL02-CL03:${id}`, [name]);
}

const cl02 = [
  ...pass("cl02-fixture-integrity.test.js", 0, [
    "CL02 support runs the fake Claude version and stream-JSON turn without real credentials",
    "CL02 support runs the six-pipe detached monitor and same-group fake Claude topology",
  ]),
  ...pass("cl02-loader-boundary.test.js", 0, [
    "CL02 support classifies only the exact absent CL03 adapter entry as reviewed red",
  ]),
  ...cl02Failure(
    "cl02-loader-boundary.test.js",
    "L23",
    "CL02-L23 rejects partial adapter and monitor modules at the strict production loader",
  ),
  ...cl02Failure(
    "cl02-monitor-containment.test.js",
    "L24",
    "CL02-L24 rejects every malformed command lifecycle overflow and forged group claim",
  ),
  ...cl02Failure(
    "cl02-monitor-containment.test.js",
    "L25",
    "CL02-L25 prompt EOF then owner death seals the monitor Claude and descendant group",
  ),
  ...cl02Failure(
    "cl02-monitor-containment.test.js",
    "L26",
    "CL02-L26 owner death after terminal output discards the candidate and seals descendants",
  ),
  ...cl02Failure(
    "cl02-monitor-containment.test.js",
    "L27",
    "CL02-L27 orders PGID ready start lifecycle sealing reap and connector emptiness proof",
  ),
  ...cl02Failure(
    "cl02-process-lifecycle.test.js",
    "L15",
    "CL02-L15 owner EOF seals the known group across every startup and execution barrier",
  ),
  ...cl02Failure(
    "cl02-process-lifecycle.test.js",
    "L16",
    "CL02-L16 recovery starts no Claude or monitor and always returns uncertainty",
  ),
  ...cl02Failure(
    "cl02-process-lifecycle.test.js",
    "L17",
    "CL02-L17 interrupt signals only the known monitor group and never claims safe cancellation",
  ),
  ...cl02Failure(
    "cl02-process-lifecycle.test.js",
    "L18",
    "CL02-L18 seals and proves the full group before every terminal provider event",
  ),
  ...cl02Failure(
    "cl02-process-lifecycle.test.js",
    "L19",
    "CL02-L19 invalidates a terminal candidate on every late provider or monitor conflict",
  ),
  ...cl02Failure(
    "cl02-security-integration.test.js",
    "L20",
    "CL02-L20 excludes content credentials history and fake controls from runtime and package artifacts",
  ),
  ...cl02Failure(
    "cl02-security-integration.test.js",
    "L21",
    "CL02-L21 never opens mutates repairs or deletes provider-owned Claude history",
  ),
  ...cl02Failure(
    "cl02-security-integration.test.js",
    "L22",
    "CL02-L22 preserves one resumed session and concurrent conversations through the K04 chain",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L01",
    "CL02-L01 pins the monitored executable identity and exact 2.1.251 version",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L02",
    "CL02-L02 launches the exact detached monitor and same-group Claude child",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L03",
    "CL02-L03 accepts only one exact init before provider input",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L04",
    "CL02-L04 leaves stdin empty until the durable session-bound pull barrier",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L05",
    "CL02-L05 resumes only the exact stored session and never starts a replacement",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L06",
    "CL02-L06 places adversarial A2A bytes only in one structured stdin text block",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L07",
    "CL02-L07 requires one byte-exact replay and derives no recovery handle from it",
  ),
  ...cl02Failure(
    "cl02-startup-session.test.js",
    "L08",
    "CL02-L08 fixes restricted safe dontAsk tool ceilings for both connector policies",
  ),
  ...cl02Failure(
    "cl02-stream-contract.test.js",
    "L09",
    "CL02-L09 denies permission and rejects every approval or unsupported control record",
  ),
  ...cl02Failure(
    "cl02-stream-contract.test.js",
    "L10",
    "CL02-L10 keeps supported assistant tool retry and status content transient",
  ),
  ...cl02Failure(
    "cl02-stream-contract.test.js",
    "L11",
    "CL02-L11 normalizes only one exact terminal result",
  ),
  ...cl02Failure(
    "cl02-stream-contract.test.js",
    "L12",
    "CL02-L12 separates definite pre-input failure from every post-input unknown",
  ),
  ...cl02Failure(
    "cl02-stream-contract.test.js",
    "L13",
    "CL02-L13 enforces raw UTF-8 JSONL record and depth boundaries",
  ),
  ...cl02Failure(
    "cl02-stream-contract.test.js",
    "L14",
    "CL02-L14 preserves the common ID event output reply and deadline limits",
  ),
].map((entry) => ({ ...entry, status: "pass" }));

export const reviewedRedInventory = {
  k02,
  cx02,
  cl02,
};
