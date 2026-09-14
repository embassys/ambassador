import { useEffect, useState } from "react";
import type { DesktopCommand } from "../../src/desktop/protocol.js";
import type { RegistrationSnapshot } from "../../src/desktop/registration.js";

type State = Omit<RegistrationSnapshot, "phase"> & {
  phase: RegistrationSnapshot["phase"] | "stopped";
};
export function Registration({
  instanceId,
  running,
  command,
  start,
  connected,
}: {
  instanceId: string;
  running: boolean;
  command(input: DesktopCommand): Promise<unknown>;
  start(): void;
  connected(): void;
}) {
  const [state, setState] = useState<State>();
  const [email, setEmail] = useState("");
  const [executor, setExecutor] = useState<"claude" | "codex" | "openclaw" | "hermes">("claude");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryReview, setRecoveryReview] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let current = true;
    void command({ type: "enrollment_status", instanceId })
      .then((value) => {
        if (current) setState(value as State);
      })
      .catch(() => {
        if (current)
          setError("Registration status could not load. Start the server, then reopen this view.");
      });
    return () => {
      current = false;
    };
  }, [instanceId, command]);
  async function submit(input: DesktopCommand) {
    if (busy) return;
    setBusy(true);
    setError("");
    if (input.type === "enrollment_verify" || input.type === "enrollment_recover") setCode("");
    try {
      setState((await command(input)) as State);
    } catch {
      setError(
        "The request could not finish. Reopen this view to check its saved state before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!running || state?.phase === "stopped")
    return (
      <section className="settings-section">
        <h3>Register this instance</h3>
        <p className="body-note">Start the local server to register your agent.</p>
        <button type="button" className="primary" onClick={start}>
          Start server
        </button>
      </section>
    );
  if (!state) return <p role="status">{error || "Loading registration…"}</p>;
  if (state.phase === "registered")
    return (
      <section className="settings-section">
        <h3>You're registered</h3>
        <p className="break">{state.email}</p>
        <p className="body-note">
          {state.credentialStatus === "expired"
            ? "Automatic renewal hasn’t completed. Open Devices & agents for an assigned execution credential, or recover this agent using email. Saved history remains here."
            : "This instance uses your saved verified identity. Connect your agent's MCP tools to finish setup."}
        </p>
        {state.needsExecutor ? (
          <>
            <label>
              Agent for incoming requests
              <select
                value={executor}
                disabled={busy}
                onChange={(event) => setExecutor(event.target.value as typeof executor)}
              >
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="openclaw">OpenClaw</option>
                <option value="hermes">Hermes</option>
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void submit({ type: "enrollment_executor", instanceId, executor })}
            >
              Use this agent
            </button>
          </>
        ) : (
          <button type="button" className="secondary" onClick={connected}>
            Connect an agent
          </button>
        )}
        {state.credentialStatus === "expired" && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void submit({
                type: "enrollment_recover",
                instanceId,
                confirmation: "recover-this-agent",
              })
            }
          >
            Send recovery code
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const entry = state.phase === "new" || state.phase === "rejected";
  const canVerify = [
    "awaiting_code",
    "registration_uncertain",
    "verification_uncertain",
    "recovery_code",
  ].includes(state.phase);
  const resendSeconds = Math.max(0, Math.ceil(((state.resendAfter ?? 0) - now) / 1000));
  return (
    <section className="settings-section registration-form">
      <h3>
        {entry
          ? "Register with Embassys"
          : state.phase === "conflict"
            ? "Already registered"
            : "Verify your email"}
      </h3>
      <p className="body-note">
        {entry
          ? "Enter your email to get started. You'll choose your agent after logging in."
          : state.email}
      </p>
      {state.message && (
        <p className="body-note" role="status">
          {state.message}
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {entry && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ type: "enrollment_register", instanceId, email });
          }}
        >
          <label>
            Email address
            <input
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Sending…" : "Send verification code"}
          </button>
        </form>
      )}
      {["conflict", "verification_uncertain", "recovery_uncertain"].includes(state.phase) &&
        (!recoveryReview ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setRecoveryReview(true)}
          >
            Recover this agent…
          </button>
        ) : (
          <div className="settings-section">
            <p>
              Recover {state.email} on this device. Completing email verification signs out its
              earlier installations. Saved conversations here are kept.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setRecoveryReview(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || resendSeconds > 0}
                onClick={() => {
                  setRecoveryReview(false);
                  void submit({
                    type: "enrollment_recover",
                    instanceId,
                    confirmation: "recover-this-agent",
                  });
                }}
              >
                Send recovery code
              </button>
            </div>
          </div>
        ))}
      {canVerify && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(
              state.phase === "recovery_code"
                ? {
                    type: "enrollment_recover",
                    instanceId,
                    code,
                    confirmation: "recover-this-agent",
                  }
                : { type: "enrollment_verify", instanceId, code },
            );
          }}
        >
          <label>
            Verification code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy || !/^\d{6}$/.test(code)}>
              {busy ? "Verifying…" : "Verify email"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || resendSeconds > 0}
              onClick={() =>
                void submit(
                  state.phase === "recovery_code"
                    ? { type: "enrollment_recover", instanceId, confirmation: "recover-this-agent" }
                    : { type: "enrollment_resend", instanceId },
                )
              }
            >
              {resendSeconds ? `Resend in ${resendSeconds}s` : "Resend code"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
