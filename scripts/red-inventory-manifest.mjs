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

const reviewedT03 = [
  ...fail(
    "t03-artifact-lifecycle.test.js",
    0,
    "d888ad889009cd267c36fd65633c6dd275b1af5f3d85a57712c2b785ac833ef6",
    [
      "T03-A01 verbose enrollment and reissue redact actual proof, nonce, token, key, code, and idempotency markers",
    ],
  ),
  ...fail(
    "t03-dpop-transport-negatives.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    [
      "T03-P01 MCP initialize, catalog, reconnect, call cancellation, and close each use fresh DPoP",
    ],
  ),
  ...fail(
    "t03-dpop-transport-negatives.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    ["T03-P02 protected proof rejection never triggers refresh, reissue, or bearer fallback"],
  ),
  ...pass("t03-issuance-negatives.test.js", 1, [
    "verification code rejected",
    "well-formed second challenge",
    "missing nonce",
    "malformed nonce",
    "duplicate nonce",
    "challenge wrong status",
    "challenge wrong body",
    "challenge wrong media type",
    "challenge missing no-store",
    "missing no-store precedes wrong media type",
    "missing no-store precedes malformed JSON",
    "invalid proof",
    "invalid proof missing no-store",
    "wrong token type",
    "wrong expires-in",
    "wrong subject",
    "wrong issuer",
    "reordered audience",
    "missing confirmation",
    "wrong thumbprint",
    "wrong token lifetime",
    "malformed JWT",
    "duplicate token member",
    "case-colliding token member",
    "verification set-cookie header",
    "nested credential-shaped data",
    "token bytes reflected outside token field",
    "raw token 4097",
    "smallest canonical token over limit",
    "success missing no-store",
  ]),
  ...pass("t03-issuance-negatives.test.js", 0, [
    "T03-N01 verification nonce and proof failures use fixed precedence and retry bounds",
    "T03-N02 invalid verification credentials are rejected before persistence",
    "T03-N03 verification accepts an exact 4096-byte bound token without exposing it",
  ]),
  ...fail(
    "t03-publication-crash.test.js",
    0,
    "c57135c5a2095ca9c63d8eb5e5cfc3832644f80445f2982cb891afb976a3fbf6",
    [
      "T03-C01 a full-process crash during pre-response uncertainty retains the old credential",
      "T03-C02 a full-process crash after publication reloads one complete replacement",
    ],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    [
      "T03-U01 lost reissue response retries with one idempotency key and fresh proofs",
      "T03-U02 reissue persistence failure retains and continues with the old credential",
    ],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    ["T03-U03 an expired credential disables protected work without network refresh"],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    0,
    "792a8962915c35c9ead3503dfa35d5260a6f076dac9546ab97d1b50821e7b0c3",
    ["T03-U04 invalid-token responses never trigger reissue, replacement, or bearer fallback"],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    0,
    "d888ad889009cd267c36fd65633c6dd275b1af5f3d85a57712c2b785ac833ef6",
    ["T03-U05 real encrypted credential reissue replaces envelope v2 and survives restart"],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    1,
    "c6db406694051321561e613f194d5b33a95f4682b0ecffb9ee917d1e8e3be0c6",
    [
      "issuer changed",
      "subject changed",
      "ordered audience changed",
      "key thumbprint changed",
      "token signing algorithm changed",
      "lifetime changed",
      "token identifier reused",
      "expiry did not advance",
    ],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    0,
    "8dd57dc6cc0841b01691f37eaa7db75be5d54fca8a309288382502598c067296",
    ["T03-U06 reissue rejects every identity, key, algorithm, and lifetime change"],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    1,
    "18da142276dd1bc964a07e8f96328e47753839c7f591d796f2ff211ea369f35b",
    [
      "missing no-store",
      "wrong token type",
      "wrong declared lifetime",
      "duplicate token member",
      "extra top-level member",
      "token bytes outside selected field",
      "wrong media type",
    ],
  ),
  ...fail(
    "t03-reissue-lifecycle.test.js",
    0,
    "f516800e18cc10ff8ce9e6e9bf5139fec34e9c3e5eb4388ba7bd1ddaa2c59b58",
    ["T03-U07 reissue applies strict interception and response-shape rules"],
  ),
  ...pass("t03-rest-boundaries.test.js", 1, [
    "short email",
    "long email",
    "email whitespace",
    "short username",
    "long username",
    "empty display name",
    "long display name",
    "unknown registration field",
    "short code",
    "long code",
    "non-ASCII code",
    "unknown verification field",
    "unknown resend field",
    "registration conflict",
    "reviewed invalid request",
    "rate limit",
    "internal error",
    "temporary failure",
    "selected route not found",
    "redirect",
    "bodyless redirect",
    "HTML redirect",
    "connection loss after dispatch",
    "16 container levels",
    "128 total object members",
    "128 total array elements",
    "unexpected success status",
    "wrong media type",
    "content encoding",
    "duplicate JSON key",
    "invalid UTF-8",
    "invalid JSON",
    "17 container levels",
    "129 total object members",
    "129 total array elements",
    "body over limit",
    "header over limit",
    "malformed error pair",
    "credential field in registration",
    "registration set-cookie headers",
  ]),
  ...pass("t03-rest-boundaries.test.js", 0, [
    "T03-B01 registration sends one exact bounded REST projection",
    "T03-B02 invalid bootstrap inputs stop before central dispatch",
    "T03-B02a exact maximum bootstrap input fields remain accepted",
    "T03-B03 reviewed bootstrap errors and unsafe outcomes never fall back or retry",
    "T03-B04a an exact 64 KiB valid bootstrap body remains accepted",
    "T03-B04b exact parser depth, member, and element limits remain accepted",
    "T03-B04 malformed and over-limit bootstrap responses fail closed",
    "T03-B05 gateway shutdown cancels one in-flight bootstrap request without retry",
    "T03-B06 a lost verification response is uncertain and is never repeated",
    "T03-B07 resend preserves the reviewed rate-limit projection without retry",
    "T03-B08 a lost resend response is uncertain and is never repeated",
  ]),
  ...pass("t03-rest-dpop-gateway.test.js", 0, [
    "T03-R01 full process owns the bootstrap catalog while central MCP is unavailable",
    "T03-R02 bootstrap schemas are gateway-owned, exact, and bounded",
    "T03-R03 registration uses the fixed REST route without MCP or route fallback",
    "T03-R04 resend uses REST and returns the generic token-free projection",
    "T03-R05 verification completes the nonce challenge and saves one bound version 2 record",
    "T03-R06 persistence failure leaves the gateway unenrolled after valid issuance",
  ]),
  ...fail(
    "t03-rest-dpop-gateway.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    ["T03-R07 restart loads the bound key and uses fresh DPoP on repeated central MCP calls"],
  ),
  ...pass("t03-security-lifecycle.test.js", 0, [
    "T03-S01 enrollment uses fresh bound P-256 proofs and persists one JSON credential",
  ]),
  ...pass("t03-security-lifecycle.test.js", 1, [
    "invalid JSON",
    "duplicate credential field",
    "missing credential version",
    "wrong credential version",
    "wrong credential token type",
    "unknown field",
    "unsupported DPoP algorithm",
    "token and key mismatch",
    "malformed token",
    "invalid private-key base64url",
    "malformed private-key DER",
    "non-P-256 private key",
    "missing token confirmation",
    "malformed token thumbprint",
  ]),
  ...pass("t03-security-lifecycle.test.js", 0, [
    "T03-S02 malformed fresh-install version 2 records fail before central dispatch",
  ]),
  ...fail(
    "t03-security-lifecycle.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    ["T03-S03 protected REST and MCP use fresh token-free DPoP transport requests"],
  ),
  ...fail(
    "t03-security-lifecycle.test.js",
    0,
    "6739dfd709f013a0ebf6de461d5dcabb259b715110d1d1a3d0e64d7e4be74e27",
    ["T03-S04 scheduled same-key reissue keeps one idempotency key and atomically replaces JSON"],
  ),
  ...pass("t03-security-lifecycle.test.js", 0, [
    "T03-S05 normal artifacts and captures exclude actual enrollment and DPoP markers",
  ]),
  ...fail(
    "t03-size-boundaries.test.js",
    1,
    "25fb9bf5bf0983d07cca779217e38e38232dec74511dd99385bab0cfd404b031",
    ["token 4096", "private key 1024", "plaintext 8192"],
  ),
  ...pass("t03-size-boundaries.test.js", 1, [
    "token 4097",
    "smallest canonical token over limit",
    "private key 1025",
    "smallest valid private key over limit",
    "plaintext 8193",
  ]),
  ...fail(
    "t03-size-boundaries.test.js",
    0,
    "42fda1c3fcfbd127de5bb8e9da9e41a72f9e6405c0b443f221d344b184fd11a6",
    ["T03-L01 exact credential token, key, and plaintext boundaries are enforced"],
  ),
];

