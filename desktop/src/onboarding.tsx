import { useEffect, useReducer, useRef, useState } from "react";
import type { DeviceReview } from "../../src/desktop/owner-devices.js";
import type { OwnerSnapshot } from "../../src/desktop/owner-protocol.js";
import type {
  DesktopCommand,
  DesktopInstance,
  GatewaySnapshot,
} from "../../src/desktop/protocol.js";
import type { RegistrationSnapshot } from "../../src/desktop/registration.js";
import { Account, notices } from "./account.js";
import { BackButton } from "./controls.js";
import { DetailSheet } from "./details.js";
import { SettingsButton } from "./navigation.js";
import { prepareOnboardingAgent } from "./onboarding-setup.js";
import { updateOnboardingAgentChoice } from "./onboarding-state.js";

type Instance = DesktopInstance & { runtime: GatewaySnapshot };
type Call = (command: DesktopCommand) => Promise<unknown>;
const agents = [
  { provider: "claude_code", executor: "claude", name: "Claude Code" },
  { provider: "codex", executor: "codex", name: "Codex" },
  { provider: "openclaw", executor: "openclaw", name: "OpenClaw" },
  { provider: "hermes", executor: "hermes", name: "Hermes" },
] as const;
type Guide = { name: string; instruction: string; note: string; connect?: string };

