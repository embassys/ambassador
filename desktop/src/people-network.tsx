import { useEffect, useRef, useState } from "react";
import type {
  OwnerCommand,
  OwnerReply,
  OwnerSnapshot,
  OwnerView,
} from "../../src/desktop/owner-protocol.js";
import { notices } from "./account.js";

type Page = Extract<OwnerView, { kind: "invitations" | "connections" }>;
export function PeopleNetwork({
  owner,
  kind,
  query,
  call,
}: {
  owner: OwnerSnapshot;
  kind: "invitations" | "connections";
  query: string;
  call(command: OwnerCommand): Promise<unknown>;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const matches = (email: string, name: string | null) =>
    `${name ?? ""} ${email}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const [page, setPage] = useState<Page>();
  const [cursor, setCursor] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh deliberately reloads the current server page.
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    void call({
      type: kind === "connections" ? "owner_connections" : "owner_invitations",
      context: owner.context,
      ...(cursor ? { cursor } : {}),
    })
      .then((raw) => {
        if (!active) return;
        const reply = raw as OwnerReply;
        if (
          reply.snapshot.context !== owner.context ||
          reply.state !== "ready" ||
          reply.data?.kind !== kind
        )
          throw new Error(notices[reply.issue ?? "offline"]);
        setPage(reply.data as Page);
      })
      .catch((error) => {
        if (active) setError(error instanceof Error ? error.message : "Couldn’t load people.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [call, owner.context, kind, cursor, version]);
  async function answer(invitation_id: string, answer: "accept" | "decline") {
    setBusy(true);
    setError("");
    try {
      const reply = (await call({
        type: "owner_invitation_answer",
        context: owner.context,
        invitation_id,
        answer,
      })) as OwnerReply;
      if (reply.snapshot.context !== owner.context || reply.data?.kind !== "invitation")
        throw new Error(notices[reply.issue ?? "offline"]);
      if (active.current) refresh((value) => value + 1);
    } catch (error) {
      if (active.current)
        setError(
          error instanceof Error ? error.message : "The answer wasn’t confirmed. Refresh to check.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div aria-busy={busy}>
      {error && (
        <p role="alert" className="account-notice">
          {error}
        </p>
      )}
      {busy && !page && (
        <p role="status" className="body-note">
          Loading…
        </p>
      )}
      {page?.kind === "connections" && (
        <>
          {!page.connections.length && (
            <p className="body-note">No connections yet. Open a saved person to invite them.</p>
          )}
          <ul className="people-directory" aria-label="Connected people">
            {page.connections
              .filter((person) => matches(person.email, person.name))
              .map((person) => (
                <li key={person.invitation_id}>
                  <span className="person-avatar" aria-hidden="true">
                    {(person.name || person.email).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="person-text">
                    <strong>{person.name || person.email}</strong>
                    <span>{person.email}</span>
                  </span>
                  <span className="subtle-tag">Connected</span>
                </li>
              ))}
          </ul>
        </>
      )}
      {page?.kind === "invitations" && (
        <>
          {!page.invitations.length && <p className="body-note">No invitations yet.</p>}
          <ul className="people-directory" aria-label="Invitations">
            {page.invitations
              .filter((invitation) => matches(invitation.other_email, invitation.other_name))
              .map((invitation) => (
                <li key={invitation.invitation_id}>
                  <span className="person-avatar" aria-hidden="true">
                    {(invitation.other_name || invitation.other_email).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="person-text">
                    <strong>{invitation.other_name || invitation.other_email}</strong>
                    <span>{invitation.other_email}</span>
                  </span>
                  {invitation.state === "pending" && invitation.direction === "incoming" ? (
                    <span className="button-row">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void answer(invitation.invitation_id, "decline")}
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => void answer(invitation.invitation_id, "accept")}
                      >
                        Accept
                      </button>
                    </span>
                  ) : (
                    <span className="subtle-tag">
                      {invitation.state === "pending"
                        ? invitation.delivered
                          ? "Invited"
                          : "Delivery unconfirmed"
                        : invitation.state === "accepted"
                          ? "Connected"
                          : "Declined"}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </>
      )}
      <div className="button-row">
        <button
          type="button"
          className="quiet-button"
          disabled={busy}
          onClick={() => refresh((value) => value + 1)}
        >
          Refresh
        </button>
        {cursor && (
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() => setCursor(undefined)}
          >
            First page
          </button>
        )}
        {page?.next_cursor && (
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() => setCursor(page.next_cursor ?? undefined)}
          >
            Next page
          </button>
        )}
      </div>
    </div>
  );
}
