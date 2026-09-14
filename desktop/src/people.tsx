import { useEffect, useRef, useState } from "react";
import { parseContactFile } from "../../src/desktop/contact-file.js";
import type { OwnerCommand, OwnerReply, OwnerSnapshot } from "../../src/desktop/owner-protocol.js";
import { type Contact, contactSchema } from "../../src/desktop/people-schema.js";
import { PeopleNetwork } from "./people-network.js";

export function PeopleIntroduction() {
  return <p className="people-storage">Saving a person doesn’t invite them or grant access.</p>;
}

export function PeopleList({
  contacts,
  busy,
  open,
  copy,
}: {
  contacts: Contact[];
  busy: boolean;
  open(contact: Contact, trigger: HTMLButtonElement): void;
  copy(contact: Contact): void;
}) {
  return (
    <ul className="people-directory" aria-label="Saved people">
      {contacts.map((contact) => (
        <li key={contact.email}>
          <button
            className="person-open"
            type="button"
            disabled={busy}
            onClick={(event) => open(contact, event.currentTarget)}
          >
            <span className="person-avatar" aria-hidden="true">
              {contact.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="person-text">
              <strong>{contact.name}</strong>
              <span>{contact.email}</span>
            </span>
          </button>
          <button
            className="quiet-button person-copy"
            type="button"
            disabled={busy}
            aria-label={`Copy email for ${contact.name}`}
            onClick={() => copy(contact)}
          >
            Copy email
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ContactImportGuide({ chooseFile }: { chooseFile(): void }) {
  return (
    <div className="contact-import-guide">
      <p>
        Export the people you want from your contacts app as a vCard file (.vcf), then choose that
        file here.
      </p>
      <p>
        You'll choose who to save before importing. Only names and emails are saved. Nothing is sent
        to your contacts.
      </p>
      <button type="button" className="primary" onClick={chooseFile}>
        Choose file…
      </button>
      <p className="body-note">
        Embassys imports files; it doesn't read your address book directly.
      </p>
    </div>
  );
}

export function People({
  owner,
  call,
}: {
  owner: OwnerSnapshot;
  call(command: OwnerCommand): Promise<unknown>;
}) {
  const [tab, setTab] = useState<"saved" | "connections" | "invitations">("saved");
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
  const [importOpen, setImportOpen] = useState(false);
  const [chosen, choose] = useState(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const importTrigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const personDialog = useRef<HTMLDialogElement>(null);
  const personTrigger = useRef<HTMLButtonElement | null>(null);
  const personOpen = Boolean(selected || editing);
  const active = useRef(true);
  const working = useRef(false);
  useEffect(() => {
    if (editing) nameInput.current?.focus();
  }, [editing]);
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
    if (importOpen) element?.showModal();
    return () => {
      element?.close();
      if (importOpen) importTrigger.current?.focus();
    };
  }, [importOpen]);
  useEffect(() => {
    if (preview) dialog.current?.querySelector<HTMLInputElement>("input:not(:disabled)")?.focus();
  }, [preview]);
  useEffect(() => {
    const element = personDialog.current;
    if (personOpen) element?.showModal();
    return () => {
      element?.close();
      if (personOpen) personTrigger.current?.focus();
    };
  }, [personOpen]);
  function closePerson() {
    if (working.current) return;
    select(undefined);
    edit(false);
    remove(false);
    setError("");
  }
  async function copyEmail(contact: Contact) {
    try {
      await window.ambassador.copy(contact.email);
      if (active.current) setNotice("Email address copied.");
    } catch {
      if (active.current) setError("Couldn't copy this email.");
    }
  }
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
      setImportOpen(false);
      choose(new Set());
      edit(false);
      remove(false);
      select(undefined);
      if (command.type === "owner_people_remove") {
        setNotice("Person removed from this device.");
      } else if (command.type === "owner_people_save" && command.contacts.length > 1) {
        setNotice(
          `${command.contacts.length} people saved on this device. No invitations were sent.`,
        );
      } else {
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
  async function invite(contact: Contact) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = (await call({
        type: "owner_invite",
        context: owner.context,
        email: contact.email,
      })) as OwnerReply;
      if (!active.current) return;
      if (reply.snapshot.context !== owner.context || reply.data?.kind !== "invitation")
        throw new Error();
      const invitation = reply.data.invitation;
      setNotice(
        invitation.state === "accepted"
          ? "You’re already connected."
          : invitation.direction === "incoming"
            ? "This person has invited you. Open Invitations to respond."
            : invitation.delivered
              ? "Invitation sent. No access is granted by connecting."
              : "The invitation is saved, but email delivery isn’t confirmed. You can try again.",
      );
    } catch {
      if (active.current)
        setError("The invitation wasn’t confirmed. Check your connection, then try again.");
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
    <section className="people-page" aria-label="People" aria-busy={loading || busy}>
      <header className="people-toolbar">
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
          className="people-tool people-import"
          aria-label="Import contacts"
          title="Import contacts"
          ref={importTrigger}
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setError("");
            setPreview(undefined);
            choose(new Set());
            setImportOpen(true);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 3v9m-3-3 3 3 3-3M4 12v4h12v-4" />
          </svg>
          Import
        </button>
        <button
          className="people-tool"
          type="button"
          disabled={busy || loading || contacts.length >= 500}
          onClick={(event) => {
            personTrigger.current = event.currentTarget;
            setNotice("");
            select(undefined);
            setName("");
            setEmail("");
            edit(true);
            remove(false);
            setError("");
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 4v12M4 10h12" />
          </svg>
          Add person
        </button>
      </header>
      {error && !personOpen && !importOpen && (
        <p className="account-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="people-notice" role="status">
          {notice}
        </p>
      )}
      <fieldset className="people-tabs">
        <legend className="sr-only">People views</legend>
        {(["saved", "connections", "invitations"] as const).map((value) => (
          <button
            type="button"
            className="quiet-button"
            aria-pressed={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {value === "saved" ? "Saved" : value === "connections" ? "Connected" : "Invitations"}
          </button>
        ))}
      </fieldset>
      <div className="people-content">
        {tab !== "saved" ? (
          <PeopleNetwork
            query={query}
            key={`${owner.context}:${tab}`}
            owner={owner}
            kind={tab}
            call={call}
          />
        ) : loading ? (
          <p className="body-note" role="status">
            Loading people…
          </p>
        ) : !contacts.length ? (
          <div className="people-empty">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              aria-hidden="true"
            >
              <circle cx="9" cy="8" r="3" />
              <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2" />
            </svg>
            <h2>Add your first person</h2>
            <p>
              Save an email with Add person, or choose people from a contact file with Import
              contacts.
            </p>
          </div>
        ) : (
          <>
            {!visible.length && <p className="people-no-match">No people match this search.</p>}
            <PeopleList
              contacts={visible.slice(0, limit)}
              busy={busy}
              open={(contact, trigger) => {
                personTrigger.current = trigger;
                setNotice("");
                select(contact);
                edit(false);
                remove(false);
                setError("");
              }}
              copy={(contact) => void copyEmail(contact)}
            />
            {visible.length > limit && (
              <button className="quiet-button" type="button" onClick={() => setLimit(limit + 50)}>
                Show more
              </button>
            )}
          </>
        )}
      </div>
      <footer className="people-footer">
        {!loading && tab === "saved" && (
          <p className="people-count" aria-live="polite">
            {query
              ? `${visible.length} ${visible.length === 1 ? "match" : "matches"}`
              : `${contacts.length} ${contacts.length === 1 ? "person" : "people"}`}
          </p>
        )}
        <PeopleIntroduction />
      </footer>
      {personOpen && (
        <dialog
          ref={personDialog}
          className="review-sheet person-sheet"
          aria-labelledby="person-title"
          onCancel={(event) => {
            event.preventDefault();
            closePerson();
          }}
        >
          <header className="review-heading">
            <h2 id="person-title">
              {editing
                ? selected
                  ? "Edit person"
                  : "Add person"
                : removing
                  ? "Remove this person?"
                  : selected?.name}
            </h2>
          </header>
          {editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (valid && !busy)
                  void run({
                    type: "owner_people_save",
                    context: owner.context,
                    contacts: [{ name, email }],
                    replace: !!selected,
                  });
              }}
            >
              <div className="review-body person-form">
                <label htmlFor="person-name">Name</label>
                <input
                  id="person-name"
                  ref={nameInput}
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
                  Saved on this device. No invitation or access is granted.
                </p>
                {!selected && existing.has(email.trim().toLowerCase()) && (
                  <p className="body-note">This email is already saved.</p>
                )}
              </div>
              <footer className="review-footer">
                <button type="button" className="secondary" disabled={busy} onClick={closePerson}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    busy || !valid || (!selected && existing.has(email.trim().toLowerCase()))
                  }
                >
                  {busy ? "Saving…" : "Save person"}
                </button>
              </footer>
            </form>
          ) : (
            selected && (
              <>
                <div className="review-body person-summary">
                  <p className="person-address">{selected.email}</p>
                  {removing ? (
                    <p>
                      Only the saved contact is removed. Their permissions and messages stay as they
                      are.
                    </p>
                  ) : (
                    <>
                      <p>
                        Use this email in your agent's chat to ask for availability or arrange a
                        meeting through Embassys.
                      </p>
                      <div className="person-sheet-actions">
                        <button
                          className="quiet-button"
                          type="button"
                          onClick={() => void copyEmail(selected)}
                        >
                          Copy email
                        </button>
                        <button
                          className="quiet-button"
                          type="button"
                          onClick={() => {
                            setName(selected.name);
                            setEmail(selected.email);
                            edit(true);
                          }}
                        >
                          Edit name
                        </button>
                        <button className="quiet-button" type="button" onClick={() => remove(true)}>
                          Remove person…
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <footer className="review-footer">
                  <button type="button" className="secondary" disabled={busy} onClick={closePerson}>
                    {removing ? "Cancel" : "Done"}
                  </button>
                  {removing ? (
                    <button
                      type="button"
                      className="danger"
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
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void invite(selected)}
                    >
                      {busy ? "Inviting…" : "Invite to Embassys"}
                    </button>
                  )}
                </footer>
              </>
            )
          )}
          {notice && (
            <p className="person-sheet-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="review-error" role="alert">
              {error}
            </p>
          )}
        </dialog>
      )}
      {importOpen && (
        <dialog
          ref={dialog}
          className="review-sheet contact-import"
          aria-labelledby="import-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) setImportOpen(false);
          }}
        >
          <header className="review-heading">
            <div>
              <p className="eyebrow">Import contacts</p>
              <h2 id="import-title">{preview ? "Choose who to add" : "From your contacts app"}</h2>
            </div>
          </header>
          <div className="review-body">
            {preview ? (
              <>
                <p className="review-intro">
                  Select up to 25 people at a time. Only their name and email will be saved. Nothing
                  is sent to them.
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
              </>
            ) : (
              <ContactImportGuide chooseFile={() => fileInput.current?.click()} />
            )}
          </div>
          <footer className="review-footer">
            <span className="body-note">
              {preview ? `${chosen.size} selected` : "vCard · Up to 1 MiB"}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setImportOpen(false)}
            >
              Cancel
            </button>
            {preview && (
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
            )}
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
