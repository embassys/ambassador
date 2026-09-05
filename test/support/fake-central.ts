import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

const FIXTURE_CLOCK_SECONDS = 1_788_220_800;
const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const VERIFICATION_CODE = "314159";
const TOKEN_SECRET = Buffer.from("current-central-fixture-hs256-secret", "utf8");
const MAX_REQUEST_BYTES = 1024 * 1024;
const EMAIL = /^[\w.-]+@[\w.-]+\.\w+$/u;
const IDENTIFIER = /^[A-Za-z0-9._~-]{1,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const FORBIDDEN_REQUEST_NAMES = new Set([
  "access_token",
  "authorization",
  "dpop",
  "jwt",
  "private_key",
  "proof",
  "token",
]);

export interface FixtureActionType {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface FixtureMessage {
  readonly id: string;
  readonly sender_agent_id: string;
  readonly action_type_id: string | null;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

export interface FixtureRequestObservation {
  readonly method: string;
  readonly path: string;
  readonly authorizationScheme: "Bearer" | "DPoP" | "other" | null;
  readonly dpopCount: number;
  readonly bodyKeys: readonly string[];
}

export type FixtureMessageState = "queued" | "delivered" | "acked";

interface IdentityRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName?: string;
  code: string;
  verified: boolean;
  publicJwk?: PublicJwk;
  thumbprint?: string;
}

type PermissionDecision = "accept" | "deny" | "allow_once" | "allow_always";

interface PermissionRecord {
  readonly id: string;
  readonly grantorEmail: string;
  readonly granteeEmail: string;
  readonly actionType: string;
  readonly scope: Record<string, unknown>;
  readonly decisionOptions: "accept_deny" | "once_always";
  readonly reason?: string;
  status: "pending" | "granted" | "denied";
  decision?: PermissionDecision;
  usesRemaining?: number | null;
  readonly createdAt: string;
  decidedAt?: string;
}

interface PermissionDecisionTokenRecord {
  readonly permissionId: string;
  readonly expiresAt: number;
  usedAt?: number;
}

interface HumanInputRecord {
  readonly id: string;
  readonly agentEmail: string;
  readonly actionType: string;
  readonly prompt: string;
  readonly inputType: "buttons" | "text";
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly messageId: string;
  status: "pending" | "answered";
}

interface HumanInputTokenRecord {
  readonly requestId: string;
  readonly expiresAt: number;
  usedAt?: number;
}

interface ActionCallRecord {
  readonly id: string;
  readonly callerEmail: string;
  readonly targetEmail: string;
  readonly actionType: string;
  status: "pending" | "completed" | "failed";
  result?: Record<string, unknown>;
}

interface MessageRecord {
  readonly recipientEmail: string;
  readonly message: FixtureMessage;
  state: FixtureMessageState;
}

interface PublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

interface TokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly iat: number;
  readonly exp: number;
  readonly cnf: { readonly jkt: string };
}

interface FixtureState {
  nowSeconds: number;
  sequence: number;
  readonly identities: Map<string, IdentityRecord>;
  readonly tokens: Map<string, string>;
  readonly permissions: Map<string, PermissionRecord>;
  readonly permissionDecisionTokens: Map<string, PermissionDecisionTokenRecord>;
  readonly permissionTokensById: Map<string, string>;
  readonly humanInputs: Map<string, HumanInputRecord>;
  readonly humanInputTokens: Map<string, HumanInputTokenRecord>;
  readonly humanInputTokensById: Map<string, string>;
  readonly humanInputActionTypes: Map<string, FixtureActionType>;
  readonly actionCalls: Map<string, ActionCallRecord>;
  readonly messages: Map<string, MessageRecord>;
  readonly replay: Set<string>;
  readonly nonces: Map<string, string>;
  readonly observations: FixtureRequestObservation[];
}

export interface ProofOptions {
  readonly method?: string;
  readonly target?: string;
  readonly accessToken?: string;
  readonly privateKey?: KeyObject;
  readonly publicJwk?: PublicJwk;
  readonly nowSeconds?: number;
  readonly jti?: string;
  readonly nonce?: string;
  readonly ath?: string;
}

export interface FixtureProtectedRequestOptions extends RequestInit {
  readonly proof?: ProofOptions | false;
  readonly authorizationScheme?: "Bearer" | "DPoP";
}

export interface FixtureClient {
  readonly email: string;
  protectedFetch(path: string, options?: FixtureProtectedRequestOptions): Promise<Response>;
  createProof(method: string, target: string, options?: ProofOptions): string;
  accessTokenForTest(): string;
  publicJwkForTest(): PublicJwk;
}

export interface FakeCentral {
  readonly apiUrl: string;
  readonly actions: readonly FixtureActionType[];
  verificationCode(email: string): string;
  permissionDecisionToken(permissionId: string): string;
  permissionOutcomeMessageId(permissionId: string): string | undefined;
  humanInputResponseToken(requestId: string): string;
  humanInputResponseMessageId(requestId: string): string | undefined;
  pendingHumanInputRequest(
    email: string,
  ): { readonly requestId: string; readonly messageId: string } | undefined;
  seedClient(email: string): FixtureClient;
  clientForVerifiedEmail(email: string): FixtureClient;
  setNonce(email: string, nonce?: string): string | undefined;
  queueMessage(
    recipientEmail: string,
    payload: Record<string, unknown>,
    senderEmail?: string,
    actionType?: string,
  ): string;
  messageState(messageId: string): FixtureMessageState | undefined;
  requests(): readonly FixtureRequestObservation[];
  resetRequests(): void;
  advanceClock(seconds: number): void;
  close(): Promise<void>;
}

const ACTIONS: readonly FixtureActionType[] = [
  {
    id: "action.create_calendar_event",
    name: "create_calendar_event",
    description: "Create a calendar event",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_time: { type: "string" },
        end_time: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["title", "start_time", "end_time"],
    },
  },
  {
    id: "action.get_email",
    name: "get_email",
    description: "Request an email address",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for requesting email address" },
      },
      required: ["reason"],
    },
  },
  {
    id: "action.get_free_busy_permission",
    name: "get_free_busy_permission",
    description: "Request free-busy information",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string" },
        date_to: { type: "string" },
        calendar_id: { type: "string" },
      },
    },
  },
  {
    id: "action.get_phone_number",
    name: "get_phone_number",
    description: "Request a phone number",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for requesting phone number" },
      },
      required: ["reason"],
    },
  },
  {
    id: "action.read_calendar_event_by_title",
    name: "read_calendar_event_by_title",
    description: "Read a calendar event",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date_from: { type: "string" },
        date_to: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    id: "action.read_calendar_permission",
    name: "read_calendar_permission",
    description: "Request calendar read access",
    input_schema: {
      type: "object",
      properties: { calendar_id: { type: "string" } },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return (
    required.every((name) => Object.hasOwn(value, name)) && keys.every((name) => allowed.has(name))
  );
}

function containsForbiddenName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenName);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([name, nested]) =>
      FORBIDDEN_REQUEST_NAMES.has(name.toLowerCase()) || containsForbiddenName(nested),
  );
}

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJsonSegment(value: string): Record<string, unknown> {
  if (!BASE64URL.test(value)) throw new Error("invalid JWT segment");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("noncanonical JWT segment");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(parsed)) throw new Error("invalid JWT object");
  return parsed;
}

