import type { LoadedCentralCredentialV2 } from "./credential-v2.js";
import type { DevelopmentVerboseTranscript } from "./development-verbose.js";
import {
  createDpopProof,
  type DpopNonceCache,
  type DpopSecurityDomain,
  parseDpopNonce,
} from "./dpop.js";

const DEFAULT_DEADLINE_MS = 30_000;
const LEASED_RECEIVE_DEADLINE_MS = 40_000;
const ACCESS_TOKEN_MAX_BYTES = 4_096;
const DPOP_PROOF_MAX_BYTES = 4_096;
const AUTHORIZATION_MAX_BYTES = 4_101;
const AUTHENTICATION_FIELDS_MAX_BYTES = 8_197;
const REQUEST_HEADERS_MAX_BYTES = 16 * 1_024;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/u;
const METHOD_PATTERN = /^[A-Z]+$/u;
const USE_NONCE_CHALLENGE = 'DPoP error="use_dpop_nonce"';
const INVALID_TOKEN_CHALLENGE = 'DPoP error="invalid_token"';
const INVALID_PROOF_CHALLENGE = 'DPoP error="invalid_dpop_proof"';

export type CentralProtectedSecurityDomain = Extract<DpopSecurityDomain, "api" | "mcp">;

export type CentralProtectedTransportErrorCode =
  | "central_dpop_challenge_failed"
  | "central_dpop_nonce_retry_exhausted"
  | "central_dpop_proof_rejected"
  | "central_protected_authentication_failed"
  | "central_protected_credential_expired"
  | "central_protected_redirect_rejected"
  | "central_protected_request_failed"
  | "central_protected_request_invalid"
  | "central_protected_response_unsafe";

const ERROR_MESSAGES: Readonly<Record<CentralProtectedTransportErrorCode, string>> = {
  central_dpop_challenge_failed: "The central DPoP challenge is invalid",
  central_dpop_nonce_retry_exhausted: "The central DPoP nonce retry was exhausted",
  central_dpop_proof_rejected: "The central DPoP proof was rejected",
  central_protected_authentication_failed: "Central authentication failed",
  central_protected_credential_expired: "The central credential has expired",
  central_protected_redirect_rejected: "The central redirect was rejected",
  central_protected_request_failed: "The central request failed; its outcome may be uncertain",
  central_protected_request_invalid: "The central request is invalid",
  central_protected_response_unsafe: "The central response is unsafe",
};

export class CentralProtectedTransportError extends Error {
  constructor(readonly code: CentralProtectedTransportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CentralProtectedTransportError";
  }
}

export interface CentralProtectedTransportOptions {
  readonly domain: CentralProtectedSecurityDomain;
  readonly credential: () => LoadedCentralCredentialV2;
  readonly nonceCache: DpopNonceCache;
  readonly verboseTranscript?: DevelopmentVerboseTranscript;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
  readonly deadlineSignal?: (deadlineMs: number) => AbortSignal;
}

function failure(code: CentralProtectedTransportErrorCode): CentralProtectedTransportError {
  return new CentralProtectedTransportError(code);
}

function hasNoStore(headers: Headers): boolean {
  return (
    headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") === true
  );
}

function requestHeaderBytes(headers: Headers): number {
  let total = 2;
  for (const [name, value] of headers) {
    total += Buffer.byteLength(name, "utf8") + 2 + Buffer.byteLength(value, "utf8") + 2;
  }
  return total;
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

function requestMethod(value: string | undefined): string {
  const method = (value ?? "GET").toUpperCase();
  if (!METHOD_PATTERN.test(method)) throw failure("central_protected_request_invalid");
  return method;
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

function isUnrepeatableBody(body: RequestInit["body"]): boolean {
  if (body instanceof ReadableStream) return true;
  if (body === null || typeof body !== "object") return false;
  return Symbol.asyncIterator in body;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A decisive response head remains authoritative when body cancellation fails.
  }
}

function validCredential(value: LoadedCentralCredentialV2): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.record?.credential_version === 2 &&
    value.record.token_type === "DPoP" &&
    value.record.dpop_alg === "ES256" &&
    typeof value.record.access_token === "string" &&
    TOKEN_PATTERN.test(value.record.access_token) &&
    Buffer.byteLength(value.record.access_token, "ascii") <= ACCESS_TOKEN_MAX_BYTES &&
    Number.isSafeInteger(value.token?.expiresAt) &&
    value.privateKey?.asymmetricKeyType === "ec" &&
    value.privateKey.asymmetricKeyDetails?.namedCurve === "prime256v1"
  );
}

