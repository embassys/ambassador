import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, scryptSync } from "node:crypto";
import { chmod, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  K02_TOKEN,
  k02Message,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

function openState(stateDirectory: string): Database.Database {
  return new Database(join(stateDirectory, "correlation.sqlite3"));
}

function normalizedSql(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function sqlDigest(value: string): string {
  return createHash("sha256").update(normalizedSql(value)).digest("hex");
}

function stateFrame(domain: number, parts: readonly Buffer[]): Buffer {
  const prefix = Buffer.from("A2A-CONNECTOR-STATE\0", "ascii");
  const fields = parts.map((part) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.byteLength);
    return Buffer.concat([length, part]);
  });
  return Buffer.concat([prefix, Buffer.from([1, domain]), ...fields]);
}

function stateHmac(key: Buffer, domain: number, parts: readonly Buffer[]): Buffer {
  return createHmac("sha256", key).update(stateFrame(domain, parts)).digest();
}

function decryptState(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

const CORRELATION_DDL_DIGESTS = {
  conversations: "8aa9a6dd0a3d5910afe3832070ed62a4d18cf72293221f5c89ae05972eaac785",
  messages: "8580992310743c9a038374b0fac6643b3a0dd5194707964455ea844d1a9205be",
  messages_due_retry: "e7c10ca79cf1d62fd6a7580fae2b9a215fcd815df458a4ea59fdddcb90f0c4c0",
  one_message_per_conversation: "fc33bb56fc8af6f13ad487cfa23eca8c718b227cf24a94bf0686444636a67c72",
  store_meta: "f5d920151ac99347def5e2c959484297809d28318dc041b5e669c3ccb593ad24",
} as const;

async function establishMapping(
  t: Parameters<typeof startK02Scenario>[0],
  caseId: string,
  suffix: string,
) {
  const scenario = await startK02Scenario(t, caseId, {
    scripts: [
      [
        { kind: "session", provider_session_id: `session_${suffix}` },
        { kind: "turn", provider_turn_id: `turn_${suffix}` },
        { kind: "reply", text: `reply_${suffix}` },
      ],
    ],
  });
  const message = k02Message(`message_${suffix}`, `conversation_${suffix}`, `prompt_${suffix}`);
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await scenario.connector.waitForIdle();
  return { scenario, message };
}

test("K02-A01 creates the exact strict schema and fixed SQLite settings", async (t) => {
  const { scenario } = await establishMapping(t, "K02-K03:A01", "schema");
  const database = openState(scenario.stateDirectory);
  try {
    assert.equal(database.pragma("application_id", { simple: true }), 0x41324353);
    assert.equal(database.pragma("user_version", { simple: true }), 1);
    assert.equal(database.pragma("page_size", { simple: true }), 4_096);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    const objects = database
      .prepare<[], { name: keyof typeof CORRELATION_DDL_DIGESTS; sql: string; type: string }>(
        "SELECT name, sql, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    assert.deepEqual(
      objects.map(({ name, type }) => ({ name, type })),
      [
        { name: "conversations", type: "table" },
        { name: "messages", type: "table" },
        { name: "messages_due_retry", type: "index" },
        { name: "one_message_per_conversation", type: "index" },
        { name: "store_meta", type: "table" },
      ],
    );
    for (const object of objects) {
      assert.equal(sqlDigest(object.sql), CORRELATION_DDL_DIGESTS[object.name]);
    }
    assert.deepEqual(
      (database.pragma("table_xinfo(store_meta)") as { name: string }[]).map(
        (column) => column.name,
      ),
      ["singleton", "schema_version", "provider_kind", "kdf_salt", "scope_hmac", "created_at_ms"],
    );
    assert.deepEqual(
      (database.pragma("table_xinfo(conversations)") as { name: string }[]).map(
        (column) => column.name,
      ),
      [
        "conversation_hmac",
        "conversation_iv",
        "conversation_ciphertext",
        "conversation_tag",
        "provider_session_hmac",
        "provider_session_iv",
        "provider_session_ciphertext",
        "provider_session_tag",
        "lifecycle",
        "created_at_ms",
        "updated_at_ms",
      ],
    );
    assert.deepEqual(
      (database.pragma("table_xinfo(messages)") as { name: string }[]).map((column) => column.name),
      [
        "message_hmac",
        "message_iv",
        "message_ciphertext",
        "message_tag",
        "conversation_hmac",
        "provider_turn_hmac",
        "provider_turn_iv",
        "provider_turn_ciphertext",
        "provider_turn_tag",
        "lifecycle",
        "blocked_class",
        "terminal_operation",
        "completion_outcome",
        "completion_reason",
        "retry_kind",
        "retry_not_before_ms",
        "retry_attempt_count",
        "turn_started_at_ms",
        "turn_deadline_ms",
        "created_at_ms",
        "updated_at_ms",
      ],
    );
    assert.deepEqual(database.pragma("foreign_key_list(messages)"), [
      {
        id: 0,
        seq: 0,
        table: "conversations",
        from: "conversation_hmac",
        to: "conversation_hmac",
        on_update: "RESTRICT",
        on_delete: "RESTRICT",
        match: "NONE",
      },
    ]);
    const metaRows = database
      .prepare<[], Record<string, unknown>>("SELECT * FROM store_meta")
      .all();
    assert.equal(metaRows.length, 1);
    const meta = metaRows[0];
    assert.ok(meta !== undefined);
    assert.deepEqual(
      {
        singleton: meta.singleton,
        schema_version: meta.schema_version,
        provider_kind: meta.provider_kind,
        kdf_salt: (meta.kdf_salt as Buffer).byteLength,
        scope_hmac: (meta.scope_hmac as Buffer).byteLength,
      },
      { singleton: 1, schema_version: 1, provider_kind: "codex", kdf_salt: 16, scope_hmac: 32 },
    );
    assert.ok(
      Number.isSafeInteger(meta.created_at_ms) &&
        (meta.created_at_ms as number) >= 0 &&
        (meta.created_at_ms as number) <= 253_402_300_799_999,
    );
  } finally {
    database.close();
  }

  const inspection = scenario.module.inspectConnectorStateForTest(scenario.stateDirectory);
  assert.deepEqual(inspection.correlationPragmas, {
    application_id: 0x41324353,
    user_version: 1,
    page_size: 4_096,
    journal_mode: "wal",
    synchronous: 2,
    foreign_keys: 1,
    trusted_schema: 0,
    temp_store: 2,
    busy_timeout: 1_000,
    wal_autocheckpoint: 256,
    journal_size_limit: 4_194_304,
    max_page_count: 65_536,
  });
  assert.deepEqual(inspection.ownerPragmas, {
    application_id: 0x4132434f,
    user_version: 1,
    page_size: 4_096,
    journal_mode: "delete",
    synchronous: 2,
    trusted_schema: 0,
    temp_store: 2,
    busy_timeout: 1_000,
    max_page_count: 64,
    journal_size_limit: 65_536,
  });
  assert.equal(
    inspection.ownerSchemaSha256,
    "4716592838eb52969c40af85fcd9c574e1cfa105260fc6fb5e5cb7b71d4b208f",
  );
  assert.deepEqual(inspection.ownerGuard, { singleton: 1, ever_initialized: 1 });
});

test("K02-A02 derives full HMAC indexes and authenticates every AES-256-GCM envelope", async (t) => {
  const conversationId = "a02_conversation";
  const messageId = "a02_message";
  const sessionId = "a02_session";
  const turnId = "a02_turn";
  const scenario = await startK02Scenario(t, "K02-K03:A02", {
    crashAfter: "turn_published",
    scripts: [
      [
        { kind: "session", provider_session_id: sessionId },
        { kind: "turn", provider_turn_id: turnId },
        { kind: "reply", text: "not reached" },
      ],
    ],
  });
  const message = k02Message(messageId, conversationId);
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_test_crash/u);
  await scenario.connector.crash();
  const database = openState(scenario.stateDirectory);
  try {
    const meta = database
      .prepare<[], { kdf_salt: Buffer; scope_hmac: Buffer }>(
        "SELECT kdf_salt, scope_hmac FROM store_meta",
      )
      .get();
    const row = database
      .prepare<
        [],
        {
          conversation_hmac: Buffer;
          conversation_iv: Buffer;
          conversation_ciphertext: Buffer;
          conversation_tag: Buffer;
          provider_session_hmac: Buffer;
          provider_session_iv: Buffer;
          provider_session_ciphertext: Buffer;
          provider_session_tag: Buffer;
          message_hmac: Buffer;
          message_iv: Buffer;
          message_ciphertext: Buffer;
          message_tag: Buffer;
          provider_turn_hmac: Buffer;
          provider_turn_iv: Buffer;
          provider_turn_ciphertext: Buffer;
          provider_turn_tag: Buffer;
        }
      >(
        "SELECT c.conversation_hmac, c.conversation_iv, c.conversation_ciphertext, c.conversation_tag, c.provider_session_hmac, c.provider_session_iv, c.provider_session_ciphertext, c.provider_session_tag, m.message_hmac, m.message_iv, m.message_ciphertext, m.message_tag, m.provider_turn_hmac, m.provider_turn_iv, m.provider_turn_ciphertext, m.provider_turn_tag FROM conversations c JOIN messages m USING(conversation_hmac)",
      )
      .get();
    assert.ok(meta !== undefined && row !== undefined);
    const derived = scryptSync(Buffer.from(K02_TOKEN, "hex"), meta.kdf_salt, 64, {
      N: 131_072,
      r: 8,
      p: 1,
      maxmem: 268_435_456,
    });
    const aesKey = derived.subarray(0, 32);
    const hmacKey = derived.subarray(32, 64);
    const provider = Buffer.from("codex", "ascii");
    const directory = Buffer.from(await realpath(scenario.workingDirectory), "utf8");
    const conversation = Buffer.from(conversationId, "ascii");
    const messageBytes = Buffer.from(messageId, "ascii");
    const session = Buffer.from(sessionId, "utf8");
    const turn = Buffer.from(turnId, "utf8");
    const conversationHmac = stateHmac(hmacKey, 0x02, [conversation]);
    const messageHmac = stateHmac(hmacKey, 0x03, [messageBytes]);
    const sessionHmac = stateHmac(hmacKey, 0x04, [session]);
    const turnHmac = stateHmac(hmacKey, 0x05, [session, turn]);
    assert.deepEqual(meta.scope_hmac, stateHmac(hmacKey, 0x01, [provider, directory]));
    assert.deepEqual(row.conversation_hmac, conversationHmac);
    assert.deepEqual(row.message_hmac, messageHmac);
    assert.deepEqual(row.provider_session_hmac, sessionHmac);
    assert.deepEqual(row.provider_turn_hmac, turnHmac);
    assert.deepEqual(
      decryptState(
        aesKey,
        row.conversation_iv,
        row.conversation_ciphertext,
        row.conversation_tag,
        stateFrame(0x11, [provider, directory, conversationHmac]),
      ),
      conversation,
    );
    assert.deepEqual(
      decryptState(
        aesKey,
        row.message_iv,
        row.message_ciphertext,
        row.message_tag,
        stateFrame(0x12, [provider, directory, conversationHmac, messageHmac]),
      ),
      messageBytes,
    );
    assert.deepEqual(
      decryptState(
        aesKey,
        row.provider_session_iv,
        row.provider_session_ciphertext,
        row.provider_session_tag,
        stateFrame(0x13, [provider, directory, conversationHmac, sessionHmac]),
      ),
      session,
    );
    assert.deepEqual(
      decryptState(
        aesKey,
        row.provider_turn_iv,
        row.provider_turn_ciphertext,
        row.provider_turn_tag,
        stateFrame(0x14, [
          provider,
          directory,
          conversationHmac,
          messageHmac,
          sessionHmac,
          turnHmac,
        ]),
      ),
      turn,
    );
    assert.equal(
      new Set([
        row.conversation_iv.toString("hex"),
        row.message_iv.toString("hex"),
        row.provider_session_iv.toString("hex"),
        row.provider_turn_iv.toString("hex"),
      ]).size,
      4,
    );
    derived.fill(0);
  } finally {
    database.close();
  }
});

