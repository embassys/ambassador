import { useEffect, useRef, useState } from "react";
import { permissionChoices } from "../../src/desktop/owner-choices.js";
import type {
  OwnerCommand,
  OwnerIssue,
  OwnerMutation,
  OwnerReply,
  OwnerReview,
  OwnerSnapshot,
  OwnerView,
} from "../../src/desktop/owner-protocol.js";
import type { RequestSource } from "./conversation-workspace.js";
import { Disclosure, StructuredData } from "./details.js";

export const notices: Record<OwnerIssue, string> = {
  review_expired: "This request changed or the review expired. Refresh and review it again.",
  request_unavailable:
    "This request or choice is no longer available. Refresh or use the email or web app.",
  invalid_code: "That code is invalid or expired. Check it or request a new code.",
  code_unconfirmed: "We couldn't confirm the code email. If it arrives, you can still use it.",
  code_expired: "That code expired. Request a new one to sign in.",
  verification_uncertain: "Sign-in wasn't confirmed. Request a new code to continue.",
  refresh_uncertain: "Your session couldn't be renewed. Sign in again with a new code.",
  session_expired: "Your session ended. Sign in again to view your account.",
  signout_unconfirmed: "Signed out on this app. We couldn't confirm sign-out on the server.",
  rate_limited: "Too many attempts. Wait a while before trying again.",
  offline: "Your account couldn't be reached. Check your connection and refresh.",
  invalid_response:
    "The server returned account data this version can't read. Refresh or use the web app.",
  storage_unavailable:
    "The saved account session couldn't be accessed. Reopen the app to try again.",
  worker_unavailable: "The account service is unavailable. Refresh to try again.",
};
type Tab = "requests" | "permissions" | "communications";
const when = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Not provided";
const action = (value: string) => value.replaceAll("_", " ");
function RequestMark({ question = false }: { question?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      {question ? (
        <>
          <path d="M4 4h16v13H9l-5 4V4Z" />
          <path d="M8 8h8M8 12h5" />
        </>
      ) : (
        <path d="M12 3 4 7v6c0 4 8 8 8 8s8-4 8-8V7L12 3Z" />
      )}
    </svg>
  );
}
function Details({ value, label = "Details" }: { value: unknown; label?: string }) {
  return value == null ? null : (
    <Disclosure className="account-details" title={label}>
      <StructuredData value={value} />
    </Disclosure>
  );
}

type Requests = Extract<OwnerView, { kind: "requests" }>;
type RequestItem =
  | { kind: "permission"; item: Requests["permission_requests"][number] }
  | { kind: "input"; item: Requests["input_requests"][number] };
export function requestItems(data: Requests): RequestItem[] {
  return [
    ...data.permission_requests.map((item) => ({ kind: "permission" as const, item })),
    ...data.input_requests.map((item) => ({ kind: "input" as const, item })),
  ].sort((a, b) => Date.parse(b.item.created_at) - Date.parse(a.item.created_at));
}
function SnapshotNote({ updated }: { updated: string | undefined }) {
  return (
    <Disclosure className="snapshot-note" title="About this inbox">
      {updated && <p>Updated {when(updated)}</p>}
      <p>
        Showing up to 200 permissions and 200 questions. This snapshot may not include every pending
        request.
      </p>
    </Disclosure>
  );
}

