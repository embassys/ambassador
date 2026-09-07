import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { controlPalette } from "../../src/desktop/appearance.js";
import type { DiagnosticPage, DiagnosticQuery } from "../../src/desktop/diagnostic-query.js";
import { suggestedInstancePort } from "../../src/desktop/instance-defaults.js";
import type { LoginItemState } from "../../src/desktop/login-item.js";
import type {
  DesktopCommand,
  DesktopInstance,
  GatewaySnapshot,
} from "../../src/desktop/protocol.js";
import type { GatewayOverview } from "../../src/gateway-application.js";
import type { TranscriptPage } from "../../src/visible-transcripts.js";

interface AppSnapshot {
  platform: string;
  appearance: "system" | "light" | "dark";
  dark: boolean;
  palette: ReturnType<typeof controlPalette>;
  appVersion: string;
  build: string;
  loginItem: LoginItemState;
  owner: { status: string; message: string };
  instances: (DesktopInstance & { runtime: GatewaySnapshot })[];
}
interface Session {
  session_id: string;
  agent_kind: string;
  status: string;
  last_used_at_ms: number;
}
interface Setup {
  endpoint: string;
  guides: {
    name: string;
    instruction: string;
    note: string;
    connect?: "claude_code" | "openclaw";
  }[];
}
declare global {
  interface Window {
    ambassador: {
      command(command: DesktopCommand): Promise<{ ok: boolean; result?: unknown; error?: string }>;
      copy(text: string): Promise<void>;
      onChange(callback: () => void): () => void;
    };
  }
}