test("K02-A03 rejects ciphertext transplanted across authenticated AAD parents", async (t) => {
  for (const envelope of ["session", "message", "turn"] as const) {
    const waiting = (suffix: string) =>
      [
        { kind: "session", provider_session_id: `session_aad_${suffix}` },
        { kind: "turn", provider_turn_id: `turn_aad_${suffix}` },
        { kind: "wait_for_cancel" },
      ] as const;
    const scenario = await startK02Scenario(t, "K02-K03:A03", {
      scripts: [waiting(`${envelope}_one`), waiting(`${envelope}_two`)],
    });
    for (const suffix of ["one", "two"]) {
      const message = k02Message(
        `aad_${envelope}_message_${suffix}`,
        `aad_${envelope}_conversation_${suffix}`,
      );
      scenario.enqueue(message);
      assert.equal((await scenario.wake(message.id)).status, 202);
    }
    await waitFor(() => scenario.provider.activeExecutionCount === 2, "two AAD parent rows");
    await scenario.connector.crash();
    const database = openState(scenario.stateDirectory);
    try {
      const rows = database
        .prepare<
          [],
          {
            conversation_hmac: Buffer;
            provider_session_iv: Buffer;
            provider_session_ciphertext: Buffer;
            provider_session_tag: Buffer;
            message_hmac: Buffer;
            message_iv: Buffer;
            message_ciphertext: Buffer;
            message_tag: Buffer;
            provider_turn_iv: Buffer;
            provider_turn_ciphertext: Buffer;
            provider_turn_tag: Buffer;
          }
        >(
          "SELECT c.conversation_hmac, c.provider_session_iv, c.provider_session_ciphertext, c.provider_session_tag, m.message_hmac, m.message_iv, m.message_ciphertext, m.message_tag, m.provider_turn_iv, m.provider_turn_ciphertext, m.provider_turn_tag FROM conversations c JOIN messages m USING(conversation_hmac) ORDER BY c.rowid",
        )
        .all();
      assert.equal(rows.length, 2);
      const first = rows[0];
      const second = rows[1];
      assert.ok(first !== undefined && second !== undefined);
      if (envelope === "session") {
        database
          .prepare(
            "UPDATE conversations SET provider_session_iv=?, provider_session_ciphertext=?, provider_session_tag=? WHERE conversation_hmac=?",
          )
          .run(
            first.provider_session_iv,
            first.provider_session_ciphertext,
            first.provider_session_tag,
            second.conversation_hmac,
          );
      } else if (envelope === "message") {
        database
          .prepare(
            "UPDATE messages SET message_iv=?, message_ciphertext=?, message_tag=? WHERE message_hmac=?",
          )
          .run(first.message_iv, first.message_ciphertext, first.message_tag, second.message_hmac);
      } else {
        database
          .prepare(
            "UPDATE messages SET provider_turn_iv=?, provider_turn_ciphertext=?, provider_turn_tag=? WHERE message_hmac=?",
          )
          .run(
            first.provider_turn_iv,
            first.provider_turn_ciphertext,
            first.provider_turn_tag,
            second.message_hmac,
          );
      }
    } finally {
      database.close();
    }
    await assert.rejects(scenario.restart([]), /connector_state_unavailable/u);
  }
});