export function AccountData({
  data,
  review,
  busy = false,
  updated,
  focusedRequest = false,
}: {
  data: OwnerView;
  updated?: string;
  review?(kind: OwnerMutation["kind"], id: string): void;
  busy?: boolean;
  focusedRequest?: boolean;
}) {
  if (
    data.kind === "people" ||
    data.kind === "profile" ||
    data.kind === "review" ||
    data.kind === "mutation"
  )
    return null;
  if (
    data.kind === "requests" &&
    !data.permission_requests.length &&
    !data.input_requests.length &&
    !data.unconfirmed?.length &&
    !data.unconfirmedMore
  )
    return (
      <>
        <div className="polished-empty">
          <div className="empty-symbol" aria-hidden="true">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M12 3 4 7v6c0 4 8 8 8 8s8-4 8-8V7L12 3Z" />
              <path d="m8 12 3 3 5-6" />
            </svg>
          </div>
          <h2>{focusedRequest ? "This request is no longer pending" : "No requests to review"}</h2>
          <p>
            {focusedRequest
              ? "Choose another request or conversation from the sidebar."
              : "When an agent needs your permission or an answer, it will appear here."}
          </p>
        </div>
        {!focusedRequest && <SnapshotNote updated={updated} />}
      </>
    );
  if (data.kind === "requests")
    return (
      <>
        {data.unconfirmed?.map((item) => (
          <p className="account-notice" role="status" key={`${item.kind}:${item.id}`}>
            Confirmation unavailable for {action(item.action_type)}. Your submission may have been
            accepted; it will not be sent again. <small className="break">Request {item.id}</small>
          </p>
        ))}
        {data.unconfirmedMore && (
          <p className="body-note">Showing the first 100 unconfirmed submissions.</p>
        )}
        <div className="inbox-list">
          {requestItems(data).map((entry) => (
            <article className="inbox-row" key={`${entry.kind}:${entry.item.id}`}>
              <div className="inbox-mark" aria-hidden="true">
                <RequestMark question={entry.kind === "input"} />
              </div>
              <div className="inbox-row-content">
                <div className="inbox-row-meta">
                  <span>
                    {entry.kind === "permission"
                      ? entry.item.requester_name ||
                        entry.item.requester_email ||
                        "Requester unavailable"
                      : "Question"}
                  </span>
                  <time dateTime={entry.item.created_at}>{when(entry.item.created_at)}</time>
                </div>
                <h3>
                  {entry.kind === "permission"
                    ? entry.item.action_description || action(entry.item.action_type)
                    : entry.item.prompt}
                </h3>
                <Disclosure className="inbox-preview-details" title="Details">
                  <p>{action(entry.item.action_type)}</p>
                  {entry.kind === "permission" ? (
                    <>
                      {entry.item.requester_name && entry.item.requester_email && (
                        <p>{entry.item.requester_email}</p>
                      )}
                      <p>Request reason isn't included by the server.</p>
                      {entry.item.expires_at && <p>Expires {when(entry.item.expires_at)}</p>}
                      <Details label="Permission scope" value={entry.item.scope} />
                    </>
                  ) : (
                    entry.item.options && (
                      <p>
                        Offered choices:{" "}
                        {entry.item.options.map((option) => option.label).join(" · ")}
                      </p>
                    )
                  )}
                </Disclosure>
                {entry.kind === "permission" &&
                  !permissionChoices(entry.item.decision_options).length && (
                    <p className="body-note">
                      This app does not recognize these choices. Use the email or web app.
                    </p>
                  )}
              </div>
              {review && (
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    busy ||
                    (entry.kind === "permission" &&
                      !permissionChoices(entry.item.decision_options).length)
                  }
                  onClick={() => review(entry.kind, entry.item.id)}
                  aria-label={entry.kind === "permission" ? "Review request" : "Review question"}
                >
                  Review
                </button>
              )}
            </article>
          ))}
        </div>
        {!focusedRequest && <SnapshotNote updated={updated} />}
      </>
    );
  if (data.kind === "permissions")
    return (
      <>
        <p className="account-limit">
          Up to 200 of the most recent permissions. Older permissions may be missing.
        </p>
        <section className="settings-section">
          {data.permissions.length === 0 && (
            <p className="body-note">No permissions in this snapshot.</p>
          )}
          {data.permissions.map((item) => (
            <article className="account-row" key={item.id}>
              <div className="account-row-heading">
                <strong>{action(item.action_type)}</strong>
                <span className="subtle-tag">{action(item.status)}</span>
              </div>
              <p className="break">
                {item.direction === "granted_by_me"
                  ? `To ${item.grantee_name || item.grantee_email || "unavailable agent"}`
                  : `From ${item.grantor_name || item.grantor_email || "unavailable agent"}`}
              </p>
              <dl className="account-facts">
                <div>
                  <dt>Decided</dt>
                  <dd>{when(item.decided_at)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{item.expires_at ? when(item.expires_at) : "No expiry provided"}</dd>
                </div>
                <div>
                  <dt>Uses remaining</dt>
                  <dd>{item.uses_remaining ?? "No limit provided"}</dd>
                </div>
              </dl>
              <Details label="Permission scope" value={item.scope} />
              {review &&
                item.direction === "granted_by_me" &&
                item.status === "granted" &&
                item.uses_remaining !== 0 &&
                (!item.expires_at || Date.parse(item.expires_at) > Date.now()) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => review("revoke", item.id)}
                  >
                    Review revocation
                  </button>
                )}
            </article>
          ))}
        </section>
      </>
    );
  return (
    <>
      <p className="account-limit">
        Up to 200 recent central messages. Delivery status does not confirm that an agent completed
        the work.
      </p>
      <section className="settings-section">
        {data.communications.length === 0 && (
          <p className="body-note">No messages in this snapshot.</p>
        )}
        {data.communications.map((item) => (
          <article className="account-row" key={item.id}>
            <div className="account-row-heading">
              <strong>{action(item.action_type || item.message_type)}</strong>
              <span className="subtle-tag">{action(item.status)}</span>
            </div>
            <p className="break">
              {item.outbound
                ? `To ${item.recipient_name || item.recipient_email || "unavailable agent"}`
                : `From ${item.sender_name || item.sender_email || "unavailable agent"}`}
            </p>
            <time>{when(item.created_at)}</time>
            <Details value={item.payload} label="Message content" />
          </article>
        ))}
      </section>
    </>
  );
}