function publicJwk(value: unknown): PublicJwk {
  if (!exactKeys(value, ["kty", "crv", "x", "y"])) throw new Error("invalid JWK");
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string" ||
    Buffer.from(value.x, "base64url").byteLength !== 32 ||
    Buffer.from(value.y, "base64url").byteLength !== 32 ||
    Buffer.from(value.x, "base64url").toString("base64url") !== value.x ||
    Buffer.from(value.y, "base64url").toString("base64url") !== value.y
  ) {
    throw new Error("invalid JWK");
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

function exportPublicJwk(key: KeyObject): PublicJwk {
  return publicJwk(key.export({ format: "jwk" }));
}

function thumbprint(jwk: PublicJwk): string {
  return createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }), "utf8")
    .digest("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("base64url");
}

function issueToken(identity: IdentityRecord, state: FixtureState): string {
  if (identity.thumbprint === undefined) throw new Error("identity has no DPoP key");
  const header = encodedJson({ alg: "HS256", typ: "JWT" });
  const claims: TokenClaims = {
    sub: identity.id,
    email: identity.email,
    iat: state.nowSeconds,
    exp: state.nowSeconds + TOKEN_LIFETIME_SECONDS,
    cnf: { jkt: identity.thumbprint },
  };
  const payload = encodedJson(claims);
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", TOKEN_SECRET)
    .update(signingInput, "ascii")
    .digest("base64url");
  const token = `${signingInput}.${signature}`;
  state.tokens.set(token, identity.email);
  return token;
}