export class CentralProtectedTransport {
  readonly #domain: CentralProtectedSecurityDomain;
  readonly #credential: () => LoadedCentralCredentialV2;
  readonly #nonceCache: DpopNonceCache;
  readonly #verboseTranscript: DevelopmentVerboseTranscript | undefined;
  readonly #request: typeof fetch;
  readonly #deadlineMs: number;
  readonly #deadlineSignal: (deadlineMs: number) => AbortSignal;

  constructor(options: CentralProtectedTransportOptions) {
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (
      (options.domain !== "api" && options.domain !== "mcp") ||
      (deadlineMs !== DEFAULT_DEADLINE_MS && deadlineMs !== LEASED_RECEIVE_DEADLINE_MS) ||
      (options.deadlineSignal !== undefined && typeof options.deadlineSignal !== "function")
    ) {
      throw failure("central_protected_request_invalid");
    }
    this.#domain = options.domain;
    this.#credential = options.credential;
    this.#nonceCache = options.nonceCache;
    this.#verboseTranscript = options.verboseTranscript;
    this.#request = options.fetch ?? (async (input, init) => await globalThis.fetch(input, init));
    this.#deadlineMs = deadlineMs;
    this.#deadlineSignal = options.deadlineSignal ?? ((value) => AbortSignal.timeout(value));
  }

  readonly fetch = async (url: string | URL, init?: RequestInit): Promise<Response> =>
    await this.#fetch(url, init, async (response) => response);

  readonly fetchAndInspectCredentials = async <T>(
    url: string | URL,
    init: RequestInit | undefined,
    inspect: (response: Response, accessTokens: readonly string[]) => Promise<T>,
  ): Promise<T> => await this.#fetch(url, init, inspect);