export function OwnerDecisionForm({
  review,
  busy,
  submit,
  cancel,
  linkedConversation = false,
}: {
  linkedConversation?: boolean;
  review: OwnerReview;
  busy: boolean;
  submit(command: Omit<Extract<OwnerCommand, { type: "owner_submit" }>, "context">): void;
  cancel(): void;
}) {
  const reviewElement = useRef<HTMLElement>(null);
  useEffect(() => {
    reviewElement.current?.focus({ preventScroll: true });
  }, []);
  const [choice, setChoice] = useState("");
  const [answer, setAnswer] = useState("");
  const target = review.target;
  const options =
    target.kind === "permission"
      ? permissionChoices(target.item.decision_options)
      : target.kind === "input" && target.item.input_type === "buttons"
        ? (target.item.options ?? [])
        : [];
  const typed = target.kind === "input" && target.item.input_type === "text";
  const revoked = target.kind === "revoke";
  return (
    <section ref={reviewElement} tabIndex={-1} className="owner-review" aria-label="Review request">
      <header className="owner-review-heading">
        <div className="owner-review-symbol">
          <RequestMark question={target.kind === "input"} />
        </div>
        <div>
          <p className="eyebrow">
            {revoked
              ? "Revoke permission"
              : target.kind === "input"
                ? "Answer needed"
                : "Permission request"}
          </p>
          <h2>
            {revoked
              ? "Withdraw this access?"
              : target.kind === "input"
                ? "Answer your agent"
                : target.item.action_description || action(target.item.action_type)}
          </h2>
        </div>
      </header>
      <dl className="request-facts">
        {target.kind === "permission" && (
          <div>
            <dt>From</dt>
            <dd>
              {target.item.requester_name || target.item.requester_email || "Requester unavailable"}
              {target.item.requester_name && target.item.requester_email && (
                <span>{target.item.requester_email}</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Action</dt>
          <dd>
            <code>{target.item.action_type}</code>
          </dd>
        </div>
        {target.kind !== "input" && (
          <div>
            <dt>Expires</dt>
            <dd>{target.item.expires_at ? when(target.item.expires_at) : "No expiry provided"}</dd>
          </div>
        )}
      </dl>
      {target.kind === "permission" && (
        <p className="request-context-note">Request reason isn't included by the server.</p>
      )}
      {target.kind === "input" ? (
        <>
          <p className="account-question">{target.item.prompt}</p>
          {!linkedConversation && (
            <p className="request-context-note">The originating conversation is unavailable.</p>
          )}
        </>
      ) : (
        <>
          {target.kind === "revoke" && (
            <p>
              Withdraw access from{" "}
              {target.item.grantee_name || target.item.grantee_email || "this agent"}. This does not
              undo completed actions.
            </p>
          )}
          {target.item.scope != null && (
            <section className="review-scope" aria-label="Permission scope">
              <h3>Permission scope</h3>
              <StructuredData value={target.item.scope} />
            </section>
          )}
        </>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit({
            type: "owner_submit",
            review_id: review.review_id,
            ...(revoked
              ? {}
              : typed
                ? { text: answer }
                : target.kind === "permission"
                  ? { decision: choice as "accept" | "deny" | "allow_once" | "allow_always" }
                  : { value: choice }),
          });
        }}
      >
        {typed ? (
          <label>
            Your answer
            <textarea
              maxLength={4000}
              required
              disabled={busy}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>
        ) : (
          !revoked && (
            <fieldset disabled={busy} className="owner-choices">
              <legend>Choose a response</legend>
              {options.map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name="owner-choice"
                    value={option.value}
                    checked={choice === option.value}
                    onChange={() => setChoice(option.value ?? "")}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>
          )
        )}
        {target.kind === "permission" && ["accept", "allow_always"].includes(choice) && (
          <p className="body-note">
            This choice grants ongoing access within the displayed scope and expiry.
          </p>
        )}
        <div className="account-actions owner-review-actions">
          <button type="button" className="secondary" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || (!revoked && !(typed ? answer.trim() : choice))}
          >
            {busy
              ? "Sending…"
              : revoked
                ? "Confirm revocation"
                : typed || target.kind === "input"
                  ? "Confirm answer"
                  : "Confirm decision"}
          </button>
        </div>
      </form>
    </section>
  );
}

export function Account({
  snapshot,
  call,
  changed,
  section = "profile",
  signIn,
  compact = false,
  initialEmail = "",
  requestSource,
  hideEmptyRequests = false,
  focusedRequest = false,
  linkedConversation = false,
}: {
  linkedConversation?: boolean;
  snapshot: OwnerSnapshot;
  call(command: OwnerCommand): Promise<unknown>;
  changed(): Promise<void>;
  section?: Tab | "profile";
  signIn?(): void;
  compact?: boolean;
  initialEmail?: string;
  requestSource?: RequestSource | undefined;
  hideEmptyRequests?: boolean;
  focusedRequest?: boolean;
}) {
  const [owner, setOwner] = useState(snapshot);
  const [email, setEmail] = useState(snapshot.email ?? initialEmail);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisionReview, setDecisionReview] = useState<OwnerReview>();
  const pageElement = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening or closing a review resets scroll; background refreshes must not.
  useEffect(() => {
    if (section === "requests") pageElement.current?.scrollIntoView({ block: "start" });
  }, [section, decisionReview?.review_id]);
  const [confirmation, setConfirmation] = useState("");
  const submitting = useRef(false);
  const [operation, setOperation] = useState<OwnerCommand["type"]>();
  const [error, setError] = useState("");
  const tab = section;
  const [direction, setDirection] = useState<"granted" | "received">("granted");
  const [localData, setData] = useState<OwnerView>();
  const data = requestSource ? requestSource.data : localData;
  const externalRequests = requestSource !== undefined;
  const [localFetchedAt, setFetchedAt] = useState("");
  const fetchedAt = requestSource ? requestSource.updated : localFetchedAt;
  const [localLoading, setLoading] = useState(false);
  const loading = requestSource ? requestSource.loading : localLoading;
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    setOwner(snapshot);
  }, [snapshot]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new account context must discard any typed code, even for the same email.
  useEffect(() => {
    setCode("");
    setDecisionReview(undefined);
    setConfirmation("");
    if (owner.email) setEmail(owner.email);
  }, [owner.context, owner.email]);
  useEffect(() => {
    if (owner.status !== "code_sent") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [owner.status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly invalidates the current snapshot without changing tabs.
  useEffect(() => {
    const version = ++generation.current;
    setData(undefined);
    setFetchedAt("");
    setError("");
    setLoading(false);
    if (owner.status !== "signed_in" || tab === "profile" || externalRequests) return;
    setLoading(true);
    const context = owner.context;
    const command: OwnerCommand =
      tab === "requests"
        ? { type: "owner_requests", context }
        : tab === "permissions"
          ? { type: "owner_permissions", context, direction }
          : { type: "owner_communications", context };
    void call(command)
      .then((raw) => {
        if (generation.current !== version || !mounted.current) return;
        const reply = raw as OwnerReply;
        if (reply.snapshot.context !== context) {
          setOwner(reply.snapshot);
          return;
        }
        if (reply.state === "unavailable") setError(notices[reply.issue ?? "offline"]);
        else {
          setData(reply.data);
          setFetchedAt(reply.fetchedAt ?? "");
        }
      })
      .catch(() => {
        if (generation.current === version && mounted.current)
          setError("This view couldn't refresh. Try again.");
      })
      .finally(() => {
        if (generation.current === version && mounted.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [call, owner.context, owner.status, tab, direction, refresh, externalRequests]);

  async function run(command: OwnerCommand) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setOperation(command.type);
    setError("");
    if (command.type === "owner_signout") {
      generation.current++;
      setData(undefined);
      setFetchedAt("");
    }
    const version = generation.current;
    try {
      const result = await call(command);
      if (mounted.current && result && typeof result === "object" && "snapshot" in result) {
        const reply = result as OwnerReply;
        if (
          (command.type === "owner_review" || command.type === "owner_submit") &&
          (version !== generation.current || reply.snapshot.context !== owner.context)
        )
          return;
        setOwner(reply.snapshot);
        if (reply.data?.kind === "review") {
          setDecisionReview(reply.data);
          setConfirmation("");
        }
        if (reply.data?.kind === "mutation") {
          setDecisionReview(undefined);
          setConfirmation(
            reply.data.status === "confirmed"
              ? "Confirmed by Embassys."
              : reply.data.status === "settled"
                ? "This request is no longer available to answer. It may have been handled elsewhere or expired."
                : "Confirmation unavailable. Your submission may have been accepted; it will not be sent again. Check the email or web app for its status.",
          );
          setRefresh((value) => value + 1);
          void requestSource?.refresh();
        }
        if (reply.state === "unavailable" && reply.issue) {
          if (command.type === "owner_submit") {
            setDecisionReview(undefined);
            setConfirmation(notices[reply.issue]);
            setRefresh((value) => value + 1);
            void requestSource?.refresh();
          } else setError(notices[reply.issue]);
        }
      }
      await changed();
    } catch {
      if (mounted.current && version === generation.current) {
        if (command.type === "owner_submit") setDecisionReview(undefined);
        setError("That operation couldn't finish. Refresh your account before trying again.");
      }
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setOperation(undefined);
      }
    }
  }
  const wait = Math.min(60, Math.max(0, Math.ceil(((owner.resendAt ?? 0) - now) / 1000)));
  const emptyLinkedRequests = hideEmptyRequests && data?.kind === "requests" && data.total === 0;
  if (emptyLinkedRequests && !decisionReview && !confirmation && !error && !requestSource?.error)
    return null;
  return (
    <div className="account-page" ref={pageElement}>
      {section !== "profile" && owner.status !== "signed_in" ? (
        <section className="simple-empty">
          <h2>
            {owner.status === "loading" ? "Opening your account…" : "Your account, in one place"}
          </h2>
          <p>
            {owner.issue
              ? notices[owner.issue]
              : "Sign in to see requests and updates from your other agents."}
          </p>
          <button type="button" className="primary" onClick={signIn}>
            Sign in
          </button>
        </section>
      ) : section === "profile" ? (
        <section className="settings-section">
          <div className="settings-row">
            <div>
              <strong>
                {owner.status === "signed_in"
                  ? owner.account?.display_name || "Your account"
                  : "Sign in"}
              </strong>
              <p className="break">
                {owner.status === "signed_in" ? owner.email : "Use your Embassys email."}
              </p>
            </div>
            {owner.status === "signed_in" && (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void run({ type: "owner_signout", context: owner.context })}
              >
                Sign out
              </button>
            )}
          </div>
          {owner.status === "signed_in" && (
            <p className="body-note">Signing out keeps local servers running.</p>
          )}
          {owner.issue && !busy && (
            <p className="account-notice" role="status">
              {notices[owner.issue]}
            </p>
          )}
          {owner.status === "loading" && (
            <p className="body-note" role="status">
              Opening your account…
            </p>
          )}
          {["signed_out", "reauth_required", "code_sent"].includes(owner.status) && (
            <form
              className="registration-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (owner.status === "code_sent") {
                  const submitted = code;
                  setCode("");
                  void run({ type: "owner_verify", context: owner.context, code: submitted });
                } else void run({ type: "owner_request_code", context: owner.context, email });
              }}
            >
              {owner.status === "code_sent" ? (
                <>
                  <p>
                    If <strong className="break">{owner.email}</strong> has an Embassys agent, a
                    sign-in code is on its way. It expires after ten minutes.
                  </p>
                  <label htmlFor="owner-code">Verification code</label>
                  <input
                    id="owner-code"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))}
                    disabled={busy}
                  />
                  <div className="account-actions">
                    <button className="primary" disabled={busy || code.length !== 6} type="submit">
                      {busy
                        ? operation === "owner_request_code"
                          ? "Sending code…"
                          : "Signing in…"
                        : "Sign in"}
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy || wait > 0}
                      onClick={() =>
                        void run({
                          type: "owner_request_code",
                          context: owner.context,
                          email: owner.email ?? email,
                        })
                      }
                    >
                      {wait > 0 ? `Resend in ${wait}s` : "Resend code"}
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void run({ type: "owner_signout", context: owner.context })}
                    >
                      Change email
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label htmlFor="owner-email">Email address</label>
                  <input
                    id="owner-email"
                    type="email"
                    autoComplete="email"
                    maxLength={320}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                  />
                  <button className="primary" disabled={busy || !email.trim()} type="submit">
                    {busy ? "Requesting code…" : "Send sign-in code"}
                  </button>
                  {!compact && (
                    <p className="body-note">
                      New to Embassys? Choose Register on the welcome screen.
                    </p>
                  )}
                </>
              )}
            </form>
          )}
          {owner.status === "unavailable" && (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void run({ type: "owner_status" })}
            >
              Refresh account
            </button>
          )}
        </section>
      ) : null}
      {!compact && !decisionReview && !focusedRequest && (
        <div className="account-toolbar">
          {data?.kind === "requests" && !decisionReview && requestItems(data).length > 0 && (
            <span className="request-count">
              {requestItems(data).length} {requestItems(data).length === 1 ? "request" : "requests"}{" "}
              to review
            </span>
          )}
          {section === "profile" && (
            <div className="account-actions">
              <button
                className="text-button"
                type="button"
                onClick={() => void run({ type: "owner_open_web" })}
                disabled={busy}
              >
                Open web app
              </button>
              {section === "profile" && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void run({ type: "owner_reveal_logs" })}
                  disabled={busy}
                >
                  Account logs
                </button>
              )}
            </div>
          )}
          {owner.status === "signed_in" && (
            <button
              className="text-button account-refresh"
              type="button"
              disabled={busy || loading}
              onClick={() => {
                setRefresh((value) => value + 1);
                void requestSource?.refresh();
                void run({ type: "owner_profile", context: owner.context });
              }}
            >
              Refresh
            </button>
          )}
        </div>
      )}
      {(error || requestSource?.error) && (
        <p className="account-notice" role="alert">
          {error || requestSource?.error}
        </p>
      )}
      {owner.status === "signed_in" && confirmation && (
        <p className="account-notice" role="status">
          {confirmation}
        </p>
      )}
      {owner.status === "signed_in" && decisionReview && (
        <OwnerDecisionForm
          key={decisionReview.review_id}
          review={decisionReview}
          linkedConversation={linkedConversation}
          busy={busy}
          cancel={() => setDecisionReview(undefined)}
          submit={(command) => void run({ ...command, context: owner.context })}
        />
      )}
      {owner.status === "signed_in" && section !== "profile" && (
        <>
          {tab === "permissions" && (
            <fieldset className="appearance-control account-tabs">
              <legend className="sr-only">Permission direction</legend>
              {(
                [
                  ["granted", "Shared by you"],
                  ["received", "Shared with you"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    className="visually-hidden"
                    type="radio"
                    name="permission-direction"
                    value={value}
                    checked={direction === value}
                    onChange={() => setDirection(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div aria-busy={loading}>
            {loading ? (
              <p className="body-note" role="status">
                Loading account…
              </p>
            ) : (
              data &&
              !decisionReview &&
              !emptyLinkedRequests && (
                <AccountData
                  data={data}
                  updated={fetchedAt}
                  busy={busy}
                  focusedRequest={focusedRequest}
                  review={(kind, id) =>
                    void run({ type: "owner_review", context: owner.context, kind, id })
                  }
                />
              )
            )}
          </div>
          {fetchedAt && section !== "requests" && (
            <p className="account-limit">Updated {when(fetchedAt)}</p>
          )}
        </>
      )}
    </div>
  );
}
