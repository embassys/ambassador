import { z } from "zod";
import { readCentralJson } from "./central-json.js";
import type { CentralProtectedTransport } from "./central-protected-transport.js";
import type { GatewayIdentity } from "./identity.js";

const responseSchema = z.strictObject({
  agent_id: z.string().min(1).max(256),
  email: z.string().min(3).max(254),
  token: z.string().min(1).max(4096),
  jkt: z.string().max(128).nullable().optional(),
  expires_at: z.iso.datetime({ offset: true }),
  previous_token_valid_until: z.iso.datetime({ offset: true }).nullable().optional(),
  message: z.string().max(512),
});
export class CentralRenewal {
  #running: Promise<void> | undefined;
  #retryAt = 0;
  constructor(
    readonly identity: GatewayIdentity,
    readonly transport: CentralProtectedTransport,
    readonly origin: string,
    readonly now = () => Date.now() / 1000,
  ) {}
  async ensure(signal?: AbortSignal): Promise<void> {
    if (this.identity.localCredential().token.expiresAt - this.now() > 86400) return;
    if (this.#running) return this.#running;
    if (this.now() < this.#retryAt) {
      if (this.identity.expired) throw new Error("Credential renewal is pending");
      return;
    }
    const task = this.#renew(signal);
    this.#running = task;
    try {
      await task;
      this.#retryAt = 0;
    } catch (error) {
      this.#retryAt = this.now() + 30;
      throw error;
    } finally {
      this.#running = undefined;
    }
  }
  async #renew(signal?: AbortSignal): Promise<void> {
    const original = this.identity.localCredential();
    const response = await this.transport.fetchRenewal(
      new URL("/api/renew_token", this.origin),
      signal,
    );
    if (
      !response.ok ||
      response.headers.has("set-cookie") ||
      !response.headers
        .get("cache-control")
        ?.split(",")
        .some((item) => item.trim().toLowerCase() === "no-store")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Credential renewal failed");
    }
    const result = responseSchema.parse(await readCentralJson(response, 64 * 1024));
    if (
      result.agent_id !== original.token.subject ||
      result.email !== original.token.email ||
      (result.jkt != null && result.jkt !== original.keyThumbprint)
    )
      throw new Error("Credential renewal binding failed");
    await this.identity.renew({ ...original.record, access_token: result.token });
  }
}
