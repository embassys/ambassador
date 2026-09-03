import type { LoadedCentralCredential } from "./central-credential.js";
import { createDpopProof, DpopError, DpopNonceCache, parseDpopNonce } from "./dpop.js";

const DEFAULT_DEADLINE_MS = 30_000;
const TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const METHOD = /^[A-Z]+$/u;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PROOF_BYTES = 4_096;

export type CentralProtectedTransportErrorCode =
  | "central_dpop_challenge_failed"
  | "central_dpop_nonce_retry_exhausted"
  | "central_protected_authentication_failed"
  | "central_protected_credential_expired"
  | "central_protected_redirect_rejected"
  | "central_protected_request_failed"
  | "central_protected_request_invalid";

const MESSAGES: Readonly<Record<CentralProtectedTransportErrorCode, string>> = {
  central_dpop_challenge_failed: "The central DPoP challenge is invalid",
  central_dpop_nonce_retry_exhausted: "The central DPoP nonce retry was exhausted",
  central_protected_authentication_failed: "Central authentication failed",
  central_protected_credential_expired: "The central credential has expired",
  central_protected_redirect_rejected: "The central redirect was rejected",
  central_protected_request_failed: "The central request failed; its outcome may be uncertain",
  central_protected_request_invalid: "The central request is invalid",
};

export class CentralProtectedTransportError extends Error {
  constructor(readonly code: CentralProtectedTransportErrorCode) {
    super(MESSAGES[code]);
    this.name = "CentralProtectedTransportError";
  }
}

export interface CentralProtectedTransportOptions {
  readonly credential: () => LoadedCentralCredential;
  readonly nonceCache?: DpopNonceCache;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
  readonly deadlineSignal?: (milliseconds: number) => AbortSignal;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

function failure(code: CentralProtectedTransportErrorCode): CentralProtectedTransportError {
  return new CentralProtectedTransportError(code);
}

function requestTarget(value: string | URL): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw failure("central_protected_request_invalid");
  }
  if (
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== ""
  ) {
    throw failure("central_protected_request_invalid");
  }
  return target;
}

function requestMethod(value: string | undefined): string {
  const method = (value ?? "GET").toUpperCase();
  if (!METHOD.test(method)) throw failure("central_protected_request_invalid");
  return method;
}

function requestHeaders(value: RequestInit["headers"]): Headers {
  let headers: Headers;
  try {
    headers = new Headers(value);
  } catch {
    throw failure("central_protected_request_invalid");
  }
  if (headers.has("authorization") || headers.has("dpop") || headers.has("cookie")) {
    throw failure("central_protected_request_invalid");
  }
  return headers;
}

function headerBytes(headers: Headers): number {
  let total = 2;
  for (const [name, value] of headers) {
    total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
  }
  return total;
}

function isUnrepeatableBody(body: RequestInit["body"]): boolean {
  if (body instanceof ReadableStream) return true;
  return body !== null && typeof body === "object" && Symbol.asyncIterator in body;
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function validCredential(value: LoadedCentralCredential): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.record?.credential_format === 1 &&
    typeof value.record.access_token === "string" &&
    TOKEN.test(value.record.access_token) &&
    value.privateKey?.asymmetricKeyType === "ec" &&
    value.privateKey.asymmetricKeyDetails?.namedCurve === "prime256v1" &&
    Number.isSafeInteger(value.token?.expiresAt)
  );
}

export class CentralProtectedTransport {
  readonly #credential: () => LoadedCentralCredential;
  readonly #nonceCache: DpopNonceCache;
  readonly #fetchImplementation: typeof fetch;
  readonly #deadlineMs: number;
  readonly #deadlineSignal: (milliseconds: number) => AbortSignal;
  readonly #now: () => number;
  readonly #uuid: (() => string) | undefined;

  constructor(options: CentralProtectedTransportOptions) {
    this.#credential = options.credential;
    this.#nonceCache = options.nonceCache ?? new DpopNonceCache();
    this.#fetchImplementation = options.fetch ?? globalThis.fetch;
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.#deadlineSignal = options.deadlineSignal ?? AbortSignal.timeout;
    this.#now = options.now ?? (() => Date.now() / 1_000);
    this.#uuid = options.uuid;
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 1) {
      throw failure("central_protected_request_invalid");
    }
  }

  async fetch(
    url: string | URL,
    init: RequestInit = {},
    deadlineMs: number = this.#deadlineMs,
  ): Promise<Response> {
    const target = requestTarget(url);
    const method = requestMethod(init.method);
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      isUnrepeatableBody(init.body) ||
      (init.credentials !== undefined && init.credentials !== "omit")
    ) {
      throw failure("central_protected_request_invalid");
    }
    const baseHeaders = requestHeaders(init.headers);
    let credential: LoadedCentralCredential;
    try {
      credential = this.#credential();
    } catch {
      throw failure("central_protected_request_invalid");
    }
    if (!validCredential(credential)) throw failure("central_protected_request_invalid");
    const origin = target.origin;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = Math.floor(this.#now());
      if (!Number.isSafeInteger(now) || now < 0) {
        throw failure("central_protected_request_invalid");
      }
      if (credential.token.expiresAt <= now) {
        throw failure("central_protected_credential_expired");
      }
      const nonce = this.#nonceCache.get(origin);
      let proof: string;
      try {
        proof = createDpopProof({
          method,
          targetUri: target.href,
          privateKey: credential.privateKey,
          publicJwk: credential.publicJwk,
          accessToken: credential.record.access_token,
          now: () => now,
          ...(this.#uuid === undefined ? {} : { uuid: this.#uuid }),
          ...(nonce === undefined ? {} : { nonce }),
        });
      } catch (error) {
        if (error instanceof DpopError) throw failure("central_protected_request_invalid");
        throw failure("central_protected_request_invalid");
      }
      if (Buffer.byteLength(proof, "ascii") > MAX_PROOF_BYTES) {
        throw failure("central_protected_request_invalid");
      }
      const headers = new Headers(baseHeaders);
      headers.set("accept-encoding", "identity");
      headers.set("authorization", `Bearer ${credential.record.access_token}`);
      headers.set("dpop", proof);
      if (headerBytes(headers) > MAX_HEADER_BYTES) {
        throw failure("central_protected_request_invalid");
      }
      let deadline: AbortSignal;
      try {
        deadline = this.#deadlineSignal(deadlineMs);
      } catch {
        throw failure("central_protected_request_invalid");
      }
      const signal =
        init.signal === undefined || init.signal === null
          ? deadline
          : AbortSignal.any([init.signal, deadline]);
      let response: Response;
      try {
        response = await this.#fetchImplementation(target, {
          ...init,
          method,
          headers,
          credentials: "omit",
          redirect: "manual",
          signal,
        });
      } catch {
        throw failure("central_protected_request_failed");
      }
      if (isRedirect(response)) {
        await cancel(response);
        throw failure("central_protected_redirect_rejected");
      }
      if (response.status !== 401) return response;

      const challenge = response.headers.get("dpop-nonce");
      if (challenge === null) {
        await cancel(response);
        throw failure("central_protected_authentication_failed");
      }
      let parsed: string;
      try {
        parsed = parseDpopNonce(challenge) as string;
      } catch {
        await cancel(response);
        throw failure("central_dpop_challenge_failed");
      }
      await cancel(response);
      if (attempt !== 0 || parsed === nonce) {
        throw failure("central_dpop_nonce_retry_exhausted");
      }
      this.#nonceCache.set(origin, parsed);
    }
    throw failure("central_dpop_nonce_retry_exhausted");
  }
}