const t03 = reviewedT03.map((entry) => ({ ...entry, status: "pass", boundary: undefined }));

const t04FailureSignatures = new Map([
  [
    "T04-X-start-commit kills the gateway after central commit and recovers once",
    "89f63ccaedfd1595bafdb1cae4e63590c63209347423da62b683a668b311f23a",
  ],
  [
    "T04-X-receive-commit kills the gateway after central commit and recovers once",
    "96312a6499d4b5b458e382764d47bafdc4836f03a16c10e2baf5b436d7a25ade",
  ],
  [
    "T04-X-reply-commit kills the gateway after central commit and recovers once",
    "4971dfe59133b117a2b1d052c961aca62c2f134e524c9d8cb4ab9ce2b71e09c5",
  ],
  [
    "T04-X-complete-commit kills the gateway after central commit and recovers once",
    "142778472305213c8a9565592ac9c934591fa628d90065c4150e617ce6bcfb22",
  ],
  [
    "T04-X-ack-commit kills the gateway after central commit and recovers once",
    "efd2844d5955565474bdfe1f298a52401708d34143495357bad912b7308e7ec2",
  ],
  [
    "T04-P01 uses REST enrollment, DPoP transport, and activation before receive",
    "d2d5a7886007782d681400c6ba6266756d7063d4f1db6b913f1edfae72028a32",
  ],
  [
    "T04-C01 makes conversation start idempotent and lookup sender-owned",
    "84d7b6e2163cae1abfbf6f868bc99361708d562f780030af0bc88ff942dd4cd2",
  ],
  [
    "T04-D01 redelivers one immutable leased message after gateway restart",
    "48162dafe212605b1690a200dabf5977792ff7a8c3e0489c8119f5deb339bbdf",
  ],
  [
    "T04-R01 derives reply routing and provider projection from the inbound IDs",
    "60cfaa0013947180e31374d318a963e8b36494b9508a49fa4d71de42f30940fd",
  ],
  [
    "T04-O01 records every terminal no-reply and failure completion idempotently",
    "e08fd7d3990e24fc8856c6f61a5ca92bf052632944520f78282f9d25dc67d3c2",
  ],
  [
    "T04-O02 lets the original sender observe a terminal no-reply outcome",
    "1287e05e27633da4d200457e2cd4b7bf5effa3db0e2311e417503b54889db93b",
  ],
  [
    "T04-R02 resolves a lost reply response without creating a second turn",
    "e063e9c6cbdd2c4fc7541e0e58b24d5132c0f7e1a32d32b569279f9387382873",
  ],
  [
    "T04-A01 repeats acknowledgement after a lost committed response",
    "36bec0821b52e9c90d4d873736008ce7b351768af2d92e6717d110f23bd0e720",
  ],
  [
    "T04-E01 does not reflect authorization, non-enumeration, or rate-limit inputs",
    "6a2e8e1d1d53c435809d47e795c4cd5114fcfb4c3d90f1b185d4c386b36e55e9",
  ],
  [
    "T04-B01 bounds concurrent local work and cancels a wait during shutdown",
    "0b55625f5d37ed00a57df1ede4d0c4f5ca008b93a63cb4e03f74e1a9e16f6c41",
  ],
  [
    "T04-S01 leaves artifacts and normal transcripts free of conversation content",
    "e2a792f07c4cfa333402dd917de31c8ce2437b285d5c4ba78f52969be52a43a2",
  ],
  [
    "T04-X-startup recovers an idempotent operation after a full-process crash",
    "389a4fc22e95fc0b6373c26914ed05ad1282daf35ab62627b053fe842f16345d",
  ],
  [
    "T04-X-readiness recovers an idempotent operation after a full-process crash",
    "c897b6892698cb9157db21e4538ffe90ad175ffb5b24146179fcae39b338cc1f",
  ],
  [
    "T04-X-operation recovers an idempotent operation after a full-process crash",
    "aa12c2fdc1bb0b8e332b112a58fa61537b802ceb490b35e3addb341f8d4be59d",
  ],
  [
    "T04-X-commit recovers an idempotent operation after a full-process crash",
    "0f3f1793c4c3030eb7fb5f2af465fd313373db2fd17cca4c117280a3506fa9de",
  ],
  [
    "T04-X-response recovers an idempotent operation after a full-process crash",
    "0264b808f3ce93a6dcf25781d8c13d86296438b706caa72eee4fc70e5e761c1d",
  ],
  [
    "T04-X-teardown recovers an idempotent operation after a full-process crash",
    "587f6ef1fcc56ccbfa6b2495422580a59b1deb1f6b561885354cdf4735ddf9af",
  ],
  [
    "T04-M02-unknown rejects an invalid receive result before journal or inbox admission",
    "87ea13e4f9e6bbfdb6723a696a27df3450236a4da38148e9ad29333c5cc264e5",
  ],
  [
    "T04-M02-duplicate rejects an invalid receive result before journal or inbox admission",
    "3ce8a1520b17dc5d8292f6decd7aacdf23e64e510e5bfa36daf8c101d3298b83",
  ],
  [
    "T04-M02-duplicate-key rejects an invalid receive result before journal or inbox admission",
    "4db3d38d290d32377cc34150726e9bd97f70e73928af1088b0117f821f677901",
  ],
  [
    "T04-M02-oversized-text rejects an invalid receive result before journal or inbox admission",
    "97d86b70352a17366b6c1c02b0dc7f072ec6b10ac03cce2d50c3fbacf77f3445",
  ],
  [
    "T04-M02-one-over-batch rejects an invalid receive result before journal or inbox admission",
    "b3eb5bca35f7c3786e558ab234bb6bad01d5939f2a7488747cde931c04ea576e",
  ],
  [
    "T04-M02-http-oversized rejects an invalid receive result before journal or inbox admission",
    "055b824e2080df03f70514e21cf875f6089c113a86173f032d50853f78503a57",
  ],
  [
    "T04-D07 accepts an exact 524288-byte batch without reordering",
    "3666802a0245c0f74125ac5a498ea0b406ddf40ebf6cafdb80aa78e944eb7e1d",
  ],
  [
    "T04-D06 keeps one central receive active while local polls stay local",
    "92a3e47214098e0d0fc8b8e258a63d159b4bc83ee05ebebe88b4f14017e95f5f",
  ],
  [
    "T04-V05 uses the fixed REST receive route without central MCP fallback",
    "bf55fcd3e4d8db7adf1c12208d2fe72b6340637deefd0ea376b0b3284cc2edeb",
  ],
  [
    "T04-V01 repeats fresh-install activation after a lost committed response",
    "b6dbac66cdac3da98b3966d248ebfd9f12f3f699f4827929d64c935d389d9013",
  ],
  [
    "T04-C02 resolves uncertain starts and rejects changed idempotent input",
    "e8232737bd4bea6361a3246d0e292420f123d779db706729e28d21efeafaedf6",
  ],
  [
    "T04-C03 rejects strict start bounds before central application work",
    "a71a48cd17d1915899f9214642a4593c8a5348ae04d30552a071c060e8d38295",
  ],
  [
    "T04-R03 repeats one reply, rejects changed text, and preserves one outbound ID",
    "3be8eb43349f17d34348559efb7c1d0384e81324f73fb2a3bbf55a3691f769e9",
  ],
  [
    "T04-R04 leaves the inbound turn open when the sender mailbox is full",
    "190f18a02af3b51b32857e385188282825f3eaa9432d590ea22dcc89f57ea332",
  ],
  [
    "T04-O03 makes a reply-completion race choose one terminal result",
    "a6958f576d6754e96969b46037f8b8cdb1866453a8e9172d6df7a0c3212acc74",
  ],
  [
    "T04-A02 rejects acknowledgement before terminal state and deletes only after exact ack",
    "239cb24f7e5d417c726a637be1c10aea304b5b0cacf388c180eb6eb3f3db01c8",
  ],
  [
    "T04-V05 uses the fixed start route and rejects redirects without reflection",
    "e3618f9e7c700707f1fe3109a0418209aa0ed2b54c32687eee0e53765277ef28",
  ],
  [
    "T04-E02 keeps DPoP challenges distinct from nested application errors",
    "0dc71809d4f5de5b6b3b07dac1fbbe42c37bae0d060a1850aa828963a592ebe7",
  ],
]);

