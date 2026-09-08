import type { ActionResultInbox } from "../action-result-inbox.js";
import type { OutboundActions } from "../outbound-actions.js";
import type { OwnerQuestions } from "../owner-questions.js";
import type { PendingActionInbox } from "../pending-action-inbox.js";
export type ActivityKind = "incoming" | "results" | "outgoing" | "questions";
export interface ActivityItem {
  id: string;
  action: string;
  status: string;
  peer?: string;
  createdAt?: string;
  question?: string;
}
export interface ActivityPage {
  state: "ready" | "stopped" | "not_registered";
  items: ActivityItem[];
  hasMore: boolean;
  nextCursor: number;
}
export function activityPage(
  sources: {
    pending: PendingActionInbox;
    results: ActionResultInbox;
    outbound: OutboundActions;
    questions: OwnerQuestions;
  },
  kind: ActivityKind,
  after = 0,
): ActivityPage {
  if (kind === "incoming") {
    const page = sources.pending.page(after, 50);
    return {
      state: "ready",
      items: page.items.map(({ value }) => ({
        id: value.call_id,
        action: value.action_type,
        status: "pending",
        peer: value.sender_agent_id,
        createdAt: value.created_at,
      })),
      hasMore: page.hasMore,
      nextCursor: page.items.at(-1)?.sequence ?? after,
    };
  }
  if (kind === "results") {
    const page = sources.results.page(after, 50);
    return {
      state: "ready",
      items: page.items.map(({ value }) => ({
        id: value.call_id,
        action: value.action_type,
        status: value.status,
        peer: value.sender_agent_id,
        createdAt: value.created_at,
      })),
      hasMore: page.hasMore,
      nextCursor: page.items.at(-1)?.sequence ?? after,
    };
  }
  if (kind === "outgoing") {
    const page = sources.outbound.page(after, 50);
    return {
      state: "ready",
      items: page.items.map(({ value }) => ({
        id: value.operation_id,
        action: value.action_type,
        status: value.status,
        peer: value.target_email,
        createdAt: value.created_at,
      })),
      hasMore: page.hasMore,
      nextCursor: page.items.at(-1)?.sequence ?? after,
    };
  }
  const page = sources.questions.page(after, 50);
  return {
    state: "ready",
    items: page.items.map(({ value }) => ({
      id: value.request_id,
      action: value.action_type,
      status: value.status === "submitting" ? "uncertain" : value.status,
      peer: value.sender_agent_id,
      question: value.input.question,
    })),
    hasMore: page.hasMore,
    nextCursor: page.items.at(-1)?.sequence ?? after,
  };
}
