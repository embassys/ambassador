import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import {
  type CentralKeyMaterial,
  centralJwkThumbprint,
  exactCentralPublicJwk,
} from "./central-credential.js";
import type { CredentialStore } from "./credential-store.js";
import { generateDpopKeyMaterial } from "./dpop.js";

const record = z.union([
  z.strictObject({ cleared: z.literal(true) }),
  z.strictObject({
    email: z.string().min(3).max(254),
    createdAt: z.number().int().nonnegative(),
    key: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/u),
  }),
]);
export class CentralVerificationKeys {
  constructor(
    readonly store: CredentialStore,
    readonly now = Date.now,
  ) {}
  static validate(value: string): void {
    record.parse(JSON.parse(value));
  }
  async forEmail(email: string): Promise<CentralKeyMaterial> {
    const saved = await this.store.load();
    const previous = saved ? record.parse(JSON.parse(saved)) : undefined;
    if (
      previous &&
      "key" in previous &&
      previous.email === email &&
      this.now() >= previous.createdAt &&
      this.now() - previous.createdAt < 30 * 60000
    ) {
      const privateKey = createPrivateKey({
        key: Buffer.from(previous.key, "base64url"),
        format: "der",
        type: "pkcs8",
      });
      const publicJwk = exactCentralPublicJwk(
        createPublicKey(privateKey).export({ format: "jwk" }),
      );
      return {
        privateKey,
        publicJwk,
        privateKeyPkcs8: previous.key,
        thumbprint: centralJwkThumbprint(publicJwk),
      };
    }
    const key = generateDpopKeyMaterial();
    await this.#save(
      saved,
      JSON.stringify({ email, createdAt: this.now(), key: key.privateKeyPkcs8 }),
    );
    return key;
  }
  async clear(): Promise<void> {
    const saved = await this.store.load();
    if (saved && !("cleared" in record.parse(JSON.parse(saved))))
      await this.#save(saved, JSON.stringify({ cleared: true }));
  }
  async #save(previous: string | undefined, value: string): Promise<void> {
    if (previous && this.store.replace) await this.store.replace(previous, value);
    else await this.store.save(value);
  }
}
