import { useRef } from "react";
import type { GatewaySnapshot } from "../../src/desktop/protocol.js";
import type { RequestSnapshot } from "./conversation-workspace.js";
import { ConversationList, type ConversationSession } from "./history.js";
import { inboxEntries } from "./inbox-navigation.js";

export function Navigation({
  page,
  sessions,
  selected,
  selectSession,
  attention,
  inboxCount,
  requests,
  selectedRequest,
  selectRequest,
  error,
  requestError,
  requestsLoading,
  refresh,
}: {
  page: string;
  sessions: ConversationSession[];
  selected: string;
  selectSession(id: string): void;
  attention?:
    | ReadonlyMap<string, { total: number; input_requests: readonly unknown[] }>
    | undefined;
  inboxCount?: number | undefined;
  requests?: RequestSnapshot | undefined;
  selectedRequest?: string | undefined;
  selectRequest?(key: string): void;
  error?: string;
  requestError?: string;
  requestsLoading?: boolean;
  refresh?(): void;
}) {
  return (
    <nav className="conversation-nav" aria-label="Main navigation">
      <div
        className="conversation-nav-heading inbox-nav-heading"
        title="Account snapshot: up to 200 permissions and 200 questions. Older requests may be missing."
      >
        <h2>Inbox</h2>
        {Boolean(inboxCount) && <span className="sidebar-count">{inboxCount}</span>}
        <button
          type="button"
          className="text-button"
          aria-label="Refresh conversations and requests"
          onClick={refresh}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" />
          </svg>
        </button>
      </div>
      {requestError && (
        <p className="sidebar-note" role="status">
          {requestError}
        </p>
      )}
      {requestsLoading && (
        <p className="sidebar-note" role="status">
          Loading requests…
        </p>
      )}
      <section className="session-list sidebar-request-list" aria-label="Inbox requests">
        {inboxEntries(requests).map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="session-row request-nav-row"
            aria-pressed={page === "attention" && selectedRequest === entry.key}
            title={`${entry.label}: ${entry.detail}${entry.uncertain ? " · Awaiting confirmation" : ""}`}
            onClick={() => selectRequest?.(entry.key)}
          >
            <span className="session-copy">
              <span className="session-topic">{entry.label}</span>
              <span className="session-excerpt">
                {entry.uncertain ? "Awaiting confirmation" : entry.detail}
              </span>
            </span>
          </button>
        ))}
      </section>
      {!requestsLoading && !requestError && inboxCount === 0 && (
        <p className="sidebar-note">No requests</p>
      )}
      {requests?.unconfirmedMore && (
        <p className="sidebar-note">Showing the first 100 unconfirmed submissions.</p>
      )}
      <div className="conversation-nav-heading">
        <h2>Conversations</h2>
      </div>
      {error && (
        <p className="sidebar-note" role="status">
          {error}
        </p>
      )}
      <ConversationList
        sessions={sessions}
        selected={page === "conversations" ? selected : ""}
        select={selectSession}
        attention={attention}
      />
      {!sessions.length && !error && (
        <p className="sidebar-note">Conversations appear here when your agent handles a request.</p>
      )}
    </nav>
  );
}

const menuPages = [
  { id: "people", label: "People" },
  { id: "agents", label: "Connect agents" },
  { id: "permissions", label: "Access" },
] as const;
export function AppMenu({ select }: { select(page: (typeof menuPages)[number]["id"]): void }) {
  const popover = useRef<HTMLDivElement>(null);
  return (
    <div className="app-menu">
      <button
        className="app-menu-trigger"
        type="button"
        popoverTarget="app-menu-options"
        aria-label="More"
        title="People, agents and access"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      <div id="app-menu-options" popover="auto" ref={popover} className="app-menu-options">
        {menuPages.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              popover.current?.hidePopover();
              select(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsButton({ open }: { open(): void }) {
  return (
    <button type="button" className="toolbar-settings" onClick={open} title="Open Settings">
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="m9.5 3-.6 2.2-1.5.9-2.2-.6-2.5 4.3 1.6 1.6v1.7l-1.6 1.6 2.5 4.3 2.2-.6 1.5.9.6 2.2h5l.6-2.2 1.5-.9 2.2.6 2.5-4.3-1.6-1.6v-1.7l1.6-1.6-2.5-4.3-2.2.6-1.5-.9-.6-2.2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span>Settings</span>
    </button>
  );
}

export function serviceStatus(runtime: GatewaySnapshot | undefined) {
  if (!runtime) return { label: "Checking…", tone: "busy" };
  if (runtime.error || runtime.notice || runtime.state === "error")
    return { label: "Needs attention", tone: "error" };
  const states = {
    running: { label: "Running", tone: "running" },
    stopped: { label: "Paused", tone: "paused" },
    starting: { label: "Starting…", tone: "busy" },
    stopping: { label: "Pausing…", tone: "busy" },
  } as const;
  return states[runtime.state];
}

export function ServiceStatus({
  runtime,
  name,
  open,
}: {
  runtime: GatewaySnapshot | undefined;
  name: string | undefined;
  open(): void;
}) {
  const status = serviceStatus(runtime);
  return (
    <footer className="service-status-bar">
      <button
        type="button"
        onClick={open}
        title="Open local service settings"
        aria-label={`Local service: ${status.label}. Open Settings`}
      >
        <span className={`service-indicator ${status.tone}`} aria-hidden="true" />
        <span role="status">{status.label}</span>
      </button>
      <span className="service-instance" title={name}>
        {name}
      </span>
    </footer>
  );
}
