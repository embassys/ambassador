import { useCallback, useEffect, useRef, useState } from "react";
import { conversationPeer } from "../../src/desktop/chat.js";
import {
  groupConversationRequests,
  type RequestLinkPage,
} from "../../src/desktop/conversations.js";
import type { OwnerReply, OwnerSnapshot, OwnerView } from "../../src/desktop/owner-protocol.js";
import type { DesktopCommand } from "../../src/desktop/protocol.js";
import { createViewReader } from "../../src/desktop/view-reader.js";
import type { ConversationSession } from "./history.js";

export type RequestSnapshot = Extract<OwnerView, { kind: "requests" }>;
export interface RequestSource {
  data?: RequestSnapshot | undefined;
  loading: boolean;
  error: string;
  updated: string;
  refresh(): Promise<void>;
}
const empty: RequestSnapshot = {
  kind: "requests",
  total: 0,
  permission_requests: [],
  input_requests: [],
};

export function useConversationWorkspace(
  owner: OwnerSnapshot | undefined,
  instanceId: string | undefined,
  runtime: string | undefined,
  active: boolean,
  call: (command: DesktopCommand) => Promise<unknown>,
  accountChanged: () => Promise<void>,
) {
  const scope = `${owner?.context}:${instanceId}:${runtime}`;
  const [state, setState] = useState<{
    scope: string;
    sessions: ConversationSession[];
    communications?: Extract<OwnerView, { kind: "communications" }>["communications"];
    requests?: RequestSnapshot | undefined;
    links: RequestLinkPage;
    updated: string;
    requestError: string;
    sessionError: string;
  }>();
  const readers = useRef<{ refresh(): Promise<void> }[]>([]);
  const refresh = useCallback(async () => {
    await Promise.all(readers.current.map((reader) => reader.refresh()));
  }, []);
  useEffect(() => {
    if (!active || !instanceId || owner?.status !== "signed_in") return;
    const initial = {
      scope,
      sessions: [],
      links: { links: [], hasMore: false, nextCursor: 0 },
      updated: "",
      requestError: "",
      sessionError: "",
    };
    setState(initial);
    const update = (patch: Partial<NonNullable<typeof state>>) =>
      setState((previous) => (previous?.scope === scope ? { ...previous, ...patch } : previous));
    const requests = createViewReader({
      queueRefresh: true,
      read: () => call({ type: "owner_requests", context: owner.context }) as Promise<OwnerReply>,
      publish: (reply) => {
        if (reply.snapshot.context !== owner.context || reply.snapshot.status !== "signed_in") {
          update({ requests: undefined, requestError: "Sign in again to load requests." });
          void accountChanged();
        } else if (reply.state === "ready" && reply.data?.kind === "requests")
          update({ requests: reply.data, updated: reply.fetchedAt ?? "", requestError: "" });
        else
          update({
            requestError: "Requests couldn't refresh. The last saved view may be out of date.",
          });
      },
      failed: () =>
        update({ requestError: "Requests couldn't refresh. Check your connection and try again." }),
    });
    const sessions = createViewReader({
      queueRefresh: true,
      read: () => call({ type: "sessions", instanceId }) as Promise<ConversationSession[]>,
      publish: (sessions) => update({ sessions, sessionError: "" }),
      failed: () => update({ sessionError: "Conversations couldn't refresh." }),
    });
    const links = createViewReader({
      read: async () => {
        let after = 0;
        const collected: RequestLinkPage = { links: [], hasMore: false, nextCursor: 0 };
        for (let count = 0; count < 10; count++) {
          const page = (await call({
            type: "request_links",
            instanceId,
            after,
          })) as RequestLinkPage;
          if (count && page.agentId !== collected.agentId) throw new Error("Enrollment changed");
          collected.agentId = page.agentId;
          collected.links.push(...page.links);
          collected.hasMore = page.hasMore;
          collected.nextCursor = page.nextCursor;
          if (!page.hasMore) break;
          if (page.nextCursor <= after) throw new Error("Invalid request cursor");
          after = page.nextCursor;
        }
        return collected;
      },
      publish: (links) => update({ links }),
      failed: () => update({ links: { links: [], hasMore: false, nextCursor: 0 } }),
    });
    const identities = createViewReader({
      read: () =>
        call({ type: "owner_communications", context: owner.context }) as Promise<OwnerReply>,
      publish: (reply) =>
        update({
          communications:
            reply.snapshot.context === owner.context &&
            reply.snapshot.status === "signed_in" &&
            reply.state === "ready" &&
            reply.data?.kind === "communications"
              ? reply.data.communications
              : [],
        }),
      failed: () => update({ communications: [] }),
    });
    readers.current = [requests, sessions, links, identities];
    void refresh();
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(visible, 15000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      for (const reader of [requests, sessions, links, identities]) reader.close();
      readers.current = [];
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [scope, active, instanceId, owner?.context, owner?.status, call, accountChanged, refresh]);
  const current = active && state?.scope === scope ? state : undefined;
  const grouped = groupConversationRequests(
    (current?.sessions ?? []).map((session) => ({
      ...session,
      peer: conversationPeer(
        session.preview?.peer,
        current?.communications ?? [],
        Boolean(owner?.account?.agent_id && owner.account.agent_id === current?.links.agentId),
      ),
    })),
    current?.requests ?? empty,
    current?.links.links ?? [],
    Boolean(owner?.account?.agent_id && owner.account.agent_id === current?.links.agentId),
  );
  return {
    ...grouped,
    inboxCount: new Set([
      ...grouped.inbox.permission_requests.map((r) => `permission:${r.id}`),
      ...grouped.inbox.input_requests.map((r) => `input:${r.id}`),
      ...(grouped.inbox.unconfirmed?.map((r) => `${r.kind}:${r.id}`) ?? []),
    ]).size,
    loaded: Boolean(current?.requests),
    sessionError: current?.sessionError ?? "",
    incompleteLinks: current?.links.hasMore ?? false,
    source: {
      data: current?.requests,
      loading: !current?.requests && !current?.requestError,
      error: current?.requestError ?? "",
      updated: current?.updated ?? "",
      refresh,
    } satisfies RequestSource,
    refresh,
    clearPreview(sessionId: string) {
      setState((previous) =>
        previous?.scope === scope
          ? {
              ...previous,
              sessions: previous.sessions.map((session) =>
                session.session_id === sessionId ? { ...session, preview: undefined } : session,
              ),
            }
          : previous,
      );
      void readers.current[1]?.refresh();
    },
  };
}
