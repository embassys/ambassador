import type { TranscriptItem } from "../visible-transcripts.js";

export interface ConversationPreview {
  title: string;
  excerpt: string;
  peer?: { agentId: string; messageId: string };
}

const topics: Record<string, string> = {
  get_phone_number: "Phone number",
  get_free_busy_permission: "Calendar availability",
  read_calendar_event_by_title: "Find a calendar event",
  read_calendar_permission: "Calendar access",
  create_calendar_event: "Create a calendar event",
  owner_input: "Owner input",
};
export function conversationTopic(actionType: string) {
  if (Object.hasOwn(topics, actionType)) return topics[actionType] ?? actionType;
  const words = actionType.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const clip = (value: string, limit: number) => {
  const text = value.replaceAll(/\s+/gu, " ").trim();
  return text.length > limit
    ? `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`
    : text;
};

export function conversationPreview(
  items: readonly TranscriptItem[],
): ConversationPreview | undefined {
  const turn = items.find((item) => item.kind === "turn" && item.status !== "expired");
  if (turn?.kind !== "turn") return undefined;
  let title = conversationTopic(turn.actionType);
  const request = items.find(
    (item) => item.kind === "entry" && item.role === "user" && item.messageId === turn.messageId,
  );
  if (request?.kind === "entry") {
    try {
      const message = JSON.parse(request.text);
      const candidate = message?.payload?.payload?.title ?? message?.payload?.title;
      if (typeof candidate === "string" && candidate.trim()) title = candidate;
    } catch {
      // Partial archived JSON does not supply a title.
    }
  }
  const entry = items.find(
    (item) => item.kind === "entry" && item.role === "agent" && item.text.trim(),
  );
  return {
    title: clip(title, 80),
    excerpt: entry?.kind === "entry" ? clip(entry.text, 180) : "",
    ...(turn.senderId && turn.messageId
      ? { peer: { agentId: turn.senderId, messageId: turn.messageId } }
      : {}),
  };
}

export function decorateConversationSessions<
  T extends { session_id: string; last_used_at_ms: number },
>(
  sessions: readonly T[],
  read: (sessionId: string) => ConversationPreview | undefined,
): (T & { preview?: ConversationPreview | undefined })[] {
  const previews = new Map<string, ConversationPreview | undefined>();
  for (const session of [...sessions]
    .sort((a, b) => b.last_used_at_ms - a.last_used_at_ms)
    .slice(0, 100)) {
    try {
      previews.set(session.session_id, read(session.session_id));
    } catch {
      /* A missing preview must not hide the conversation. */
    }
  }
  return sessions.map((session) => ({ ...session, preview: previews.get(session.session_id) }));
}
