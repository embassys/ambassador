import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { TextDecoder } from "node:util";
import {
  type CentralCredentialV2Record,
  type CentralTokenClaims,
  CredentialV2Error,
  parseCentralAccessToken,
} from "./credential-v2.js";
import type { DevelopmentVerboseTranscript } from "./development-verbose.js";
import {
  createCentralCredentialV2Record,
  createDpopProof,
  type DpopKeyMaterial,
  generateDpopKeyMaterial,
  parseDpopNonce,
} from "./dpop.js";
import type { CentralToolDefinition } from "./mcp-contract.js";

const REQUEST_BODY_MAX_BYTES = 2 * 1024;
const RESPONSE_BODY_MAX_BYTES = 64 * 1024;
const RESPONSE_HEADERS_MAX_BYTES = 16 * 1024;
const RESPONSE_MAX_DEPTH = 16;
const RESPONSE_MAX_STRUCTURAL_TOKENS = 1_024;
const RESPONSE_MAX_MEMBERS = 128;
const RESPONSE_MAX_ELEMENTS = 128;
const ENROLLMENT_DEADLINE_MS = 30_000;
const TOKEN_LIFETIME_SECONDS = 86_400;
const URI_UNRESERVED = /^[A-Za-z0-9._~-]{1,128}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CODE_PATTERN = /^[A-Za-z0-9]{6}$/u;
const ACCESS_TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const SAFE_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const FORBIDDEN_RESPONSE_NAMES = new Set([
  "access_token",
  "authorization",
  "dpop_proof",
  "jwt",
  "nonce",
  "private_key",
  "token",
]);

export type CentralEnrollmentErrorCode =
  | "central_dpop_challenge_failed"
  | "central_dpop_nonce_retry_exhausted"
  | "central_dpop_proof_rejected"
  | "central_enrollment_contract_failed"
  | "central_enrollment_outcome_uncertain"
  | "central_rate_limited"
  | "central_verification_credential_invalid"
  | "central_verification_response_unsafe"
  | "registration_conflict"
  | "verification_failed";

export interface CentralTokenProfile {
  readonly issuer: string;
  readonly audiences: readonly [string, string];
}

export interface CentralEnrollmentClientOptions {
  readonly centralApiUrl: string;
  readonly tokenProfile: CentralTokenProfile;
  readonly verboseTranscript?: DevelopmentVerboseTranscript;
  readonly deadlineMs?: number;
  readonly fetch?: typeof fetch;
}

export interface VerificationEnrollmentSuccess {
  readonly credential: CentralCredentialV2Record;
  readonly localResult: {
    readonly verified: true;
    readonly agent_id: string;
    readonly username: string;
    readonly message: string;
  };
}

type BootstrapToolName = "register_agent" | "resend_verification" | "verify_email";

interface EnrollmentHttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly headerValues: ReadonlyMap<string, readonly string[]>;
  readonly rawHeaderBytes: number;
  readonly body: Uint8Array;
}

export class CentralEnrollmentError extends Error {
  constructor(readonly code: CentralEnrollmentErrorCode) {
    super("Central enrollment failed");
    this.name = "CentralEnrollmentError";
  }
}

class EnrollmentContractError extends Error {}
class EnrollmentOutcomeUncertain extends Error {}
class ResponseTooLarge extends EnrollmentContractError {}

