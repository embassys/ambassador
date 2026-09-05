import type { ActionResultInbox } from "./action-result-inbox.js";
import { serializeLocalToolResult } from "./local-tool-result.js";
import { McpContractError } from "./mcp-contract.js";
import type { OutboundActions } from "./outbound-actions.js";
import type { PendingActionInbox } from "./pending-action-inbox.js";

const PAGE_BYTES = 500 * 1024;
const MAX_LIMIT = 100;
interface Cursor {
  section: number;
  after: number;
}
export interface InboxPage extends Record<string, unknown> {
  readonly count: number;
  readonly items: Record<string, unknown>[];
  readonly next_cursor?: string;
}

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decode(value: unknown): Cursor {
  if (value === undefined) return { section: 0, after: 0 };
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new McpContractError();
  try {
    const result = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (
      Object.keys(result).length !== 2 ||
      ![0, 1, 2].includes(result.section) ||
      !Number.isSafeInteger(result.after) ||
      result.after < 0 ||
      encode(result) !== value
    )
      throw new McpContractError();
    return result;
  } catch {
    throw new McpContractError();
  }
}

export class LocalInbox {
  constructor(
    readonly calls: PendingActionInbox,
    readonly results: ActionResultInbox,
    readonly outbound?: OutboundActions,
  ) {}

  get(
    arguments_: Record<string, unknown>,
    options: {
      readonly signal?: AbortSignal;
      readonly validate?: (page: InboxPage) => void;
    } = {},
  ): InboxPage {
    if (Object.keys(arguments_).some((key) => !["cursor", "limit"].includes(key)))
      throw new McpContractError();
    const limit = arguments_.limit ?? 50;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
      throw new McpContractError();
    options.signal?.throwIfAborted();
    let cursor = decode(arguments_.cursor);
    const items: Record<string, unknown>[] = [];
    const consumed: string[] = [];
    let more = false;
    let pageBytes = 2;
    while (cursor.section < 3) {
      const store =
        cursor.section === 0 ? this.calls : cursor.section === 1 ? this.results : this.outbound;
      if (store === undefined) break;
      const next = store.page(cursor.after, 1);
      const entry = next.items[0];
      if (entry === undefined) {
        cursor = { section: cursor.section + 1, after: 0 };
        continue;
      }
      const item =
        cursor.section === 0
          ? {
              kind: "action_call",
              ...entry.value,
              response: {
                tool: "submit_action_result",
                required: {
                  call_id: (entry.value as { call_id: string }).call_id,
                  status: ["success", "error"],
                  result: { type: "object" },
                },
              },
            }
          : { kind: cursor.section === 1 ? "action_result" : "outbound_action", ...entry.value };
      const itemBytes =
        Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length === 0 ? 0 : 1);
      if (items.length >= limit || (items.length > 0 && pageBytes + itemBytes > PAGE_BYTES)) {
        more = true;
        break;
      }
      items.push(item);
      pageBytes += itemBytes;
      if (cursor.section === 1) consumed.push((entry.value as { call_id: string }).call_id);
      cursor = { section: cursor.section, after: entry.sequence };
    }
    const result: InboxPage = {
      count: items.length,
      items,
      ...(more ? { next_cursor: encode(cursor) } : {}),
    };
    // All validation and serialization precedes consumption, including custom credential checks.
    options.validate?.(result);
    serializeLocalToolResult(result);
    options.signal?.throwIfAborted();
    if (this.results.removeMany(consumed) !== consumed.length)
      throw new Error("Inbox consumption failed");
    return result;
  }
}
