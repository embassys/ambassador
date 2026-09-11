import type { TranscriptItem, TranscriptPage } from "../visible-transcripts.js";
import { conversationTopic } from "./conversation-preview.js";

export interface ConversationPeer {
  name: string;
  email?: string;
  agentId?: string;
}
type CommunicationIdentity = {
  id: string;
  outbound: boolean;
  sender_name: string | null;
  sender_email: string | null;
};
export function conversationPeer(
  peer: { agentId: string; messageId: string } | undefined,
  messages: readonly CommunicationIdentity[],
  sameOwner: boolean,
): ConversationPeer {
  const fallback = {
    name: peer ? `Agent ${peer.agentId.slice(0, 8)}` : "Unknown agent",
    ...(peer ? { agentId: peer.agentId } : {}),
  };
  if (!peer || !sameOwner) return fallback;
  const matches = messages.filter((m) => m.id === peer.messageId && !m.outbound);
  const first = matches[0];
  if (
    !first ||
    matches.some(
      (m) => m.sender_email !== first.sender_email || m.sender_name !== first.sender_name,
    )
  )
    return fallback;
  return {
    name: first.sender_name?.trim() || first.sender_email?.trim() || fallback.name,
    ...(first.sender_email ? { email: first.sender_email } : {}),
    agentId: peer.agentId,
  };
}
export function chronologicalItems(items: readonly TranscriptItem[]) {
  return [...items].sort((a, b) => a.createdAt - b.createdAt);
}

export function mergeChatPages(
  previous: TranscriptPage,
  next: TranscriptPage,
  mode: "refresh" | "earlier",
): TranscriptPage {
  if (
    mode === "refresh" &&
    (!next.items.length ||
      !next.items.some((item) => previous.items.some((old) => old.id === item.id)))
  )
    return next;
  const records = new Map(
    (mode === "earlier"
      ? [...next.items, ...previous.items]
      : [...previous.items, ...next.items]
    ).map((item) => [item.id, item]),
  );
  const capped = records.size >= 500;
  return {
    ...next,
    items: [...records.values()].slice(-500),
    nextCursor: mode === "earlier" ? next.nextCursor : previous.nextCursor,
    hasMore: !capped && (mode === "earlier" ? next.hasMore : previous.hasMore),
    warnings: [
      ...new Set([
        ...previous.warnings,
        ...next.warnings,
        ...(capped
          ? ["Showing 500 saved records. Reload latest messages to return to recent activity."]
          : []),
      ]),
    ],
  };
}
export function incomingMessage(text: string): {
  side: "peer" | "owner" | "system";
  title: string;
  text?: string;
  fields?: unknown;
  detailsOnly?: boolean;
} {
  try {
    const envelope = JSON.parse(text);
    const message = envelope?.payload;
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
    const topic =
      typeof message.action_type === "string" ? conversationTopic(message.action_type) : "Request";
    if (message.type === "action_call") {
      const payload = message.payload;
      return {
        side: "peer",
        title: topic,
        detailsOnly: true,
        ...(typeof payload?.reason === "string" ? { text: payload.reason } : {}),
        fields:
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "reason"))
            : payload,
      };
    }
    if (message.type === "action_response")
      return { side: "peer", title: `${topic} · Result`, fields: message.result ?? message };
    if (message.type === "owner_input")
      return {
        side: "owner",
        title: "Your answer",
        text: typeof message.question === "string" ? message.question : undefined,
        fields: message.value,
      };
    if (message.type === "permission_outcome")
      return {
        side: "system",
        title: "Permission update",
        fields: {
          status: message.status ?? message.decision ?? "Unknown",
          action: message.action_type,
        },
      };
  } catch {
    /* Truncated or unsupported envelopes stay explicitly unattributed. */
  }
  return {
    side: "system",
    title: "Embassys message",
    text: "Open message details to read the saved content.",
  };
}