class StrictResponseJsonParser {
  #index = 0;
  #members = 0;
  #elements = 0;
  #structuralTokens = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#index !== this.text.length) this.#invalid();
    return value;
  }

  #value(depth: number): unknown {
    this.#whitespace();
    const character = this.text[this.#index];
    if (character === "{") return this.#object(depth + 1);
    if (character === "[") return this.#array(depth + 1);
    if (character === '"') return this.#string();
    if (this.text.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #object(depth: number): Record<string, unknown> {
    this.#container(depth);
    this.#index += 1;
    this.#whitespace();
    const result: Record<string, unknown> = {};
    const names = new Set<string>();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (true) {
      if (this.text[this.#index] !== '"') this.#invalid();
      const name = this.#string();
      if (names.has(name)) this.#invalid();
      names.add(name);
      this.#members += 1;
      if (this.#members > RESPONSE_MAX_MEMBERS) this.#invalid();
      this.#whitespace();
      if (this.text[this.#index] !== ":") this.#invalid();
      this.#index += 1;
      result[name] = this.#value(depth);
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.#invalid();
      this.#index += 1;
      this.#whitespace();
    }
  }

  #array(depth: number): unknown[] {
    this.#container(depth);
    this.#index += 1;
    this.#whitespace();
    const result: unknown[] = [];
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.#value(depth));
      this.#elements += 1;
      if (this.#elements > RESPONSE_MAX_ELEMENTS) this.#invalid();
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") this.#invalid();
      this.#index += 1;
      this.#whitespace();
    }
  }

  #container(depth: number): void {
    this.#structuralTokens += 1;
    if (depth > RESPONSE_MAX_DEPTH || this.#structuralTokens > RESPONSE_MAX_STRUCTURAL_TOKENS) {
      this.#invalid();
    }
  }

  #string(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.text.length) {
      const character = this.text[this.#index];
      this.#index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(this.text.slice(start, this.#index));
        } catch {
          return this.#invalid();
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) this.#invalid();
        return value;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) this.#invalid();
    }
    return this.#invalid();
  }

  #number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.#index;
    const parsed = match.exec(this.text);
    if (parsed === null) this.#invalid();
    this.#index = match.lastIndex;
    const value = Number(parsed[0]);
    if (!Number.isFinite(value)) this.#invalid();
    return value;
  }

  #whitespace(): void {
    while ([9, 10, 13, 32].includes(this.text.charCodeAt(this.#index))) this.#index += 1;
  }

  #invalid(): never {
    throw new EnrollmentContractError();
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function characterLength(value: string): number {
  return [...value].length;
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedString(
  value: unknown,
  minimumCharacters: number,
  maximumCharacters: number,
  maximumBytes: number,
): value is string {
  if (typeof value !== "string") return false;
  const length = characterLength(value);
  return (
    length >= minimumCharacters &&
    length <= maximumCharacters &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    value.trim() === value &&
    !hasAsciiControl(value)
  );
}

function validEmail(value: unknown): value is string {
  return boundedString(value, 3, 254, 254) && EMAIL_PATTERN.test(value);
}

function validUsername(value: unknown): value is string {
  return boundedString(value, 3, 50, 200);
}

function validDisplayName(value: unknown): value is string {
  return boundedString(value, 1, 128, 512);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((name) => Object.hasOwn(value, name)) && keys.every((name) => allowed.has(name))
  );
}

function validateArguments(
  name: BootstrapToolName,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "register_agent") {
    if (
      !exactKeys(value, ["email", "username"], ["display_name"]) ||
      !validEmail(value.email) ||
      !validUsername(value.username) ||
      (value.display_name !== undefined && !validDisplayName(value.display_name))
    ) {
      throw new EnrollmentContractError();
    }
    return {
      email: value.email,
      username: value.username,
      ...(value.display_name === undefined ? {} : { display_name: value.display_name }),
    };
  }
  if (name === "verify_email") {
    if (
      !exactKeys(value, ["email", "code"]) ||
      !validEmail(value.email) ||
      typeof value.code !== "string" ||
      !CODE_PATTERN.test(value.code)
    ) {
      throw new EnrollmentContractError();
    }
    return { email: value.email, code: value.code };
  }
  if (!exactKeys(value, ["email"]) || !validEmail(value.email)) {
    throw new EnrollmentContractError();
  }
  return { email: value.email };
}

function parseStrictResponse(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EnrollmentContractError();
  }
  const value = new StrictResponseJsonParser(text).parse();
  if (!isObject(value)) throw new EnrollmentContractError();
  return value;
}

