import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  EncryptedFileCredentialStore,
  type EncryptedFileCredentialStoreOptions,
} from "./credential-store.js";

const SECRET = /^[a-f0-9]{48}$/u;
const DEFAULT_SCOPE = '{"kind":"ambassador-webhook-secret","version":1}';
const creations = new Map<string, Promise<string>>();

export interface WebhookSecretStore {
  load(): Promise<string | undefined>;
  createOrLoad(): Promise<string>;
}

export interface EncryptedFileWebhookSecretStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsAccessControl?: EncryptedFileCredentialStoreOptions["windowsAccessControl"];
  readonly scope?: string;
}

function validateWebhookSecret(value: string): void {
  if (!SECRET.test(value)) throw new Error("The webhook secret store is invalid");
}

export class EncryptedFileWebhookSecretStore implements WebhookSecretStore {
  readonly #path: string;
  readonly #store: EncryptedFileCredentialStore;

  constructor(path: string, keyPath: string, options: EncryptedFileWebhookSecretStoreOptions = {}) {
    this.#path = resolve(path);
    this.#store = new EncryptedFileCredentialStore(path, keyPath, options.scope ?? DEFAULT_SCOPE, {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.windowsAccessControl === undefined
        ? {}
        : { windowsAccessControl: options.windowsAccessControl }),
      validatePlaintext: validateWebhookSecret,
    });
  }

  async load(): Promise<string | undefined> {
    return this.#store.load();
  }

  async createOrLoad(): Promise<string> {
    const existing = creations.get(this.#path);
    if (existing !== undefined) return existing;
    const creation = this.#createOrLoad();
    creations.set(this.#path, creation);
    try {
      return await creation;
    } finally {
      creations.delete(this.#path);
    }
  }

  async #createOrLoad(): Promise<string> {
    const stored = await this.#store.load();
    if (stored !== undefined) return stored;
    const created = randomBytes(24).toString("hex");
    await this.#store.save(created);
    return created;
  }
}
