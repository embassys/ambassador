import type { ReactNode } from "react";

export function Disclosure({
  title,
  meta,
  children,
  className = "",
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`detail-disclosure ${className}`}>
      <summary>
        <svg
          className="disclosure-chevron"
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
        <span className="disclosure-title">{title}</span>
        {meta && <span className="disclosure-meta">{meta}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
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