function responseHeaders(response: IncomingMessage): {
  readonly headers: Headers;
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly rawBytes: number;
} {
  const headers = new Headers();
  const values = new Map<string, string[]>();
  let total = 2;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name === undefined || value === undefined) throw new EnrollmentContractError();
    total += Buffer.byteLength(name, "latin1") + 2 + Buffer.byteLength(value, "latin1") + 2;
    headers.append(name, value);
    const normalized = name.toLowerCase();
    const existing = values.get(normalized);
    if (existing === undefined) values.set(normalized, [value]);
    else existing.push(value);
  }
  return { headers, values, rawBytes: total };
}

async function readResponseBody(
  response: IncomingMessage,
  headers: Headers,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > RESPONSE_BODY_MAX_BYTES) {
    response.destroy();
    throw new ResponseTooLarge();
  }
  const cancel = (): void => {
    response.destroy(new EnrollmentOutcomeUncertain());
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > RESPONSE_BODY_MAX_BYTES) {
        response.destroy();
        throw new ResponseTooLarge();
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ResponseTooLarge) throw error;
    throw new EnrollmentOutcomeUncertain();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  return Buffer.concat(chunks, total);
}

async function readFetchResponseBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > RESPONSE_BODY_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
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
        throw new ResponseTooLarge();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof ResponseTooLarge) throw error;
    throw new EnrollmentOutcomeUncertain();
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

function assertResponseHeaderSize(response: EnrollmentHttpResponse): void {
  if (response.rawHeaderBytes > RESPONSE_HEADERS_MAX_BYTES) {
    throw new EnrollmentContractError();
  }
}

function assertNoResponseCookies(response: EnrollmentHttpResponse): void {
  if (response.headerValues.has("set-cookie")) throw new EnrollmentContractError();
}

function assertSafeRepresentationHeaders(response: EnrollmentHttpResponse): void {
  const mediaType = response.headers.get("content-type");
  if (mediaType === null || !SAFE_MEDIA_TYPE.test(mediaType)) throw new EnrollmentContractError();
  if (response.headers.has("content-encoding")) throw new EnrollmentContractError();
}

function hasNoStore(response: EnrollmentHttpResponse): boolean {
  return (
    response.headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") === true
  );
}

