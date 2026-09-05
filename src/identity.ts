import {
  type CentralCredentialRecord,
  type LoadedCentralCredential,
  parseCentralCredential,
  serializeCentralCredential,
} from "./central-credential.js";
import type { CredentialStore } from "./credential-store.js";

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
    return new GatewayIdentity(
      store,
      nowSeconds,
      stored === undefined
        ? undefined
        : parseCentralCredential(stored, nowSeconds, { allowExpired: true }),
    );
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
