import { useEffect, useRef, useState } from "react";
import { parseContactFile } from "../../src/desktop/contact-file.js";
import type { OwnerCommand, OwnerReply, OwnerSnapshot } from "../../src/desktop/owner-protocol.js";
import { type Contact, contactSchema } from "../../src/desktop/people-schema.js";

export function People({
  owner,
  call,
}: {
  owner: OwnerSnapshot;
  call(command: OwnerCommand): Promise<unknown>;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [selected, select] = useState<Contact>();
  const [editing, edit] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [removing, remove] = useState(false);
  const [preview, setPreview] = useState<ReturnType<typeof parseContactFile>>();
  const [chosen, choose] = useState(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const working = useRef(false);
  // The parent keys this view by account context. Late reads never cross an account change.
  useEffect(() => {
    active.current = true;
    void call({ type: "owner_people", context: owner.context })
      .then((raw) => {
        const reply = raw as OwnerReply;
        if (!active.current) return;
        if (reply.snapshot.context !== owner.context || reply.data?.kind !== "people")
          throw new Error();
        setContacts(reply.data.contacts);
      })
      .catch(() => {
        if (active.current)
          setError("Your saved people couldn't be loaded. Reopen this view to try again.");
      })
      .finally(() => {
        if (active.current) setLoading(false);
      });
    return () => {
      active.current = false;
    };
  }, [call, owner.context]);
  useEffect(() => {
    const element = dialog.current;
    if (preview) element?.showModal();
    return () => element?.close();
  }, [preview]);
  async function run(command: OwnerCommand) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = (await call(command)) as OwnerReply;
      if (!active.current) return;
      if (reply.snapshot.context !== owner.context || reply.data?.kind !== "people")
        throw new Error();
      setContacts(reply.data.contacts);
      setPreview(undefined);
      choose(new Set());
      edit(false);
      remove(false);
      if (command.type === "owner_people_remove") {
        select(undefined);
        setNotice("Person removed from this device.");
      } else {
        select(reply.data.contacts.find((contact) => contact.email === email.trim().toLowerCase()));
        setNotice("Saved on this device. No invitation was sent.");
      }
    } catch {
      if (active.current)
        setError(
          "Couldn't save this change. Check that you have fewer than 500 people, then reopen this view and try again.",
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function importFile(file?: File) {
    setError("");
    setNotice("");
    if (!file) return;
    try {
      if (file.size > 1048576 || !/\.vcf$/iu.test(file.name))
        throw new Error("Choose a .vcf contact file smaller than 1 MiB.");
      const parsed = parseContactFile(await file.text());
      if (!active.current) return;
      setPreview(parsed);
      choose(new Set());
    } catch (error) {
      if (active.current)
        setError(error instanceof Error ? error.message : "This contact file couldn't be read.");
    }
  }
  const visible = contacts.filter((contact) =>
    `${contact.name} ${contact.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  const valid = contactSchema.safeParse({ name, email }).success;
  const existing = new Set(contacts.map((contact) => contact.email));
  return (
    <section className="people-page" aria-busy={loading || busy}>
      <div className="people-toolbar">
        <label className="people-search">
          <span className="sr-only">Search people</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
          <input
            type="search"
            placeholder="Search people"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(50);
            }}
          />
        </label>
        <input
          className="visually-hidden"
          tabIndex={-1}
          aria-label="Contact file"
          ref={fileInput}
          type="file"
          accept=".vcf,text/vcard"
          onChange={(event) => {
            void importFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <button
          className="secondary"
          type="button"
          disabled={busy || loading}
          onClick={() => fileInput.current?.click()}
        >
          Import contacts
        </button>
        <button
          className="primary"
          type="button"
          disabled={busy || loading || contacts.length >= 500}
          onClick={() => {
            select(undefined);
            setName("");
            setEmail("");
            edit(true);
            remove(false);
            setError("");
          }}
        >
          Add person
        </button>
      </div>
      {error && (
        <p className="account-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="people-notice" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p className="body-note" role="status">
          Loading people…
        </p>
      ) : (
        <div className={`people-layout ${selected || editing ? "with-detail" : ""}`}>
          <div className="people-list">
            {!contacts.length ? (
              <div className="polished-empty">
                <div className="empty-symbol" aria-hidden="true">
                  ↗
                </div>
                <h2>Your people, close by</h2>
                <p>
                  Save someone’s email or choose contacts to import. You can use their address when
                  asking your agent to connect.
                </p>
              </div>
            ) : (
              <>
                <div className="list-caption">
                  {query
                    ? `${visible.length} ${visible.length === 1 ? "match" : "matches"}`
                    : `${contacts.length} saved ${contacts.length === 1 ? "person" : "people"}`}
                </div>
                {!visible.length && <p className="simple-empty">No people match this search.</p>}
                {visible.slice(0, limit).map((contact) => (
                  <button
                    key={contact.email}
                    className={`person-row ${selected?.email === contact.email ? "selected" : ""}`}
                    type="button"
                    aria-pressed={selected?.email === contact.email}
                    disabled={busy}
                    onClick={() => {
                      select(contact);
                      edit(false);
                      remove(false);
                    }}
                  >
                    <span className="person-avatar" aria-hidden="true">
                      {contact.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="person-text">
                      <strong>{contact.name}</strong>
                      <span>{contact.email}</span>
                    </span>
                    <span className="person-chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                ))}
                {visible.length > limit && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => setLimit(limit + 50)}
                  >
                    Show more
                  </button>
                )}
              </>
            )}
          </div>
          {(selected || editing) && (
            <aside className="person-detail">
              {editing ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (valid)
                      void run({
                        type: "owner_people_save",
                        context: owner.context,
                        contacts: [{ name, email }],
                        replace: !!selected,
                      });
                  }}
                >
                  <p className="eyebrow">{selected ? "Edit person" : "New person"}</p>
                  <h2>{selected ? "Edit name" : "Add someone"}</h2>
                  <label htmlFor="person-name">Name</label>
                  <input
                    id="person-name"
                    autoComplete="off"
                    value={name}
                    maxLength={120}
                    required
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <label htmlFor="person-email">Email address</label>
                  <input
                    id="person-email"
                    type="email"
                    autoComplete="off"
                    value={email}
                    maxLength={320}
                    required
                    disabled={busy || !!selected}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <p className="body-note">
                    Saved locally. Adding someone doesn’t grant permission to access their
                    information.
                  </p>
                  <div className="account-actions">
                    <button
                      className="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => edit(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="primary"
                      type="submit"
                      disabled={
                        busy || !valid || (!selected && existing.has(email.trim().toLowerCase()))
                      }
                    >
                      {busy ? "Saving…" : "Save person"}
                    </button>
                  </div>
                  {!selected && existing.has(email.trim().toLowerCase()) && (
                    <p className="body-note">This email is already saved.</p>
                  )}
                </form>
              ) : (
                selected && (
                  <>
                    <div className="person-avatar large" aria-hidden="true">
                      {selected.name.slice(0, 1).toUpperCase()}
                    </div>
                    <h2>{selected.name}</h2>
                    <p className="person-email">{selected.email}</p>
                    <span className="subtle-tag">Saved on this device</span>
                    <div className="person-actions">
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => {
                          void window.ambassador
                            .copy(selected.email)
                            .then(() => setNotice("Email address copied."))
                            .catch(() => setError("Couldn't copy this email."));
                        }}
                      >
                        Copy email
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setName(selected.name);
                          setEmail(selected.email);
                          edit(true);
                        }}
                      >
                        Edit name
                      </button>
                    </div>
                    <div className="person-permission-note">
                      <strong>Access is always separate</strong>
                      <p>Your agent still needs permission for each protected action.</p>
                    </div>
                    {removing ? (
                      <div className="person-remove">
                        <p>
                          Remove this saved person? Their permissions and messages stay as they are.
                        </p>
                        <div className="account-actions">
                          <button
                            className="secondary"
                            type="button"
                            disabled={busy}
                            onClick={() => remove(false)}
                          >
                            Cancel
                          </button>
                          <button
                            className="danger"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run({
                                type: "owner_people_remove",
                                context: owner.context,
                                email: selected.email,
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => remove(true)}
                      >
                        Remove person
                      </button>
                    )}
                  </>
                )
              )}
            </aside>
          )}
        </div>
      )}
      <details className="people-footnote">
        <summary>Saved on this device</summary>
        <p>
          Only names and emails are saved, for this account on this device. Invitations and synced
          connections aren’t available yet.
        </p>
      </details>
      {preview && (
        <dialog
          ref={dialog}
          className="review-sheet contact-import"
          aria-labelledby="import-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setPreview(undefined);
          }}
        >
          <header className="review-heading">
            <div>
              <p className="eyebrow">Import contacts</p>
              <h2 id="import-title">Choose who to add</h2>
            </div>
          </header>
          <div className="review-body">
            <p className="review-intro">
              Select up to 25 people at a time. Only their name and email will be saved. Nothing is
              sent to them.
            </p>
            <div className="import-list">
              {preview.contacts.map((contact) => (
                <label key={contact.email}>
                  <input
                    type="checkbox"
                    checked={chosen.has(contact.email)}
                    disabled={
                      busy ||
                      existing.has(contact.email) ||
                      (!chosen.has(contact.email) &&
                        (chosen.size >= 25 || contacts.length + chosen.size >= 500))
                    }
                    onChange={(event) => {
                      const next = new Set(chosen);
                      if (event.target.checked) next.add(contact.email);
                      else next.delete(contact.email);
                      choose(next);
                    }}
                  />
                  <span>
                    <strong>{contact.name}</strong>
                    <span>
                      {contact.email}
                      {existing.has(contact.email) ? " · Already saved" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {!preview.contacts.length && <p>No supported email contacts in this file.</p>}
            {(preview.skipped > 0 || preview.duplicates > 0) && (
              <p className="body-note">
                {preview.skipped} cards skipped (unsupported or no valid email).{" "}
                {preview.duplicates} duplicate email entries ignored.
              </p>
            )}
          </div>
          <footer className="review-footer">
            <span className="body-note">{chosen.size} selected</span>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !chosen.size}
              onClick={() =>
                void run({
                  type: "owner_people_save",
                  context: owner.context,
                  contacts: preview.contacts.filter((contact) => chosen.has(contact.email)),
                })
              }
            >
              Add selected
            </button>
          </footer>
          {error && (
            <p className="review-error" role="alert">
              {error}
            </p>
          )}
        </dialog>
      )}
    </section>
  );
}