function assertSafeResponseValue(
  value: unknown,
  token: string | undefined,
  allowTopLevelToken: boolean,
  depth = 0,
): void {
  if (typeof value === "string") {
    if (token !== undefined && value.includes(token)) throw new EnrollmentContractError();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeResponseValue(item, token, false, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [name, nested] of Object.entries(value)) {
    const lower = name.toLowerCase();
    const permittedToken = allowTopLevelToken && depth === 0 && name === "token";
    if (FORBIDDEN_RESPONSE_NAMES.has(lower) && !permittedToken) {
      throw new EnrollmentContractError();
    }
    if (token !== undefined && name.includes(token)) throw new EnrollmentContractError();
    if (permittedToken) continue;
    assertSafeResponseValue(nested, token, false, depth + 1);
  }
}

function safeMessage(value: unknown, fallback: string): string {
  return boundedString(value, 1, 1_024, 1_024) ? value : fallback;
}

function registrationSuccess(value: Record<string, unknown>): Record<string, unknown> {
  assertSafeResponseValue(value, undefined, false);
  if (
    typeof value.agent_id !== "string" ||
    !URI_UNRESERVED.test(value.agent_id) ||
    !validUsername(value.username) ||
    !validEmail(value.email)
  ) {
    throw new EnrollmentContractError();
  }
  return {
    agent_id: value.agent_id,
    username: value.username,
    email: value.email,
    message: safeMessage(value.message, "Verification code sent."),
  };
}

function resendSuccess(value: Record<string, unknown>): Record<string, unknown> {
  assertSafeResponseValue(value, undefined, false);
  return { message: safeMessage(value.message, "Verification code resent.") };
}

function errorCode(value: Record<string, unknown>): string | undefined {
  if (!exactKeys(value, ["error"]) || !isObject(value.error) || !exactKeys(value.error, ["code"])) {
    return undefined;
  }
  return typeof value.error.code === "string" ? value.error.code : undefined;
}

function flatError(value: Record<string, unknown>): string | undefined {
  return exactKeys(value, ["error"]) && typeof value.error === "string" ? value.error : undefined;
}

function assertRateLimit(response: EnrollmentHttpResponse, value: Record<string, unknown>): void {
  const retryAfter = response.headers.get("retry-after");
  if (errorCode(value) !== "rate_limited" || retryAfter === null || !/^\d+$/u.test(retryAfter)) {
    throw new EnrollmentContractError();
  }
}

function responseError(
  route: BootstrapToolName,
  response: EnrollmentHttpResponse,
  value: Record<string, unknown>,
): CentralEnrollmentError {
  if (route === "verify_email" && !hasNoStore(response)) {
    return new CentralEnrollmentError("central_verification_response_unsafe");
  }
  const reviewed = errorCode(value);
  if (response.status === 429) {
    assertRateLimit(response, value);
    return new CentralEnrollmentError("central_rate_limited");
  }
  if (response.status === 422 && reviewed === "invalid_request") {
    return new CentralEnrollmentError("central_enrollment_contract_failed");
  }
  if (response.status === 500 && reviewed === "internal_error") {
    return new CentralEnrollmentError("central_enrollment_outcome_uncertain");
  }
  if (response.status === 503 && reviewed === "temporarily_unavailable") {
    return new CentralEnrollmentError("central_enrollment_outcome_uncertain");
  }
  if (
    route === "register_agent" &&
    response.status === 409 &&
    reviewed === "registration_conflict"
  ) {
    return new CentralEnrollmentError("registration_conflict");
  }
  if (route === "verify_email" && response.status === 400 && reviewed === "verification_failed") {
    return new CentralEnrollmentError("verification_failed");
  }
  if (
    route === "verify_email" &&
    response.status === 400 &&
    flatError(value) === "invalid_dpop_proof"
  ) {
    return new CentralEnrollmentError("central_dpop_proof_rejected");
  }
  if (response.status >= 300 && response.status < 400) {
    return new CentralEnrollmentError("central_enrollment_outcome_uncertain");
  }
  return new CentralEnrollmentError("central_enrollment_contract_failed");
}

function validNonceHeader(response: EnrollmentHttpResponse): string | undefined {
  const values = response.headerValues.get("dpop-nonce") ?? [];
  if (values.length !== 1) return undefined;
  try {
    return parseDpopNonce(values[0]);
  } catch {
    return undefined;
  }
}

function nonceChallenge(
  response: EnrollmentHttpResponse,
  value: Record<string, unknown>,
): string | undefined {
  if (response.status !== 400 || flatError(value) !== "use_dpop_nonce" || !hasNoStore(response)) {
    return undefined;
  }
  return validNonceHeader(response);
}

export const REST_BOOTSTRAP_TOOLS: readonly CentralToolDefinition[] = [
  {
    name: "register_agent",
    description: "Register a central identity and send a verification code.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: {
          type: "string",
          minLength: 3,
          maxLength: 254,
          pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
        },
        username: { type: "string", minLength: 3, maxLength: 50 },
        display_name: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["email", "username"],
    },
  },
  {
    name: "verify_email",
    description: "Verify email control and enroll this gateway.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: {
          type: "string",
          minLength: 3,
          maxLength: 254,
          pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
        },
        code: { type: "string", minLength: 6, maxLength: 6, pattern: "^[A-Za-z0-9]{6}$" },
      },
      required: ["email", "code"],
    },
  },
  {
    name: "resend_verification",
    description: "Request a fresh verification code.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        email: {
          type: "string",
          minLength: 3,
          maxLength: 254,
          pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
        },
      },
      required: ["email"],
    },
  },
];

