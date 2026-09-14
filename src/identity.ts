import {
  type CentralCredentialRecord,
  type LoadedCentralCredential,
  parseCentralCredential,
  serializeCentralCredential,
} from "./central-credential.js";
import { type CredentialStore, EncryptedFileCredentialStore } from "./credential-store.js";

export type { CredentialStore } from "./credential-store.js";

export class IdentityError extends Error {
  constructor(
    readonly code: "already_enrolled" | "not_enrolled" | "verification_busy" | "credential_expired",
  ) {
    super(code);
    this.name = "IdentityError";
  }
}

export class GatewayIdentity {
  #credential: LoadedCentralCredential | undefined;
  #commitBusy = false;
  #archive: LoadedCentralCredential | undefined;
  #archiveStore: CredentialStore | undefined;

  private constructor(
    private readonly store: CredentialStore,
    private readonly nowSeconds: () => number,
    credential?: LoadedCentralCredential,
  ) {
    this.#credential = credential;
  }

  static async open(
    store: CredentialStore,
    nowSeconds: () => number = () => Date.now() / 1_000,
  ): Promise<GatewayIdentity> {
    const stored = await store.load();
    const identity = new GatewayIdentity(
      store,
      nowSeconds,
      stored === undefined
        ? undefined
        : parseCentralCredential(stored, nowSeconds, { allowExpired: true }),
    );
    identity.#archiveStore =
      store instanceof EncryptedFileCredentialStore ? store.archiveStore() : undefined;
    const archive = await identity.#archiveStore?.load();
    if (archive) {
      const parsed = parseCentralCredential(archive, nowSeconds, { allowExpired: true });
      if (
        !identity.#credential ||
        parsed.token.subject !== identity.#credential.token.subject ||
        parsed.token.email !== identity.#credential.token.email
      )
        throw new Error("Stored conversation identity differs from enrollment");
      identity.#archive = parsed;
    }
    return identity;
  }

  get enrolled(): boolean {
    return this.#credential !== undefined;
  }

  get enrollment(): Record<string, string | boolean> {
    if (this.#credential === undefined) return { status: "not_enrolled" };
    return {
      status: "registered",
      verified: true,
      agent_id: this.#credential.token.subject,
      email: this.#credential.token.email,
      credential_status: this.expired ? "expired" : "active",
    };
  }

  credential(): LoadedCentralCredential {
    const credential = this.localCredential();
    if (this.expired) throw new IdentityError("credential_expired");
    return credential;
  }

  get expired(): boolean {
    return (
      this.#credential !== undefined &&
      this.#credential.token.expiresAt <= Math.floor(this.nowSeconds())
    );
  }

  localCredential(): LoadedCentralCredential {
    if (this.#credential === undefined) throw new IdentityError("not_enrolled");
    return this.#credential;
  }

  storageCredential(): LoadedCentralCredential {
    return this.#archive ?? this.localCredential();
  }
  async replaceExecution(record: CentralCredentialRecord): Promise<void> {
    if (!this.enrolled) {
      await this.enroll(async () => ({ credential: record, localResult: undefined }));
      return;
    }
    if (this.#commitBusy) throw new IdentityError("verification_busy");
    this.#commitBusy = true;
    try {
      const old = this.localCredential();
      const serialized = serializeCentralCredential(record);
      const replacement = parseCentralCredential(serialized, this.nowSeconds);
      if (
        replacement.token.subject !== old.token.subject ||
        replacement.token.email !== old.token.email
      )
        throw new Error("Execution credential belongs to another agent");
      if (replacement.keyThumbprint !== old.keyThumbprint && !this.#archive) {
        if (!this.#archiveStore) throw new Error("Archive key custody unavailable");
        await this.#archiveStore.save(old.serialized);
        this.#archive = old;
      }
      if (this.store.replace) await this.store.replace(old.serialized, serialized);
      else await this.store.save(serialized);
      this.#credential = replacement;
    } finally {
      this.#commitBusy = false;
    }
  }
  async renew(record: CentralCredentialRecord): Promise<void> {
    if (this.#commitBusy) throw new IdentityError("verification_busy");
    this.#commitBusy = true;
    try {
      const old = this.localCredential();
      const serialized = serializeCentralCredential(record);
      const loaded = parseCentralCredential(serialized, this.nowSeconds);
      if (
        loaded.token.subject !== old.token.subject ||
        loaded.token.email !== old.token.email ||
        loaded.keyThumbprint !== old.keyThumbprint ||
        loaded.record.dpop_private_key_pkcs8 !== old.record.dpop_private_key_pkcs8 ||
        loaded.token.expiresAt <= old.token.expiresAt ||
        loaded.token.executionDeviceId !== old.token.executionDeviceId ||
        loaded.token.executorEpoch !== old.token.executorEpoch
      )
        throw new Error("The renewed credential changed identity or key");
      if (this.store.replace) await this.store.replace(old.serialized, serialized);
      else await this.store.save(serialized);
      this.#credential = loaded;
    } finally {
      this.#commitBusy = false;
    }
  }

  async enroll<T>(
    operation: () => Promise<{
      readonly credential: CentralCredentialRecord;
      readonly localResult: T;
    }>,
  ): Promise<T> {
    if (this.#credential !== undefined) throw new IdentityError("already_enrolled");
    if (this.#commitBusy) throw new IdentityError("verification_busy");
    this.#commitBusy = true;
    try {
      const result = await operation();
      const serialized = serializeCentralCredential(result.credential);
      const loaded = parseCentralCredential(serialized, this.nowSeconds);
      await this.store.save(serialized);
      this.#credential = loaded;
      return result.localResult;
    } finally {
      this.#commitBusy = false;
    }
  }
}