function verifyToken(
  token: string,
  state: FixtureState,
): { identity: IdentityRecord; claims: TokenClaims } {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("invalid token");
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  const header = decodeJsonSegment(encodedHeader);
  if (header.alg !== "HS256") throw new Error("invalid token algorithm");
  const expected = createHmac("sha256", TOKEN_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`, "ascii")
    .digest();
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid token signature");
  }
  const claims = decodeJsonSegment(encodedPayload);
  if (
    !exactKeys(claims, ["sub", "email", "iat", "exp", "cnf"]) ||
    typeof claims.sub !== "string" ||
    typeof claims.email !== "string" ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    !exactKeys(claims.cnf, ["jkt"]) ||
    typeof claims.cnf.jkt !== "string" ||
    (claims.exp as number) <= state.nowSeconds
  ) {
    throw new Error("invalid token claims");
  }
  const email = state.tokens.get(token);
  const identity = email === undefined ? undefined : state.identities.get(email);
  if (
    identity === undefined ||
    !identity.verified ||
    identity.id !== claims.sub ||
    identity.email !== claims.email ||
    identity.thumbprint !== claims.cnf.jkt
  ) {
    throw new Error("unknown token");
  }
  return {
    identity,
    claims: {
      sub: claims.sub,
      email: claims.email,
      iat: claims.iat as number,
      exp: claims.exp as number,
      cnf: { jkt: claims.cnf.jkt },
    },
  };
}

function headerValues(request: IncomingMessage, selected: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === selected && value !== undefined) result.push(value);
  }
  return result;
}

function safeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers?: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-type": "application/json",
    ...headers,
  });
  response.end(body);
}

function detail(
  response: ServerResponse,
  status: number,
  message: string,
  headers?: Record<string, string>,
): void {
  safeJson(response, status, { detail: message }, headers);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(bytes);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function nextId(state: FixtureState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}.${state.sequence.toString().padStart(6, "0")}`;
}

function nextUuid(state: FixtureState): string {
  state.sequence += 1;
  return `00000000-0000-4000-8000-${state.sequence.toString().padStart(12, "0")}`;
}

function currentTimestamp(state: FixtureState): string {
  return new Date(state.nowSeconds * 1_000).toISOString();
}

function actionByName(state: FixtureState, name: string): FixtureActionType | undefined {
  return ACTIONS.find((action) => action.name === name) ?? state.humanInputActionTypes.get(name);
}

function payloadMatchesAction(
  action: FixtureActionType,
  payload: Record<string, unknown>,
): boolean {
  const required = action.input_schema.required;
  const properties = action.input_schema.properties;
  if (!Array.isArray(required) || !isRecord(properties)) return true;
  return required.every(
    (name) =>
      typeof name === "string" &&
      typeof payload[name] === "string" &&
      isRecord(properties[name]) &&
      properties[name].type === "string",
  );
}

function createProof(
  method: string,
  target: string,
  accessToken: string,
  privateKey: KeyObject,
  jwk: PublicJwk,
  options: ProofOptions = {},
): string {
  const header = encodedJson({ typ: "dpop+jwt", alg: "ES256", jwk: options.publicJwk ?? jwk });
  const payload = encodedJson({
    jti: options.jti ?? randomUUID(),
    htm: options.method ?? method,
    htu: options.target ?? target,
    iat: options.nowSeconds ?? FIXTURE_CLOCK_SECONDS,
    ath: options.ath ?? tokenHash(options.accessToken ?? accessToken),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: options.privateKey ?? privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

function authenticateProtected(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  state: FixtureState,
): IdentityRecord | undefined {
  const authorization = headerValues(request, "authorization");
  const proofs = headerValues(request, "dpop");
  if (
    authorization.length !== 1 ||
    !authorization[0]?.startsWith("Bearer ") ||
    proofs.length !== 1
  ) {
    detail(response, 401, "Not authenticated");
    return undefined;
  }
  const token = authorization[0].slice("Bearer ".length);
  let identity: IdentityRecord;
  let claims: TokenClaims;
  try {
    ({ identity, claims } = verifyToken(token, state));
    const proof = proofs[0] as string;
    const segments = proof.split(".");
    if (segments.length !== 3) throw new Error("invalid proof");
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = decodeJsonSegment(encodedHeader);
    if (
      !exactKeys(header, ["typ", "alg", "jwk"]) ||
      header.typ !== "dpop+jwt" ||
      header.alg !== "ES256"
    ) {
      throw new Error("invalid proof header");
    }
    const jwk = publicJwk(header.jwk);
    if (thumbprint(jwk) !== claims.cnf.jkt) throw new Error("wrong proof key");
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      signature.byteLength !== 64 ||
      !verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
        {
          key: createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        signature,
      )
    ) {
      throw new Error("invalid proof signature");
    }
    const payload = decodeJsonSegment(encodedPayload);
    const allowed = new Set(["jti", "htm", "htu", "iat", "ath", "nonce"]);
    if (
      !["jti", "htm", "htu", "iat", "ath"].every((name) => Object.hasOwn(payload, name)) ||
      Object.keys(payload).some((name) => !allowed.has(name)) ||
      typeof payload.jti !== "string" ||
      !IDENTIFIER.test(payload.jti) ||
      payload.htm !== request.method ||
      payload.htu !== target ||
      !Number.isSafeInteger(payload.iat) ||
      (payload.iat as number) < state.nowSeconds - 60 ||
      (payload.iat as number) > state.nowSeconds + 5 ||
      payload.ath !== tokenHash(token)
    ) {
      throw new Error("invalid proof claims");
    }
    const expectedNonce = state.nonces.get(identity.email);
    if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
      const nextNonce = randomBytes(32).toString("base64url");
      state.nonces.set(identity.email, nextNonce);
      detail(response, 401, "DPoP nonce required", { "dpop-nonce": nextNonce });
      return undefined;
    }
    const replayKey = `${identity.id}\0${payload.jti}`;
    if (state.replay.has(replayKey)) throw new Error("replayed proof");
    state.replay.add(replayKey);
  } catch {
    detail(response, 401, "Invalid DPoP proof");
    return undefined;
  }
  return identity;
}

function queueMessage(
  state: FixtureState,
  recipientEmail: string,
  senderEmail: string,
  payload: Record<string, unknown>,
  actionType?: string,
): string {
  const recipient = state.identities.get(recipientEmail);
  const sender = state.identities.get(senderEmail);
  if (recipient === undefined || sender === undefined)
    throw new Error("fixture identity is missing");
  const action = actionType === undefined ? undefined : actionByName(state, actionType);
  const id = nextUuid(state);
  state.messages.set(id, {
    recipientEmail,
    state: "queued",
    message: {
      id,
      sender_agent_id: sender.id,
      action_type_id: action?.id ?? null,
      payload,
      created_at: currentTimestamp(state),
    },
  });
  return id;
}

function requestObservation(request: IncomingMessage, body: unknown): FixtureRequestObservation {
  const authorization = headerValues(request, "authorization");
  const value = authorization.length === 1 ? authorization[0] : undefined;
  const scheme = value?.split(" ", 1)[0];
  return {
    method: request.method ?? "",
    path: request.url ?? "",
    authorizationScheme:
      scheme === undefined ? null : scheme === "Bearer" || scheme === "DPoP" ? scheme : "other",
    dpopCount: headerValues(request, "dpop").length,
    bodyKeys: isRecord(body) ? Object.keys(body).sort() : [],
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  state: FixtureState,
): Promise<void> {
  let body: unknown;
  try {
    body = request.method === "POST" ? await readJson(request) : {};
  } catch {
    detail(response, 400, "Invalid request");
    return;
  }
  state.observations.push(requestObservation(request, body));
  const target = new URL(request.url ?? "/", origin);
  const isHumanDecision = target.pathname === "/api/human_input_response";
  const isPermissionDecision =
    target.pathname === "/permission/decide" || target.pathname === "/api/permission_decision";
  if (!isPermissionDecision && !isHumanDecision && containsForbiddenName(body)) {
    detail(response, 422, "Invalid request");
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/register_agent") {
    if (
      !exactKeys(body, ["email"], ["display_name"]) ||
      typeof body.email !== "string" ||
      !EMAIL.test(body.email) ||
      (body.display_name !== undefined &&
        (typeof body.display_name !== "string" ||
          body.display_name.length < 1 ||
          body.display_name.length > 128))
    ) {
      detail(response, 422, "Invalid registration");
      return;
    }
    const existing = state.identities.get(body.email);
    if (existing?.verified === true) {
      detail(response, 409, "Agent already registered");
      return;
    }
    const identity: IdentityRecord = {
      id: nextId(state, "agent"),
      email: body.email,
      ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
      code: VERIFICATION_CODE,
      verified: false,
    };
    state.identities.set(identity.email, identity);
    safeJson(response, 200, {
      agent_id: identity.id,
      email: identity.email,
      message: "Verification code sent to your email. Please verify to complete registration.",
    });
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/resend_verification") {
    if (!exactKeys(body, ["email"]) || typeof body.email !== "string" || !EMAIL.test(body.email)) {
      detail(response, 422, "Invalid resend request");
      return;
    }
    const identity = state.identities.get(body.email);
    if (identity === undefined) {
      detail(response, 404, "Agent not found");
      return;
    }
    if (identity.verified) {
      detail(response, 400, "Agent already verified");
      return;
    }
    identity.code = VERIFICATION_CODE;
    safeJson(response, 200, { message: "Verification code sent to your email." });
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/verify_email") {
    if (
      !exactKeys(body, ["email", "code", "jwk"]) ||
      typeof body.email !== "string" ||
      typeof body.code !== "string" ||
      !/^\d{6}$/u.test(body.code)
    ) {
      detail(response, 422, "Invalid verification");
      return;
    }
    const identity = state.identities.get(body.email);
    if (identity === undefined) {
      detail(response, 404, "Agent not found");
      return;
    }
    if (identity.verified || identity.code !== body.code) {
      detail(response, 400, "Verification failed");
      return;
    }
    try {
      identity.publicJwk = publicJwk(body.jwk);
    } catch {
      detail(response, 400, "Invalid JWK");
      return;
    }
    identity.thumbprint = thumbprint(identity.publicJwk);
    identity.verified = true;
    const token = issueToken(identity, state);
    safeJson(response, 200, {
      agent_id: identity.id,
      email: identity.email,
      token,
      jkt: identity.thumbprint,
      message:
        "Email verified successfully. Store this token securely - it will not be shown again.",
    });
    return;
  }

  if (request.method === "GET" && target.pathname === "/permission/decide") {
    const token = target.searchParams.get("token");
    const choice = target.searchParams.get("choice");
    const decisionToken = token === null ? undefined : state.permissionDecisionTokens.get(token);
    const permission =
      decisionToken === undefined ? undefined : state.permissions.get(decisionToken.permissionId);
    const offered =
      permission?.decisionOptions === "once_always"
        ? ["allow_once", "allow_always", "deny"]
        : ["accept", "deny"];
    if (
      decisionToken === undefined ||
      permission === undefined ||
      decisionToken.usedAt !== undefined ||
      decisionToken.expiresAt <= state.nowSeconds ||
      permission.status !== "pending"
    ) {
      detail(response, 410, "This decision link is not valid");
      return;
    }
    if (choice === null || !offered.includes(choice)) {
      detail(response, 400, "Decision was not offered");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Confirm permission decision</title>");
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/permission_decision") {
    if (!exactKeys(body, ["token", "decision"]) || typeof body.token !== "string") {
      detail(response, 422, "Invalid permission decision");
      return;
    }
    const decisionToken = state.permissionDecisionTokens.get(body.token);
    const permission =
      decisionToken === undefined ? undefined : state.permissions.get(decisionToken.permissionId);
    const offered =
      permission?.decisionOptions === "once_always"
        ? ["allow_once", "allow_always", "deny"]
        : ["accept", "deny"];
    if (
      decisionToken === undefined ||
      permission === undefined ||
      decisionToken.usedAt !== undefined ||
      decisionToken.expiresAt <= state.nowSeconds ||
      permission.status !== "pending"
    ) {
      detail(response, 410, "This decision link is not valid");
      return;
    }
    if (typeof body.decision !== "string" || !offered.includes(body.decision)) {
      detail(response, 400, "Decision was not offered");
      return;
    }
    const decision = body.decision as PermissionDecision;
    decisionToken.usedAt = state.nowSeconds;
    permission.decision = decision;
    permission.status = decision === "deny" ? "denied" : "granted";
    permission.usesRemaining = decision === "allow_once" ? 1 : null;
    permission.decidedAt = currentTimestamp(state);
    queueMessage(
      state,
      permission.granteeEmail,
      permission.grantorEmail,
      {
        type: "permission_outcome",
        permission_id: permission.id,
        action_type: permission.actionType,
        decision,
        status: permission.status,
        granted: permission.status === "granted",
        single_use: decision === "allow_once",
        grantor_email: permission.grantorEmail,
      },
      permission.actionType,
    );
    safeJson(response, 200, {
      permission_id: permission.id,
      decision,
      status: permission.status,
      granted: permission.status === "granted",
    });
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/human_input_response") {
    if (
      !exactKeys(body, ["token"], ["value", "text"]) ||
      typeof body.token !== "string" ||
      (typeof body.value !== "string" && typeof body.text !== "string")
    ) {
      detail(response, 422, "Invalid human input response");
      return;
    }
    const responseToken = state.humanInputTokens.get(body.token);
    const input =
      responseToken === undefined ? undefined : state.humanInputs.get(responseToken.requestId);
    if (
      responseToken === undefined ||
      input === undefined ||
      responseToken.usedAt !== undefined ||
      responseToken.expiresAt <= state.nowSeconds ||
      input.status !== "pending"
    ) {
      detail(response, 410, "This link is no longer usable");
      return;
    }
    if (
      input.inputType === "buttons"
        ? !input.options.some(({ value }) => value === body.value)
        : typeof body.text !== "string" || body.text.length < 1 || body.text.length > 4_000
    ) {
      detail(response, 400, "Answer was not offered");
      return;
    }
    responseToken.usedAt = state.nowSeconds;
    input.status = "answered";
    queueMessage(
      state,
      input.agentEmail,
      input.agentEmail,
      {
        type: "human_input_response",
        request_id: input.id,
        action_type: input.actionType,
        input_type: input.inputType,
        value: input.inputType === "buttons" ? body.value : null,
        text: input.inputType === "text" ? body.text : null,
        prompt: input.prompt,
        message_id: input.messageId,
      },
      input.actionType,
    );
    safeJson(response, 200, {
      request_id: input.id,
      status: "answered",
      input_type: input.inputType,
      value: input.inputType === "buttons" ? body.value : null,
      text: input.inputType === "text" ? body.text : null,
    });
    return;
  }

  if (!target.pathname.startsWith("/api/")) {
    detail(response, 404, "Not found");
    return;
  }
  const identity = authenticateProtected(request, response, target.href, state);
  if (identity === undefined) return;

  if (request.method === "GET" && target.pathname === "/api/list_action_types") {
    safeJson(response, 200, [...ACTIONS, ...state.humanInputActionTypes.values()]);
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/get_human_input") {
    if (
      !exactKeys(body, ["permission_type", "request", "input_type", "message_id"], ["options"]) ||
      typeof body.permission_type !== "string" ||
      body.permission_type.length < 1 ||
      body.permission_type.length > 128 ||
      typeof body.request !== "string" ||
      body.request.length < 1 ||
      body.request.length > 2_000 ||
      (body.input_type !== "buttons" && body.input_type !== "text") ||
      (body.input_type === "buttons"
        ? !Array.isArray(body.options) || body.options.length < 1 || body.options.length > 10
        : body.options != null) ||
      typeof body.message_id !== "string"
    ) {
      detail(response, 422, "Invalid human input request");
      return;
    }
    const options: Array<{ label: string; value: string }> = [];
    for (const option of (body.options ?? []) as unknown[]) {
      if (
        !exactKeys(option, ["label", "value"]) ||
        typeof option.label !== "string" ||
        option.label.length < 1 ||
        option.label.length > 64 ||
        typeof option.value !== "string" ||
        option.value.length < 1 ||
        option.value.length > 64
      ) {
        detail(response, 422, "Invalid human input request");
        return;
      }
      options.push({ label: option.label, value: option.value });
    }
    if (new Set(options.map(({ value }) => value)).size !== options.length) {
      detail(response, 422, "Invalid human input request");
      return;
    }
    const source = state.messages.get(body.message_id);
    const sender = [...state.identities.values()].find(
      (candidate) => candidate.id === source?.message.sender_agent_id,
    );
    if (
      source === undefined ||
      (source.recipientEmail !== identity.email && sender?.email !== identity.email)
    ) {
      detail(response, source === undefined ? 404 : 403, "Message unavailable");
      return;
    }
    const actionType = body.permission_type;
    if (actionByName(state, actionType) === undefined) {
      state.humanInputActionTypes.set(actionType, {
        id: nextId(state, "action.human_input"),
        name: actionType,
        description: `Auto-created from a human input request by ${identity.email}`,
        input_schema: {},
      });
    }
    const requestId = nextUuid(state);
    const input: HumanInputRecord = {
      id: requestId,
      agentEmail: identity.email,
      actionType,
      prompt: body.request,
      inputType: body.input_type,
      options,
      messageId: body.message_id,
      status: "pending",
    };
    state.humanInputs.set(requestId, input);
    const token = randomBytes(32).toString("base64url");
    state.humanInputTokens.set(token, {
      requestId,
      expiresAt: state.nowSeconds + 72 * 60 * 60,
    });
    state.humanInputTokensById.set(requestId, token);
    safeJson(response, 200, {
      request_id: requestId,
      status: "pending",
      input_type: body.input_type,
      message: `Question emailed to ${identity.email}`,
      options: body.input_type === "buttons" ? options : null,
    });
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/request_permission") {
    if (
      !exactKeys(
        body,
        [],
        [
          "target_email",
          "message_id",
          "action_type",
          "permission_type",
          "decision_options",
          "reason",
          "scope",
        ],
      ) ||
      (body.target_email === undefined && body.message_id === undefined) ||
      (body.action_type === undefined) === (body.permission_type === undefined) ||
      (body.target_email !== undefined && typeof body.target_email !== "string") ||
      (body.message_id !== undefined && typeof body.message_id !== "string") ||
      (body.action_type !== undefined && typeof body.action_type !== "string") ||
      (body.permission_type !== undefined && typeof body.permission_type !== "string") ||
      (body.decision_options !== undefined &&
        body.decision_options !== "accept_deny" &&
        body.decision_options !== "once_always") ||
      (body.reason !== undefined &&
        (typeof body.reason !== "string" || body.reason.length > 500)) ||
      (body.scope !== undefined && body.scope !== null && !isRecord(body.scope))
    ) {
      detail(response, 422, "Invalid permission request");
      return;
    }
    let targetEmail = body.target_email as string | undefined;
    if (body.message_id !== undefined) {
      const messageRecord = state.messages.get(body.message_id as string);
      const sender = [...state.identities.values()].find(
        (candidate) => candidate.id === messageRecord?.message.sender_agent_id,
      );
      let derivedTarget: string | undefined;
      if (messageRecord?.recipientEmail === identity.email) derivedTarget = sender?.email;
      else if (sender?.email === identity.email) derivedTarget = messageRecord?.recipientEmail;
      else {
        detail(response, 403, "Not a party to message");
        return;
      }
      if (targetEmail !== undefined && targetEmail !== derivedTarget) {
        detail(response, 422, "Target does not match message");
        return;
      }
      targetEmail = derivedTarget;
    }
    if (targetEmail === undefined) {
      detail(response, 404, "Message party not found");
      return;
    }
    const actionType = (body.action_type ?? body.permission_type) as string;
    const targetIdentity = state.identities.get(targetEmail);
    if (targetIdentity?.verified !== true) {
      detail(response, 404, "Target or action not found");
      return;
    }
    if (targetEmail === identity.email) {
      detail(response, 400, "Cannot request permission from yourself");
      return;
    }
    let permission = [...state.permissions.values()].find(
      (candidate) =>
        candidate.grantorEmail === targetEmail &&
        candidate.granteeEmail === identity.email &&
        candidate.actionType === actionType &&
        (candidate.status === "pending" ||
          (candidate.status === "granted" &&
            (candidate.usesRemaining === null || (candidate.usesRemaining ?? 0) > 0))),
    );
    if (permission === undefined) {
      const created: PermissionRecord = {
        id: nextUuid(state),
        grantorEmail: targetEmail,
        granteeEmail: identity.email,
        actionType,
        scope: (body.scope ?? {}) as Record<string, unknown>,
        decisionOptions: (body.decision_options ??
          "accept_deny") as PermissionRecord["decisionOptions"],
        ...(body.reason === undefined ? {} : { reason: body.reason as string }),
        status: "pending",
        createdAt: currentTimestamp(state),
      };
      permission = created;
      state.permissions.set(created.id, created);
      const token = randomBytes(32).toString("base64url");
      state.permissionDecisionTokens.set(token, {
        permissionId: created.id,
        expiresAt: state.nowSeconds + 72 * 60 * 60,
      });
      state.permissionTokensById.set(created.id, token);
    } else if (permission.status === "granted") {
      queueMessage(
        state,
        permission.grantorEmail,
        identity.email,
        {
          type: "permission_already_granted",
          permission_id: permission.id,
          action_type: permission.actionType,
          requester_email: identity.email,
          decision: permission.decision,
          scope: permission.scope,
          reason: body.reason ?? null,
        },
        permission.actionType,
      );
    }
    safeJson(response, 200, {
      permission_id: permission.id,
      status: permission.status,
      message:
        permission.status === "pending"
          ? `Approval request emailed to ${targetEmail}`
          : "Permission was already granted; no approval email was sent.",
      already_granted: permission.status === "granted",
      decision: permission.decision ?? null,
    });
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/call_action") {
    if (
      !exactKeys(body, ["target_email", "action_type", "payload"]) ||
      typeof body.target_email !== "string" ||
      typeof body.action_type !== "string" ||
      !isRecord(body.payload)
    ) {
      detail(response, 422, "Invalid action call");
      return;
    }
    const action = actionByName(state, body.action_type);
    const permission = [...state.permissions.values()].find(
      (candidate) =>
        candidate.grantorEmail === body.target_email &&
        candidate.granteeEmail === identity.email &&
        candidate.actionType === body.action_type &&
        candidate.status === "granted" &&
        (candidate.usesRemaining === null || (candidate.usesRemaining ?? 0) > 0),
    );
    if (
      action === undefined ||
      permission === undefined ||
      !payloadMatchesAction(action, body.payload)
    ) {
      detail(response, 403, "Action not permitted");
      return;
    }
    if (permission.usesRemaining !== null && permission.usesRemaining !== undefined) {
      permission.usesRemaining -= 1;
    }
    const callId = nextUuid(state);
    state.actionCalls.set(callId, {
      id: callId,
      callerEmail: identity.email,
      targetEmail: body.target_email,
      actionType: action.name,
      status: "pending",
    });
    const messageId = queueMessage(
      state,
      body.target_email,
      identity.email,
      { type: "action_call", call_id: callId, action_type: action.name, payload: body.payload },
      action.name,
    );
    safeJson(response, 200, { call_id: callId, message_id: messageId, status: "delivered" });
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/submit_action_result") {
    if (
      !exactKeys(body, ["call_id", "result", "status"]) ||
      typeof body.call_id !== "string" ||
      !isRecord(body.result) ||
      (body.status !== "success" && body.status !== "error")
    ) {
      detail(response, 422, "Invalid action result");
      return;
    }
    const call = state.actionCalls.get(body.call_id);
    if (call === undefined || call.targetEmail !== identity.email) {
      detail(response, 404, "Action call not found");
      return;
    }
    if (call.status !== "pending") {
      detail(response, 409, "Action call already completed");
      return;
    }
    call.status = body.status === "success" ? "completed" : "failed";
    call.result = body.result;
    const messageId = queueMessage(
      state,
      call.callerEmail,
      identity.email,
      {
        type: "action_response",
        call_id: call.id,
        action_type: call.actionType,
        status: body.status,
        result: body.result,
      },
      call.actionType,
    );
    safeJson(response, 200, { call_id: call.id, status: call.status, message_id: messageId });
    return;
  }

  if (request.method === "GET" && target.pathname === "/api/poll_messages") {
    const timeout = target.searchParams.get("timeout");
    if (timeout !== null && (!/^\d+$/u.test(timeout) || Number(timeout) > 60)) {
      detail(response, 422, "Invalid timeout");
      return;
    }
    const messages: FixtureMessage[] = [];
    for (const record of state.messages.values()) {
      if (record.recipientEmail !== identity.email || record.state !== "queued") continue;
      record.state = "delivered";
      messages.push(record.message);
    }
    safeJson(response, 200, { messages });
    return;
  }

  if (request.method === "GET" && target.pathname === "/api/get_my_permissions") {
    const permissions = [...state.permissions.values()]
      .filter(
        (permission) =>
          permission.grantorEmail === identity.email || permission.granteeEmail === identity.email,
      )
      .map((permission) => ({
        id: permission.id,
        grantor_email: permission.grantorEmail,
        grantee_email: permission.granteeEmail,
        action_type: permission.actionType,
        status: permission.status,
        scope: permission.scope,
        created_at: permission.createdAt,
        decided_at: permission.decidedAt ?? null,
        expires_at: null,
      }));
    safeJson(response, 200, permissions);
    return;
  }

  if (request.method === "POST" && target.pathname === "/api/ack_message") {
    if (!exactKeys(body, ["message_id"]) || typeof body.message_id !== "string") {
      detail(response, 422, "Invalid acknowledgement");
      return;
    }
    const message = state.messages.get(body.message_id);
    if (
      message === undefined ||
      message.recipientEmail !== identity.email ||
      message.state !== "delivered"
    ) {
      detail(response, 404, "Message not found");
      return;
    }
    message.state = "acked";
    safeJson(response, 200, { message_id: body.message_id, status: "acked" });
    return;
  }

  detail(response, 404, "Not found");
}

class FixtureClientImplementation implements FixtureClient {
  readonly #privateKey: KeyObject;
  readonly #publicJwk: PublicJwk;

  constructor(
    readonly email: string,
    private readonly origin: string,
    private readonly accessToken: string,
    keyPair: { readonly privateKey: KeyObject; readonly publicJwk: PublicJwk },
  ) {
    this.#privateKey = keyPair.privateKey;
    this.#publicJwk = keyPair.publicJwk;
  }

  accessTokenForTest(): string {
    return this.accessToken;
  }

  publicJwkForTest(): PublicJwk {
    return this.#publicJwk;
  }

  createProof(method: string, target: string, options: ProofOptions = {}): string {
    return createProof(
      method,
      target,
      this.accessToken,
      this.#privateKey,
      this.#publicJwk,
      options,
    );
  }

  async protectedFetch(
    path: string,
    options: FixtureProtectedRequestOptions = {},
  ): Promise<Response> {
    const target = new URL(path, this.origin).href;
    const method = (options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers);
    headers.set("authorization", `${options.authorizationScheme ?? "Bearer"} ${this.accessToken}`);
    if (options.proof !== false) {
      headers.set("dpop", this.createProof(method, target, options.proof));
    }
    const { authorizationScheme: _authorizationScheme, proof: _proof, ...request } = options;
    return await fetch(target, { ...request, method, headers, redirect: "manual" });
  }
}

export async function startFakeCentral(t?: TestContext): Promise<FakeCentral> {
  const state: FixtureState = {
    nowSeconds: FIXTURE_CLOCK_SECONDS,
    sequence: 0,
    identities: new Map(),
    tokens: new Map(),
    permissions: new Map(),
    permissionDecisionTokens: new Map(),
    permissionTokensById: new Map(),
    humanInputs: new Map(),
    humanInputTokens: new Map(),
    humanInputTokensById: new Map(),
    humanInputActionTypes: new Map(),
    actionCalls: new Map(),
    messages: new Map(),
    replay: new Set(),
    nonces: new Map(),
    observations: [],
  };
  let origin = "";
  const server = createServer((request, response) => {
    void route(request, response, origin, state).catch(() => {
      if (!response.headersSent) detail(response, 500, "Fixture failure");
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  const clients = new Map<string, FixtureClientImplementation>();
  const seedClient = (email: string): FixtureClientImplementation => {
    if (!EMAIL.test(email)) throw new Error("fixture email is invalid");
    const existing = clients.get(email);
    if (existing !== undefined) return existing;
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = exportPublicJwk(pair.publicKey);
    const identity: IdentityRecord = {
      id: nextId(state, "agent"),
      email,
      code: VERIFICATION_CODE,
      verified: true,
      publicJwk: jwk,
      thumbprint: thumbprint(jwk),
    };
    state.identities.set(email, identity);
    const client = new FixtureClientImplementation(email, origin, issueToken(identity, state), {
      privateKey: pair.privateKey,
      publicJwk: jwk,
    });
    clients.set(email, client);
    return client;
  };

  const close = async (): Promise<void> => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  };
  t?.after(close);

  return {
    apiUrl: origin,
    actions: ACTIONS,
    verificationCode(email: string): string {
      const identity = state.identities.get(email);
      if (identity === undefined) throw new Error("fixture identity is missing");
      return identity.code;
    },
    permissionDecisionToken(permissionId: string): string {
      const token = state.permissionTokensById.get(permissionId);
      if (token === undefined) throw new Error("fixture permission decision token is missing");
      return token;
    },
    permissionOutcomeMessageId(permissionId: string): string | undefined {
      return [...state.messages.values()].find(
        ({ message }) =>
          message.payload.type === "permission_outcome" &&
          message.payload.permission_id === permissionId,
      )?.message.id;
    },
    humanInputResponseToken(requestId: string): string {
      const token = state.humanInputTokensById.get(requestId);
      if (token === undefined) throw new Error("fixture human input token is missing");
      return token;
    },
    humanInputResponseMessageId(requestId: string): string | undefined {
      return [...state.messages.values()].find(
        ({ message }) =>
          message.payload.type === "human_input_response" &&
          message.payload.request_id === requestId,
      )?.message.id;
    },
    pendingHumanInputRequest(email: string) {
      const input = [...state.humanInputs.values()].find(
        (candidate) => candidate.agentEmail === email && candidate.status === "pending",
      );
      return input === undefined ? undefined : { requestId: input.id, messageId: input.messageId };
    },
    seedClient,
    clientForVerifiedEmail(email: string): FixtureClient {
      const client = clients.get(email);
      if (client === undefined) throw new Error("fixture client is missing");
      return client;
    },
    setNonce(email: string, nonce?: string): string | undefined {
      if (!state.identities.has(email)) throw new Error("fixture identity is missing");
      if (nonce === undefined) {
        state.nonces.delete(email);
        return undefined;
      }
      if (!IDENTIFIER.test(nonce)) throw new Error("fixture nonce is invalid");
      state.nonces.set(email, nonce);
      return nonce;
    },
    queueMessage(
      recipientEmail: string,
      payload: Record<string, unknown>,
      senderEmail = "sender@fixture.test",
      actionType?: string,
    ): string {
      if (!state.identities.has(senderEmail)) seedClient(senderEmail);
      return queueMessage(state, recipientEmail, senderEmail, payload, actionType);
    },
    messageState(messageId: string): FixtureMessageState | undefined {
      return state.messages.get(messageId)?.state;
    },
    requests(): readonly FixtureRequestObservation[] {
      return state.observations.map((observation) => ({
        ...observation,
        bodyKeys: [...observation.bodyKeys],
      }));
    },
    resetRequests(): void {
      state.observations.length = 0;
    },
    advanceClock(seconds: number): void {
      if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error("fixture clock delta is invalid");
      }
      state.nowSeconds += seconds;
    },
    close,
  };
}

export function createFixtureKeyPair(): {
  readonly privateKey: KeyObject;
  readonly publicJwk: PublicJwk;
} {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey: pair.privateKey, publicJwk: exportPublicJwk(pair.publicKey) };
}
