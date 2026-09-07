import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  DesktopCommand,
  DesktopInstance,
  GatewaySnapshot,
} from "../../src/desktop/protocol.js";

interface AppSnapshot {
  appVersion: string;
  build: string;
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
  guides: { name: string; instruction: string; note: string }[];
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
  const [page, setPage] = useState<Page>("attention");
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<string[]>();
  const [logs, setLogs] = useState<{ id: string; entry: unknown }[]>([]);
  const [setup, setSetup] = useState<Setup>();
  const [newName, setNewName] = useState("");
  const [newPort, setNewPort] = useState("8788");
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

  useEffect(() => {
    let current = true;
    viewGeneration.current++;
    setHistory(undefined);
    setBusy(false);
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
        else if (page === "diagnostics")
          setLogs((result as unknown[]).map((entry) => ({ id: crypto.randomUUID(), entry })));
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

  async function mutate(command: DesktopCommand) {
    setBusy(true);
    setError("");
    try {
      await call(command);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation could not finish.");
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string, key: string) {
    await window.ambassador.copy(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1800);
  }
  const running = selected?.runtime.state === "running";
  const endpoint = selected ? `http://127.0.0.1:${selected.port}/mcp` : "";
  const currentPage = pages.find((item) => item.id === page) ?? {
    label: "Ambassador",
    description: "Your local workspace",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <span>Ambassador</span>
        </div>
        <div className="workspace-label">YOUR WORKSPACE</div>
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
          <div className="instance-label">LOCAL INSTANCE</div>
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
          <span className="preview-tag">DEVELOPMENT</span>
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
            {page === "attention" && (
              <>
                <section className="welcome-card">
                  <div className="eyebrow">MEET YOUR AMBASSADOR</div>
                  <h2>
                    Your agents.
                    <br />
                    Working together.
                  </h2>
                  <p>
                    A home for the requests, conversations and decisions
                    <br className="wide-only" /> that move between you and other people's agents.
                  </p>
                  <button type="button" className="primary" onClick={() => setPage("agents")}>
                    Set up an agent <Icon name="arrow" size={16} />
                  </button>
                  <div className="welcome-art" aria-hidden="true">
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <div className="art-core">
                      <Icon name="agents" size={44} />
                    </div>
                    <span className="satellite satellite-one">
                      <Icon name="conversations" size={24} />
                    </span>
                    <span className="satellite satellite-two">
                      <Icon name="check" size={22} />
                    </span>
                  </div>
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
                      <p>Add Ambassador to the agent you already use.</p>
                    </div>
                    <button type="button" className="text-button" onClick={() => setPage("agents")}>
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
            )}
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
                  Use the setup instructions below. Automatic connection and verification will be
                  added next. For multiple instances, use separate provider profiles so requests
                  reach the intended identity.
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
                            <span className="muted-text">Manual setup</span>
                          </div>
                        </div>
                        <p>{guide.note}</p>
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
                    These are Ambassador-managed sessions. Provider history may be a partial
                    preview.
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
                          onClick={() => {
                            if (id) {
                              const generation = ++viewGeneration.current;
                              setBusy(true);
                              void call({
                                type: "history",
                                instanceId: id,
                                sessionId: item.session_id,
                              })
                                .then((result) => {
                                  if (viewGeneration.current === generation)
                                    setHistory(result as string[]);
                                })
                                .catch(() => {
                                  if (viewGeneration.current === generation)
                                    setError(
                                      "Start the server and check the provider to load this history.",
                                    );
                                })
                                .finally(() => {
                                  if (viewGeneration.current === generation) setBusy(false);
                                });
                            }
                          }}
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
                        <pre>{history.join("\n")}</pre>
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
                  <h3>Recent events</h3>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      if (id)
                        void call({ type: "logs", instanceId: id })
                          .then((result) =>
                            setLogs(
                              (result as unknown[]).map((entry) => ({
                                id: crypto.randomUUID(),
                                entry,
                              })),
                            ),
                          )
                          .catch(() => setError("Could not refresh logs."));
                    }}
                  >
                    Refresh
                  </button>
                </div>
                <div className="quiet-note">
                  Development logs contain request and response bodies with credentials removed.
                  Showing the latest 100 records.
                </div>
                {loading ? (
                  <p>Loading diagnostics…</p>
                ) : (
                  <div className="log-list">
                    {logs.length ? (
                      logs.map(({ entry, id: recordId }) => {
                        const record = entry as {
                          timestamp?: string;
                          event?: string;
                          data?: unknown;
                        };
                        return (
                          <details key={recordId}>
                            <summary>
                              <time>
                                {record.timestamp
                                  ? new Date(record.timestamp).toLocaleTimeString()
                                  : ""}
                              </time>
                              <span>{record.event ?? "Event"}</span>
                            </summary>
                            <pre>{JSON.stringify(record.data ?? {}, null, 2)}</pre>
                          </details>
                        );
                      })
                    ) : (
                      <Empty
                        icon="diagnostics"
                        title="No recent events"
                        text="Start the server to record local activity."
                      />
                    )}
                  </div>
                )}
              </>
            )}
            {page === "settings" && (
              <>
                <section className="settings-section">
                  <h3>Account</h3>
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
                            type: running || selected.runtime.state === "error" ? "stop" : "start",
                            instanceId: selected.id,
                          })
                        }
                      >
                        {running || selected.runtime.state === "error"
                          ? "Stop server"
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
                      void mutate({ type: "create", name: newName, port: Number(newPort) });
                    }}
                  >
                    <label>
                      Name
                      <input
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
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
                        value={newPort}
                        onChange={(event) => setNewPort(event.target.value)}
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
                </section>
                <p className="body-note">
                  Closing the window keeps Ambassador in the menu bar. Quit Ambassador stops its
                  servers. Launch-at-login, updates and account recovery will follow in later
                  development stages.
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
