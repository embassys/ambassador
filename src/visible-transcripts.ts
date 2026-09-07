import { createHash } from "node:crypto";
import { z } from "zod";
import type { LoadedCentralCredential } from "./central-credential.js";
import type { CentralMessage } from "./central-rest.js";
import { EncryptedRecordStore } from "./encrypted-record-store.js";
import { redactVerboseValue } from "./verbose-log.js";

const common = {
  id: z.string().max(1024),
  sessionId: z.string().max(512),
  messageId: z.string().max(512),
  createdAt: z.number().int().nonnegative(),
};
const turnSchema = z.strictObject({
  ...common,
  kind: z.literal("turn"),
  senderId: z.string().max(256),
  actionType: z.string().max(128),
  fingerprint: z.string().length(64),
  status: z.enum(["recording", "complete", "partial", "expired"]),
  reason: z.string().max(128).optional(),
  parts: z.number().int().nonnegative(),
  lastRole: z.enum(["user", "agent", "tool"]).optional(),
  sourceSequence: z.number().int().nonnegative(),
  sourceFingerprint: z.string().max(64),
  chars: z.number().int().nonnegative(),
});
const entrySchema = z.strictObject({
  ...common,
  kind: z.literal("entry"),
  role: z.enum(["user", "agent", "tool"]),
  text: z.string().max(16_384),
});
const healthSchema = z.strictObject({
  id: z.literal("health"),
  kind: z.literal("health"),
  lastGapAt: z.string().max(24),
  reason: z.string().max(128),
  padding: z.string().max(1024),
});
const recordSchema = z.discriminatedUnion("kind", [turnSchema, entrySchema, healthSchema]);
type Turn = z.infer<typeof turnSchema>;
type Entry = z.infer<typeof entrySchema>;
type Record = z.infer<typeof recordSchema>;
export type TranscriptItem = Turn | Entry;
export interface TranscriptPage {
  readonly source: "archive";
  readonly items: TranscriptItem[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly warnings: string[];
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (messageId: string) => `turn:${digest(messageId)}`;
const sessionGroup = (sessionId: string) => `session:${sessionId}`;
const turnGroup = (messageId: string) => key(messageId);

export class VisibleTranscripts {
  readonly #store: EncryptedRecordStore<Record>;
  readonly #now: () => number;
  #retentionCursor = 0;
  constructor(
    path: string,
    credential: LoadedCentralCredential,
    options: { now?: () => number; maximumBytes?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#store = new EncryptedRecordStore(path, credential, {
      scope: "ambassador-visible-transcripts",
      indexedStates: true,
      indexedGroups: true,
      identifier: (record) => record.id,
      parse: (bytes) => recordSchema.parse(JSON.parse(bytes.toString("utf8"))),
      error: () => new Error("The visible conversation archive is unavailable or full."),
      ...(options.maximumBytes === undefined ? {} : { maximumBytes: options.maximumBytes }),
    });
    if (!this.#store.get("health")) this.#health("");
  }
  #health(reason: string): void {
    const record = {
      id: "health" as const,
      kind: "health" as const,
      lastGapAt: reason ? new Date(this.#now()).toISOString() : "",
      reason,
      padding: "",
    };
    record.padding = " ".repeat(512 - Buffer.byteLength(JSON.stringify(record)));
    this.#store.put(record, { replace: true, state: 2 });
  }
  #gap(messageId?: string): false {
    try {
      this.#health(
        "Some visible content could not be saved. Check Diagnostics and available storage.",
      );
    } catch {
      /* Archival must never replace or block workflow custody. */
    }
    try {
      const turn = messageId ? this.#turn(messageId) : undefined;
      if (turn) {
        turn.reason = "Some visible content could not be saved.";
        this.#saveTurn(turn);
      }
    } catch {
      /* Keep the fixed-size archive health notice when the quota is exhausted. */
    }
    return false;
  }
  #turn(messageId: string): Turn | undefined {
    const record = this.#store.get(key(messageId));
    return record?.kind === "turn" ? record : undefined;
  }
  #saveTurn(turn: Turn, state?: number): void {
    this.#store.put(turn, {
      replace: true,
      groups: [sessionGroup(turn.sessionId), turnGroup(turn.messageId)],
      state: state ?? (turn.status === "recording" ? 0 : turn.status === "expired" ? 4 : 1),
    });
  }
  #append(turn: Turn, role: Entry["role"], raw: string): void {
    let text = String(redactVerboseValue(raw));
    if (turn.chars + text.length > 4 * 1024 * 1024)
      throw new Error("Visible turn exceeds its archive limit.");
    turn.chars += text.length;
    while (text.length) {
      let entry: Entry | undefined;
      if (turn.lastRole === role && role !== "tool" && turn.parts > 0) {
        const last = this.#store.get(`${turn.id}:${turn.parts}`);
        if (last?.kind === "entry" && last.text.length < 16_384) entry = last;
      }
      if (!entry) {
        turn.parts++;
        entry = {
          id: `${turn.id}:${turn.parts}`,
          kind: "entry",
          sessionId: turn.sessionId,
          messageId: turn.messageId,
          createdAt: this.#now(),
          role,
          text: "",
        };
      }
      let length = Math.min(16_384 - entry.text.length, text.length);
      const last = text.charCodeAt(length - 1);
      if (length < text.length && last >= 0xd800 && last <= 0xdbff) length--;
      if (length === 0) {
        turn.lastRole = undefined;
        continue;
      }
      entry.text = String(redactVerboseValue(entry.text + text.slice(0, length)));
      text = text.slice(length);
      this.#store.put(entry, {
        replace: true,
        groups: [sessionGroup(turn.sessionId), turnGroup(turn.messageId)],
        state: 2,
      });
      turn.lastRole = role;
    }
  }
  begin(sessionId: string, message: CentralMessage): boolean {
    try {
      if (!message.id || sessionId.length > 512 || message.id.length > 512)
        throw new Error("Missing archive correlation.");
      const prior = this.#turn(message.id);
      const fingerprint = digest(message);
      if (prior) return prior.fingerprint === fingerprint && prior.sessionId === sessionId;
      const turn: Turn = {
        id: key(message.id),
        kind: "turn",
        sessionId,
        messageId: message.id,
        senderId: message.sender_agent_id,
        actionType:
          typeof message.payload.action_type === "string"
            ? message.payload.action_type
            : String(message.payload.type ?? "message"),
        createdAt: this.#now(),
        fingerprint,
        status: "recording",
        parts: 0,
        sourceSequence: 0,
        sourceFingerprint: "",
        chars: 0,
      };
      this.#store.transaction(() => {
        this.#saveTurn(turn);
        this.#append(turn, "user", JSON.stringify(redactVerboseValue(message), null, 2));
        this.#saveTurn(turn);
      });
      return true;
    } catch {
      return this.#gap(message.id);
    }
  }
  update(messageId: string, sequence: number, value: unknown): boolean {
    try {
      if (!value || typeof value !== "object" || !("sessionUpdate" in value)) return true;
      let role: Entry["role"];
      let text: string;
      if (
        value.sessionUpdate === "agent_message_chunk" &&
        "content" in value &&
        value.content &&
        typeof value.content === "object" &&
        "type" in value.content &&
        value.content.type === "text" &&
        "text" in value.content &&
        typeof value.content.text === "string"
      ) {
        role = "agent";
        text = value.content.text;
      } else if (
        value.sessionUpdate === "tool_call" ||
        value.sessionUpdate === "tool_call_update"
      ) {
        role = "tool";
        const title =
          "title" in value && typeof value.title === "string"
            ? value.title.slice(0, 2000)
            : "Tool update";
        const status =
          "status" in value && typeof value.status === "string" ? value.status.slice(0, 80) : "";
        text = status ? `${title}\n${status}` : title;
      } else return true;
      const turn = this.#turn(messageId);
      if (!turn || turn.status !== "recording" || !Number.isSafeInteger(sequence) || sequence < 1)
        return false;
      const fingerprint = digest({ role, text });
      if (sequence < turn.sourceSequence) return true;
      if (sequence === turn.sourceSequence) return turn.sourceFingerprint === fingerprint;
      this.#store.transaction(() => {
        this.#append(turn, role, text);
        turn.sourceSequence = sequence;
        turn.sourceFingerprint = fingerprint;
        this.#saveTurn(turn);
      });
      return true;
    } catch {
      return this.#gap(messageId);
    }
  }
  finish(messageId: string, status: "complete" | "partial"): boolean {
    try {
      const turn = this.#turn(messageId);
      if (!turn || turn.status !== "recording") return false;
      turn.status = turn.reason ? "partial" : status;
      if (status === "partial")
        turn.reason = "The provider turn ended without a confirmed complete transcript.";
      this.#saveTurn(turn);
      return true;
    } catch {
      return this.#gap(messageId);
    }
  }
  recoverInterrupted(): boolean {
    const page = this.#store.pageStates([0], 0, 64);
    for (const { value } of page.items)
      if (value.kind === "turn") {
        value.status = "partial";
        value.reason = "Interrupted when the local server stopped.";
        this.#saveTurn(value);
      }
    return page.hasMore;
  }
  maintain(): void {
    // Resume a bounded purge before selecting another expired turn.
    const deleting = this.#store.nextInStates([3]);
    if (deleting?.kind === "turn") {
      const page = this.#store.pageGroup(turnGroup(deleting.messageId), 0, 128);
      const entries = page.items.filter((item) => item.value.kind === "entry");
      this.#store.remove(entries.map((item) => item.value.id));
      if (!page.hasMore) this.#saveTurn(deleting, 4);
      return;
    }
    const page = this.#store.pageStates([1, 4], this.#retentionCursor, 64);
    this.#retentionCursor = page.hasMore ? (page.items.at(-1)?.sequence ?? 0) : 0;
    for (const { value } of page.items) {
      if (value.kind !== "turn") continue;
      if (value.status === "expired" && value.createdAt < this.#now() - 90 * 86_400_000)
        this.#store.remove([value.id]);
      else if (value.status !== "expired" && value.createdAt < this.#now() - 30 * 86_400_000) {
        value.status = "expired";
        value.reason = "Conversation bodies removed after the 30-day retention period.";
        this.#saveTurn(value, 3);
        return;
      }
    }
  }
  page(sessionId: string, after = 0, limit = 50): TranscriptPage {
    const page = this.#store.pageGroup(sessionGroup(sessionId), after, limit, 512 * 1024);
    const health = this.#store.get("health");
    const turns = new Map<string, Turn | undefined>();
    const lookup = (messageId: string) => {
      if (!turns.has(messageId)) turns.set(messageId, this.#turn(messageId));
      return turns.get(messageId);
    };
    const expired = (turn: Turn) =>
      turn.status === "expired" ||
      (turn.status !== "recording" && turn.createdAt < this.#now() - 30 * 86_400_000);
    const items: TranscriptItem[] = [];
    for (const { value } of page.items) {
      if (value.kind === "turn")
        items.push(
          expired(value)
            ? {
                ...value,
                status: "expired",
                reason: "Conversation bodies removed after the 30-day retention period.",
              }
            : value,
        );
      else if (value.kind === "entry") {
        const turn = lookup(value.messageId);
        if (turn && !expired(turn)) items.push(value);
      }
    }
    return {
      source: "archive",
      items,
      nextCursor: page.items.at(-1)?.sequence ?? after,
      hasMore: page.hasMore,
      warnings:
        health?.kind === "health" && health.reason
          ? [`${health.reason} Last gap: ${health.lastGapAt}`]
          : [],
    };
  }
  deleteSession(sessionId: string): boolean {
    const page = this.#store.pageGroup(sessionGroup(sessionId), 0, 128);
    this.#store.remove(page.items.map((item) => item.value.id));
    return page.hasMore;
  }
  close(): void {
    this.#store.close();
  }
}
