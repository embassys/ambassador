import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ConversationPeer,
  chronologicalItems,
  incomingMessage,
} from "../../src/desktop/chat.js";
import type { ConversationPreview } from "../../src/desktop/conversation-preview.js";
import type { TranscriptPage } from "../../src/visible-transcripts.js";
import { Disclosure, SavedContent, StructuredData } from "./details.js";

export interface ConversationSession {
  session_id: string;
  agent_kind: string;
  status: string;
  last_used_at_ms: number;
  preview?: ConversationPreview | undefined;
  peer?: ConversationPeer | undefined;
}
export type ConversationPage =
  | TranscriptPage
  | {
      source: "provider";
      lines: readonly string[];
      warnings: string[];
      hasMore: false;
      nextCursor: number;
    };
const providerNames: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};
const providerName = (value: string) =>
  Object.hasOwn(providerNames, value) ? providerNames[value] : value;
const date = (value: number) =>
  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const time = (value: number) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function ConversationList({
  sessions,
  selected,
  select,
  attention,
}: {
  sessions: ConversationSession[];
  selected: string;
  select(id: string): void;
  attention?:
    | ReadonlyMap<string, { total: number; input_requests: readonly unknown[] }>
    | undefined;
}) {
  return (
    <section className="session-list" aria-label="Saved conversations">
      {sessions.map((item) => (
        <button
          type="button"
          className="session-row"
          key={item.session_id}
          onClick={() => select(item.session_id)}
          aria-pressed={selected === item.session_id}
          title={`${item.peer?.name ?? "Unknown agent"} · ${item.peer?.email ?? item.peer?.agentId ?? "Identity unavailable"}\n${item.preview?.title ?? "Conversation"}\n${item.preview?.excerpt ?? "Preview unavailable"}\n${providerName(item.agent_kind)} · ${item.session_id} · ${date(item.last_used_at_ms)} ${time(item.last_used_at_ms)}`}
        >
          <span className="session-copy">
            <span className="session-topic">
              {item.peer?.name ?? `Agent · ${item.session_id.slice(-4)}`}
            </span>
            <span className="session-excerpt">
              {item.preview?.title ?? `${providerName(item.agent_kind)} · Preview unavailable`}
            </span>
          </span>
          {Boolean(attention?.get(item.session_id)?.total) && (
            <span
              className="conversation-attention"
              title={
                attention?.get(item.session_id)?.input_requests.length
                  ? "Answer needed"
                  : "Approval needed"
              }
            >
              <span aria-hidden="true" />
              <span className="sr-only">
                {attention?.get(item.session_id)?.input_requests.length
                  ? "Answer needed"
                  : "Approval needed"}
              </span>
              <span className="attention-count">{attention?.get(item.session_id)?.total}</span>
            </span>
          )}
          {!attention?.get(item.session_id)?.total && (
            <time className="session-date" dateTime={new Date(item.last_used_at_ms).toISOString()}>
              {date(item.last_used_at_ms)}
            </time>
          )}
        </button>
      ))}
    </section>
  );
}
export function ConversationHeading({ session }: { session?: ConversationSession | undefined }) {
  const peer = session?.peer;
  return (
    <div className="chat-heading">
      <span className="chat-avatar" aria-hidden="true">
        {initials(peer?.name)}
      </span>
      <div>
        <h1>{peer?.name ?? "Unknown agent"}</h1>
        <p>
          {peer?.email ?? (peer?.agentId ? `Agent ${peer.agentId}` : "Peer identity unavailable")}
          <span> · via Embassys</span>
        </p>
      </div>
    </div>
  );
}
const initials = (name?: string) =>
  name
    ? name
        .split(/\s+/u)
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toUpperCase()
    : "?";

export function ChatScroll({
  history,
  children,
}: {
  history: ConversationPage | undefined;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const loaded = useRef(false);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const content = body.current;
    const scroller = content?.closest<HTMLElement>(".page-body");
    if (!content || !scroller) return;
    const reviewing = () => Boolean(content.querySelector(".owner-review"));
    const onScroll = () => {
      pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72;
      setAway(!pinned.current && !reviewing());
      const top = scroller.getBoundingClientRect().top;
      const visible = Array.from(content.querySelectorAll<HTMLElement>("[data-chat-entry]")).find(
        (item) => item.getBoundingClientRect().bottom > top,
      );
      anchor.current = visible
        ? { id: visible.dataset.chatEntry ?? "", offset: visible.getBoundingClientRect().top - top }
        : undefined;
    };
    const resize = new ResizeObserver(() => {
      // A review owns its reading position while the owner considers a response.
      if (reviewing()) {
        setAway(false);
        return;
      }
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    });
    resize.observe(content);
    resize.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resize.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, []);
  useLayoutEffect(() => {
    const scroller = body.current?.closest<HTMLElement>(".page-body");
    if (!scroller) return;
    if (body.current?.querySelector(".owner-review")) return;
    if (!pinned.current && loaded.current && anchor.current) {
      const saved = anchor.current;
      const visible = Array.from(
        body.current?.querySelectorAll<HTMLElement>("[data-chat-entry]") ?? [],
      ).find((item) => item.dataset.chatEntry === saved.id);
      if (visible)
        scroller.scrollTop +=
          visible.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
    } else if (pinned.current || (!loaded.current && history)) {
      scroller.scrollTop = scroller.scrollHeight;
      pinned.current = true;
      setAway(false);
    }
    loaded.current = Boolean(history);
  }, [history]);
  return (
    <div className="conversation-pane chat-pane" ref={body}>
      {children}
      {away && (
        <button
          type="button"
          className="chat-jump"
          onClick={() => {
            pinned.current = true;
            setAway(false);
            const scroller = body.current?.closest<HTMLElement>(".page-body");
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
          }}
        >
          ↓ Latest messages
        </button>
      )}
    </div>
  );
}

