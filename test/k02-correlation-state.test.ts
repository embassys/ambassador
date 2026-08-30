import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, scryptSync } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { openConnectorState } from "../packages/connector-core/src/state.js";

import {
  K02_TOKEN,
  k02Message,
  ManualK02Clock,
  startK02Scenario,
  waitFor,
} from "./support/connector/k02-production.js";

function openState(stateDirectory: string): Database.Database {
  return new Database(join(stateDirectory, "correlation.sqlite3"));
}

async function holdWalAbove(
  stateDirectory: string,
  minimumBytes: number,
): Promise<{ bytes: number; release(): void }> {
  const path = join(stateDirectory, "correlation.sqlite3");
  const wal = `${path}-wal`;
  const reader = new Database(path, { readonly: true });
  const writer = new Database(path);
  let released = false;
  try {
    reader.pragma("wal_autocheckpoint=0");
    reader.exec("BEGIN");
    reader.prepare("SELECT conversation_hmac FROM conversations ORDER BY rowid LIMIT 1").get();
    writer.pragma("wal_autocheckpoint=0");
    writer.pragma("synchronous=OFF");
    const update = writer.prepare(
      "UPDATE conversations SET updated_at_ms=updated_at_ms+1 WHERE rowid=(SELECT min(rowid) FROM conversations)",
    );
    let bytes = 0;
    for (let writes = 0; bytes <= minimumBytes; writes += 1) {
      assert.ok(writes < 8_192, "failed to grow the real correlation WAL to its boundary");
      update.run();
      if (writes % 32 === 31) bytes = (await stat(wal)).size;
    }
    writer.close();
    return {
      bytes,
      release() {
        if (released) return;
        released = true;
        reader.exec("COMMIT");
        reader.close();
      },
    };
  } catch (error) {
    if (writer.open) writer.close();
    if (reader.open) {
      try {
        reader.exec("ROLLBACK");
      } catch {}
      reader.close();
    }
    throw error;
  }
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };

  await check("4 MiB checkpoint target", async () => {
    const actions: Readonly<Record<string, unknown>>[] = [];
    const target = await startK02Scenario(t, "K02-K03:A01", {
      stateActionObserverForTest: {
        observe(event) {
          actions.push(structuredClone(event));
        },
      },
      scripts: [
        [
          { kind: "session", provider_session_id: "a01_wal_target_session" },
          { kind: "turn", provider_turn_id: "a01_wal_target_turn_1" },
          { kind: "reply", text: "establish WAL target mapping" },
        ],
        [
          { kind: "turn", provider_turn_id: "a01_wal_target_turn_2" },
          { kind: "reply", text: "continue after checkpoint" },
        ],
      ],
    });
    const first = k02Message("a01_wal_target_first", "a01_wal_target_conversation");
    target.enqueue(first);
    assert.equal((await target.wake(first.id)).status, 202);
    await target.connector.waitForIdle();
    const held = await holdWalAbove(target.stateDirectory, 4_194_304);
    held.release();
    actions.length = 0;
    const second = k02Message(
      "a01_wal_target_second",
      first.conversation_id,
      "checkpoint before continuation",
      first.id,
    );
    target.enqueue(second);
    assert.equal((await target.wake(second.id)).status, 202);
    await target.connector.waitForIdle();
    const checkpoint = actions.findIndex(
      (event) => event.kind === "wal_checkpoint" && event.mode === "PASSIVE",
    );
    const externalEffect = actions.findIndex((event) => event.kind === "external_effect");
    assert.ok(checkpoint >= 0, "no PASSIVE checkpoint was observed above the 4 MiB target");
    assert.ok(
      externalEffect > checkpoint,
      "an external effect preceded the required WAL target checkpoint",
    );
  });

  await check("16 MiB hard action boundary", async () => {
    const actions: Readonly<Record<string, unknown>>[] = [];
    const hard = await startK02Scenario(t, "K02-K03:A01", {
      stateActionObserverForTest: {
        observe(event) {
          actions.push(structuredClone(event));
        },
      },
      scripts: [
        [
          { kind: "session", provider_session_id: "a01_wal_hard_session" },
          { kind: "turn", provider_turn_id: "a01_wal_hard_turn_1" },
          { kind: "reply", text: "establish hard WAL mapping" },
        ],
        [
          { kind: "turn", provider_turn_id: "a01_wal_hard_turn_2" },
          { kind: "reply", text: "must not dispatch" },
        ],
      ],
    });
    const first = k02Message("a01_wal_hard_first", "a01_wal_hard_conversation");
    hard.enqueue(first);
    assert.equal((await hard.wake(first.id)).status, 202);
    await hard.connector.waitForIdle();
    const held = await holdWalAbove(hard.stateDirectory, 16_777_216);
    actions.length = 0;
    const providerCalls = hard.provider.requests.length;
    try {
      const second = k02Message(
        "a01_wal_hard_second",
        first.conversation_id,
        "hard boundary continuation",
        first.id,
      );
      hard.enqueue(second);
      const wake = await hard.wake(second.id).catch(() => undefined);
      assert.notEqual(wake?.status, 202, "accepted a wake while the WAL remained above 16 MiB");
      await assert.rejects(hard.connector.waitForIdle(), /connector_state_unavailable/u);
      assert.equal(hard.provider.requests.length, providerCalls);
      const passive = actions.findIndex(
        (event) => event.kind === "wal_checkpoint" && event.mode === "PASSIVE",
      );
      const truncate = actions.findIndex(
        (event) => event.kind === "wal_checkpoint" && event.mode === "TRUNCATE",
      );
      assert.ok(passive >= 0 && truncate > passive, "hard boundary skipped PASSIVE then TRUNCATE");
      assert.equal(
        actions.some((event) => event.kind === "external_effect"),
        false,
      );
    } finally {
      held.release();
      await hard.connector.crash();
    }
  });

  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
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
    await waitFor(() => {
      try {
        const database = openState(scenario.stateDirectory);
        try {
          return (
            database
              .prepare<[], { count: number }>(
                "SELECT count(*) AS count FROM conversations c JOIN messages m USING(conversation_hmac) WHERE c.provider_session_ciphertext IS NOT NULL AND m.provider_turn_ciphertext IS NOT NULL",
              )
              .get()?.count === 2
          );
        } finally {
          database.close();
        }
      } catch {
        return false;
      }
    }, "two durable AAD parent rows");
    assert.equal(scenario.provider.activeExecutionCount, 2);
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
  const strengthenedFailures: string[] = [];
  const check = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      strengthenedFailures.push(`${label}: ${failureText(error)}`);
    }
  };
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

  const pairedFaults = [
    {
      name: "uncertain terminal",
      fault: "uncertain_after_message_update",
      scripts: [
        [
          { kind: "session", provider_session_id: "session_atomic_uncertain" },
          { kind: "turn", provider_turn_id: "turn_atomic_uncertain" },
          { kind: "uncertain" },
        ],
      ],
      oldPair: { conversation: "active", message: "turn_running" },
    },
    {
      name: "completion acceptance",
      fault: "completion_after_conversation_update",
      scripts: [
        [
          { kind: "session", provider_session_id: "session_atomic_completion" },
          { kind: "turn", provider_turn_id: "turn_atomic_completion" },
          { kind: "no_reply" },
        ],
      ],
      oldPair: { conversation: "active", message: "central_pending" },
    },
    {
      name: "reply acknowledgement",
      fault: "reply_ack_after_conversation_update",
      scripts: [
        [
          { kind: "session", provider_session_id: "session_atomic_reply_ack" },
          { kind: "turn", provider_turn_id: "turn_atomic_reply_ack" },
          { kind: "reply", text: "atomic reply acknowledgement" },
        ],
      ],
      oldPair: { conversation: "active", message: "ack_pending" },
    },
    {
      name: "completion acknowledgement",
      fault: "completion_ack_after_conversation_update",
      scripts: [
        [
          { kind: "session", provider_session_id: "session_atomic_completion_ack" },
          { kind: "turn", provider_turn_id: "turn_atomic_completion_ack" },
          { kind: "no_reply" },
        ],
      ],
      oldPair: { conversation: "closed", message: "ack_pending" },
    },
  ] as const;
  for (const [index, vector] of pairedFaults.entries()) {
    const atomic = await startK02Scenario(t, "K02-K03:A04", {
      failPairedStateWriteAfter: vector.fault,
      scripts: vector.scripts,
    });
    const atomicMessage = k02Message(`atomic_${index}`, `atomic_conversation_${index}`);
    atomic.enqueue(atomicMessage);
    assert.equal((await atomic.wake(atomicMessage.id)).status, 202);
    await assert.rejects(
      atomic.connector.waitForIdle(),
      /connector_state_unavailable/u,
      `${vector.name} did not expose the injected paired-write failure`,
    );
    await atomic.connector.close();
    const atomicDatabase = openState(atomic.stateDirectory);
    try {
      assert.deepEqual(
        atomicDatabase
          .prepare<[], { conversation: string; message: string }>(
            "SELECT conversations.lifecycle AS conversation, messages.lifecycle AS message FROM conversations JOIN messages USING(conversation_hmac)",
          )
          .get(),
        vector.oldPair,
        `${vector.name} left a mixed durable pair`,
      );
    } finally {
      atomicDatabase.close();
    }
  }

  const lostReplyClock = new ManualK02Clock(1_788_420_000_000);
  const lostReply = await startK02Scenario(t, "K02-K03:A04", {
    clock: lostReplyClock,
    failPairedStateWriteAfter: "lost_reply_after_message_update",
    gatewayProxy: true,
    scripts: [
      [
        { kind: "session", provider_session_id: "session_atomic_lost_reply" },
        { kind: "turn", provider_turn_id: "turn_atomic_lost_reply" },
        { kind: "reply", text: "atomic lost reply" },
      ],
      [{ kind: "uncertain" }],
    ],
  });
  lostReply.gatewayProxy?.failNext("reply_message", { kind: "drop_before_dispatch" });
  const lostReplyMessage = k02Message("atomic_lost_reply", "atomic_lost_reply_conversation");
  lostReply.enqueue(lostReplyMessage);
  assert.equal(
    (await lostReply.wake(lostReplyMessage.id, Math.floor(lostReplyClock.nowMs() / 1_000))).status,
    202,
  );
  await waitFor(() => {
    const retryDatabase = openState(lostReply.stateDirectory);
    try {
      const row = retryDatabase
        .prepare<[], { retry_kind: string | null }>("SELECT retry_kind FROM messages")
        .get();
      return row?.retry_kind === "outcome_lookup";
    } finally {
      retryDatabase.close();
    }
  }, "atomic lost-reply outcome schedule");
  lostReplyClock.advance(30_000);
  await assert.rejects(lostReply.connector.waitForIdle(), /connector_state_unavailable/u);
  await lostReply.connector.close();
  const lostReplyDatabase = openState(lostReply.stateDirectory);
  try {
    assert.deepEqual(
      lostReplyDatabase
        .prepare<[], { conversation: string; message: string }>(
          "SELECT conversations.lifecycle AS conversation, messages.lifecycle AS message FROM conversations JOIN messages USING(conversation_hmac)",
        )
        .get(),
      { conversation: "active", message: "central_pending" },
    );
  } finally {
    lostReplyDatabase.close();
  }

  const recovered = await startK02Scenario(t, "K02-K03:A04", {
    crashForRecoveryState: "uncertain",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_atomic_recovered_reply" },
        { kind: "turn", provider_turn_id: "turn_atomic_recovered_reply" },
        { kind: "uncertain" },
      ],
    ],
  });
  const recoveredMessage = k02Message(
    "atomic_recovered_reply",
    "atomic_recovered_reply_conversation",
  );
  recovered.enqueue(recoveredMessage);
  assert.equal((await recovered.wake(recoveredMessage.id)).status, 202);
  await assert.rejects(recovered.connector.waitForIdle(), /connector_test_crash/u);
  await recovered.connector.crash();
  const recoveredRestart = await recovered.restart(
    [[{ kind: "reply", text: "exact recovered reply" }]],
    { failPairedStateWriteAfter: "reply_ack_after_conversation_update" },
  );
  await assert.rejects(recoveredRestart.connector.waitForIdle(), /connector_state_unavailable/u);
  await recoveredRestart.connector.close();
  const recoveredDatabase = openState(recovered.stateDirectory);
  try {
    assert.deepEqual(
      recoveredDatabase
        .prepare<[], { conversation: string; message: string }>(
          "SELECT conversations.lifecycle AS conversation, messages.lifecycle AS message FROM conversations JOIN messages USING(conversation_hmac)",
        )
        .get(),
      { conversation: "uncertain", message: "ack_pending" },
    );
  } finally {
    recoveredDatabase.close();
  }

  await check("bindTurn rejects an invalid old message-conversation pair", async () => {
    const pairScenario = await startK02Scenario(t, "K02-K03:A04", { scripts: [] });
    await pairScenario.connector.close();
    const now = Date.now();
    const state = openConnectorState({
      stateDirectory: pairScenario.stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: realpathSync.native(pairScenario.workingDirectory),
      nowMs: now,
    });
    try {
      state.insertConversationAndMessage("bind_turn_pair", "bind_turn_message", now);
      state.dispatch("bind_turn_message", false, now);
      state.bindSession("bind_turn_pair", "bind_turn_message", "bind_turn_session", now);
      state.database.exec("UPDATE conversations SET lifecycle='uncertain'");
      assert.throws(
        () => state.bindTurn("bind_turn_message", "bind_turn_session", "bind_turn_id", now),
        /connector_state_unavailable/u,
      );
      assert.deepEqual(
        state.database
          .prepare<
            [],
            { conversation: string; message: string; provider_turn_hmac: Buffer | null }
          >(
            "SELECT c.lifecycle AS conversation, m.lifecycle AS message, m.provider_turn_hmac FROM conversations c JOIN messages m USING(conversation_hmac)",
          )
          .get(),
        { conversation: "uncertain", message: "turn_starting", provider_turn_hmac: null },
      );
    } finally {
      state.close();
    }
  });

  await check("message-only transition rejects an invalid new pair", async () => {
    const pairScenario = await startK02Scenario(t, "K02-K03:A04", { scripts: [] });
    await pairScenario.connector.close();
    const now = Date.now();
    const state = openConnectorState({
      stateDirectory: pairScenario.stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: realpathSync.native(pairScenario.workingDirectory),
      nowMs: now,
    });
    try {
      state.insertConversationAndMessage("message_pair", "message_pair_id", now);
      state.dispatch("message_pair_id", false, now);
      state.bindSession("message_pair", "message_pair_id", "message_pair_session", now);
      state.bindTurn("message_pair_id", "message_pair_session", "message_pair_turn", now);
      assert.throws(
        () => state.transitionMessage("message_pair_id", "turn_running", "uncertain", now),
        /connector_state_unavailable/u,
      );
      assert.deepEqual(
        state.database
          .prepare<[], { conversation: string; message: string }>(
            "SELECT c.lifecycle AS conversation, m.lifecycle AS message FROM conversations c JOIN messages m USING(conversation_hmac)",
          )
          .get(),
        { conversation: "active", message: "turn_running" },
      );
    } finally {
      state.close();
    }
  });

  await check("closed-row deletion rejects an invalid old pair", async () => {
    const pairScenario = await startK02Scenario(t, "K02-K03:A04", { scripts: [] });
    await pairScenario.connector.close();
    const now = Date.now();
    const state = openConnectorState({
      stateDirectory: pairScenario.stateDirectory,
      webhookToken: K02_TOKEN,
      providerKind: "codex",
      workingDirectory: realpathSync.native(pairScenario.workingDirectory),
      nowMs: now,
    });
    try {
      state.insertConversationAndMessage("delete_pair", "delete_pair_id", now);
      state.dispatch("delete_pair_id", false, now);
      state.bindSession("delete_pair", "delete_pair_id", "delete_pair_session", now);
      state.bindTurn("delete_pair_id", "delete_pair_session", "delete_pair_turn", now);
      state.transitionMessage("delete_pair_id", "turn_running", "central_pending", now, {
        terminal_operation: "reply",
      });
      state.transitionMessage("delete_pair_id", "central_pending", "ack_pending", now);
      state.transitionMessage("delete_pair_id", "ack_pending", "closed", now);
      state.database.exec("UPDATE conversations SET lifecycle='uncertain'");
      assert.throws(
        () => state.deleteClosedMessage("delete_pair_id"),
        /connector_state_unavailable/u,
      );
      assert.deepEqual(
        state.database
          .prepare<[], { conversation: string; message: string }>(
            "SELECT c.lifecycle AS conversation, m.lifecycle AS message FROM conversations c JOIN messages m USING(conversation_hmac)",
          )
          .get(),
        { conversation: "uncertain", message: "closed" },
      );
    } finally {
      state.close();
    }
  });

  const joinScenario = await startK02Scenario(t, "K02-K03:A04", { scripts: [] });
  await joinScenario.connector.close();
  const joinNow = Date.now();
  const joinState = openConnectorState({
    stateDirectory: joinScenario.stateDirectory,
    webhookToken: K02_TOKEN,
    providerKind: "codex",
    workingDirectory: realpathSync.native(joinScenario.workingDirectory),
    nowMs: joinNow,
  });
  joinState.insertConversationAndMessage("join_conversation", "join_message", joinNow);
  joinState.dispatch("join_message", false, joinNow);
  joinState.bindSession("join_conversation", "join_message", "join_provider_session", joinNow);
  joinState.bindTurn("join_message", "join_provider_session", "join_provider_turn", joinNow);
  joinState.close();

  type MessageShape =
    | "received"
    | "binding"
    | "turn_starting"
    | "turn_running"
    | "waiting_for_approval"
    | "uncertain"
    | "central_pending_reply"
    | "central_pending_complete"
    | "ack_pending_reply"
    | "ack_pending_complete"
    | "blocked_empty"
    | "blocked_reply"
    | "blocked_complete"
    | "closed_reply"
    | "closed_complete";
  const allowedJoins: Readonly<Record<MessageShape, readonly string[]>> = {
    received: ["binding", "active"],
    binding: ["binding"],
    turn_starting: ["active"],
    turn_running: ["active"],
    waiting_for_approval: ["active"],
    uncertain: ["uncertain"],
    central_pending_reply: ["active", "uncertain"],
    central_pending_complete: ["binding", "active", "uncertain"],
    ack_pending_reply: ["active", "uncertain"],
    ack_pending_complete: ["closed"],
    blocked_empty: ["binding", "active", "uncertain"],
    blocked_reply: ["active", "uncertain"],
    blocked_complete: ["binding", "active", "uncertain", "closed"],
    closed_reply: ["active"],
    closed_complete: ["closed"],
  };
  const allConversationStates = ["binding", "active", "uncertain", "closed"] as const;
  const joinDatabase = openState(joinScenario.stateDirectory);
  const baseConversation = joinDatabase
    .prepare<[], Record<string, unknown>>("SELECT * FROM conversations")
    .get();
  const baseMessage = joinDatabase
    .prepare<[], Record<string, unknown>>("SELECT * FROM messages")
    .get();
  assert.ok(baseConversation !== undefined && baseMessage !== undefined);
  joinDatabase.close();

  for (const [shape, allowed] of Object.entries(allowedJoins) as [
    MessageShape,
    readonly string[],
  ][]) {
    for (const conversationLifecycle of allConversationStates) {
      if (allowed.includes(conversationLifecycle)) continue;
      const databaseForShape = openState(joinScenario.stateDirectory);
      try {
        const hasSession = conversationLifecycle !== "binding";
        databaseForShape
          .prepare(
            "UPDATE conversations SET provider_session_hmac=?, provider_session_iv=?, provider_session_ciphertext=?, provider_session_tag=?, lifecycle=?",
          )
          .run(
            hasSession ? baseConversation.provider_session_hmac : null,
            hasSession ? baseConversation.provider_session_iv : null,
            hasSession ? baseConversation.provider_session_ciphertext : null,
            hasSession ? baseConversation.provider_session_tag : null,
            conversationLifecycle,
          );
        const running = ["turn_running", "waiting_for_approval", "uncertain"].includes(shape);
        const reply = shape.endsWith("_reply");
        const complete = shape.endsWith("_complete");
        const blocked = shape.startsWith("blocked_");
        const lifecycle = shape.replace(/_(reply|complete|empty)$/u, "");
        const dispatched = lifecycle !== "received";
        databaseForShape
          .prepare(
            "UPDATE messages SET provider_turn_hmac=?, provider_turn_iv=?, provider_turn_ciphertext=?, provider_turn_tag=?, lifecycle=?, blocked_class=?, terminal_operation=?, completion_outcome=?, completion_reason=?, retry_kind=NULL, retry_not_before_ms=NULL, retry_attempt_count=0, turn_started_at_ms=?, turn_deadline_ms=?",
          )
          .run(
            running && hasSession ? baseMessage.provider_turn_hmac : null,
            running && hasSession ? baseMessage.provider_turn_iv : null,
            running && hasSession ? baseMessage.provider_turn_ciphertext : null,
            running && hasSession ? baseMessage.provider_turn_tag : null,
            lifecycle,
            blocked ? "contract" : null,
            reply ? "reply" : complete ? "complete" : null,
            complete ? "failed" : null,
            complete ? "provider_execution_failed" : null,
            dispatched ? baseMessage.turn_started_at_ms : null,
            dispatched ? baseMessage.turn_deadline_ms : null,
          );
      } finally {
        databaseForShape.close();
      }
      assert.throws(
        () => {
          const invalid = openConnectorState({
            stateDirectory: joinScenario.stateDirectory,
            webhookToken: K02_TOKEN,
            providerKind: "codex",
            workingDirectory: realpathSync.native(joinScenario.workingDirectory),
            nowMs: Date.now(),
          });
          invalid.close();
        },
        /connector_state_unavailable/u,
        `startup accepted disallowed ${shape}/${conversationLifecycle} join`,
      );
    }
  }
  assert.deepEqual(strengthenedFailures, [], strengthenedFailures.join("\n"));
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
  const startupCleanup = await startK02Scenario(t, "K02-K03:A07", { scripts: [] });
  await startupCleanup.connector.close();
  const startupNow = Date.now();
  const startupState = openConnectorState({
    stateDirectory: startupCleanup.stateDirectory,
    webhookToken: K02_TOKEN,
    providerKind: "codex",
    workingDirectory: realpathSync.native(startupCleanup.workingDirectory),
    nowMs: startupNow,
  });
  try {
    startupState.insertConversationAndMessage(
      "startup_closed_conversation",
      "startup_closed_message",
      startupNow,
    );
    startupState.dispatch("startup_closed_message", false, startupNow);
    startupState.bindSession(
      "startup_closed_conversation",
      "startup_closed_message",
      "startup_closed_session",
      startupNow,
    );
    startupState.bindTurn(
      "startup_closed_message",
      "startup_closed_session",
      "startup_closed_turn",
      startupNow,
    );
    startupState.transitionMessage(
      "startup_closed_message",
      "turn_running",
      "central_pending",
      startupNow,
      { terminal_operation: "reply" },
    );
    startupState.transitionMessage(
      "startup_closed_message",
      "central_pending",
      "ack_pending",
      startupNow,
    );
    startupState.transitionMessage("startup_closed_message", "ack_pending", "closed", startupNow);
  } finally {
    startupState.close();
  }
  const beforeRestart = openState(startupCleanup.stateDirectory);
  try {
    assert.deepEqual(
      beforeRestart
        .prepare<[], { conversation: string; message: string }>(
          "SELECT c.lifecycle AS conversation, m.lifecycle AS message FROM conversations c JOIN messages m USING(conversation_hmac)",
        )
        .get(),
      { conversation: "active", message: "closed" },
    );
  } finally {
    beforeRestart.close();
  }
  const startupRestart = await startupCleanup.restart([]);
  await startupRestart.connector.waitForIdle();
  assert.deepEqual(startupCleanup.gateway.calls, [], "startup cleanup contacted the gateway");
  const afterRestart = openState(startupCleanup.stateDirectory);
  try {
    assert.equal(
      afterRestart.prepare<[], { count: number }>("SELECT count(*) AS count FROM messages").get()
        ?.count,
      0,
      "startup retained a closed acknowledged row",
    );
    assert.deepEqual(
      afterRestart.prepare<[], { lifecycle: string }>("SELECT lifecycle FROM conversations").all(),
      [{ lifecycle: "active" }],
    );
  } finally {
    afterRestart.close();
  }

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
    assert.equal(
      database.prepare<[], { lifecycle: string }>("SELECT lifecycle FROM conversations").get()
        ?.lifecycle,
      "active",
    );
    assert.equal(scenario.gateway.tombstone(message.id)?.acknowledged, true);
  } finally {
    database.close();
  }

  const completion = await startK02Scenario(t, "K02-K03:A07", {
    scripts: [
      [
        { kind: "session", provider_session_id: "session_retention_completion" },
        { kind: "turn", provider_turn_id: "turn_retention_completion" },
        { kind: "no_reply" },
      ],
    ],
  });
  const completionMessage = k02Message(
    "message_retention_completion",
    "conversation_retention_completion",
  );
  completion.enqueue(completionMessage);
  assert.equal((await completion.wake(completionMessage.id)).status, 202);
  await completion.connector.waitForIdle();
  const completionDatabase = openState(completion.stateDirectory);
  try {
    assert.equal(
      completionDatabase
        .prepare<[], { count: number }>("SELECT count(*) AS count FROM messages")
        .get()?.count,
      0,
    );
    assert.equal(
      completionDatabase
        .prepare<[], { lifecycle: string }>("SELECT lifecycle FROM conversations")
        .get()?.lifecycle,
      "closed",
    );
  } finally {
    completionDatabase.close();
  }

  const recovered = await startK02Scenario(t, "K02-K03:A07", {
    crashForRecoveryState: "uncertain",
    scripts: [
      [
        { kind: "session", provider_session_id: "session_retention_recovered" },
        { kind: "turn", provider_turn_id: "turn_retention_recovered" },
        { kind: "uncertain" },
      ],
    ],
  });
  const recoveredMessage = k02Message(
    "message_retention_recovered",
    "conversation_retention_recovered",
  );
  recovered.enqueue(recoveredMessage);
  assert.equal((await recovered.wake(recoveredMessage.id)).status, 202);
  await assert.rejects(recovered.connector.waitForIdle(), /connector_test_crash/u);
  await recovered.connector.crash();
  const restarted = await recovered.restart([
    [{ kind: "reply", text: "retained exact recovered reply" }],
  ]);
  await restarted.connector.waitForIdle();
  const recoveredDatabase = openState(recovered.stateDirectory);
  try {
    assert.equal(
      recoveredDatabase
        .prepare<[], { count: number }>("SELECT count(*) AS count FROM messages")
        .get()?.count,
      0,
    );
    assert.equal(
      recoveredDatabase
        .prepare<[], { lifecycle: string }>("SELECT lifecycle FROM conversations")
        .get()?.lifecycle,
      "active",
      "acknowledging an exactly recovered reply did not restore the uncertain conversation",
    );
  } finally {
    recoveredDatabase.close();
  }
});

