import { randomUUID } from "node:crypto";

import { parseStrictCentralJsonResponse } from "./central-enrollment.js";
import {
  type CentralProtectedTransport,
  CentralProtectedTransportError,
} from "./central-protected-transport.js";
import {
  type CentralCredentialV2Record,
  CredentialV2Error,
  type LoadedCentralCredentialV2,
} from "./credential-v2.js";
import type { DevelopmentVerboseTranscript } from "./development-verbose.js";
import { createCentralCredentialV2Record, dpopKeyMaterialFromCredential } from "./dpop.js";
import { type GatewayIdentity, IdentityError } from "./identity.js";

const REISSUE_WINDOW_SECONDS = 12 * 60 * 60;
const TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const RESPONSE_BODY_MAX_BYTES = 64 * 1024;
const RESPONSE_HEADERS_MAX_BYTES = 16 * 1024;
const UNCERTAIN_RETRY_DELAY_MS = 10;
const SAFE_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CentralReissueControllerOptions {
  readonly centralApiUrl: string | URL;
  readonly identity: GatewayIdentity;
  readonly transport: CentralProtectedTransport;
  readonly verboseTranscript?: DevelopmentVerboseTranscript;
}

function safeApiBase(value: string | URL): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("The central reissue configuration is invalid");
  }
  return url;
}

function hasNoStore(headers: Headers): boolean {
  return (
    headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") === true
  );
}

function approximateHeaderBytes(headers: Headers): number {
  let total = 2;
  for (const [name, value] of headers) {
    total += Buffer.byteLength(name, "latin1") + 2 + Buffer.byteLength(value, "latin1") + 2;
  }
  return total;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A rejected response remains rejected regardless of cancellation failure.
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > RESPONSE_BODY_MAX_BYTES) {
    await cancelBody(response);
    throw new Error("unsafe response");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > RESPONSE_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("unsafe response");
      }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exactReplacement(
  value: Record<string, unknown>,
  currentKey: ReturnType<typeof dpopKeyMaterialFromCredential>,
  transcript: DevelopmentVerboseTranscript | undefined,
): CentralCredentialV2Record {
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "expires_in" ||
    keys[1] !== "token" ||
    keys[2] !== "token_type" ||
    typeof value.token !== "string" ||
    value.token_type !== "DPoP" ||
    value.expires_in !== TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("unsafe response");
  }
  transcript?.addSecret(value.token);
  return createCentralCredentialV2Record(value.token, currentKey);
}

function isAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof CentralProtectedTransportError &&
    (error.code === "central_protected_authentication_failed" ||
      error.code === "central_dpop_proof_rejected")
  );
}

function isUncertainTransportFailure(error: unknown): boolean {
  return (
    error instanceof CentralProtectedTransportError &&
    error.code === "central_protected_request_failed"
  );
}

function waitForUncertainRetry(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (canRetry: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      resolve(canRetry);
    };
    const aborted = (): void => finish(false);
    const timer = setTimeout(() => finish(true), UNCERTAIN_RETRY_DELAY_MS);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export class CentralReissueController {
  readonly #target: URL;
  readonly #identity: GatewayIdentity;
  readonly #transport: CentralProtectedTransport;
  readonly #verboseTranscript: DevelopmentVerboseTranscript | undefined;
  readonly #lifetime = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<boolean> | undefined;
  #closed = false;

  constructor(options: CentralReissueControllerOptions) {
    this.#target = new URL("/api/v2/token/reissue", safeApiBase(options.centralApiUrl));
    this.#identity = options.identity;
    this.#transport = options.transport;
    this.#verboseTranscript = options.verboseTranscript;
  }

  start(): void {
    if (this.#closed || this.#timer !== undefined || this.#active !== undefined) return;
    let credential: LoadedCentralCredentialV2;
    try {
      credential = this.#identity.authenticatedCredentialV2();
    } catch {
      return;
    }
    const delaySeconds =
      credential.token.expiresAt - Math.floor(Date.now() / 1_000) - REISSUE_WINDOW_SECONDS;
    if (delaySeconds <= 0) {
      const active = this.#run();
      this.#active = active;
      void active.then((reschedule) => {
        if (this.#active === active) this.#active = undefined;
        if (reschedule) this.start();
      });
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.start();
    }, delaySeconds * 1_000);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#lifetime.abort();
    await this.#active?.catch(() => undefined);
  }

  async #run(): Promise<boolean> {
    if (this.#closed || this.#lifetime.signal.aborted) return false;
    const idempotencyKey = randomUUID();
    if (!UUID_V4_PATTERN.test(idempotencyKey)) return false;
    this.#verboseTranscript?.addSecret(idempotencyKey);
    for (let uncertainAttempt = 0; uncertainAttempt < 2; uncertainAttempt += 1) {
      try {
        const current = this.#identity.authenticatedCredentialV2();
        const now = Math.floor(Date.now() / 1_000);
        if (
          current.token.expiresAt <= now ||
          current.token.expiresAt - now > REISSUE_WINDOW_SECONDS
        ) {
          return false;
        }
        const response = await this.#transport.fetch(this.#target, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            "Idempotency-Key": idempotencyKey,
          },
          body: "{}",
          redirect: "manual",
          signal: this.#lifetime.signal,
        });
        if (
          approximateHeaderBytes(response.headers) > RESPONSE_HEADERS_MAX_BYTES ||
          !hasNoStore(response.headers) ||
          response.headers.has("set-cookie") ||
          response.headers.has("content-encoding") ||
          !SAFE_MEDIA_TYPE.test(response.headers.get("content-type") ?? "")
        ) {
          await cancelBody(response);
          return false;
        }
        if (response.status === 401) {
          await cancelBody(response);
          this.#identity.markAuthenticationFailed();
          return false;
        }
        if (response.status !== 200) {
          await cancelBody(response);
          return false;
        }
        const parsed = parseStrictCentralJsonResponse(
          await readBoundedBody(response, this.#lifetime.signal),
        );
        const replacement = exactReplacement(
          parsed,
          dpopKeyMaterialFromCredential(current),
          this.#verboseTranscript,
        );
        await this.#identity.replaceCredentialV2(replacement);
        return true;
      } catch (error) {
        if (this.#closed || this.#lifetime.signal.aborted) return false;
        if (isAuthenticationFailure(error)) {
          this.#identity.markAuthenticationFailed();
          return false;
        }
        if (isUncertainTransportFailure(error) && uncertainAttempt === 0) {
          const canRetry = await waitForUncertainRetry(this.#lifetime.signal);
          if (!canRetry || this.#closed || this.#lifetime.signal.aborted) return false;
          continue;
        }
        if (
          error instanceof CredentialV2Error ||
          error instanceof IdentityError ||
          error instanceof CentralProtectedTransportError
        ) {
          return false;
        }
        return false;
      }
    }
    return false;
  }
}