function AgentSetup({
  owner,
  instance,
  call,
  changed,
  complete,
}: {
  owner: OwnerSnapshot;
  instance?: Instance | undefined;
  call: Call;
  changed(): Promise<void>;
  complete(): void;
}) {
  const [review, setReview] = useState<DeviceReview>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (review) dialog.current?.showModal();
    return () => dialog.current?.close();
  }, [review]);
  const [registration, setRegistration] = useState<RegistrationSnapshot>();
  const [guides, setGuides] = useState<Guide[]>([]);
  const [selection, updateSelection] = useReducer(updateOnboardingAgentChoice, {
    index: 0,
    chosen: false,
  });
  const choice = selection.index;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [configured, setConfigured] = useState(false);
  const [verified, setVerified] = useState(false);
  const running = instance?.runtime.state === "running";
  const instanceId = instance?.id;
  useEffect(() => {
    let current = true;
    if (!instanceId || !running) return;
    setRegistration(undefined);
    void Promise.all([
      call({ type: "enrollment_status", instanceId }),
      call({ type: "setup", instanceId }),
    ])
      .then(([state, setup]) => {
        if (!current) return;
        const value = state as RegistrationSnapshot;
        setRegistration(value);
        setGuides((setup as { guides: Guide[] }).guides);
        updateSelection({
          type: "loaded",
          index: Math.max(
            0,
            agents.findIndex((agent) => agent.executor === value.executor),
          ),
        });
      })
      .catch(() => {
        if (current) setError("Setup couldn't load. Check the server and try again.");
      });
    return () => {
      current = false;
    };
  }, [instanceId, running, call]);
  const agent = agents[choice] ?? agents[0];
  const guide = guides.find((item) => item.name === agent.name);
  async function connect(approvedReview?: DeviceReview) {
    if (!instance || !registration || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setReview(undefined);
      const prepared = await prepareOnboardingAgent(
        owner,
        registration,
        instance.id,
        call,
        approvedReview,
      );
      if (prepared.review) {
        setReview(prepared.review);
        return;
      }
      if (prepared.registration) setRegistration(prepared.registration);
      const result = (await call({
        type: "agent_connection",
        instanceId: instance.id,
        provider: agent.provider,
        operation: guide?.connect ? "connect" : "check",
      })) as { state: string; message: string };
      setMessage(result.message);
      if (result.state === "configured" || result.state === "verified") {
        // Manual setup still needs the owner-selected executor after checking its settings.
        if (!guide?.connect && prepared.registration?.needsExecutor)
          await call({
            type: "enrollment_executor",
            instanceId: instance.id,
            executor: agent.executor,
          });
        setVerified(result.state === "verified");
        setConfigured(true);
        await changed();
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Setup did not finish. Your account is saved; try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="onboarding-step">2 · Connect your agent</p>
      <h1>
        {verified
          ? `${agent.name} is connected`
          : configured
            ? "Your settings are saved"
            : "Which agent do you use?"}
      </h1>
      <p className="onboarding-intro">
        {configured
          ? verified
            ? "Your agent is connected. You can add more agents later."
            : "Your connection settings are saved. Test the connection when your agent is available."
          : "We'll connect Embassys, add a skill so your agent recognizes it, and check that the tools work."}
      </p>
      {!instance ? (
        <p role="status">No local installation is available. Open server settings to add one.</p>
      ) : !running ? (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await call({ type: "start", instanceId: instance.id });
              await changed();
            } catch {
              setError("The server couldn't start. Open server settings to check it.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Start setup
        </button>
      ) : !registration ? (
        <p role="status">Checking this device…</p>
      ) : configured ? (
        <>
          <p className="onboarding-note" role="status">
            {message}
          </p>
          {!verified && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={async () => {
                if (!instance) return;
                setBusy(true);
                try {
                  const result = (await call({
                    type: "agent_connection",
                    instanceId: instance.id,
                    provider: agent.provider,
                    operation: "test",
                  })) as { state: string; message: string };
                  setVerified(result.state === "verified");
                  setMessage(result.message);
                } catch {
                  setMessage(
                    "The check did not finish. Your settings are saved; open the agent and try again.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Checking agent…" : "Test connection"}
            </button>
          )}
          <p className="onboarding-note">Try asking your agent: “Can you contact Alex's agent?”</p>
          <button type="button" className="primary" onClick={complete}>
            Open Embassys
          </button>
        </>
      ) : (
        <>
          <fieldset className="onboarding-agents" aria-label="Choose your agent">
            {agents.map((item, index) => (
              <button
                key={item.provider}
                type="button"
                className={`onboarding-agent ${choice === index ? "selected" : ""}`}
                aria-pressed={choice === index}
                disabled={busy}
                onClick={() => {
                  updateSelection({ type: "choose", index });
                  setMessage("");
                  setError("");
                }}
              >
                <span className="agent-initial">{item.name[0]}</span>
                {item.name}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            className="primary onboarding-primary"
            disabled={busy}
            onClick={() => void connect()}
          >
            {busy
              ? "Connecting and checking agent…"
              : guide?.connect
                ? `Connect ${agent.name}`
                : "Check connection"}
          </button>
          {guide && (
            <DetailSheet className="onboarding-manual" title="Manual setup">
              <p>{guide.note}</p>
              <pre>{guide.instruction}</pre>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void window.ambassador
                    .copy(guide.instruction)
                    .then(() => setMessage("Instructions copied."))
                    .catch(() => setError("Couldn't copy. You can select the instructions above."));
                }}
              >
                Copy instructions
              </button>
            </DetailSheet>
          )}
        </>
      )}
      {review && (
        <dialog
          ref={dialog}
          className="review-sheet person-sheet"
          aria-labelledby="setup-move-title"
          onCancel={() => setReview(undefined)}
        >
          <h2 id="setup-move-title">Run your agent on this device?</h2>
          <p>
            Your agent for {owner.email} is assigned to another device. Moving it here stops new
            requests from running there. Your permissions stay with the same agent.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setReview(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void connect(review)}
            >
              Move here &amp; connect
            </button>
          </div>
        </dialog>
      )}
      {message && !configured && (
        <p role="status" className="body-note">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="account-notice">
          {error}
        </p>
      )}
      {!configured && (
        <button
          type="button"
          className="quiet-button onboarding-later"
          disabled={busy}
          onClick={complete}
        >
          I'll connect it later
        </button>
      )}
    </>
  );
}

export function Onboarding({
  owner,
  instance,
  call,
  changed,
  complete,
  settings,
}: {
  owner: OwnerSnapshot;
  instance?: Instance | undefined;
  call: Call;
  changed(): Promise<void>;
  complete(): void;
  settings(): void;
}) {
  const [view, setView] = useState<"welcome" | "login" | "register">(() =>
    ["code_sent", "reauth_required", "unavailable"].includes(owner.status) ? "login" : "welcome",
  );
  const login = view === "login";
  return (
    <div className="onboarding-shell">
      <header className="onboarding-brand">
        <span>Embassys</span>
        <SettingsButton open={settings} />
      </header>
      <main className="onboarding-content">
        {owner.status === "loading" ? (
          <p role="status">Opening Embassys…</p>
        ) : owner.status === "signed_in" ? (
          <AgentSetup
            key={`${owner.account?.owner_id ?? owner.email}:${instance?.id}`}
            owner={owner}
            instance={instance}
            call={call}
            changed={changed}
            complete={complete}
          />
        ) : view === "welcome" && !login ? (
          <>
            <div className="onboarding-emblem" aria-hidden="true">
              <img src="/brand.svg" alt="" />
            </div>
            <h1>Welcome to Embassys</h1>
            <p className="onboarding-intro">
              Sign in, connect your agent, and choose what to share.
            </p>
            {owner.issue && (
              <p role="status" className="account-notice">
                {notices[owner.issue]}
              </p>
            )}
            <div className="onboarding-actions">
              <button type="button" className="primary" onClick={() => setView("login")}>
                Log in
              </button>
              <button type="button" className="secondary" onClick={() => setView("register")}>
                Register
              </button>
            </div>
            <p className="onboarding-compatible">
              Works with Claude Code, Codex, OpenClaw and Hermes
            </p>
          </>
        ) : (
          <>
            {owner.status !== "code_sent" && (
              <BackButton
                className="onboarding-back"
                label="Back to welcome"
                onClick={() => setView("welcome")}
              />
            )}
            <p className="onboarding-step">1 · Your account</p>
            <h1>{login ? "Welcome back" : "Join Embassys"}</h1>
            <Account snapshot={owner} call={call} changed={changed} compact />
            {login && owner.status !== "code_sent" && (
              <button type="button" className="quiet-button" onClick={() => setView("register")}>
                New here? Register
              </button>
            )}
          </>
        )}
      </main>
    </div>
  );
}
