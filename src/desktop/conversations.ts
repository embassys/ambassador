export interface RequestLink {
  kind: "input" | "permission";
  requestId: string;
  sessionId: string;
}
export interface RequestLinkPage {
  agentId?: string | undefined;
  links: RequestLink[];
  hasMore: boolean;
  nextCursor: number;
}

/** Desktop-only view of recorded question/dispatch relationships. No inference. */
export function requestLinksPage(
  questions: {
    page(
      after: number,
      limit: number,
    ): {
      items: readonly {
        sequence: number;
        value: { remote_request_id?: string | undefined; source_message_id: string };
      }[];
      hasMore: boolean;
    };
  },
  sessionForMessage: (messageId: string) => string | undefined,
  agentId: string,
  after = 0,
): RequestLinkPage {
  const page = questions.page(after, 100);
  const links: RequestLink[] = [];
  for (const { value } of page.items) {
    if (!value.remote_request_id) continue;
    const sessionId = sessionForMessage(value.source_message_id);
    if (sessionId) links.push({ kind: "input", requestId: value.remote_request_id, sessionId });
  }
  return {
    agentId,
    links,
    hasMore: page.hasMore,
    nextCursor: page.items.at(-1)?.sequence ?? after,
  };
}

export function groupConversationRequests<
  S extends { session_id: string; last_used_at_ms: number },
  T extends {
    total: number;
    permission_requests: readonly { id: string }[];
    input_requests: readonly { id: string }[];
    unconfirmed?: readonly { id: string; kind?: string | undefined }[] | undefined;
  },
>(sessions: readonly S[], requests: T, links: readonly RequestLink[], sameIdentity: boolean) {
  const known = new Set(sessions.map((s) => s.session_id));
  const uncertain = new Set(requests.unconfirmed?.map((r) => `${r.kind}:${r.id}`));
  const destinations = new Map<string, Set<string>>();
  if (sameIdentity)
    for (const link of links) {
      const key = `${link.kind}:${link.requestId}`;
      const values = destinations.get(key) ?? new Set<string>();
      values.add(link.sessionId);
      destinations.set(key, values);
    }
  const destination = (kind: string, id: string) => {
    if (uncertain.has(`${kind}:${id}`)) return undefined;
    const values = destinations.get(`${kind}:${id}`);
    if (values?.size !== 1) return undefined;
    const value = [...values][0];
    return value && known.has(value) ? value : undefined;
  };
  function subset(sessionId?: string): T {
    const permission_requests = requests.permission_requests.filter(
      (r) => destination("permission", r.id) === sessionId,
    );
    const input_requests = requests.input_requests.filter(
      (r) => destination("input", r.id) === sessionId,
    );
    return {
      ...requests,
      permission_requests,
      input_requests,
      total: permission_requests.length + input_requests.length,
      ...(sessionId ? { unconfirmed: [], unconfirmedMore: false } : {}),
    };
  }
  const bySession = new Map(sessions.map((s) => [s.session_id, subset(s.session_id)]));
  const sorted = [...sessions].sort(
    (a, b) =>
      Number(Boolean(bySession.get(b.session_id)?.total)) -
        Number(Boolean(bySession.get(a.session_id)?.total)) ||
      b.last_used_at_ms - a.last_used_at_ms ||
      a.session_id.localeCompare(b.session_id),
  );
  return { inbox: subset(), bySession, sessions: sorted };
}