test("K02-A08 fails closed on unexpected artifacts, weak modes, and database damage", async (t) => {
  for (const failure of [
    "unexpected_artifact",
    "weak_mode",
    "hard_link",
    "database_damage",
  ] as const) {
    const { scenario } = await establishMapping(t, "K02-K03:A08", `filesystem_${failure}`);
    await scenario.connector.close();
    const unexpected = join(scenario.stateDirectory, "unexpected.backup");
    const databasePath = join(scenario.stateDirectory, "correlation.sqlite3");
    const hardLink = join(scenario.rootDirectory, "correlation-hard-link");
    const effectiveUid = process.geteuid?.();
    for (const leaf of await readdir(scenario.stateDirectory)) {
      const metadata = await stat(join(scenario.stateDirectory, leaf));
      if (effectiveUid !== undefined) assert.equal(metadata.uid, effectiveUid);
      assert.equal(metadata.nlink, 1);
    }
    if (failure === "unexpected_artifact") {
      await writeFile(unexpected, "content-free but unallowlisted", { mode: 0o600 });
    } else if (failure === "weak_mode") {
      await chmod(databasePath, 0o644);
    } else if (failure === "hard_link") {
      await link(databasePath, hardLink);
    } else {
      await writeFile(databasePath, "not a SQLite database");
    }
    await assert.rejects(scenario.restart([]), /connector_state_unavailable/u);
    if (failure === "unexpected_artifact") await unlink(unexpected);
    if (failure === "hard_link") await unlink(hardLink);
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