function t04Failure(file, name) {
  const boundary = t04FailureSignatures.get(name);
  if (boundary === undefined) throw new Error(`missing reviewed T04 boundary for ${name}`);
  return { file, nesting: 0, status: "fail", skip: false, todo: false, boundary, name };
}

const reviewedT04 = [
  ...[
    "T04-X-start-commit kills the gateway after central commit and recovers once",
    "T04-X-receive-commit kills the gateway after central commit and recovers once",
    "T04-X-reply-commit kills the gateway after central commit and recovers once",
    "T04-X-complete-commit kills the gateway after central commit and recovers once",
    "T04-X-ack-commit kills the gateway after central commit and recovers once",
  ].map((name) => t04Failure("t04-commit-recovery.test.js", name)),
  ...[
    "T04-P01 uses REST enrollment, DPoP transport, and activation before receive",
    "T04-C01 makes conversation start idempotent and lookup sender-owned",
    "T04-D01 redelivers one immutable leased message after gateway restart",
    "T04-R01 derives reply routing and provider projection from the inbound IDs",
    "T04-O01 records every terminal no-reply and failure completion idempotently",
    "T04-O02 lets the original sender observe a terminal no-reply outcome",
    "T04-R02 resolves a lost reply response without creating a second turn",
    "T04-A01 repeats acknowledgement after a lost committed response",
    "T04-E01 does not reflect authorization, non-enumeration, or rate-limit inputs",
    "T04-B01 bounds concurrent local work and cancels a wait during shutdown",
    "T04-S01 leaves artifacts and normal transcripts free of conversation content",
  ].map((name) => t04Failure("t04-conversation-recovery.test.js", name)),
  ...[
    "T04-X-startup recovers an idempotent operation after a full-process crash",
    "T04-X-readiness recovers an idempotent operation after a full-process crash",
    "T04-X-operation recovers an idempotent operation after a full-process crash",
    "T04-X-commit recovers an idempotent operation after a full-process crash",
    "T04-X-response recovers an idempotent operation after a full-process crash",
    "T04-X-teardown recovers an idempotent operation after a full-process crash",
  ].map((name) => t04Failure("t04-crash-barriers.test.js", name)),
  ...[
    "T04-M02-unknown rejects an invalid receive result before journal or inbox admission",
    "T04-M02-duplicate rejects an invalid receive result before journal or inbox admission",
    "T04-M02-duplicate-key rejects an invalid receive result before journal or inbox admission",
    "T04-M02-oversized-text rejects an invalid receive result before journal or inbox admission",
    "T04-M02-one-over-batch rejects an invalid receive result before journal or inbox admission",
    "T04-M02-http-oversized rejects an invalid receive result before journal or inbox admission",
    "T04-D07 accepts an exact 524288-byte batch without reordering",
    "T04-D06 keeps one central receive active while local polls stay local",
    "T04-V05 uses the fixed REST receive route without central MCP fallback",
  ].map((name) => t04Failure("t04-inbound-boundaries.test.js", name)),
  ...[
    "T04-V01 repeats fresh-install activation after a lost committed response",
    "T04-C02 resolves uncertain starts and rejects changed idempotent input",
    "T04-C03 rejects strict start bounds before central application work",
    "T04-R03 repeats one reply, rejects changed text, and preserves one outbound ID",
    "T04-R04 leaves the inbound turn open when the sender mailbox is full",
    "T04-O03 makes a reply-completion race choose one terminal result",
    "T04-A02 rejects acknowledgement before terminal state and deletes only after exact ack",
  ].map((name) => t04Failure("t04-lifecycle-contract.test.js", name)),
  t04Failure(
    "t04-outbound-boundaries.test.js",
    "T04-V05 uses the fixed start route and rejects redirects without reflection",
  ),
  t04Failure(
    "t04-outbound-boundaries.test.js",
    "T04-E02 keeps DPoP challenges distinct from nested application errors",
  ),
  ...pass("t04-response-observer.test.js", 0, [
    "T04 support holds a completed upstream response until explicit release",
  ]),
];

const t04 = reviewedT04.map((entry) => ({ ...entry, status: "pass", boundary: undefined }));

const packagedDocker = [
  {
    file: "c01-packaged-docker-v2.test.js",
    nesting: 0,
    status: "fail",
    skip: false,
    todo: false,
    boundary: "C01-D01:rest-registration",
    name: "C01-D01 packaged gateway completes fresh-install v2 through the independent Docker fixture",
  },
];

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

export const reviewedRedInventory = { t03, t04, k02, cx02, "packaged-docker": packagedDocker };