export function ConversationContent({
  history,
  busy,
  sessionId,
  session,
  reload,
  next,
  remove,
}: {
  history: ConversationPage | undefined;
  busy: boolean;
  sessionId: string;
  session?: ConversationSession | undefined;
  reload(): void;
  next(): void;
  remove(): void;
}) {
  if (busy && !history)
    return (
      <section className="history history-placeholder" aria-busy="true">
        <p>Loading conversation…</p>
      </section>
    );
  if (!history)
    return (
      <section className="history history-placeholder">
        <h2>{sessionId ? "Conversation unavailable" : "Select a conversation"}</h2>
        <p>
          {sessionId
            ? "Try opening it again, or choose another conversation."
            : "Read the requests and replies saved on this device."}
        </p>
        {sessionId && (
          <button type="button" className="secondary" onClick={reload}>
            Try again
          </button>
        )}
      </section>
    );
  const items = history.source === "archive" ? chronologicalItems(history.items) : [];
  const peer = session?.peer;
  const ownLabel = `Your agent${session ? ` · ${providerName(session.agent_kind)}` : ""}`;
  let previousDate = "";
  return (
    <section className="history chat-history" aria-label="Conversation">
      <div className="chat-history-tools">
        <button
          type="button"
          className="text-button"
          disabled={!history.hasMore || busy}
          onClick={next}
        >
          Earlier messages
        </button>
        <Disclosure className="conversation-info" title="Conversation details">
          <p>{session?.preview?.title ?? "Saved conversation"}</p>
          <code>{sessionId}</code>
          <p>
            Saved locally for 30 days. Tool summaries are included; private reasoning is excluded. A
            finished agent turn does not confirm an action was completed.
          </p>
          {items.some((item) => item.kind === "turn" && item.status === "recording") && (
            <p>In progress or interrupted: the saved agent turn has no finish record.</p>
          )}
          <button type="button" className="text-button" onClick={reload}>
            Reload latest messages
          </button>
          <button type="button" className="text-button destructive-text" onClick={remove}>
            Delete local history…
          </button>
        </Disclosure>
      </div>
      {history.warnings.map((warning) => (
        <p className="quiet-note" role="status" key={warning}>
          {warning}
        </p>
      ))}
      <div className="chat-timeline">
        {history.source === "provider" ? (
          <>
            <p className="quiet-note">Provider preview · message authors are unavailable</p>
            <pre className="provider-preview">{history.lines.join("\n")}</pre>
          </>
        ) : (
          items.map((item) => {
            if (item.kind === "turn")
              return (item.status === "complete" || item.status === "recording") &&
                !item.reason ? null : (
                <p className="chat-status" key={item.id}>
                  {item.status === "recording"
                    ? "In progress or interrupted"
                    : item.status === "partial"
                      ? "Partial history"
                      : "Expired history"}
                  {item.reason ? ` · ${item.reason}` : ""}
                </p>
              );
            const day = new Date(item.createdAt).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
            const showDate = day !== previousDate;
            previousDate = day;
            const incoming = item.role === "user" ? incomingMessage(item.text) : undefined;
            const side =
              item.role === "agent" || item.role === "tool" ? "own" : (incoming?.side ?? "system");
            const label =
              side === "own"
                ? ownLabel
                : side === "peer"
                  ? `${peer?.name ?? "Other agent"}${peer?.email ? "’s agent" : ""}`
                  : side === "owner"
                    ? "You · via Embassys"
                    : "Embassys";
            return (
              <div key={item.id} className="chat-event">
                {showDate && <div className="chat-date">{day}</div>}
                {item.role === "tool" ? (
                  <div className="chat-tool" data-chat-entry={item.id}>
                    <Disclosure title="Tool activity" meta={time(item.createdAt)}>
                      <SavedContent text={item.text} />
                    </Disclosure>
                  </div>
                ) : (
                  <article
                    className={`chat-message chat-${side}`}
                    aria-label={label}
                    data-chat-entry={item.id}
                  >
                    <div className="chat-message-label">{label}</div>
                    <div className="chat-bubble">
                      {incoming ? (
                        <>
                          <strong className="chat-subject">{incoming.title}</strong>
                          {incoming.text && <ChatText text={incoming.text} />}
                          {!incoming.detailsOnly &&
                            incoming.fields !== undefined &&
                            !(
                              typeof incoming.fields === "object" &&
                              incoming.fields !== null &&
                              Object.keys(incoming.fields).length === 0
                            ) && <StructuredData value={incoming.fields} />}
                          <Disclosure className="chat-message-details" title="Message details">
                            <SavedContent text={item.text} />
                          </Disclosure>
                        </>
                      ) : (
                        <ChatText text={item.text} />
                      )}
                    </div>
                    <time dateTime={new Date(item.createdAt).toISOString()}>
                      {time(item.createdAt)}
                    </time>
                  </article>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
function ChatText({ text }: { text: string }) {
  return (
    <div className="chat-text">
      {text.split(/\n\s*\n/u).map((paragraph, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Saved paragraphs have stable positional identity and no interactive state.
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}