const paths = {
  attention: "M12 3 3 7v6c0 4 9 8 9 8s9-4 9-8V7L12 3ZM12 8v5m0 3h.01",
  conversations: "M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 1 1 19 0ZM7 9h10M7 13h6",
  permissions: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
  agents: "M8 3h8v4H8zM4 7h16v13H4zM8 12h.01M16 12h.01M8 16h8M1 11v5M23 11v5",
  diagnostics: "M3 12h4l3-8 4 16 3-8h4",
  settings: "M4 7h16M4 17h16M9 4v6M15 14v6",
  arrow: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  server: "M3 3h18v7H3zM3 14h18v7H3zM7 6h.01M7 17h.01M11 6h6M11 17h6",
} as const;
type Page = "attention" | "conversations" | "permissions" | "agents" | "diagnostics" | "settings";
function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
const pages: { id: Page; label: string; description: string }[] = [
  { id: "attention", label: "Attention", description: "Requests and questions that need you." },
  {
    id: "conversations",
    label: "Conversations",
    description: "Follow the work your agents do with other people.",
  },
  {
    id: "permissions",
    label: "Permissions",
    description: "A clear record of who can access what.",
  },
  { id: "agents", label: "Agents", description: "Connect the tools you already use." },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Understand what happened, without the guesswork.",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Your account, local servers and preferences.",
  },
];

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [overview, setOverview] = useState<GatewayOverview>();
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem("ambassador.page");
    return pages.find((item) => item.id === saved)?.id ?? "attention";
  });
  const [selectedId, setSelectedId] = useState(
    () => localStorage.getItem("ambassador.instance") ?? "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [appearanceChoice, setAppearanceChoice] = useState<AppSnapshot["appearance"]>();
  const pendingAppearance = useRef<AppSnapshot["appearance"]>(undefined);
  const savingAppearance = useRef(false);
  const [copied, setCopied] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<
    | TranscriptPage
    | {
        source: "provider";
        lines: readonly string[];
        warnings: string[];
        hasMore: false;
        nextCursor: number;
      }
  >();
  const [historySession, setHistorySession] = useState("");
  const [logs, setLogs] = useState<DiagnosticPage>();
  const [logSearch, setLogSearch] = useState("");
  const [logFrom, setLogFrom] = useState("");
  const [logTo, setLogTo] = useState("");
  const [includeBodies, setIncludeBodies] = useState(false);
  const [exportPreview, setExportPreview] = useState<{
    previewId: string;
    recordCount: number;
    bytes: number;
    includeBodies: boolean;
    warnings: string[];
  }>();
  const [exportSaved, setExportSaved] = useState(false);
  const [chooseLocation, setChooseLocation] = useState(false);
  const createRequest = useRef(crypto.randomUUID());
  const [setup, setSetup] = useState<Setup>();
  const [connectionMessages, setConnectionMessages] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newPort, setNewPort] = useState("");
  const proposedPort = newPort || String(suggestedInstancePort(snapshot?.instances ?? []));
  const [loading, setLoading] = useState(false);
  const viewGeneration = useRef(0);

  const call = useCallback(async (command: DesktopCommand) => {
    const reply = await window.ambassador.command(command);
    if (!reply.ok) throw new Error(reply.error ?? "The operation could not finish.");
    return reply.result;
  }, []);
  const refresh = useCallback(async () => {
    try {
      setSnapshot((await call({ type: "snapshot" })) as AppSnapshot);
    } catch {
      setError("The app could not refresh its server state.");
    }
  }, [call]);
  useEffect(() => {
    void refresh();
    return window.ambassador.onChange(() => {
      void refresh();
    });
  }, [refresh]);
  const selected =
    snapshot?.instances.find((instance) => instance.id === selectedId) ?? snapshot?.instances[0];
  const id = selected?.id;
  const runtimeState = selected?.runtime.state;
  useEffect(() => {
    if (!id || (page !== "attention" && page !== "settings")) return;
    let current = true;
    let reading = false;
    setOverview(undefined);
    const update = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await call({ type: "overview", instanceId: id });
        if (current) setOverview(result as GatewayOverview);
      } catch {
        if (current) setError("Agent activity is unavailable. Check this instance in Diagnostics.");
      } finally {
        reading = false;
      }
    };
    void update();
    const timer = runtimeState === "running" ? setInterval(() => void update(), 5000) : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [id, runtimeState, page, call]);
  useEffect(() => {
    if (!snapshot) return;
    document.documentElement.dataset.platform = snapshot.platform;
    document.documentElement.dataset.theme = snapshot.dark ? "dark" : "light";
    document.documentElement.style.setProperty("--control-accent", snapshot.palette.accent);
    document.documentElement.style.setProperty(
      "--control-accent-text",
      snapshot.palette.accentText,
    );
    document.documentElement.style.setProperty("--accent", snapshot.palette.link);
  }, [snapshot]);
  useEffect(() => {
    localStorage.setItem("ambassador.page", page);
    if (id) localStorage.setItem("ambassador.instance", id);
  }, [page, id]);

  useEffect(() => {
    let current = true;
    viewGeneration.current++;
    setHistory(undefined);
    setHistorySession("");
    setSessions([]);
    setSetup(undefined);
    setConnectionMessages({});
    setExportPreview(undefined);
    setExportSaved(false);
    setLogs(undefined);
    setLogSearch("");
    setLogFrom("");
    setLogTo("");
    setBusy(savingAppearance.current);
    setError("");
    if (!id || !["conversations", "diagnostics", "agents"].includes(page)) return;
    setLoading(true);
    const command: DesktopCommand =
      page === "conversations"
        ? { type: "sessions", instanceId: id }
        : page === "diagnostics"
          ? { type: "logs", instanceId: id }
          : { type: "setup", instanceId: id };
    void call(command)
      .then((result) => {
        if (!current) return;
        if (page === "conversations") setSessions(result as Session[]);
        else if (page === "diagnostics") setLogs(result as DiagnosticPage);
        else setSetup(result as Setup);
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : "This view is unavailable.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [id, page, call]);

  async function chooseAppearance(value: AppSnapshot["appearance"]) {
    pendingAppearance.current = value;
    setAppearanceChoice(value);
    if (savingAppearance.current) return;
    savingAppearance.current = true;
    setBusy(true);
    setError("");
    try {
      while (pendingAppearance.current !== undefined) {
        const next = pendingAppearance.current;
        pendingAppearance.current = undefined;
        setSnapshot((await call({ type: "set_appearance", appearance: next })) as AppSnapshot);
      }
    } catch {
      pendingAppearance.current = undefined;
      setError("Your appearance preference could not be saved. Try again.");
    } finally {
      savingAppearance.current = false;
      setAppearanceChoice(undefined);
      setBusy(false);
    }
  }

  async function mutate(command: DesktopCommand) {
    setBusy(true);
    setError("");
    try {
      const result = await call(command);
      if (
        command.type === "create" &&
        result &&
        typeof result === "object" &&
        "createdInstanceId" in result &&
        typeof result.createdInstanceId === "string"
      ) {
        setSelectedId(result.createdInstanceId);
        setNewName("");
        setNewPort("");
        createRequest.current = crypto.randomUUID();
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation could not finish.");
    } finally {
      setBusy(false);
    }
  }
  async function connectAgent(
    provider: "claude_code" | "openclaw",
    operation: "connect" | "check" | "repair" | "disconnect" = "connect",
  ) {
    if (!id) return;
    const generation = ++viewGeneration.current;
    setBusy(true);
    setConnectionMessages((previous) => ({ ...previous, [provider]: "Checking settings…" }));
    try {
      const result = (await call({
        type: "agent_connection",
        instanceId: id,
        provider,
        operation,
      })) as { message: string };
      if (generation === viewGeneration.current)
        setConnectionMessages((previous) => ({ ...previous, [provider]: result.message }));
    } catch {
      if (generation === viewGeneration.current)
        setConnectionMessages((previous) => ({
          ...previous,
          [provider]: "Setup could not finish. Review the provider's settings before trying again.",
        }));
    } finally {
      if (generation === viewGeneration.current) setBusy(false);
    }
  }
  async function copy(text: string, key: string) {
    await window.ambassador.copy(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1800);
  }
  async function loadHistory(sessionId: string, after = 0) {
    if (!id) return;
    const generation = ++viewGeneration.current;
    setHistorySession(sessionId);
    setBusy(true);
    try {
      const result = await call({ type: "history", instanceId: id, sessionId, after });
      if (viewGeneration.current === generation) setHistory(result as NonNullable<typeof history>);
    } catch {
      if (viewGeneration.current === generation)
        setError("This conversation could not be loaded. Check Diagnostics for this instance.");
    } finally {
      if (viewGeneration.current === generation) setBusy(false);
    }
  }
  async function deleteHistory() {
    if (!id || !historySession) return;
    const generation = viewGeneration.current;
    setBusy(true);
    try {
      const result = (await call({
        type: "history_delete",
        instanceId: id,
        sessionId: historySession,
      })) as { deleted: boolean };
      if (generation === viewGeneration.current && result.deleted)
        setHistory({
          source: "archive",
          items: [],
          warnings: ["Local history deleted. Provider history and pending work remain."],
          nextCursor: 0,
          hasMore: false,
        });
    } catch {
      if (generation === viewGeneration.current) setError("Local history could not be deleted.");
    } finally {
      if (generation === viewGeneration.current) setBusy(false);
    }
  }
  function logQuery(offset = 0): DiagnosticQuery {
    return {
      search: logSearch,
      offset,
      limit: 100,
      ...(logFrom ? { from: new Date(logFrom).toISOString() } : {}),
      ...(logTo ? { to: new Date(logTo).toISOString() } : {}),
    };
  }
  async function loadLogs(offset = 0) {
    if (!id) return;
    const generation = viewGeneration.current;
    setLoading(true);
    try {
      const result = await call({ type: "logs", instanceId: id, query: logQuery(offset) });
      if (generation === viewGeneration.current) setLogs(result as DiagnosticPage);
    } catch {
      if (generation === viewGeneration.current)
        setError("Could not load logs. Check the selected dates and server.");
    } finally {
      if (generation === viewGeneration.current) setLoading(false);
    }
  }
  async function prepareExport() {
    if (!id) return;
    const generation = viewGeneration.current;
    setBusy(true);
    setExportSaved(false);
    setExportPreview(undefined);
    try {
      const result = await call({
        type: "export_prepare",
        instanceId: id,
        includeBodies,
        query: logQuery(),
      });
      if (generation === viewGeneration.current)
        setExportPreview(result as NonNullable<typeof exportPreview>);
    } catch {
      if (generation === viewGeneration.current)
        setError("Could not prepare the export. Try a shorter time range.");
    } finally {
      if (generation === viewGeneration.current) setBusy(false);
    }
  }
  async function saveExport() {
    if (!id || !exportPreview) return;
    const generation = viewGeneration.current;
    setBusy(true);
    try {
      const result = (await call({
        type: "export_save",
        instanceId: id,
        previewId: exportPreview.previewId,
      })) as { saved: boolean };
      if (generation === viewGeneration.current && result.saved) {
        setExportSaved(true);
        setExportPreview(undefined);
      }
    } catch {
      if (generation === viewGeneration.current)
        setError("Could not save. Prepare a fresh export and choose a new filename.");
    } finally {
      if (generation === viewGeneration.current) setBusy(false);
    }
  }
  const running = selected?.runtime.state === "running";
  const endpoint = selected ? `http://127.0.0.1:${selected.port}/mcp` : "";
  const currentPage = pages.find((item) => item.id === page) ?? {
    label: "Embassys",
    description: "Your local workspace",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/brand.svg" alt="" />
          <span>Embassys</span>
        </div>
        <div className="workspace-label">Workspace</div>
        <nav aria-label="Main navigation">
          {pages.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <Icon name={item.id} />
              <span>{item.label}</span>
              {page === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="instance-label">Local instance</div>
          <label className="sr-only" htmlFor="instance-select">
            Selected instance
          </label>
          <select
            id="instance-select"
            value={selected?.id ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {snapshot?.instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>
          <div className="connection">
            <span className={`status-dot ${running ? "green" : "amber"}`} />
            {running
              ? "Local server running"
              : selected?.runtime.state === "error"
                ? "Server needs attention"
                : "Server stopped"}
          </div>
          <div className="version">Development preview · {snapshot?.appVersion ?? "…"}</div>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <h1>{currentPage.label}</h1>
            <p>{currentPage.description}</p>
          </div>
          <span className={`toolbar-status ${running ? "is-running" : ""}`}>
            <span className={`status-dot ${running ? "green" : "amber"}`} />
            {selected?.name ?? "Workspace"}
          </span>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {selected?.runtime.error && <div className="error-banner">{selected.runtime.error}</div>}
        {!snapshot ? (
          <div className="empty-state">Opening your workspace…</div>
        ) : (
          <>
            {page === "attention" &&
              (overview === undefined ? (
                <p role="status">Loading agent activity…</p>
              ) : overview.enrollment.verified === true ? (
                <>
                  <section className="settings-section identity-card">
                    <img className="brand-mark" src="/brand.svg" alt="" />
                    <div>
                      <h3>Agent registered</h3>
                      <p className="body-note break">{overview.enrollment.email}</p>
                    </div>
                    <span className="subtle-tag">
                      {overview.enrollment.credential_status === "active"
                        ? "Verified"
                        : "Credentials need attention"}
                    </span>
                  </section>
                  <div className="section-title">
                    <h3>Agent activity</h3>
                  </div>
                  <div className="steps">
                    <div className="step">
                      <Icon name="attention" />
                      <div>
                        <h4>
                          {overview.pendingCalls} incoming{" "}
                          {overview.pendingCalls === 1 ? "request" : "requests"} pending
                        </h4>
                        <p>
                          {overview.pendingCalls
                            ? "Open the conversation to see the agent's progress. Approval and question emails go to the owner."
                            : "Your agent has no pending incoming actions saved on this device."}
                        </p>
                      </div>
                    </div>
                    <div className="step">
                      <Icon name="conversations" />
                      <div>
                        <h4>
                          {overview.sessionCount} saved{" "}
                          {overview.sessionCount === 1 ? "conversation" : "conversations"}
                        </h4>
                        <p>Available conversation history stays here when the app restarts.</p>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setPage("conversations")}
                      >
                        View
                      </button>
                    </div>
                    <div className="step">
                      <Icon name="check" />
                      <div>
                        <h4>
                          {overview.receivedResults} saved{" "}
                          {overview.receivedResults === 1 ? "result" : "results"}
                        </h4>
                        <p>Results stay available until your requesting agent confirms receipt.</p>
                      </div>
                    </div>
                  </div>
                  <p className="quiet-note">
                    App sign-in, approval controls and push notifications are not available in this
                    preview. Use the email sent for each owner decision.
                  </p>
                </>
              ) : (
                <>
                  <section className="welcome-card">
                    <img className="welcome-logo" src="/brand.svg" alt="" />
                    <h2>Welcome to Embassys</h2>
                    <p>Connect your agent to exchange requests with other people's agents.</p>
                    <button type="button" className="primary" onClick={() => setPage("agents")}>
                      Set up an agent <Icon name="arrow" size={16} />
                    </button>
                  </section>
                  <div className="section-title">
                    <h3>Getting connected</h3>
                    <span>Your first steps</span>
                  </div>
                  <div className="steps">
                    <div className="step">
                      <div className={`step-number ${running ? "complete" : ""}`}>
                        {running ? <Icon name="check" size={18} /> : "1"}
                      </div>
                      <div>
                        <h4>Start your local server</h4>
                        <p>
                          {running
                            ? "Running quietly in the background."
                            : "Start it from Settings when you're ready."}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setPage("settings")}
                      >
                        Manage
                      </button>
                    </div>
                    <div className="step">
                      <div className="step-number">2</div>
                      <div>
                        <h4>Connect an agent</h4>
                        <p>Add Embassys to the agent you already use.</p>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setPage("agents")}
                      >
                        Set up
                      </button>
                    </div>
                    <div className="step">
                      <div className="step-number muted">3</div>
                      <div>
                        <h4>Sign in to your account</h4>
                        <p>App sign-in and approval notifications are being built next.</p>
                      </div>
                      <span className="subtle-tag">Coming next</span>
                    </div>
                  </div>
                  <div className="quiet-note">
                    <Icon name="attention" size={18} />
                    <span>
                      This preview runs the real local server. The owner inbox is not connected yet.
                    </span>
                  </div>
                </>
              ))}
            {page === "agents" && (
              <>
                <div className="endpoint-card">
                  <div>
                    <span className="eyebrow">THIS INSTANCE'S MCP ADDRESS</span>
                    <code>{endpoint}</code>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void copy(endpoint, "endpoint")}
                  >
                    {copied === "endpoint" ? "Copied" : "Copy address"}
                  </button>
                </div>
                <p className="body-note">
                  Add Embassys to your agent using the instructions below. Guided setup is available
                  for tested clients on this platform. Use separate provider profiles for different
                  instances.
                </p>
                {loading ? (
                  <p>Loading setup instructions…</p>
                ) : (
                  <div className="agent-grid">
                    {setup?.guides.map((guide, index) => (
                      <section className="agent-card" key={guide.name}>
                        <div className="agent-heading">
                          <div className={`agent-avatar color-${index}`}>{guide.name[0]}</div>
                          <div>
                            <h3>{guide.name}</h3>
                            <span className="muted-text">
                              {guide.connect ? "Guided setup" : "Manual setup"}
                            </span>
                          </div>
                        </div>
                        <p>{guide.note}</p>
                        {guide.connect && connectionMessages[guide.connect] && (
                          <p className="quiet-note" role="status">
                            {connectionMessages[guide.connect]}
                          </p>
                        )}
                        {guide.connect && (
                          <button
                            type="button"
                            className="primary"
                            disabled={busy || !running}
                            onClick={() => {
                              if (guide.connect) void connectAgent(guide.connect);
                            }}
                          >
                            Connect {guide.name}
                          </button>
                        )}
                        {guide.connect && (
                          <div className="button-row">
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                if (guide.connect) void connectAgent(guide.connect, "check");
                              }}
                            >
                              Check settings
                            </button>
                            <details>
                              <summary>Manage connection</summary>
                              <div className="button-row">
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={busy || !running}
                                  onClick={() => {
                                    if (guide.connect) void connectAgent(guide.connect, "repair");
                                  }}
                                >
                                  Repair
                                </button>
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() => {
                                    if (guide.connect)
                                      void connectAgent(guide.connect, "disconnect");
                                  }}
                                >
                                  Disconnect…
                                </button>
                              </div>
                            </details>
                          </div>
                        )}
                        {guide.connect && !running && (
                          <p className="body-note">Start this instance from Settings to connect.</p>
                        )}
                        <details>
                          <summary>Setup instructions</summary>
                          <pre>{guide.instruction}</pre>
                        </details>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void copy(guide.instruction, guide.name)}
                        >
                          {copied === guide.name ? "Copied" : "Copy instructions"}
                        </button>
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
            {page === "conversations" && (
              <>
                <div className="quiet-note">
                  <Icon name="conversations" size={18} />
                  <span>
                    Visible text is saved for 30 days. Tool summaries are included; private
                    reasoning is excluded. Older provider history may be a partial preview.
                  </span>
                </div>
                {loading ? (
                  <p>Loading sessions…</p>
                ) : sessions.length === 0 ? (
                  <Empty
                    icon="conversations"
                    title="Conversations will appear here"
                    text="When your agent handles a request from another person, its session will be listed here."
                  />
                ) : (
                  <div className="session-layout">
                    <div className="session-list">
                      {sessions.map((item) => (
                        <button
                          type="button"
                          className="session-row"
                          key={item.session_id}
                          onClick={() => void loadHistory(item.session_id)}
                          aria-pressed={historySession === item.session_id}
                        >
                          <strong>{item.agent_kind}</strong>
                          <small>{item.session_id.slice(0, 16)}…</small>
                          <span>{new Date(item.last_used_at_ms).toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                    <section className="history">
                      {busy ? (
                        "Loading conversation…"
                      ) : history ? (
                        <>
                          <p className="body-note">
                            {history.source === "archive"
                              ? "Saved by Embassys"
                              : "Provider preview"}
                          </p>
                          {history.warnings.map((warning) => (
                            <p className="quiet-note" key={warning}>
                              {warning}
                            </p>
                          ))}
                          {history.source === "provider" ? (
                            <pre>{history.lines.join("\n")}</pre>
                          ) : (
                            history.items.map((item) =>
                              item.kind === "turn" ? (
                                <div className="turn-marker" key={item.id}>
                                  <strong>{item.actionType}</strong>
                                  <span>
                                    {item.status === "recording"
                                      ? "In progress or interrupted"
                                      : item.status}
                                  </span>
                                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                                  {item.reason && <p>{item.reason}</p>}
                                </div>
                              ) : item.role === "user" || item.role === "tool" ? (
                                <details className="transcript-detail" key={item.id}>
                                  <summary>
                                    {item.role === "user" ? "Incoming request" : "Tool activity"}
                                  </summary>
                                  <pre>{item.text}</pre>
                                </details>
                              ) : (
                                <div className="transcript-message" key={item.id}>
                                  {item.text}
                                </div>
                              ),
                            )
                          )}
                          <div className="button-row">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => void loadHistory(historySession)}
                            >
                              First page
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={!history.hasMore}
                              onClick={() => void loadHistory(historySession, history.nextCursor)}
                            >
                              Next page
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => void deleteHistory()}
                            >
                              Delete local history…
                            </button>
                          </div>
                        </>
                      ) : (
                        <p>Select a session to read the available history.</p>
                      )}
                    </section>
                  </div>
                )}
              </>
            )}
            {page === "permissions" && (
              <>
                <div className="segmented">
                  <span className="chosen">Access I granted</span>
                  <span>Access granted to me</span>
                </div>
                <Empty
                  icon="permissions"
                  title="Your permissions, in one place"
                  text="Owner sign-in will connect your permission history and requests. This preview does not grant, revoke or change access."
                />
              </>
            )}
            {page === "diagnostics" && (
              <>
                <div className="health-grid">
                  <div className="health-card">
                    <span>Local server</span>
                    <strong>{selected?.runtime.state ?? "Stopped"}</strong>
                  </div>
                  <div className="health-card">
                    <span>Port</span>
                    <strong>{selected?.port}</strong>
                  </div>
                  <div className="health-card">
                    <span>Log retention</span>
                    <strong>4 × 8 MiB</strong>
                  </div>
                </div>
                <div className="section-title">
                  <h3>Events</h3>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      if (id) void mutate({ type: "reveal_logs", instanceId: id });
                    }}
                  >
                    Open log folder
                  </button>
                </div>
                <form
                  className="log-filters"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void loadLogs();
                  }}
                >
                  <label>
                    Search events or request IDs
                    <input
                      value={logSearch}
                      maxLength={128}
                      onChange={(event) => setLogSearch(event.target.value)}
                      placeholder="Request ID, action or error"
                    />
                  </label>
                  <label>
                    From
                    <input
                      type="datetime-local"
                      value={logFrom}
                      onChange={(event) => setLogFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    Until
                    <input
                      type="datetime-local"
                      value={logTo}
                      onChange={(event) => setLogTo(event.target.value)}
                    />
                  </label>
                  <button type="submit" className="secondary" disabled={loading}>
                    Apply
                  </button>
                </form>
                <div className="quiet-note">
                  Development logs retain request and response bodies with credentials removed.
                  Times use your local timezone.
                </div>
                {logs?.warnings.map((warning) => (
                  <p className="quiet-note" key={warning}>
                    {warning}
                  </p>
                ))}
                {loading ? (
                  <p role="status">Loading diagnostics…</p>
                ) : (
                  <div className="log-list">
                    {logs?.records.length ? (
                      logs.records.map((record) => (
                        <details key={record.id}>
                          <summary>
                            <time>{new Date(record.timestamp).toLocaleString()}</time>
                            <span>{record.event}</span>
                          </summary>
                          <pre>{JSON.stringify(record.data ?? {}, null, 2)}</pre>
                        </details>
                      ))
                    ) : (
                      <Empty
                        icon="diagnostics"
                        title="No matching events"
                        text="Try another filter, or start the server to record activity."
                      />
                    )}
                  </div>
                )}
                <div className="section-title">
                  <p className="body-note">
                    {logs?.total ?? 0} matching events. Showing up to 100 per page.
                  </p>
                  <div className="button-row">
                    <button
                      type="button"
                      className="text-button"
                      disabled={loading}
                      onClick={() => void loadLogs()}
                    >
                      Newest
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={loading || !logs?.hasMore}
                      onClick={() => void loadLogs(logs?.nextOffset)}
                    >
                      Older events
                    </button>
                  </div>
                </div>
                <section className="settings-section">
                  <h3>Export diagnostics</h3>
                  <p className="body-note">
                    Exports use your current search and time range. Nothing is uploaded.
                  </p>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={includeBodies}
                      onChange={(event) => {
                        setIncludeBodies(event.target.checked);
                        setExportPreview(undefined);
                      }}
                    />{" "}
                    Include request and response bodies
                  </label>
                  <p className="body-note">
                    Credentials are always removed. Bodies can contain personal messages and action
                    results.
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void prepareExport()}
                  >
                    Preview export
                  </button>
                  {exportPreview && (
                    <div className="export-preview" role="status">
                      <strong>
                        {exportPreview.recordCount} events · {Math.ceil(exportPreview.bytes / 1024)}{" "}
                        KiB
                      </strong>
                      <p>
                        {exportPreview.includeBodies
                          ? "Includes redacted request and response bodies."
                          : "Event metadata only. Request and response bodies are omitted."}
                      </p>
                      {exportPreview.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => void saveExport()}
                      >
                        Save export…
                      </button>
                    </div>
                  )}
                  {exportSaved && <p role="status">Export saved.</p>}
                </section>
              </>
            )}
            {page === "settings" && (
              <>
                <section className="settings-section">
                  <h3>Appearance</h3>
                  <div className="settings-row">
                    <div>
                      <strong>Theme</strong>
                      <p>Follow your system, or choose a light or dark appearance.</p>
                    </div>
                    {snapshot.platform === "darwin" ? (
                      <fieldset
                        className="appearance-control"
                        disabled={busy && !savingAppearance.current}
                      >
                        <legend className="visually-hidden">Appearance</legend>
                        {(["system", "light", "dark"] as const).map((value) => (
                          <label key={value}>
                            <input
                              className="visually-hidden"
                              type="radio"
                              name="appearance"
                              value={value}
                              checked={(appearanceChoice ?? snapshot.appearance) === value}
                              onChange={() => void chooseAppearance(value)}
                            />
                            <span>
                              {value === "system" ? "System" : value === "light" ? "Light" : "Dark"}
                            </span>
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      <select
                        aria-label="Appearance"
                        value={appearanceChoice ?? snapshot.appearance}
                        disabled={busy && !savingAppearance.current}
                        onChange={(event) =>
                          void chooseAppearance(event.target.value as AppSnapshot["appearance"])
                        }
                      >
                        <option value="system">System</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    )}
                  </div>
                </section>
                <section className="settings-section">
                  <h3>Startup</h3>
                  <div className="settings-row">
                    <div>
                      <strong>Launch at login</strong>
                      <p>{snapshot.loginItem.message}</p>
                      <p>Stopping an individual server keeps it stopped on the next app launch.</p>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !snapshot.loginItem.canChange}
                      onClick={() =>
                        void mutate({
                          type: "set_launch_at_login",
                          enabled: !snapshot.loginItem.configured,
                        })
                      }
                    >
                      {snapshot.loginItem.canChange
                        ? snapshot.loginItem.configured
                          ? "Turn off"
                          : "Turn on"
                        : "Unavailable"}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    Refresh startup status
                  </button>
                </section>
                <section className="settings-section">
                  <h3>Account</h3>
                  {overview?.enrollment.verified === true && (
                    <div className="settings-row">
                      <div>
                        <strong>Registered agent</strong>
                        <p className="break">{overview.enrollment.email}</p>
                        <p>
                          This is the agent's saved identity. Owner account sign-in is separate.
                        </p>
                      </div>
                      <span className="subtle-tag">Verified</span>
                    </div>
                  )}
                  <div className="settings-row">
                    <div>
                      <strong>Sign in with your email</strong>
                      <p>
                        App sign-in is not available in this build. Existing agent registration is
                        separate.
                      </p>
                    </div>
                    <span className="subtle-tag">Coming next</span>
                  </div>
                </section>
                {selected && (
                  <section className="settings-section">
                    <h3>{selected.name}</h3>
                    <div className="settings-row">
                      <div>
                        <strong>Local server</strong>
                        <p>
                          {running
                            ? "Keeps running when you close this window."
                            : "Your saved state stays here while the server is stopped."}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={running ? "secondary" : "primary"}
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            type: running ? "stop" : "start",
                            instanceId: selected.id,
                          })
                        }
                      >
                        {running
                          ? "Stop server"
                          : selected.runtime.state === "error"
                            ? "Retry start"
                            : "Start server"}
                      </button>
                    </div>
                    <div className="settings-row">
                      <div>
                        <strong>MCP address</strong>
                        <p className="mono">{endpoint}</p>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void copy(endpoint, "settings-endpoint")}
                      >
                        {copied === "settings-endpoint" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <div className="settings-row">
                      <div>
                        <strong>Data location</strong>
                        <p className="mono break">{selected.stateDirectory}</p>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div>
                        <strong>Clean local instance</strong>
                        <p>
                          Clear local registration and work. Keep logs and provider configuration.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            type: "clean",
                            instanceId: selected.id,
                            confirmation: "clear-local-instance",
                          })
                        }
                      >
                        Clean…
                      </button>
                    </div>
                  </section>
                )}
                <section className="settings-section">
                  <h3>Another local instance</h3>
                  <p className="body-note">
                    Create an isolated server with its own port and storage. This build uses the
                    bundled engine version for each instance.
                  </p>
                  <form
                    className="create-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate({
                        type: "create",
                        requestId: createRequest.current,
                        name: newName,
                        port: Number(proposedPort),
                        chooseLocation,
                      });
                    }}
                  >
                    <label>
                      Name
                      <input
                        value={newName}
                        onChange={(event) => {
                          setNewName(event.target.value);
                          createRequest.current = crypto.randomUUID();
                        }}
                        required
                        maxLength={80}
                        placeholder="Development"
                      />
                    </label>
                    <label className="port-input">
                      Port
                      <input
                        type="number"
                        min={1024}
                        max={65535}
                        value={proposedPort}
                        onChange={(event) => {
                          setNewPort(event.target.value);
                          createRequest.current = crypto.randomUUID();
                        }}
                        required
                      />
                    </label>
                    <button
                      type="submit"
                      className="secondary"
                      disabled={busy || snapshot.instances.length >= 8}
                    >
                      Create instance
                    </button>
                  </form>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={chooseLocation}
                      onChange={(event) => {
                        setChooseLocation(event.target.checked);
                        createRequest.current = crypto.randomUUID();
                      }}
                    />{" "}
                    Choose where to store this instance
                  </label>
                </section>
                <p className="body-note">
                  Closing the window keeps Embassys in the menu bar. Quit Embassys stops its
                  servers. Updates and account recovery will follow in later development stages.
                </p>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Empty({ icon, title, text }: { icon: keyof typeof paths; title: string; text: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={30} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