  async #fetch<T>(
    url: string | URL,
    init: RequestInit | undefined,
    inspect: (response: Response, accessTokens: readonly string[]) => Promise<T>,
  ): Promise<T> {
    const target = requestTarget(url);
    const method = requestMethod(init?.method);
    if (
      isUnrepeatableBody(init?.body) ||
      (init?.credentials !== undefined && init.credentials !== "omit")
    ) {
      throw failure("central_protected_request_invalid");
    }
    const baseHeaders = requestHeaders(init?.headers);
    let credential: LoadedCentralCredentialV2;
    try {
      credential = this.#credential();
    } catch {
      throw failure("central_protected_request_invalid");
    }
    if (!validCredential(credential)) throw failure("central_protected_request_invalid");
    this.#verboseTranscript?.addSecret(credential.record.access_token);
    this.#verboseTranscript?.addSecret(credential.record.dpop_private_key_pkcs8);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (Math.floor(Date.now() / 1_000) >= credential.token.expiresAt) {
        throw failure("central_protected_credential_expired");
      }
      const nonce = this.#nonceCache.get(this.#domain);
      if (nonce !== undefined) this.#verboseTranscript?.addSecret(nonce);
      let proof: string;
      try {
        proof = createDpopProof({
          method,
          targetUri: target.href,
          privateKey: credential.privateKey,
          publicJwk: credential.publicJwk,
          accessToken: credential.record.access_token,
          ...(nonce === undefined ? {} : { nonce }),
        });
      } catch {
        throw failure("central_protected_request_invalid");
      }
      const authorization = `DPoP ${credential.record.access_token}`;
      if (
        Buffer.byteLength(proof, "ascii") > DPOP_PROOF_MAX_BYTES ||
        Buffer.byteLength(authorization, "ascii") > AUTHORIZATION_MAX_BYTES ||
        Buffer.byteLength(proof, "ascii") + Buffer.byteLength(authorization, "ascii") >
          AUTHENTICATION_FIELDS_MAX_BYTES
      ) {
        throw failure("central_protected_request_invalid");
      }
      const headers = new Headers(baseHeaders);
      headers.set("authorization", authorization);
      headers.set("dpop", proof);
      if (requestHeaderBytes(headers) > REQUEST_HEADERS_MAX_BYTES) {
        throw failure("central_protected_request_invalid");
      }
      this.#verboseTranscript?.addSecret(proof);
      let deadlineSignal: AbortSignal;
      try {
        deadlineSignal = this.#deadlineSignal(this.#deadlineMs);
      } catch {
        throw failure("central_protected_request_invalid");
      }
      if (!(deadlineSignal instanceof AbortSignal)) {
        throw failure("central_protected_request_invalid");
      }
      const signal =
        init?.signal === undefined || init.signal === null
          ? deadlineSignal
          : AbortSignal.any([init.signal, deadlineSignal]);
      const requestInit: RequestInit = {
        ...init,
        method,
        redirect: "manual",
        credentials: "omit",
        headers,
        signal,
      };
      this.#verboseTranscript?.recordHttpRequest(
        this.#domain === "api" ? "central_rest" : "central_mcp",
        target,
        requestInit,
      );

      let response: Response;
      try {
        response = await this.#request(target, requestInit);
      } catch {
        const safe = failure("central_protected_request_failed");
        this.#verboseTranscript?.recordError(
          this.#domain === "api" ? "central_rest" : "central_mcp",
          safe,
        );
        throw safe;
      }
      const responseNonce = response.headers.get("dpop-nonce");
      if (responseNonce !== null) this.#verboseTranscript?.addSecret(responseNonce);
      this.#verboseTranscript?.record({
        boundary: this.#domain === "api" ? "central_rest" : "central_mcp",
        direction: "response",
        status: response.status,
        headers: response.headers,
      });

      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response);
        throw failure("central_protected_redirect_rejected");
      }
      if (response.headers.has("set-cookie") || response.headers.has("content-encoding")) {
        await cancelBody(response);
        throw failure("central_protected_response_unsafe");
      }

      const authenticate = response.headers.get("www-authenticate");
      const exactNonceChallenge = response.status === 401 && authenticate === USE_NONCE_CHALLENGE;
      const challengeLike =
        authenticate === USE_NONCE_CHALLENGE ||
        authenticate?.includes("use_dpop_nonce") === true ||
        (response.status === 401 && responseNonce !== null);
      let parsedNonce: string | undefined;
      if (responseNonce !== null) {
        try {
          parsedNonce = parseDpopNonce(responseNonce);
        } catch {
          await cancelBody(response);
          throw failure(
            challengeLike ? "central_dpop_challenge_failed" : "central_protected_response_unsafe",
          );
        }
        if (!hasNoStore(response.headers)) {
          await cancelBody(response);
          throw failure(
            challengeLike ? "central_dpop_challenge_failed" : "central_protected_response_unsafe",
          );
        }
      }

      if (authenticate === USE_NONCE_CHALLENGE || authenticate?.includes("use_dpop_nonce")) {
        if (!exactNonceChallenge || parsedNonce === undefined || !hasNoStore(response.headers)) {
          await cancelBody(response);
          throw failure("central_dpop_challenge_failed");
        }
        await cancelBody(response);
        if (attempt !== 0) throw failure("central_dpop_nonce_retry_exhausted");
        this.#nonceCache.set(this.#domain, parsedNonce);
        continue;
      }

      if (response.status === 401 && authenticate === INVALID_TOKEN_CHALLENGE) {
        await cancelBody(response);
        throw failure("central_protected_authentication_failed");
      }
      if (response.status === 401 && authenticate === INVALID_PROOF_CHALLENGE) {
        await cancelBody(response);
        throw failure("central_dpop_proof_rejected");
      }
      if (response.status === 401 && responseNonce !== null) {
        await cancelBody(response);
        throw failure("central_dpop_challenge_failed");
      }
      if (
        authenticate?.includes("invalid_token") === true ||
        authenticate?.includes("invalid_dpop_proof") === true
      ) {
        await cancelBody(response);
        throw failure("central_protected_response_unsafe");
      }
      if (parsedNonce !== undefined) this.#nonceCache.set(this.#domain, parsedNonce);
      let currentCredential: LoadedCentralCredentialV2;
      try {
        currentCredential = this.#credential();
      } catch {
        await cancelBody(response);
        throw failure("central_protected_response_unsafe");
      }
      if (!validCredential(currentCredential)) {
        await cancelBody(response);
        throw failure("central_protected_response_unsafe");
      }
      const accessTokens = [
        ...new Set([credential.record.access_token, currentCredential.record.access_token]),
      ];
      for (const accessToken of accessTokens) this.#verboseTranscript?.addSecret(accessToken);
      return await inspect(response, accessTokens);
    }
    throw failure("central_dpop_nonce_retry_exhausted");
  }
}
