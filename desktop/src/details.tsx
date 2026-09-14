import { type ReactNode, useId, useRef } from "react";

export function DetailSheet({
  title,
  meta,
  children,
  className = "",
  onOpen,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  onOpen?(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className={`detail-access ${className}`}>
      <button
        type="button"
        ref={trigger}
        className="detail-trigger"
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => {
          dialog.current?.showModal();
          onOpen?.();
        }}
      >
        <span className="detail-title">{title}</span>
        {meta && <span className="detail-meta">{meta}</span>}
        <svg
          className="detail-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
        </svg>
      </button>
      <dialog
        id={id}
        ref={dialog}
        className="detail-sheet"
        aria-labelledby={`${id}-title`}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dialog.current?.close();
        }}
        onClose={(event) => {
          event.stopPropagation();
          if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
        }}
      >
        <header className="detail-sheet-header">
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="quiet-button" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </header>
        <div className="detail-sheet-body">{children}</div>
      </dialog>
    </div>
  );
}

export function StructuredData({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="data-empty">null</span>;
  if (typeof value !== "object")
    return (
      <span
        className={`data-value ${typeof value === "string" && /^(\/|[A-Za-z]:\\)/u.test(value) ? "data-path" : ""}`}
      >
        {String(value)}
      </span>
    );
  if (depth >= 5) return <pre className="data-overflow">{JSON.stringify(value, null, 2)}</pre>;
  if (Array.isArray(value))
    return value.length ? (
      <ol className="data-list">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Immutable JSON values retain their array position and have no interactive state.
          <li key={index}>
            <StructuredData value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="data-empty">[]</span>
    );
  const fields = Object.entries(value);
  return fields.length ? (
    <dl className="structured-data">
      {fields.map(([key, item]) => (
        <div key={key}>
          <dt title={key}>{key.replaceAll("_", " ")}</dt>
          <dd>
            <StructuredData value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <span className="data-empty">{"{}"}</span>
  );
}

export function SavedContent({ text }: { text: string }) {
  try {
    return <StructuredData value={JSON.parse(text)} />;
  } catch {
    return <div className="saved-text">{text}</div>;
  }
}
