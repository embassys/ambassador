import { useEffect, useState } from "react";
import type { CentralPermission } from "../../src/central-rest.js";
import type { ActivityKind, ActivityPage } from "../../src/desktop/activity.js";
import type { DesktopCommand } from "../../src/desktop/protocol.js";

type Command = (input: DesktopCommand) => Promise<unknown>;
const unavailable: Record<string, string> = {
  stopped: "Start this instance's server to read its current status.",
  not_registered: "Register this instance in Registration first.",
  expired:
    "The saved credential has expired. Local history is still available; central identity recovery is not supported yet.",
  unavailable:
    "Embassys could not load this information. Check the connection and try again. This does not mean there are no records.",
};
function date(value?: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Not supplied";
}
export function Permissions({ instanceId, command }: { instanceId: string; command: Command }) {
  const [data, setData] = useState<{
    state: string;
    items: CentralPermission[];
    email?: string;
    fetchedAt?: string;
  }>();
  const [direction, setDirection] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit Refresh request.
  useEffect(() => {
    let current = true;
    setBusy(true);
    setData(undefined);
    setPage(0);
    void command({ type: "permissions", instanceId })
      .then((value) => {
        if (current) setData(value as NonNullable<typeof data>);
      })
      .catch(() => {
        if (current) setData({ state: "unavailable", items: [] });
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [instanceId, command, revision]);
  const items = (data?.items ?? []).filter(
    (item) =>
      (status === "all" || item.status === status) &&
      (direction === "all" ||
        (direction === "granted"
          ? item.grantor_email === data?.email
          : item.grantee_email === data?.email)),
  );
  return (
    <>
      <p className="body-note">
        Permission records for this instance's agent. Decide requests through their email links.
        Full audit history, use limits and revocation are not available here yet.
      </p>
      <div className="status-toolbar">
        <label>
          Direction
          <select
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">Both directions</option>
            <option value="granted">Access I grant</option>
            <option value="received">Access granted to me</option>
          </select>
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="granted">Granted</option>
            <option value="denied">Denied</option>
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </button>
      </div>
      {busy ? (
        <p role="status">Loading permissions…</p>
      ) : data?.state !== "ready" ? (
        <p role="status">{unavailable[data?.state ?? "unavailable"]}</p>
      ) : (
        <>
          <p className="body-note">
            {items.length} records · Checked {date(data.fetchedAt)}
          </p>
          {items.length === 0 && <p>No permission records match this view.</p>}
          {items.slice(page * 50, (page + 1) * 50).map((item) => (
            <section className="settings-section" key={item.id}>
              <div className="section-title">
                <h3>{item.action_type.replaceAll("_", " ")}</h3>
                <span className="subtle-tag">
                  {item.status === "granted" &&
                  item.expires_at &&
                  Date.parse(item.expires_at) <= Date.now()
                    ? "Expired"
                    : item.status}
                </span>
              </div>
              <p className="break">
                {item.grantor_email} → {item.grantee_email}
              </p>
              <p className="body-note">
                Requested {date(item.created_at)} · Decided {date(item.decided_at)}
                {item.expires_at ? ` · Expires ${date(item.expires_at)}` : ""}
              </p>
              {item.scope && (
                <details>
                  <summary>Requested scope</summary>
                  <pre className="status-json">{JSON.stringify(item.scope, null, 2)}</pre>
                </details>
              )}
            </section>
          ))}
          {items.length > 50 && (
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={!page}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </button>
              <span>Page {page + 1}</span>
              <button
                type="button"
                className="secondary"
                disabled={(page + 1) * 50 >= items.length}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
export function Activity({
  instanceId,
  command,
  initialKind = "incoming",
}: {
  instanceId: string;
  command: Command;
  initialKind?: ActivityKind;
}) {
  const [kind, setKind] = useState<ActivityKind>(initialKind);
  const [after, setAfter] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<ActivityPage>();
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit Refresh request.
  useEffect(() => {
    let current = true;
    setData(undefined);
    setError("");
    void command({ type: "activity", instanceId, kind, after })
      .then((value) => {
        if (current) setData(value as ActivityPage);
      })
      .catch(() => {
        if (current) setError(unavailable.unavailable ?? "Unavailable");
      });
    return () => {
      current = false;
    };
  }, [instanceId, command, kind, after, revision]);
  return (
    <section className="settings-section">
      <h3>Saved work</h3>
      <p className="body-note">
        Status observed by this instance. Reading it does not acknowledge a result. Use the email
        for a human decision or answer.
      </p>
      <div className="status-toolbar">
        <label>
          Show
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as ActivityKind);
              setAfter(0);
            }}
          >
            <option value="incoming">Incoming requests</option>
            <option value="outgoing">Outgoing requests</option>
            <option value="results">Received results</option>
            <option value="questions">Owner questions</option>
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!data && !error}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">Loading saved work…</p>
      ) : data.state !== "ready" ? (
        <p>{unavailable[data.state]}</p>
      ) : (
        <>
          {data.items.length === 0 && <p>No saved records in this view.</p>}
          {data.items.map((item) => (
            <article className="activity-row" key={item.id}>
              <div className="section-title">
                <strong>{item.action.replaceAll("_", " ")}</strong>
                <span className="subtle-tag">{item.status.replaceAll("_", " ")}</span>
              </div>
              <p className="body-note break">
                {item.peer}
                {item.createdAt ? ` · ${date(item.createdAt)}` : ""}
              </p>
              {item.question && <p className="break">{item.question}</p>}
              <details>
                <summary>Request reference</summary>
                <code className="break">{item.id}</code>
              </details>
            </article>
          ))}
          <div className="button-row">
            <button
              type="button"
              className="text-button"
              disabled={!after}
              onClick={() => setAfter(0)}
            >
              First page
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!data.hasMore}
              onClick={() => setAfter(data.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}