test("K02-A04 commits paired message and conversation transitions atomically", async (t) => {
  const scenario = await startK02Scenario(t, "K02-K03:A04", {
    failPairedStateWriteAfter: "conversation_update",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_atomic" },
        { kind: "turn", provider_turn_id: "turn_atomic" },
        { kind: "reply", text: "atomic reply" },
      ],
    ],
  });
  const message = k02Message("atomic_message", "atomic_conversation");
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await assert.rejects(scenario.connector.waitForIdle(), /connector_state_unavailable/u);
  await scenario.connector.close();
  const database = openState(scenario.stateDirectory);
  try {
    const pair = database
      .prepare<[], { conversation: string; message: string }>(
        "SELECT conversations.lifecycle AS conversation, messages.lifecycle AS message FROM conversations JOIN messages USING(conversation_hmac)",
      )
      .get();
    assert.deepEqual(pair, { conversation: "binding", message: "binding" });
  } finally {
    database.close();
  }
});

test("K02-A05 independently rejects ciphertext, GCM-tag, HMAC-index, and schema corruption", async (t) => {
  for (const corruption of ["ciphertext", "tag", "hmac", "schema"] as const) {
    const { scenario } = await establishMapping(t, "K02-K03:A05", `corrupt_${corruption}`);
    await scenario.connector.close();
    const database = openState(scenario.stateDirectory);
    try {
      if (corruption === "schema") {
        database.exec("CREATE TABLE unexpected_schema(value INTEGER) STRICT");
      } else {
        const row = database
          .prepare<[], { provider_session_ciphertext: Buffer }>(
            "SELECT provider_session_ciphertext FROM conversations",
          )
          .get();
        assert.ok(row !== undefined);
        if (corruption === "ciphertext") {
          const bytes = Buffer.from(row.provider_session_ciphertext);
          bytes[0] = (bytes[0] ?? 0) ^ 1;
          database.prepare("UPDATE conversations SET provider_session_ciphertext=?").run(bytes);
        } else if (corruption === "tag") {
          database.exec("UPDATE conversations SET provider_session_tag = zeroblob(16)");
        } else {
          database.exec("UPDATE conversations SET provider_session_hmac = zeroblob(32)");
        }
      }
    } finally {
      database.close();
    }
    await assert.rejects(scenario.restart([]), /connector_state_unavailable/u);
  }
});

