import type { TranscriptPage } from "../visible-transcripts.js";
import type { ConversationPeer } from "./chat.js";
import { type ConversationPreview, conversationTopic } from "./conversation-preview.js";
import type { Communication, CommunicationsPage } from "./owner-contract.js";

export interface AccountConversationSession {
  session_id: string;
  agent_kind: string;
  status: string;
  last_used_at_ms: number;
  preview?: ConversationPreview | undefined;
  peer?: ConversationPeer | undefined;
  // null means account-only. Undefined means an ordinary local session.
  localSessionId?: string | null;
  accountLocalId?: string;
  accountMessages?: Communication[];
  retention?: CommunicationsPage["retention"] | undefined;
}
const compare = (a: Communication, b: Communication) =>
  Date.parse(b.created_at) - Date.parse(a.created_at) || b.message_id.localeCompare(a.message_id);

export function mergeCommunicationPages(
  previous: CommunicationsPage | undefined,
  next: CommunicationsPage,
  mode: "refresh" | "earlier",
  seen: ReadonlySet<string> = new Set(),
): CommunicationsPage {
  if (next.next_cursor && seen.has(next.next_cursor)) throw new Error("Repeated history cursor");
  if (
    !previous ||
    (mode === "refresh" &&
      !next.items.some((item) => previous.items.some((old) => old.message_id === item.message_id)))
  )
    return next;
  const records = new Map(
    (mode === "refresh"
      ? [...previous.items, ...next.items]
      : [...next.items, ...previous.items]
    ).map((item) => [item.message_id, item]),
  );
  const items = [...records.values()].sort(compare);
  if (
    items.length > 1000 ||
    new TextEncoder().encode(JSON.stringify(items)).byteLength > 8 * 1024 * 1024
  )
    throw new Error("History view is full. Reload recent messages to continue.");
  return {
    ...next,
    items,
    ...(mode === "refresh"
      ? { has_more: previous.has_more, next_cursor: previous.next_cursor }
      : {}),
  };
}

export function accountConversations(
  local: readonly AccountConversationSession[],
  page: CommunicationsPage | undefined,
  localAgentId: string | undefined,
): AccountConversationSession[] {
  const sessions = local.map((item) => ({ ...item }));
  const groups = new Map<
    string,
    { mine: string; peer: Communication["sender"]; items: Communication[] }
  >();
  for (const item of page?.items ?? []) {
    // Internal traffic is grouped with a stable perspective across replies.
    const mine =
      item.direction === "internal"
        ? ([item.sender?.agent_id ?? "", item.recipient.agent_id].sort()[0] ?? "")
        : item.sender?.is_mine
          ? item.sender.agent_id
          : item.recipient.agent_id;
    const peer = item.sender?.agent_id === mine ? item.recipient : item.sender;
    const key = `account:${mine}:${peer?.agent_id ?? `deleted:${item.message_id}`}`;
    const group = groups.get(key) ?? { mine, peer, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const items = group.items.sort(compare);
    const latest = items[0];
    if (!latest) continue;
    const matches = sessions.filter(
      (s) =>
        group.peer !== null &&
        group.mine === localAgentId &&
        s.preview?.peer?.agentId === group.peer.agent_id,
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    const peer: ConversationPeer = {
      name:
        group.peer?.display_name?.trim() ||
        group.peer?.email ||
        (group.peer ? `Agent ${group.peer.agent_id.slice(0, 8)}` : "Deleted agent"),
      ...(group.peer
        ? { agentId: group.peer.agent_id, ...(group.peer.email ? { email: group.peer.email } : {}) }
        : {}),
    };
    const patch = {
      peer,
      accountLocalId: group.mine,
      accountMessages: items,
      retention: page?.retention,
      last_used_at_ms: Math.max(match?.last_used_at_ms ?? 0, Date.parse(latest.created_at)),
      preview: match?.preview ?? {
        title: conversationTopic(latest.action_type ?? latest.message_type ?? "Message"),
        excerpt: latest.call_status ?? latest.status,
      },
    };
    if (match) Object.assign(match, patch, { localSessionId: match.session_id });
    else
      sessions.push({
        session_id: key,
        agent_kind: "Embassys",
        status: "history",
        ...patch,
        localSessionId: null,
      });
  }
  return sessions.sort(
    (a, b) => b.last_used_at_ms - a.last_used_at_ms || a.session_id.localeCompare(b.session_id),
  );
}

export function combineConversation(
  local: TranscriptPage | undefined,
  messages: readonly Communication[],
  sessionId: string,
): TranscriptPage {
  const ids = new Set(messages.map((item) => item.message_id));
  const entries = messages.map((item) => ({
    kind: "entry" as const,
    id: `account:${item.message_id}`,
    sessionId,
    messageId: item.message_id,
    role: "user" as const,
    createdAt: Date.parse(item.created_at),
    text: JSON.stringify({ id: item.message_id, payload: item.payload }),
  }));
  return {
    source: "archive",
    items: [
      ...(local?.items ?? []).filter(
        (item) => !(item.kind === "entry" && item.role === "user" && ids.has(item.messageId)),
      ),
      ...entries,
    ].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    hasMore: local?.hasMore ?? false,
    nextCursor: local?.nextCursor ?? 0,
    warnings: local?.warnings ?? [],
  };
}
