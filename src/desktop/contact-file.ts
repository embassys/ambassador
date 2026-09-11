import { type Contact, contactSchema } from "./people-schema.js";

const decode = (value: string) =>
  value
    .replace(/\\([nN,;\\])/gu, (_, escaped: string) => (/n/iu.test(escaped) ? " " : escaped))
    .trim();

/** Deliberately bounded UTF-8 vCard 3/4 subset: names and literal email addresses only. */
export function parseContactFile(text: string): {
  contacts: Contact[];
  skipped: number;
  duplicates: number;
} {
  if (
    !text.trim() ||
    new TextEncoder().encode(text).length > 1048576 ||
    text.includes(String.fromCharCode(0)) ||
    text.includes("\ufffd")
  )
    throw new Error("Choose a UTF-8 contact file smaller than 1 MiB.");
  const lines = text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n[ \t]|\n[ \t]/gu, "")
    .split(/\r?\n/u);
  const contacts = new Map<string, Contact>();
  let card: string[] | undefined;
  let cards = 0,
    skipped = 0,
    duplicates = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.toUpperCase() === "BEGIN:VCARD") {
      if (card || ++cards > 1000) throw new Error("Invalid contact file or more than 1,000 cards.");
      card = [];
    } else if (line.toUpperCase() === "END:VCARD") {
      if (!card) throw new Error("This contact file is incomplete.");
      let name = "",
        fallback = "",
        version = "",
        unsupported = false;
      const emails: string[] = [];
      for (const field of card) {
        const colon = field.indexOf(":");
        if (colon < 0) {
          unsupported = true;
          continue;
        }
        const head = field.slice(0, colon);
        const property = head.split(";")[0]?.split(".").at(-1)?.toUpperCase();
        const value = field.slice(colon + 1);
        if (
          ["FN", "N", "EMAIL"].includes(property ?? "") &&
          /(?:;ENCODING=|;CHARSET=(?!UTF-8(?:;|$)))/iu.test(head)
        )
          unsupported = true;
        if (property === "VERSION") version = value;
        if (property === "FN") name ||= decode(value);
        if (property === "N")
          fallback ||= value
            .split(/(?<!\\);/u)
            .slice(0, 2)
            .reverse()
            .map(decode)
            .filter(Boolean)
            .join(" ");
        if (property === "EMAIL" && !/;VALUE=(?!TEXT(?:;|$))/iu.test(head))
          emails.push(decode(value));
      }
      let valid = false;
      if (!unsupported && ["3.0", "4.0"].includes(version)) {
        for (const email of emails) {
          const parsed = contactSchema.safeParse({ name: name || fallback || email, email });
          if (!parsed.success) continue;
          valid = true;
          if (contacts.has(parsed.data.email)) duplicates++;
          else contacts.set(parsed.data.email, parsed.data);
          if (contacts.size > 1000)
            throw new Error("Choose a file with at most 1,000 email addresses.");
        }
      }
      if (!valid) skipped++;
      card = undefined;
    } else {
      if (!card) throw new Error("Choose a vCard (.vcf) contact file.");
      card.push(line);
    }
  }
  if (card || !cards) throw new Error("This contact file is incomplete.");
  return { contacts: [...contacts.values()], skipped, duplicates };
}