test("K02-A06 rejects token, provider, and canonical-directory scope changes", async (t) => {
  const { scenario } = await establishMapping(t, "K02-K03:A06", "scope");
  await scenario.connector.close();
  const otherDirectory = join(scenario.workingDirectory, "other");
  await (await import("node:fs/promises")).mkdir(otherDirectory);
  await assert.rejects(
    scenario.restart([], { webhookToken: "f".repeat(48) }),
    /connector_scope_mismatch/u,
  );
  await assert.rejects(
    scenario.restart([], { workingDirectory: otherDirectory }),
    /connector_scope_mismatch/u,
  );
  await assert.rejects(
    scenario.restart([], { providerKind: "claude" }),
    /connector_scope_mismatch/u,
  );
  assert.equal(K02_TOKEN.length, 48);
});

test("K02-A07 deletes only an acknowledged message and retains the conversation mapping", async (t) => {
  const { scenario, message } = await establishMapping(t, "K02-K03:A07", "retention");
  const database = openState(scenario.stateDirectory);
  try {
    assert.equal(
      database.prepare<[], { count: number }>("SELECT count(*) AS count FROM messages").get()
        ?.count,
      0,
    );
    assert.equal(
      database.prepare<[], { count: number }>("SELECT count(*) AS count FROM conversations").get()
        ?.count,
      1,
    );
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
  } finally {
    database.close();
  }
});

