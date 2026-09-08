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
function Details({ value, label = "Details" }: { value: unknown; label?: string }) {
  return value == null ? null : (
    <details className="account-details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function AccountData({
  data,
  review,
  busy = false,
}: {
  data: OwnerView;
  review?(kind: OwnerMutation["kind"], id: string): void;
  busy?: boolean;
}) {
  if (data.kind === "profile" || data.kind === "review" || data.kind === "mutation") return null;
  if (data.kind === "requests")
    return (
      <>
        <p className="body-note">Review a request to approve it or send an answer.</p>
        <p className="account-limit">
          Showing up to 200 permissions and 200 questions. This snapshot may not include every
          pending request.
        </p>
        {data.unconfirmed?.map((item) => (
          <p className="account-notice" role="status" key={`${item.kind}:${item.id}`}>
            Confirmation unavailable for {action(item.action_type)}. Your submission may have been
            accepted; it will not be sent again. <small className="break">Request {item.id}</small>
          </p>
        ))}
        {data.unconfirmedMore && (
          <p className="body-note">Showing the first 100 unconfirmed submissions.</p>
        )}
        <section className="settings-section">
          <h3>Permission requests · {data.permission_requests.length} shown</h3>
          {data.permission_requests.length === 0 && (
            <p className="body-note">No permission requests in this snapshot.</p>
          )}
          {data.permission_requests.map((item) => (
            <article className="account-row" key={item.id}>
              <div className="account-row-heading">
                <strong>{action(item.action_type)}</strong>
                <time>{when(item.created_at)}</time>
              </div>
              <p className="break">
                {item.requester_name || item.requester_email || "Requester unavailable"}
                {item.requester_name && item.requester_email ? ` · ${item.requester_email}` : ""}
              </p>
              {item.action_description && <p>{item.action_description}</p>}
              <p className="body-note">Request reason isn't included by the server.</p>
              {item.expires_at && <p className="body-note">Expires {when(item.expires_at)}</p>}
              <Details label="Permission scope" value={item.scope} />
              {review && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !permissionChoices(item.decision_options).length}
                  onClick={() => review("permission", item.id)}
                >
                  Review request
                </button>
              )}
              {!permissionChoices(item.decision_options).length && (
                <p className="body-note">
                  This app does not recognize these choices. Use the email or web app.
                </p>
              )}
            </article>
          ))}
        </section>
        <section className="settings-section">
          <h3>Questions · {data.input_requests.length} shown</h3>
          {data.input_requests.length === 0 && (
            <p className="body-note">No questions in this snapshot.</p>
          )}
          {data.input_requests.map((item) => (
            <article className="account-row" key={item.id}>
              <div className="account-row-heading">
                <strong>{action(item.action_type)}</strong>
                <time>{when(item.created_at)}</time>
              </div>
              <p className="account-question">{item.prompt}</p>
              {item.options && (
                <p className="body-note">
                  Offered choices: {item.options.map((option) => option.label).join(" · ")}
                </p>
              )}
              {review && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => review("input", item.id)}
                >
                  Review question
                </button>
              )}
            </article>
          ))}
        </section>
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
}: {
  review: OwnerReview;
  busy: boolean;
  submit(command: Omit<Extract<OwnerCommand, { type: "owner_submit" }>, "context">): void;
  cancel(): void;
}) {
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
    <section className="owner-review settings-section" aria-label="Review request">
      <h3>
        {revoked
          ? "Revoke permission"
          : target.kind === "input"
            ? "Answer your agent"
            : "Decide permission"}
      </h3>
      <strong>{action(target.item.action_type)}</strong>
      {target.kind === "permission" && (
        <>
          <p className="break">
            Requested by{" "}
            {target.item.requester_name ||
              target.item.requester_email ||
              "an unavailable requester"}
            {target.item.requester_name && target.item.requester_email
              ? ` · ${target.item.requester_email}`
              : ""}
          </p>
          {target.item.action_description && <p>{target.item.action_description}</p>}
          <p className="body-note">Request reason isn't included by the server.</p>
        </>
      )}
      {target.kind === "input" ? (
        <>
          <p className="account-question">{target.item.prompt}</p>
          <p className="body-note">The server does not include the originating conversation.</p>
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
          <p className="body-note">
            {target.item.expires_at
              ? `Expires ${when(target.item.expires_at)}`
              : "No expiry provided."}
          </p>
          {target.item.scope != null && (
            <div className="account-details">
              <p>Permission scope</p>
              <pre>{JSON.stringify(target.item.scope, null, 2)}</pre>
            </div>
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
                  {option.label}
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
        <div className="account-actions">
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
}: {
  snapshot: OwnerSnapshot;
  call(command: OwnerCommand): Promise<unknown>;
  changed(): Promise<void>;
  section?: Tab | "profile";
  signIn?(): void;
  compact?: boolean;
  initialEmail?: string;
}) {
  const [owner, setOwner] = useState(snapshot);
  const [email, setEmail] = useState(snapshot.email ?? initialEmail);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisionReview, setDecisionReview] = useState<OwnerReview>();
  const [confirmation, setConfirmation] = useState("");
  const submitting = useRef(false);
  const [operation, setOperation] = useState<OwnerCommand["type"]>();
  const [error, setError] = useState("");
  const tab = section;
  const [direction, setDirection] = useState<"granted" | "received">("granted");
  const [data, setData] = useState<OwnerView>();
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(false);
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
    if (owner.status !== "signed_in" || tab === "profile") return;
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
  }, [call, owner.context, owner.status, tab, direction, refresh]);

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
        }
        if (reply.state === "unavailable" && reply.issue) {
          if (command.type === "owner_submit") {
            setDecisionReview(undefined);
            setConfirmation(notices[reply.issue]);
            setRefresh((value) => value + 1);
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
  return (
    <div className="account-page">
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
      {!compact && (
        <div className="account-toolbar">
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
          {owner.status === "signed_in" && (
            <button
              className="secondary"
              type="button"
              disabled={busy || loading}
              onClick={() => {
                setRefresh((value) => value + 1);
                void run({ type: "owner_profile", context: owner.context });
              }}
            >
              Refresh
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="account-notice" role="alert">
          {error}
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
              data && (
                <AccountData
                  data={data}
                  busy={busy}
                  review={(kind, id) =>
                    void run({ type: "owner_review", context: owner.context, kind, id })
                  }
                />
              )
            )}
          </div>
          {fetchedAt && (
            <p className="account-limit">
              Updated {when(fetchedAt)}. Refresh to see changes made elsewhere.
            </p>
          )}
        </>
      )}
    </div>
  );
}
