import type { CredentialStore, VersionedCredentialStore } from "./credential-store.js";
import {
  assertSameKeyCredentialReplacement,
  type CentralCredentialV2Record,
  type LoadedCentralCredentialV2,
  parseCentralCredentialV2,
  serializeCentralCredentialV2,
} from "./credential-v2.js";
import { parseVerificationSuccess, type VerificationSuccess } from "./mcp-contract.js";

export type { CredentialStore } from "./credential-store.js";

export class IdentityError extends Error {
  constructor(
    readonly code:
      | "already_enrolled"
      | "central_authentication_failed"
      | "legacy_credential_required"
      | "not_enrolled"
      | "verification_busy",
  ) {
    super(code);
    this.name = "IdentityError";
  }
}

export class GatewayIdentity {
  #credential:
    | { readonly version: 1; readonly token: string }
    | { readonly version: 2; readonly value: LoadedCentralCredentialV2 }
    | undefined;
  #authenticationFailed = false;
  #credentialCommitBusy = false;

  private constructor(
    private readonly credentialStore: CredentialStore,
    credential:
      | { readonly version: 1; readonly token: string }
      | { readonly version: 2; readonly value: LoadedCentralCredentialV2 }
      | undefined,
  ) {
    this.#credential = credential;
  }

  static async open(credentialStore: CredentialStore): Promise<GatewayIdentity> {
    if (isVersionedCredentialStore(credentialStore)) {
      const stored = await credentialStore.loadCredential();
      if (stored === undefined) return new GatewayIdentity(credentialStore, undefined);
      if (stored.version === 1 && stored.plaintext.trimStart().startsWith("{")) {
        throw new Error("The legacy credential is invalid");
      }
      return new GatewayIdentity(
        credentialStore,
        stored.version === 1
          ? { version: 1, token: stored.plaintext }
          : { version: 2, value: parseCentralCredentialV2(stored.plaintext) },
      );
    }
    const token = await credentialStore.load();
    if (token === undefined) return new GatewayIdentity(credentialStore, undefined);
    if (token.trimStart().startsWith("{")) throw new Error("The legacy credential is invalid");
    return new GatewayIdentity(credentialStore, { version: 1, token });
  }

  get enrolled(): boolean {
    return this.#credential !== undefined;
  }

  get authenticationFailed(): boolean {
    return this.#authenticationFailed;
  }

  get credentialVersion(): 1 | 2 | undefined {
    return this.#credential?.version;
  }

  authenticatedToken(): string {
    if (this.#authenticationFailed) {
      throw new IdentityError("central_authentication_failed");
    }
    if (this.#credential === undefined) {
      throw new IdentityError("not_enrolled");
    }
    if (this.#credential.version !== 1) throw new IdentityError("legacy_credential_required");
    return this.#credential.token;
  }

  authenticatedCredentialV2(): LoadedCentralCredentialV2 {
    if (this.#authenticationFailed) {
      throw new IdentityError("central_authentication_failed");
    }
    if (this.#credential?.version !== 2) {
      throw new IdentityError("not_enrolled");
    }
    return this.#credential.value;
  }

  async commitCredentialV2(record: CentralCredentialV2Record): Promise<LoadedCentralCredentialV2> {
    return await this.#serializeCredentialCommit(
      async () => await this.#commitCredentialV2(record),
    );
  }

  async enrollCredentialV2<T>(
    operation: () => Promise<{
      readonly credential: CentralCredentialV2Record;
      readonly localResult: T;
    }>,
  ): Promise<T> {
    return await this.#serializeCredentialCommit(async () => {
      const result = await operation();
      await this.#commitCredentialV2(result.credential);
      this.#authenticationFailed = false;
      return result.localResult;
    });
  }

  async replaceCredentialV2(record: CentralCredentialV2Record): Promise<LoadedCentralCredentialV2> {
    const current = this.authenticatedCredentialV2();
    const serialized = serializeCentralCredentialV2(record);
    const replacement = parseCentralCredentialV2(serialized);
    assertSameKeyCredentialReplacement(current, replacement);
    const store = requireVersionedCredentialStore(this.credentialStore);
    await store.saveCredential({ version: 2, plaintext: serialized });
    if (this.#authenticationFailed) throw new IdentityError("central_authentication_failed");
    this.#credential = { version: 2, value: replacement };
    return replacement;
  }

  async verify(operation: () => Promise<unknown>): Promise<VerificationSuccess["localResult"]> {
    return await this.#serializeCredentialCommit(async () => {
      const verified = parseVerificationSuccess(await operation());
      await this.credentialStore.save(verified.token);
      this.#credential = { version: 1, token: verified.token };
      this.#authenticationFailed = false;
      return verified.localResult;
    });
  }

  markAuthenticationFailed(): void {
    if (this.#credential !== undefined) {
      this.#authenticationFailed = true;
    }
  }

  async #commitCredentialV2(record: CentralCredentialV2Record): Promise<LoadedCentralCredentialV2> {
    if (this.#credential !== undefined) throw new IdentityError("already_enrolled");
    const serialized = serializeCentralCredentialV2(record);
    const credential = parseCentralCredentialV2(serialized);
    const store = requireVersionedCredentialStore(this.credentialStore);
    await store.saveCredential({ version: 2, plaintext: serialized });
    this.#credential = { version: 2, value: credential };
    return credential;
  }

  async #serializeCredentialCommit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#credential !== undefined) throw new IdentityError("already_enrolled");
    if (this.#credentialCommitBusy) throw new IdentityError("verification_busy");
    this.#credentialCommitBusy = true;
    try {
      return await operation();
    } finally {
      this.#credentialCommitBusy = false;
    }
  }
}

function isVersionedCredentialStore(
  store: CredentialStore,
): store is CredentialStore & VersionedCredentialStore {
  return (
    "loadCredential" in store &&
    typeof store.loadCredential === "function" &&
    "saveCredential" in store &&
    typeof store.saveCredential === "function"
  );
}

function requireVersionedCredentialStore(
  store: CredentialStore,
): CredentialStore & VersionedCredentialStore {
  if (!isVersionedCredentialStore(store)) {
    throw new Error("The versioned credential store is unavailable");
  }
  return store;
}