test("K02-A08 fails closed on unexpected artifacts, weak modes, and database damage", async (t) => {
  for (const failure of ["unexpected_artifact", "weak_mode", "database_damage"] as const) {
    const { scenario } = await establishMapping(t, "K02-K03:A08", `filesystem_${failure}`);
    await scenario.connector.close();
    const unexpected = join(scenario.stateDirectory, "unexpected.backup");
    const databasePath = join(scenario.stateDirectory, "correlation.sqlite3");
    if (failure === "unexpected_artifact") {
      await writeFile(unexpected, "content-free but unallowlisted", { mode: 0o600 });
    } else if (failure === "weak_mode") {
      await chmod(databasePath, 0o644);
    } else {
      await writeFile(databasePath, "not a SQLite database");
    }
    await assert.rejects(scenario.restart([]), /connector_state_unavailable/u);
    if (failure === "unexpected_artifact") await unlink(unexpected);
  }
});

test("K02-S01 keeps content, credentials, approvals, and execution options out of artifacts", async (t) => {
  const sentinels = [
    "message_security_sentinel",
    "conversation_security_sentinel",
    "prompt-security-sentinel-44d2",
    "reply-security-sentinel-44d2",
    "session-security-sentinel-44d2",
    "turn-security-sentinel-44d2",
    "approval-security-sentinel-44d2",
    K02_TOKEN,
    "--approval=bypass",
  ];
  const scenario = await startK02Scenario(t, "K02-K03:S01-artifacts", {
    scripts: [
      [
        { kind: "session", provider_session_id: sentinels[4] as string },
        { kind: "turn", provider_turn_id: sentinels[5] as string },
        { kind: "approval_required", approval_request_id: sentinels[6] as string },
        {
          kind: "approval_resolved",
          approval_request_id: sentinels[6] as string,
          decision: "denied",
        },
        { kind: "reply", text: sentinels[3] as string },
      ],
    ],
  });
  const message = k02Message(sentinels[0] as string, sentinels[1] as string, sentinels[2]);
  scenario.enqueue(message);
  assert.equal((await scenario.wake(message.id)).status, 202);
  await scenario.connector.waitForIdle();

  const chunks: Buffer[] = [];
  async function collect(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await stat(path);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) chunks.push(await readFile(path));
    }
  }
  await collect(scenario.rootDirectory);
  const artifacts = Buffer.concat(chunks);
  for (const sentinel of sentinels) {
    assert.ok(!artifacts.includes(Buffer.from(sentinel)), `artifact retained ${sentinel}`);
  }
  assert.ok(!JSON.stringify(scenario.observedSpawns).includes(sentinels[2] as string));
  assert.ok(!JSON.stringify(scenario.observedSpawns).includes(K02_TOKEN));
});