export class CentralEnrollmentClient {
  readonly #apiBase: URL;
  readonly #tokenProfile: CentralTokenProfile;
  readonly #verboseTranscript: DevelopmentVerboseTranscript | undefined;
  readonly #deadlineMs: number;
  readonly #fetch: typeof fetch | undefined;

  constructor(options: CentralEnrollmentClientOptions) {
    this.#apiBase = new URL(options.centralApiUrl);
    const loopback =
      this.#apiBase.hostname === "127.0.0.1" ||
      this.#apiBase.hostname === "[::1]" ||
      this.#apiBase.hostname === "localhost";
    if (
      (this.#apiBase.protocol !== "https:" && !(this.#apiBase.protocol === "http:" && loopback)) ||
      this.#apiBase.username !== "" ||
      this.#apiBase.password !== "" ||
      this.#apiBase.search !== "" ||
      this.#apiBase.hash !== "" ||
      options.tokenProfile.issuer.length === 0 ||
      options.tokenProfile.audiences.some((audience) => audience.length === 0)
    ) {
      throw new Error("The central enrollment configuration is invalid");
    }
    this.#tokenProfile = options.tokenProfile;
    this.#verboseTranscript = options.verboseTranscript;
    this.#deadlineMs = options.deadlineMs ?? ENROLLMENT_DEADLINE_MS;
    this.#fetch = options.fetch;
  }

  async register(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await this.#ordinaryRequest("register_agent", arguments_, signal);
  }

  async resend(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await this.#ordinaryRequest("resend_verification", arguments_, signal);
  }

  async verify(
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<VerificationEnrollmentSuccess> {
    let body: Record<string, unknown>;
    try {
      body = validateArguments("verify_email", arguments_);
    } catch {
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
    if (typeof body.code === "string") this.#verboseTranscript?.addSecret(body.code);
    const key = generateDpopKeyMaterial();
    this.#verboseTranscript?.addSecret(key.privateKeyPkcs8);
    let nonce: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = new URL("/api/verify_email", this.#apiBase);
      const proof = createDpopProof({
        method: "POST",
        targetUri: target.href,
        privateKey: key.privateKey,
        publicJwk: key.publicJwk,
        ...(nonce === undefined ? {} : { nonce }),
      });
      this.#verboseTranscript?.addSecret(proof);
      const response = await this.#send("verify_email", target, body, signal, { DPoP: proof });
      const parsed = response.value;
      if (!hasNoStore(response.response)) {
        throw new CentralEnrollmentError("central_verification_response_unsafe");
      }
      const responseNonce = response.response.headers.get("dpop-nonce");
      if (responseNonce !== null) this.#verboseTranscript?.addSecret(responseNonce);
      if (responseNonce !== null && validNonceHeader(response.response) === undefined) {
        this.#recordSafeFailure(response.response, "central_dpop_challenge_failed");
        throw new CentralEnrollmentError("central_dpop_challenge_failed");
      }
      const challengeNonce = nonceChallenge(response.response, parsed);
      if (response.response.status === 400 && flatError(parsed) === "use_dpop_nonce") {
        if (challengeNonce === undefined) {
          this.#recordSafeFailure(response.response, "central_dpop_challenge_failed");
          throw new CentralEnrollmentError("central_dpop_challenge_failed");
        }
        this.#verboseTranscript?.addSecret(challengeNonce);
        if (attempt !== 0) {
          this.#recordSafeFailure(response.response, "central_dpop_nonce_retry_exhausted");
          throw new CentralEnrollmentError("central_dpop_nonce_retry_exhausted");
        }
        this.#recordResponse(response.response, parsed);
        nonce = challengeNonce;
        continue;
      }
      if (response.response.status !== 200) {
        const failure = responseError("verify_email", response.response, parsed);
        this.#recordSafeFailure(response.response, failure.code);
        throw failure;
      }
      const success = this.#verificationSuccess(parsed, key);
      this.#recordResponse(response.response, parsed);
      return success;
    }
    throw new CentralEnrollmentError("central_dpop_nonce_retry_exhausted");
  }

  async #ordinaryRequest(
    name: Exclude<BootstrapToolName, "verify_email">,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let body: Record<string, unknown>;
    try {
      body = validateArguments(name, arguments_);
    } catch {
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
    const path = name === "register_agent" ? "/api/register" : "/api/resend_verification";
    const result = await this.#send(name, new URL(path, this.#apiBase), body, signal);
    if (result.response.status !== 200) {
      const failure = responseError(name, result.response, result.value);
      this.#recordSafeFailure(result.response, failure.code);
      throw failure;
    }
    try {
      const success =
        name === "register_agent" ? registrationSuccess(result.value) : resendSuccess(result.value);
      this.#recordResponse(result.response, result.value);
      return success;
    } catch {
      this.#recordSafeFailure(result.response, "central_enrollment_contract_failed");
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
  }

  #verificationSuccess(
    value: Record<string, unknown>,
    key: DpopKeyMaterial,
  ): VerificationEnrollmentSuccess {
    const tokenNames = Object.keys(value).filter((name) => name.toLowerCase() === "token");
    if (tokenNames.length !== 1 || tokenNames[0] !== "token") {
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
    const token = value.token;
    if (
      typeof value.agent_id !== "string" ||
      !URI_UNRESERVED.test(value.agent_id) ||
      !validUsername(value.username) ||
      typeof token !== "string" ||
      !ACCESS_TOKEN.test(token) ||
      Buffer.byteLength(token, "ascii") > 4_096 ||
      value.token_type !== "DPoP" ||
      value.expires_in !== TOKEN_LIFETIME_SECONDS
    ) {
      throw new CentralEnrollmentError("central_verification_credential_invalid");
    }
    try {
      assertSafeResponseValue(value, token, true);
    } catch {
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
    let claims: CentralTokenClaims;
    try {
      claims = parseCentralAccessToken(token);
    } catch (error) {
      if (error instanceof CredentialV2Error) {
        throw new CentralEnrollmentError("central_verification_credential_invalid");
      }
      throw error;
    }
    if (
      claims.subject !== value.agent_id ||
      claims.keyThumbprint !== key.thumbprint ||
      claims.issuer !== this.#tokenProfile.issuer ||
      claims.audiences[0] !== this.#tokenProfile.audiences[0] ||
      claims.audiences[1] !== this.#tokenProfile.audiences[1]
    ) {
      throw new CentralEnrollmentError("central_verification_credential_invalid");
    }
    this.#verboseTranscript?.addSecret(token);
    return {
      credential: createCentralCredentialV2Record(token, key),
      localResult: {
        verified: true,
        agent_id: value.agent_id,
        username: value.username,
        message: safeMessage(value.message, "Email verified successfully."),
      },
    };
  }

  async #send(
    route: BootstrapToolName,
    target: URL,
    body: Record<string, unknown>,
    signal: AbortSignal,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<{
    readonly response: EnrollmentHttpResponse;
    readonly value: Record<string, unknown>;
  }> {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized, "utf8") > REQUEST_BODY_MAX_BYTES) {
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#deadlineMs)]);
    const init: RequestInit = {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders,
      },
      body: serialized,
      signal: requestSignal,
    };
    this.#verboseTranscript?.recordHttpRequest("central_rest", target, init);
    let response: EnrollmentHttpResponse;
    try {
      response = await this.#request(
        target,
        serialized,
        init.headers as Record<string, string>,
        requestSignal,
      );
    } catch (error) {
      if (error instanceof EnrollmentContractError) {
        throw new CentralEnrollmentError("central_enrollment_contract_failed");
      }
      throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
    }
    try {
      assertResponseHeaderSize(response);
      if (route === "verify_email" && !hasNoStore(response)) {
        throw new CentralEnrollmentError("central_verification_response_unsafe");
      }
      assertNoResponseCookies(response);
      if (response.status >= 300 && response.status < 400) {
        throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
      }
      assertSafeRepresentationHeaders(response);
      const value = parseStrictResponse(response.body);
      return { response, value };
    } catch (error) {
      if (error instanceof EnrollmentOutcomeUncertain) {
        throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
      }
      if (error instanceof CentralEnrollmentError) throw error;
      throw new CentralEnrollmentError("central_enrollment_contract_failed");
    }
  }

  async #request(
    target: URL,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<EnrollmentHttpResponse> {
    if (this.#fetch !== undefined) {
      return await this.#requestWithFetch(target, body, headers, signal);
    }
    return await new Promise((resolve, reject) => {
      let settled = false;
      let aborting = false;
      const finish = (
        operation: (value: EnrollmentHttpResponse | PromiseLike<EnrollmentHttpResponse>) => void,
        value: EnrollmentHttpResponse,
      ): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        operation(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      };
      const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
        target,
        {
          method: "POST",
          headers,
          maxHeaderSize: RESPONSE_HEADERS_MAX_BYTES,
        },
        (incoming) => {
          void (async () => {
            try {
              const collected = responseHeaders(incoming);
              const responseBody = await readResponseBody(incoming, collected.headers, signal);
              finish(resolve, {
                status: incoming.statusCode ?? 0,
                headers: collected.headers,
                headerValues: collected.values,
                rawHeaderBytes: collected.rawBytes,
                body: responseBody,
              });
            } catch (error) {
              if (aborting) return;
              fail(error);
            }
          })();
        },
      );
      const abort = (): void => {
        aborting = true;
        request.destroy(new EnrollmentOutcomeUncertain());
      };
      request.once("error", (error: Error & { code?: string }) => {
        if (aborting) return;
        if (error.code === "HPE_HEADER_OVERFLOW") fail(new EnrollmentContractError());
        else fail(new EnrollmentOutcomeUncertain());
      });
      request.once("close", () => {
        if (!aborting) return;
        setImmediate(() => fail(new EnrollmentOutcomeUncertain()));
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      request.end(body);
    });
  }

  async #requestWithFetch(
    target: URL,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<EnrollmentHttpResponse> {
    let response: Response;
    try {
      response = await (this.#fetch as typeof fetch)(target, {
        method: "POST",
        redirect: "manual",
        headers,
        body,
        signal,
      });
    } catch (error) {
      const cause =
        error instanceof Error
          ? (error as Error & { cause?: { code?: unknown } }).cause
          : undefined;
      if (cause?.code === "UND_ERR_HEADERS_OVERFLOW") throw new EnrollmentContractError();
      throw new EnrollmentOutcomeUncertain();
    }
    const values = new Map<string, readonly string[]>();
    let rawHeaderBytes = 2;
    for (const [name, value] of response.headers) {
      values.set(name.toLowerCase(), [value]);
      rawHeaderBytes +=
        Buffer.byteLength(name, "latin1") + 2 + Buffer.byteLength(value, "latin1") + 2;
    }
    return {
      status: response.status,
      headers: response.headers,
      headerValues: values,
      rawHeaderBytes,
      body: await readFetchResponseBody(response, signal),
    };
  }

  #recordResponse(response: EnrollmentHttpResponse, body: unknown): void {
    this.#verboseTranscript?.record({
      boundary: "central_rest",
      direction: "response",
      status: response.status,
      headers: response.headers,
      body,
    });
  }

  #recordSafeFailure(response: EnrollmentHttpResponse, code: CentralEnrollmentErrorCode): void {
    this.#verboseTranscript?.record({
      boundary: "central_rest",
      direction: "response",
      status: response.status,
      headers: response.headers,
      body: { code },
    });
  }
}
