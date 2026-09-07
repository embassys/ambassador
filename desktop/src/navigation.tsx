export const primaryPages = [
  { id: "attention", label: "Requests", path: "M3 13h4l2 3h6l2-3h4M3 13l2-8h14l2 8v6H3z" },
  {
    id: "permissions",
    label: "Permissions",
    path: "M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1 3 9 9m-4-4 2-2m1 5 2-2",
  },
  {
    id: "conversations",
    label: "Messages",
    path: "M20 12a8 8 0 0 1-11 7l-5 1 1-5a8 8 0 1 1 15-3Z",
  },
  {
    id: "account",
    label: "Account",
    path: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 21v-2a7 7 0 0 1 14 0v2",
  },
] as const;
export function Navigation({
  page,
  select,
}: {
  page: string;
  select(page: (typeof primaryPages)[number]["id"]): void;
}) {
  const current = primaryPages.some((item) => item.id === page) ? page : "account";
  return (
    <nav aria-label="Main navigation">
      {primaryPages.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`nav-item ${current === item.id ? "active" : ""}`}
          aria-current={current === item.id ? "page" : undefined}
          onClick={() => select(item.id)}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={item.path} />
          </svg>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
