import { useEffect, useRef, useState } from "react";
import type { DeviceReview } from "../../src/desktop/owner-devices.js";
import type {
  OwnerCommand,
  OwnerReply,
  OwnerSnapshot,
  OwnerView,
} from "../../src/desktop/owner-protocol.js";

type Devices = Extract<OwnerView, { kind: "devices" }>;
export function OwnerDevices({
  owner,
  instanceId,
  instanceName,
  call,
  changed,
}: {
  owner: OwnerSnapshot;
  instanceId?: string | undefined;
  instanceName?: string | undefined;
  call(command: OwnerCommand): Promise<unknown>;
  changed(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Devices>();
  const [review, setReview] = useState<DeviceReview>();
  const [agent, setAgent] = useState(owner.account?.agents[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  function closeReview() {
    setReview(undefined);
    requestAnimationFrame(() => {
      if (active.current) trigger.current?.focus();
    });
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (review) dialog.current?.showModal();
    return () => dialog.current?.close();
  }, [review]);
  useEffect(() => {
    if (!owner.account?.agents.some((value) => value.id === agent && value.email_verified))
      setAgent(owner.account?.agents.find((value) => value.email_verified)?.id ?? "");
  }, [owner.account?.agents, agent]);
  async function run(command: OwnerCommand) {
    if (busy) return;
    if (command.type === "owner_device_review")
      trigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    setNotice("");
    try {
      const result = (await call(command)) as OwnerReply;
      if (!active.current) return;
      if (result.data?.kind === "device_review") setReview(result.data);
      else if (result.data?.kind === "devices") setData(result.data);
      else if (result.data?.kind === "device_result") {
        closeReview();
        setNotice(
          !result.data.confirmed
            ? "The change wasn’t confirmed. Refresh devices before trying again."
            : result.data.local_ready === false
              ? "The execution device changed, but local setup did not finish. Review this device and try setup again."
              : result.data.operation === "revoke"
                ? "Device access revoked."
                : "Execution device updated.",
        );
        if (result.snapshot.status === "signed_in") {
          const refreshed = (await call({
            type: "owner_devices",
            context: result.snapshot.context,
          })) as OwnerReply;
          if (active.current && refreshed.data?.kind === "devices") setData(refreshed.data);
        }
      } else throw new Error("This review changed or could not be confirmed. Refresh devices.");
      await changed();
    } catch (error) {
      if (active.current)
        setNotice(error instanceof Error ? error.message : "Devices could not refresh.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => {
          setOpen(!open);
          if (!open) void run({ type: "owner_devices", context: owner.context });
        }}
      >
        Devices &amp; agents
      </button>
      {notice && (
        <p role="status" className="body-note">
          {notice}
        </p>
      )}
      {open && (
        <>
          <p className="body-note">
            Choose where each agent runs. Revoking a device signs it out and stops its agents from
            receiving new work.
          </p>
          {owner.account?.agents.length ? (
            <label className="settings-row">
              <strong>Agent</strong>
              <select
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
                disabled={busy}
              >
                {owner.account.agents.map((value) => (
                  <option key={value.id} value={value.id} disabled={!value.email_verified}>
                    {value.display_name ? `${value.display_name} · ` : ""}
                    {value.email}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="body-note">
              No agents are linked yet. Register an agent, then refresh this list.
            </p>
          )}
          {data?.devices.map((device) => (
            <div className="settings-row" key={device.id}>
              <div>
                <strong>
                  {device.device_name || "Unnamed device"}
                  {device.is_current ? " · This device" : ""}
                </strong>
                <p>
                  {device.revoked_at
                    ? "Access revoked"
                    : device.executes_agent_ids.length
                      ? `Runs ${device.executes_agent_ids.length} agent${device.executes_agent_ids.length === 1 ? "" : "s"}`
                      : "No agents assigned"}
                </p>
              </div>
              {!device.revoked_at && (
                <div className="button-row">
                  {agent && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || (device.is_current && !instanceId)}
                      onClick={() =>
                        void run({
                          type: "owner_device_review",
                          context: owner.context,
                          operation: "execute",
                          device_id: device.id,
                          agent_id: agent,
                        })
                      }
                    >
                      {device.executes_agent_ids.includes(agent) ? "Review setup" : "Use device"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        type: "owner_device_review",
                        context: owner.context,
                        operation: "revoke",
                        device_id: device.id,
                      })
                    }
                  >
                    Revoke…
                  </button>
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void run({ type: "owner_devices", context: owner.context })}
          >
            Refresh devices &amp; agents
          </button>
        </>
      )}
      {review && (
        <dialog
          ref={dialog}
          className="review-sheet person-sheet"
          aria-labelledby="device-review-title"
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else closeReview();
          }}
        >
          <header className="review-heading">
            <h2 id="device-review-title">
              {review.operation === "revoke"
                ? "Revoke device access?"
                : "Run your agent on this device?"}
            </h2>
          </header>
          <div className="review-body person-summary">
            <p>
              <strong>{review.device.device_name || "Unnamed device"}</strong>
              {review.device.is_current ? " · This device" : ""}
            </p>
            <p>
              {review.operation === "revoke"
                ? `This signs out the device and leaves ${review.device.executes_agent_ids.length} assigned agents unable to receive new work until another device is chosen.`
                : `Run ${review.agent?.email} on ${review.device.device_name || "this device"}. Its previous device will stop receiving new work. Saved local conversations are preserved.`}
            </p>
            {review.operation === "execute" && review.device.is_current && (
              <p className="body-note">
                Local installation: {instanceName || "Selected installation"}. Its server will stop
                briefly during setup.
              </p>
            )}
          </div>
          <footer className="review-footer">
            <button type="button" className="secondary" disabled={busy} onClick={closeReview}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run({
                  type: "owner_device_submit",
                  context: owner.context,
                  review_id: review.review_id,
                  ...(instanceId ? { instanceId } : {}),
                })
              }
            >
              {busy ? "Updating…" : review.operation === "revoke" ? "Revoke device" : "Use device"}
            </button>
          </footer>
        </dialog>
      )}
    </section>
  );
}
