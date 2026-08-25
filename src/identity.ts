import type { CredentialStore } from "./credential-store.js";
import { parseVerificationSuccess, type VerificationSuccess } from "./mcp-contract.js";

export type { CredentialStore } from "./credential-store.js";

export class IdentityError extends Error {
  constructor(
    readonly code:
      | "already_enrolled"
      | "central_authentication_failed"
      | "not_enrolled"
      | "verification_busy",
  ) {
    super(code);
    this.name = "IdentityError";
  }
}

export class GatewayIdentity {
  #centralToken: string | undefined;
  #authenticationFailed = false;
  #verificationBusy = false;

  private constructor(
    private readonly credentialStore: CredentialStore,
    centralToken: string | undefined,
  ) {
    this.#centralToken = centralToken;
  }

  static async open(credentialStore: CredentialStore): Promise<GatewayIdentity> {
    return new GatewayIdentity(credentialStore, await credentialStore.load());
  }

  get enrolled(): boolean {
    return this.#centralToken !== undefined;
  }

  get authenticationFailed(): boolean {
    return this.#authenticationFailed;
  }

  authenticatedToken(): string {
    if (this.#authenticationFailed) {
      throw new IdentityError("central_authentication_failed");
    }
    if (this.#centralToken === undefined) {
      throw new IdentityError("not_enrolled");
    }
    return this.#centralToken;
  }

  async verify(operation: () => Promise<unknown>): Promise<VerificationSuccess["localResult"]> {
    if (this.#centralToken !== undefined) {
      throw new IdentityError("already_enrolled");
    }
    if (this.#verificationBusy) {
      throw new IdentityError("verification_busy");
    }

    this.#verificationBusy = true;
    try {
      const verified = parseVerificationSuccess(await operation());
      await this.credentialStore.save(verified.token);
      this.#centralToken = verified.token;
      this.#authenticationFailed = false;
      return verified.localResult;
    } finally {
      this.#verificationBusy = false;
    }
  }

  markAuthenticationFailed(): void {
    if (this.#centralToken !== undefined) {
      this.#authenticationFailed = true;
    }
  }
}
