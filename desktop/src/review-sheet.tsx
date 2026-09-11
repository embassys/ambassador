import { useEffect, useRef, useState } from "react";
import type { DesktopReview } from "../../src/desktop/review.js";

function formatted(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function ReviewContent({
  review,
  choice,
  choose,
  busy,
  submit,
  cancel,
}: {
  review: DesktopReview;
  choice: string;
  choose(value: string): void;
  busy: boolean;
  submit(): void;
  cancel(): void;
}) {
  const connection = review.kind === "connection";
  const read = !connection && review.permission.title === "mcp__ambassador__get_my_permissions";
  const remove = connection && review.action === "Disconnect";
  return (
    <>
      <header className="review-heading">
        <div className="review-symbol" aria-hidden="true">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M12 3 4 7v6c0 4 8 8 8 8s8-4 8-8V7L12 3Z" />
            <path d={connection ? "m8 12 3 3 5-6" : "M12 8v5m0 3h.01"} />
          </svg>
        </div>
        <div>
          <p className="eyebrow">
            {connection ? "Agent setup" : "Approval needed"} · {review.instanceName}
          </p>
          <h2 id="review-title">
            {connection
              ? `${review.action} ${review.providerName}?`
              : read
                ? "Check your Embassys connection"
                : "Review your agent's request"}
          </h2>
        </div>
      </header>
      <div className="review-body">
        <p id="review-description" className="review-intro">
          {connection
            ? remove
              ? "Remove the unchanged connection and skill added by this app. Your conversations and other settings stay in place."
              : `Add Embassys tools and its discovery skill to ${review.providerName}, then check the connection in a fresh session.`
            : read
              ? "Your agent wants to read this device's registration and permissions to confirm it is connected. Choose how to approve this step."
              : "Your agent needs a decision to continue setup. Choose one of its options below. You can inspect the full request before deciding."}
        </p>
        {connection ? (
          <>
            <ul className="review-checklist">
              {(remove
                ? ["Only app-owned, unchanged files are removed", "Saved conversations are kept"]
                : [
                    "Connect Embassys tools",
                    "Install the discovery skill",
                    "Verify with your agent",
                  ]
              ).map((item) => (
                <li key={item}>
                  <span aria-hidden="true">✓</span>
                  {item}
                </li>
              ))}
            </ul>
            <details className="review-details">
              <summary>Connection details</summary>
              <dl className="review-locations">
                <div>
                  <dt>Local address</dt>
                  <dd>
                    <code>{review.endpoint}</code>
                  </dd>
                </div>
                <div>
                  <dt>Agent settings</dt>
                  <dd>
                    <code>{review.configurationPath}</code>
                  </dd>
                </div>
                <div>
                  <dt>Discovery skill</dt>
                  <dd>
                    <code>{review.skillPath}</code>
                  </dd>
                </div>
              </dl>
            </details>
          </>
        ) : (
          <>
            <fieldset className="review-choices" disabled={busy}>
              <legend>Choose a response</legend>
              {review.permission.options.map((option) => (
                <label
                  className={choice === option.optionId ? "selected" : ""}
                  key={option.optionId}
                >
                  <input
                    type="radio"
                    name="provider-choice"
                    value={option.optionId}
                    checked={choice === option.optionId}
                    onChange={() => choose(option.optionId)}
                  />
                  <span>{option.name}</span>
                </label>
              ))}
            </fieldset>
            <details className="review-details">
              <summary>Technical details</summary>
              <p className="review-tool">
                <span>Requested tool</span>
                <code>{review.permission.title || "Not provided"}</code>
              </p>
              <pre>{formatted(review.permission.detail)}</pre>
            </details>
          </>
        )}
      </div>
      <footer className="review-footer">
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className={remove ? "danger" : "primary"}
          disabled={busy || (!connection && !choice)}
          onClick={submit}
        >
          {busy ? "Saving…" : connection ? review.action : "Continue"}
        </button>
      </footer>
    </>
  );
}

export function ReviewSheet({
  review,
  answer,
}: {
  review: DesktopReview;
  answer(id: string, value: string | null): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choice, choose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function respond(value: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      await answer(review.id, value);
    } catch {
      setError("This review couldn't be completed. Cancel and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="review-sheet"
      aria-labelledby="review-title"
      aria-describedby="review-description"
      onCancel={(event) => {
        event.preventDefault();
        void respond(null);
      }}
    >
      <ReviewContent
        review={review}
        choice={choice}
        choose={choose}
        busy={busy}
        submit={() => void respond(review.kind === "connection" ? "confirm" : choice)}
        cancel={() => void respond(null)}
      />
      {error && (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
