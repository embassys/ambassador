import { join } from "node:path";
import { z } from "zod";
import { EncryptedRecordStore } from "../encrypted-record-store.js";
import type { OwnerStore } from "./owner-store.js";
import { type Contact, contactEmail, contactSchema, contactsSchema } from "./people-schema.js";

const recordSchema = z.strictObject({ agentId: z.uuid(), contacts: contactsSchema });
export class OwnerPeople {
  readonly records: EncryptedRecordStore<z.infer<typeof recordSchema>>;
  constructor(store: OwnerStore) {
    this.records = new EncryptedRecordStore(
      join(store.directory, "people.sqlite"),
      { storageSecret: store.key, salt: "embassys-owner-people:v1" },
      {
        scope: "embassys-owner-people",
        identifier: (value) => value.agentId,
        parse: (bytes) => recordSchema.parse(JSON.parse(bytes.toString("utf8"))),
        error: () => new Error("Saved people couldn't be accessed."),
      },
    );
  }
  list(agentId: string): Contact[] {
    return this.records.get(z.uuid().parse(agentId))?.contacts ?? [];
  }
  save(agentId: string, values: Contact[], replace = false): void {
    const validated = z.array(contactSchema).min(1).max(50).parse(values);
    if (replace && validated.length !== 1) throw new Error("Edit one person at a time.");
    const contacts = new Map(this.list(agentId).map((contact) => [contact.email, contact]));
    for (const contact of validated)
      if (replace || !contacts.has(contact.email)) contacts.set(contact.email, contact);
    if (contacts.size > 500)
      throw new Error("You can save up to 500 people. Remove someone before adding more.");
    this.records.put(recordSchema.parse({ agentId, contacts: [...contacts.values()] }), {
      replace: true,
    });
  }
  remove(agentId: string, email: string): void {
    const normalized = contactEmail.parse(email);
    const contacts = this.list(agentId).filter((contact) => contact.email !== normalized);
    if (!contacts.length) this.records.remove([agentId]);
    else this.records.put({ agentId, contacts }, { replace: true });
  }
  close(): void {
    this.records.close();
  }
}
