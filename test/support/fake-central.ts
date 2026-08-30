import assert from "node:assert/strict";
import {
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

const CENTRAL_JWT = "fixture-central-jwt-never-expose-locally";
const VERIFICATION_CODE = "246810";
const V2_VERIFICATION_CODE = "123456";
const V2_INITIAL_TIME = 1_788_000_000;
const V2_ISSUER = "urn:a2a:fixture:issuer:v2";
const V2_API_AUDIENCE = "urn:a2a:fixture:resource:api:v2";
const V2_MCP_AUDIENCE = "urn:a2a:fixture:resource:mcp:v2";
const V2_API_DOMAIN = "a2a-fixture-api-v2";
const V2_MCP_DOMAIN = "a2a-fixture-mcp-v2";
const V2_ISSUANCE_DOMAIN = "a2a-fixture-issuance-v2";
const TOKEN_LIFETIME_SECONDS = 86_400;
const LEASE_SECONDS = 60;
const START_RECORD_SECONDS = 48 * 60 * 60;
const MAX_RECEIVE_BYTES = 524_288;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const URI_UNRESERVED_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PublicEcJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

interface PrivateEcJwk extends PublicEcJwk {
  d: string;
}

interface DpopProofOptions {
  accessToken?: string | null;
  nonce?: string;
  htm?: string;
  htu?: string;
  iat?: number;
  jti?: string;
}

interface DpopRequestOptions {
  accessToken?: string | null;
}

export interface FixtureDpopClient {
  readonly accessToken: string | undefined;
  readonly jkt: string;
  readonly publicJwk: PublicEcJwk;
  setAccessToken: (token: string) => void;
  proof: (method: string, target: string, options?: DpopProofOptions) => string;
  headers: (method: string, target: string, options?: DpopProofOptions) => Record<string, string>;
  request: (target: string, init?: RequestInit, options?: DpopRequestOptions) => Promise<Response>;
}

export type V2FaultOperation =
  | "register"
  | "verify"
  | "resend"
  | "activate"
  | "start"
  | "start_lookup"
  | "receive"
  | "reply"
  | "complete"
  | "outcome"
  | "ack"
  | "reissue"
  | "revoke";

export type V2Fault = "drop_after_commit" | "temporarily_unavailable" | "rate_limited";

interface V2MessageState {
  id: string;
  conversationId: string;
  recipientAgentId: string;
  terminalOutcome: string | null;
  replyMessageId: string | null;
  acknowledged: boolean;
  leaseUntil: number | null;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function fixedPrivateJwk(scalar: number): PrivateEcJwk {
  const privateBytes = Buffer.alloc(32);
  privateBytes.writeUInt32BE(scalar, 28);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(privateBytes);
  const publicBytes = ecdh.getPublicKey(undefined, "uncompressed");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64url(publicBytes.subarray(1, 33)),
    y: base64url(publicBytes.subarray(33, 65)),
    d: base64url(privateBytes),
  };
}

function publicJwk(jwk: PrivateEcJwk): PublicEcJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

function jwkThumbprint(jwk: PublicEcJwk): string {
  return base64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

function privateKey(jwk: PrivateEcJwk): KeyObject {
  return createPrivateKey({ key: jwk as JsonWebKey, format: "jwk" });
}

function publicKey(jwk: PublicEcJwk): KeyObject {
  return createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
}

function signJwt(header: unknown, payload: unknown, key: KeyObject): string {
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header), "utf8"));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "ascii"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64url(signature)}`;
}

function decodeBase64url(value: string): Buffer {
  if (!BASE64URL.test(value) || value.includes("=")) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (base64url(decoded) !== value) throw new Error("noncanonical base64url");
  return decoded;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

class JsonScanner {
  readonly text: string;
  readonly maxDepth: number;
  readonly maxMembers: number;
  index = 0;
  members = 0;

  constructor(text: string, maxDepth: number, maxMembers: number) {
    this.text = text;
    this.maxDepth = maxDepth;
    this.maxMembers = maxMembers;
  }

  scan(): void {
    this.whitespace();
    this.value(0);
    this.whitespace();
    if (this.index !== this.text.length) throw new Error("trailing JSON data");
  }

  private whitespace(): void {
    while (/\s/u.test(this.text[this.index] ?? "")) this.index += 1;
  }

  private value(depth: number): void {
    if (depth > this.maxDepth) throw new Error("JSON nesting limit");
    const character = this.text[this.index];
    if (character === "{") this.object(depth + 1);
    else if (character === "[") this.array(depth + 1);
    else if (character === '"') this.string();
    else this.primitive();
  }

  private object(depth: number): void {
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.text[this.index] !== '"') throw new Error("invalid object key");
      const key = this.string();
      if (keys.has(key)) throw new Error("duplicate object key");
      keys.add(key);
      this.members += 1;
      if (this.members > this.maxMembers) throw new Error("JSON member limit");
      this.whitespace();
      if (this.text[this.index] !== ":") throw new Error("missing object colon");
      this.index += 1;
      this.whitespace();
      this.value(depth);
      this.whitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === "}") return;
      if (separator !== ",") throw new Error("invalid object separator");
      this.whitespace();
    }
  }

  private array(depth: number): void {
    this.index += 1;
    this.whitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.value(depth);
      this.whitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === "]") return;
      if (separator !== ",") throw new Error("invalid array separator");
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (character === "\\") this.index += 1;
      this.index += 1;
    }
    throw new Error("unterminated JSON string");
  }

  private primitive(): void {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,}\]]/u.test(this.text[this.index] ?? "")) {
      this.index += 1;
    }
    if (start === this.index) throw new Error("invalid JSON value");
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

function assertNoLoneSurrogates(root: unknown): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (hasLoneSurrogate(value)) throw new Error("lone JSON surrogate");
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, member] of Object.entries(value)) {
        if (hasLoneSurrogate(key)) throw new Error("lone JSON surrogate");
        pending.push(member);
      }
    }
  }
}

function parseStrictJson(bytes: Buffer, maxDepth = 100, maxMembers = 16_384): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  new JsonScanner(text, maxDepth, maxMembers).scan();
  const parsed = JSON.parse(text) as unknown;
  assertNoLoneSurrogates(parsed);
  return parsed;
}

function normalizeHtu(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  if (/%(?![0-9a-fA-F]{2})/u.test(url.pathname)) {
    throw new Error("invalid URI percent encoding");
  }
  const normalizedPath = url.pathname.replace(/%[0-9a-fA-F]{2}/gu, (encoded) => {
    const byte = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9._~-]/u.test(character) ? character : `%${encoded.slice(1).toUpperCase()}`;
  });
  url.pathname = normalizedPath || "/";
  return url.toString().replace(/\/$/u, url.pathname.endsWith("/") ? "/" : "");
}

function fixtureUuid(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

class FixtureDpopClientImpl implements FixtureDpopClient {
  readonly publicJwk: PublicEcJwk;
  readonly jkt: string;
  private readonly key: KeyObject;
  private readonly now: () => number;
  private nextProofId: number;
  private token: string | undefined;

  constructor(scalar: number, now: () => number, firstProofId: number, token?: string) {
    const jwk = fixedPrivateJwk(scalar);
    this.publicJwk = publicJwk(jwk);
    this.jkt = jwkThumbprint(this.publicJwk);
    this.key = privateKey(jwk);
    this.now = now;
    this.nextProofId = firstProofId;
    this.token = token;
  }

  get accessToken(): string | undefined {
    return this.token;
  }

  setAccessToken(token: string): void {
    this.token = token;
  }

  proof(method: string, target: string, options: DpopProofOptions = {}): string {
    const accessToken =
      options.accessToken === null ? undefined : (options.accessToken ?? this.accessToken);
    const payload: Record<string, unknown> = {
      jti: options.jti ?? fixtureUuid(this.nextProofId++),
      htm: options.htm ?? method.toUpperCase(),
      htu: options.htu ?? normalizeHtu(target),
      iat: options.iat ?? this.now(),
    };
    if (options.nonce !== undefined) payload.nonce = options.nonce;
    if (accessToken !== undefined) payload.ath = base64url(sha256(accessToken));
    return signJwt({ typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk }, payload, this.key);
  }

  headers(method: string, target: string, options: DpopProofOptions = {}): Record<string, string> {
    const accessToken =
      options.accessToken === null ? undefined : (options.accessToken ?? this.accessToken);
    const headers: Record<string, string> = {
      dpop: this.proof(method, target, { ...options, accessToken: accessToken ?? null }),
    };
    if (accessToken !== undefined) headers.authorization = `DPoP ${accessToken}`;
    return headers;
  }

  async request(
    target: string,
    init: RequestInit = {},
    options: DpopRequestOptions = {},
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const accessToken =
      options.accessToken === null ? undefined : (options.accessToken ?? this.accessToken);
    const send = async (nonce?: string): Promise<Response> => {
      const headers = new Headers(init.headers);
      const proofOptions: DpopProofOptions = { accessToken: accessToken ?? null };
      if (nonce !== undefined) proofOptions.nonce = nonce;
      for (const [name, value] of Object.entries(this.headers(method, target, proofOptions))) {
        headers.set(name, value);
      }
      return await fetch(target, { ...init, method, headers });
    };
    const first = await send();
    const nonce = first.headers.get("dpop-nonce");
    const challengeStatus = accessToken === undefined ? 400 : 401;
    if (nonce === null || first.status !== challengeStatus) return first;
    return await send(nonce);
  }
}

interface MessageRecord {
  id: string;
  content: string;
  delivered: boolean;
  contentAcknowledged: boolean;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

interface V2Agent {
  id: string;
  username: string;
  email: string;
  verified: boolean;
  deliveryVersion: "v1" | "v2";
  grants: Set<string>;
  legacyMigrationBlocked: boolean;
}

interface VerificationRecord {
  purpose: "enrollment" | "recovery";
  expiresAt: number;
}

interface TokenRecord {
  token: string;
  agentId: string;
  jkt: string;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
  revoked: boolean;
}

interface ConversationMessage {
  id: string;
  conversation_id: string;
  sender_agent_id: string;
  message_type: "conversation_turn";
  in_reply_to_message_id: string | null;
  payload: { text: string };
  created_at: string;
}

interface MessageRecordV2 {
  message: ConversationMessage;
  recipientAgentId: string;
  leaseUntil: number | null;
  terminal:
    | { kind: "replied"; replyMessageId: string; fingerprint: string }
    | { kind: "completed"; outcome: string; reasonCode: string }
    | null;
  acknowledged: boolean;
}

interface StartRecord {
  senderAgentId: string;
  requestId: string;
  recipientAgentId: string;
  recipientUsername: string;
  fingerprint: string;
  messageId: string;
  conversationId: string;
  createdAt: number;
}

interface ReissueRecord {
  agentId: string;
  token: string;
  createdAt: number;
}

type IdempotencyNamespaceRecord =
  | { operation: "start"; expiresAt: number }
  | { operation: "reissue"; agentId: string; expiresAt: number };

interface LegacyBearerRecord {
  token: string;
  agentId: string;
  expiresAt: number;
  revoked: boolean;
}

interface PermissionRecordV2 {
  id: string;
  requesterAgentId: string;
  targetAgentId: string;
  actionType: string;
  scope: Record<string, unknown> | null;
  status: "pending" | "granted" | "denied";
}

interface ReplayRecord {
  expiresAt: number;
  securityDomain: string;
  jkt: string;
}

interface CoreResult {
  status: number;
  body: Record<string, unknown>;
}

interface ParsedProof {
  publicJwk: PublicEcJwk;
  jkt: string;
  payload: Record<string, unknown>;
}

interface ProtectedIdentity {
  agent: V2Agent;
  token: TokenRecord;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > limit) {
      throw new Error("request too large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readObject(
  request: IncomingMessage,
  limit = 1_048_576,
  maxDepth = 100,
  maxMembers = 16_384,
): Promise<Record<string, unknown>> {
  const parsed = parseStrictJson(await readBytes(request, limit), maxDepth, maxMembers);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function tool(name: string, properties: Record<string, unknown>, required: string[] = []): unknown {
  return {
    name,
    description: `${name} fixture tool`,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const tools = [
  tool(
    "register_agent",
    {
      username: { type: "string" },
      email: { type: "string" },
      display_name: { type: "string" },
    },
    ["username", "email"],
  ),
  tool("verify_email", { email: { type: "string" }, code: { type: "string" } }, ["email", "code"]),
  tool("resend_verification", { email: { type: "string" } }, ["email"]),
  tool("poll_messages", { token: { type: "string" }, timeout: { type: "number" } }, ["token"]),
  tool("ack_message", { token: { type: "string" }, message_id: { type: "string" } }, [
    "token",
    "message_id",
  ]),
];

const v2Tools = [
  tool("list_action_types", {}),
  tool(
    "request_permission",
    {
      target_username: { type: "string" },
      action_type: { type: "string" },
      scope: { anyOf: [{ type: "object" }, { type: "null" }] },
    },
    ["target_username", "action_type"],
  ),
  tool(
    "respond_to_permission",
    {
      permission_id: { type: "string" },
      decision: { type: "string", enum: ["granted", "denied"] },
    },
    ["permission_id", "decision"],
  ),
  tool(
    "call_action",
    {
      target_username: { type: "string" },
      action_type: { type: "string" },
      payload: { type: "object" },
    },
    ["target_username", "action_type", "payload"],
  ),
  tool("get_my_permissions", {
    status: { type: "string", enum: ["all", "pending", "granted", "denied"] },
  }),
  tool(
    "start_conversation",
    {
      recipient_username: { type: "string" },
      payload: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      request_id: { type: "string" },
    },
    ["recipient_username", "payload", "request_id"],
  ),
  tool("get_conversation_start", { request_id: { type: "string" } }, ["request_id"]),
  tool("receive_messages", { timeout_seconds: { type: "integer" }, limit: { type: "integer" } }, [
    "timeout_seconds",
    "limit",
  ]),
  tool(
    "reply_message",
    {
      message_id: { type: "string" },
      payload: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    ["message_id", "payload"],
  ),
  tool(
    "complete_message",
    {
      message_id: { type: "string" },
      outcome: { type: "string" },
      reason_code: { type: "string" },
    },
    ["message_id", "outcome", "reason_code"],
  ),
  tool("get_message_outcome", { message_id: { type: "string" } }, ["message_id"]),
  tool("ack_message", { message_id: { type: "string" } }, ["message_id"]),
];

function toolResult(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    },
  };
}

export interface FakeCentral {
  apiUrl: string;
  mcpUrl: string;
  jwt: string;
  v2Issuer: string;
  v2Audiences: readonly [string, string];
  pollCount: () => number;
  calls: ToolCallRecord[];
  setApiPollAvailable: (available: boolean) => void;
  setMcpPollMode: (
    mode: "normal" | "authentication_failure" | "credential_result" | "invalid_result",
  ) => void;
  setPollResponse: (response: unknown) => void;
  setMcpAvailable: (available: boolean) => void;
  setAcknowledgementMode: (mode: "normal" | "mismatch" | "failure" | "disconnect") => void;
  setToolDescription: (name: string, description: string | undefined) => void;
  setVerificationResult: (result: Record<string, unknown> | string | undefined) => void;
  injectMessage: (id: string, content: string) => void;
  messageState: (id: string) => MessageRecord;
  createDpopClient: () => FixtureDpopClient;
  seedClient: (username: string) => FixtureDpopClient;
  seededLegacyBearer: (username: string) => string;
  advanceClock: (seconds: number) => void;
  clock: () => number;
  resetV2: () => void;
  refreshSeedCredentials: () => void;
  currentV2Token: (username: string) => string;
  failNextV2: (operation: V2FaultOperation, fault: V2Fault) => void;
  setV1MigrationBlocked: (username: string, blocked: boolean) => void;
  setConversationGrant: (
    recipientUsername: string,
    senderUsername: string,
    granted: boolean,
  ) => void;
  v2MessageState: (id: string) => V2MessageState;
}

export async function startFakeCentral(t: TestContext): Promise<FakeCentral> {
  const messages = new Map<string, MessageRecord>();
  const calls: ToolCallRecord[] = [];
  let pollCount = 0;
  let pollResponse: unknown;
  let apiPollAvailable = true;
  let mcpPollMode: "normal" | "authentication_failure" | "credential_result" | "invalid_result" =
    "normal";
  let mcpAvailable = true;
  let acknowledgementMode: "normal" | "mismatch" | "failure" | "disconnect" = "normal";
  const toolDescriptions = new Map<string, string>();
  let verificationResult: Record<string, unknown> | string | undefined;
  let baseUrl = "";

  const issuerJwk = fixedPrivateJwk(1);
  const issuerPrivateKey = privateKey(issuerJwk);
  const issuerPublicKey = publicKey(publicJwk(issuerJwk));
  const nonceKey = Buffer.from("a2a-fixture-nonce-mac-key-v2-0001", "utf8");
  const fingerprintKey = Buffer.from("a2a-fixture-fingerprint-key-v2", "utf8");
  const agentsById = new Map<string, V2Agent>();
  const agentsByUsername = new Map<string, V2Agent>();
  const agentsByEmail = new Map<string, V2Agent>();
  const codes = new Map<string, VerificationRecord>();
  const tokens = new Map<string, TokenRecord>();
  const messagesV2 = new Map<string, MessageRecordV2>();
  const starts = new Map<string, StartRecord>();
  const reissues = new Map<string, ReissueRecord>();
  const idempotencyNamespaces = new Map<string, IdempotencyNamespaceRecord>();
  const legacyBearerTokens = new Map<string, LegacyBearerRecord>();
  const permissionsV2 = new Map<string, PermissionRecordV2>();
  const replayClaims = new Map<string, ReplayRecord>();
  const seedClients = new Map<string, FixtureDpopClientImpl>();
  const nextFaults = new Map<V2FaultOperation, V2Fault[]>();
  let now = V2_INITIAL_TIME;
  let agentSequence = 1;
  let conversationSequence = 1;
  let messageSequence = 1;
  let tokenSequence = 1;
  let nonceSequence = 1;
  let clientSequence = 100;
  let permissionSequence = 1;
  let actionSequence = 1;

  function addAgent(agent: V2Agent): void {
    agentsById.set(agent.id, agent);
    agentsByUsername.set(agent.username, agent);
    agentsByEmail.set(agent.email, agent);
  }

  function issueToken(agent: V2Agent, jkt: string): string {
    const tokenId = fixtureUuid(10_000 + tokenSequence++);
    const payload = {
      iss: V2_ISSUER,
      aud: [V2_API_AUDIENCE, V2_MCP_AUDIENCE],
      sub: agent.id,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
      jti: tokenId,
      cnf: { jkt },
    };
    const token = signJwt({ typ: "JWT", alg: "ES256" }, payload, issuerPrivateKey);
    tokens.set(token, {
      token,
      agentId: agent.id,
      jkt,
      issuedAt: now,
      expiresAt: now + TOKEN_LIFETIME_SECONDS,
      tokenId,
      revoked: false,
    });
    return token;
  }

  function issueLegacyBearer(agent: V2Agent): string {
    const token = signJwt(
      { typ: "JWT", alg: "ES256" },
      {
        iss: V2_ISSUER,
        aud: [V2_API_AUDIENCE, V2_MCP_AUDIENCE],
        sub: agent.id,
        iat: now,
        exp: now + TOKEN_LIFETIME_SECONDS,
        jti: fixtureUuid(20_000),
      },
      issuerPrivateKey,
    );
    legacyBearerTokens.set(token, {
      token,
      agentId: agent.id,
      expiresAt: now + TOKEN_LIFETIME_SECONDS,
      revoked: false,
    });
    return token;
  }

  function addSeed(username: string, scalar: number, deliveryVersion: "v1" | "v2"): V2Agent {
    const suffix = username.replace("fixture_", "");
    const agent: V2Agent = {
      id: `agent_fixture_${suffix}`,
      username,
      email: `${username}@fixture.invalid`,
      verified: true,
      deliveryVersion,
      grants: new Set<string>(),
      legacyMigrationBlocked: false,
    };
    addAgent(agent);
    const client = new FixtureDpopClientImpl(scalar, () => now, scalar * 1_000);
    client.setAccessToken(issueToken(agent, client.jkt));
    seedClients.set(username, client);
    return agent;
  }

  function resetV2State(): void {
    agentsById.clear();
    agentsByUsername.clear();
    agentsByEmail.clear();
    codes.clear();
    tokens.clear();
    messagesV2.clear();
    starts.clear();
    reissues.clear();
    idempotencyNamespaces.clear();
    legacyBearerTokens.clear();
    permissionsV2.clear();
    replayClaims.clear();
    seedClients.clear();
    nextFaults.clear();
    now = V2_INITIAL_TIME;
    agentSequence = 1;
    conversationSequence = 1;
    messageSequence = 1;
    tokenSequence = 1;
    nonceSequence = 1;
    clientSequence = 100;
    permissionSequence = 1;
    actionSequence = 1;
    const sender = addSeed("fixture_sender", 2, "v2");
    const recipient = addSeed("fixture_recipient", 3, "v2");
    addSeed("fixture_denied", 4, "v2");
    const legacy = addSeed("fixture_legacy", 5, "v1");
    issueLegacyBearer(legacy);
    recipient.grants.add(sender.id);
  }

  function pruneIdempotencyRecords(): void {
    for (const [key, record] of starts) {
      if (record.createdAt + START_RECORD_SECONDS <= now) starts.delete(key);
    }
    for (const [key, record] of reissues) {
      if (record.createdAt + START_RECORD_SECONDS <= now) reissues.delete(key);
    }
    for (const [requestId, record] of idempotencyNamespaces) {
      if (record.expiresAt <= now) idempotencyNamespaces.delete(requestId);
    }
  }

  function nextAgentId(): string {
    return `agent_fixture_${(agentSequence++).toString().padStart(4, "0")}`;
  }

  function nextConversationId(): string {
    return `conv_fixture_${(conversationSequence++).toString().padStart(6, "0")}`;
  }

  function nextMessageId(): string {
    return `msg_fixture_${(messageSequence++).toString().padStart(6, "0")}`;
  }

  function fingerprint(...values: string[]): string {
    const hmac = createHmac("sha256", fingerprintKey);
    for (const value of values) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      hmac.update(length);
      hmac.update(bytes);
    }
    return hmac.digest("base64url");
  }

  function nonceMacInput(
    scope: "issuance" | "resource",
    securityDomain: string,
    bindings: string[],
    prefix: Buffer,
  ): Buffer {
    const chunks: Buffer[] = [];
    for (const value of ["a2a-dpop-nonce-v1", scope, securityDomain, ...bindings]) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      chunks.push(length, bytes);
    }
    chunks.push(prefix);
    return Buffer.concat(chunks);
  }

  function makeNonce(
    scope: "issuance" | "resource",
    securityDomain: string,
    bindings: string[],
  ): string {
    const prefix = Buffer.alloc(25);
    prefix[0] = 1;
    prefix.writeBigUInt64BE(BigInt(now), 1);
    sha256(`fixture-nonce-${nonceSequence++}`).copy(prefix, 9, 0, 16);
    const tag = createHmac("sha256", nonceKey)
      .update(nonceMacInput(scope, securityDomain, bindings, prefix))
      .digest();
    return base64url(Buffer.concat([prefix, tag]));
  }

  function nonceIsValid(
    nonce: string,
    scope: "issuance" | "resource",
    securityDomain: string,
    bindings: string[],
  ): boolean {
    if (nonce.length !== 76 || !BASE64URL.test(nonce)) return false;
    let bytes: Buffer;
    try {
      bytes = decodeBase64url(nonce);
    } catch {
      return false;
    }
    if (bytes.byteLength !== 57 || bytes[0] !== 1) return false;
    const issuedAt = Number(bytes.readBigUInt64BE(1));
    if (issuedAt > now + 5 || now - issuedAt > 300) return false;
    const prefix = bytes.subarray(0, 25);
    const expectedTag = createHmac("sha256", nonceKey)
      .update(nonceMacInput(scope, securityDomain, bindings, prefix))
      .digest();
    return timingSafeEqual(bytes.subarray(25), expectedTag);
  }

  function nonceIssuedAt(nonce: string): number {
    return Number(decodeBase64url(nonce).readBigUInt64BE(1));
  }

  function parseProof(rawProof: string, requireAth: boolean): ParsedProof {
    if (Buffer.byteLength(rawProof, "ascii") > 4_096 || /[^\x21-\x7e]/u.test(rawProof)) {
      throw new Error("invalid proof bytes");
    }
    const segments = rawProof.split(".");
    if (segments.length !== 3) throw new Error("invalid proof segments");
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw new Error("invalid proof");
    }
    const headerValue = parseStrictJson(decodeBase64url(encodedHeader), 4, 8);
    const payloadValue = parseStrictJson(decodeBase64url(encodedPayload), 4, 8);
    if (
      headerValue === null ||
      typeof headerValue !== "object" ||
      Array.isArray(headerValue) ||
      payloadValue === null ||
      typeof payloadValue !== "object" ||
      Array.isArray(payloadValue)
    ) {
      throw new Error("invalid proof objects");
    }
    const header = headerValue as Record<string, unknown>;
    const payload = payloadValue as Record<string, unknown>;
    if (!exactKeys(header, ["typ", "alg", "jwk"])) throw new Error("invalid proof header");
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256") throw new Error("invalid proof alg");
    if (header.jwk === null || typeof header.jwk !== "object" || Array.isArray(header.jwk)) {
      throw new Error("invalid proof jwk");
    }
    const jwk = header.jwk as Record<string, unknown>;
    if (!exactKeys(jwk, ["kty", "crv", "x", "y"])) throw new Error("invalid JWK members");
    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      decodeBase64url(jwk.x).byteLength !== 32 ||
      decodeBase64url(jwk.y).byteLength !== 32
    ) {
      throw new Error("invalid proof key");
    }
    const publicProofJwk: PublicEcJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
    const required = requireAth
      ? ["jti", "htm", "htu", "iat", "ath"]
      : ["jti", "htm", "htu", "iat"];
    if (!exactKeys(payload, required, ["nonce"])) throw new Error("invalid proof claims");
    const signature = decodeBase64url(encodedSignature);
    if (signature.byteLength !== 64) throw new Error("invalid proof signature size");
    if (
      !cryptoVerify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
        { key: publicKey(publicProofJwk), dsaEncoding: "ieee-p1363" },
        signature,
      )
    ) {
      throw new Error("invalid proof signature");
    }
    return { publicJwk: publicProofJwk, jkt: jwkThumbprint(publicProofJwk), payload };
  }

  function proofClaimsAreValid(
    proof: ParsedProof,
    method: string,
    htu: string,
    accessToken?: string,
  ): boolean {
    const { payload } = proof;
    let claimedTarget: URL;
    try {
      claimedTarget = new URL(typeof payload.htu === "string" ? payload.htu : "");
    } catch {
      return false;
    }
    if (
      typeof payload.jti !== "string" ||
      !UUID_V4.test(payload.jti) ||
      payload.htm !== method ||
      typeof payload.htu !== "string" ||
      (claimedTarget.protocol !== "http:" && claimedTarget.protocol !== "https:") ||
      claimedTarget.username !== "" ||
      claimedTarget.password !== "" ||
      claimedTarget.search !== "" ||
      claimedTarget.hash !== "" ||
      normalizeHtu(payload.htu) !== normalizeHtu(htu) ||
      !Number.isInteger(payload.iat) ||
      (payload.iat as number) < now - 60 ||
      (payload.iat as number) > now + 5
    ) {
      return false;
    }
    if (accessToken === undefined) return payload.ath === undefined;
    return payload.ath === base64url(sha256(accessToken));
  }

  function claimReplay(
    securityDomain: string,
    proof: ParsedProof,
    method: string,
    htu: string,
  ): "accepted" | "replayed" | "key_capacity" | "domain_capacity" {
    for (const [key, record] of replayClaims) {
      if (record.expiresAt <= now) replayClaims.delete(key);
    }
    const replayKey = base64url(
      sha256(
        `${securityDomain}\0${proof.jkt}\0${method}\0${normalizeHtu(htu)}\0${String(proof.payload.jti)}`,
      ),
    );
    if (replayClaims.has(replayKey)) return "replayed";
    const sameDomain = [...replayClaims.values()].filter(
      (record) => record.securityDomain === securityDomain,
    );
    if (sameDomain.length >= 1_000_000) return "domain_capacity";
    if (sameDomain.filter((record) => record.jkt === proof.jkt).length >= 256) {
      return "key_capacity";
    }
    replayClaims.set(replayKey, { expiresAt: now + 65, securityDomain, jkt: proof.jkt });
    return "accepted";
  }

  function rawHeaderValues(request: IncomingMessage, name: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
        const value = request.rawHeaders[index + 1];
        if (value !== undefined) values.push(value);
      }
    }
    return values;
  }

  function rawHeaderByteLength(request: IncomingMessage): number {
    let total = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index] ?? "";
      const value = request.rawHeaders[index + 1] ?? "";
      total += Buffer.byteLength(name, "latin1") + Buffer.byteLength(value, "latin1") + 4;
    }
    return total;
  }

  function noStoreJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    json(response, status, body, { "cache-control": "no-store", ...headers });
  }

  function protectedChallenge(
    response: ServerResponse,
    error: "use_dpop_nonce" | "invalid_dpop_proof" | "invalid_token",
    nonce?: string,
  ): void {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "www-authenticate": `DPoP error="${error}"`,
    };
    if (nonce !== undefined) headers["dpop-nonce"] = nonce;
    response.writeHead(401, headers);
    response.end();
  }

  function validateAccessToken(token: string): TokenRecord | undefined {
    const record = tokens.get(token);
    if (record === undefined || record.revoked || record.expiresAt <= now) return undefined;
    const segments = token.split(".");
    if (segments.length !== 3) return undefined;
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      return undefined;
    }
    try {
      if (
        !cryptoVerify(
          "sha256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
          { key: issuerPublicKey, dsaEncoding: "ieee-p1363" },
          decodeBase64url(encodedSignature),
        )
      ) {
        return undefined;
      }
      const payload = parseStrictJson(decodeBase64url(encodedPayload), 4, 16) as Record<
        string,
        unknown
      >;
      if (
        payload.iss !== V2_ISSUER ||
        payload.sub !== record.agentId ||
        payload.iat !== record.issuedAt ||
        payload.exp !== record.expiresAt ||
        payload.jti !== record.tokenId ||
        !Array.isArray(payload.aud) ||
        payload.aud.length !== 2 ||
        payload.aud[0] !== V2_API_AUDIENCE ||
        payload.aud[1] !== V2_MCP_AUDIENCE ||
        payload.cnf === null ||
        typeof payload.cnf !== "object" ||
        Array.isArray(payload.cnf) ||
        (payload.cnf as Record<string, unknown>).jkt !== record.jkt
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return record;
  }

  function validateIssuanceProof(
    request: IncomingMessage,
    response: ServerResponse,
    expectedHtu: string,
  ): string | undefined {
    const proofHeaders = rawHeaderValues(request, "dpop");
    if (rawHeaderValues(request, "authorization").length !== 0 || proofHeaders.length !== 1) {
      noStoreJson(response, 400, { error: "invalid_dpop_proof" });
      return undefined;
    }
    let proof: ParsedProof;
    try {
      proof = parseProof(proofHeaders[0] ?? "", false);
      if (!proofClaimsAreValid(proof, "POST", expectedHtu)) throw new Error("invalid claims");
    } catch {
      noStoreJson(response, 400, { error: "invalid_dpop_proof" });
      return undefined;
    }
    if (proof.payload.nonce === undefined) {
      noStoreJson(
        response,
        400,
        { error: "use_dpop_nonce" },
        { "dpop-nonce": makeNonce("issuance", V2_ISSUANCE_DOMAIN, [proof.jkt]) },
      );
      return undefined;
    }
    if (
      typeof proof.payload.nonce !== "string" ||
      !nonceIsValid(proof.payload.nonce, "issuance", V2_ISSUANCE_DOMAIN, [proof.jkt])
    ) {
      noStoreJson(response, 400, { error: "invalid_dpop_proof" });
      return undefined;
    }
    const replay = claimReplay(V2_ISSUANCE_DOMAIN, proof, "POST", expectedHtu);
    if (replay === "key_capacity") {
      noStoreJson(response, 429, { error: "dpop_rate_limited" }, { "retry-after": "1" });
      return undefined;
    }
    if (replay === "domain_capacity") {
      noStoreJson(response, 503, { error: "temporarily_unavailable" });
      return undefined;
    }
    if (replay === "replayed") {
      noStoreJson(response, 400, { error: "invalid_dpop_proof" });
      return undefined;
    }
    if (now - nonceIssuedAt(proof.payload.nonce) >= 240) {
      response.setHeader("dpop-nonce", makeNonce("issuance", V2_ISSUANCE_DOMAIN, [proof.jkt]));
    }
    return proof.jkt;
  }

  function authenticateProtected(
    request: IncomingMessage,
    response: ServerResponse,
    expectedHtu: string,
    scope: "api" | "mcp",
  ): ProtectedIdentity | undefined {
    const authorizationHeaders = rawHeaderValues(request, "authorization");
    if (authorizationHeaders.length !== 1) {
      protectedChallenge(response, "invalid_token");
      return undefined;
    }
    const authorization = authorizationHeaders[0] ?? "";
    if (Buffer.byteLength(authorization, "ascii") > 4_101 || !authorization.startsWith("DPoP ")) {
      protectedChallenge(response, "invalid_token");
      return undefined;
    }
    const tokenValue = authorization.slice(5);
    if (Buffer.byteLength(tokenValue, "ascii") > 4_096 || tokenValue.length === 0) {
      protectedChallenge(response, "invalid_token");
      return undefined;
    }
    const token = validateAccessToken(tokenValue);
    if (token === undefined) {
      protectedChallenge(response, "invalid_token");
      return undefined;
    }
    const proofHeaders = rawHeaderValues(request, "dpop");
    if (proofHeaders.length !== 1 || Buffer.byteLength(proofHeaders[0] ?? "", "ascii") > 4_096) {
      protectedChallenge(response, "invalid_dpop_proof");
      return undefined;
    }
    let proof: ParsedProof;
    try {
      proof = parseProof(proofHeaders[0] ?? "", true);
      if (
        proof.jkt !== token.jkt ||
        !proofClaimsAreValid(proof, request.method ?? "", expectedHtu, tokenValue)
      ) {
        throw new Error("invalid protected proof");
      }
    } catch {
      protectedChallenge(response, "invalid_dpop_proof");
      return undefined;
    }
    const agent = agentsById.get(token.agentId);
    if (agent === undefined) {
      protectedChallenge(response, "invalid_token");
      return undefined;
    }
    if (proof.payload.nonce === undefined) {
      const domain = scope === "api" ? V2_API_DOMAIN : V2_MCP_DOMAIN;
      protectedChallenge(
        response,
        "use_dpop_nonce",
        makeNonce("resource", domain, [agent.id, proof.jkt]),
      );
      return undefined;
    }
    const domain = scope === "api" ? V2_API_DOMAIN : V2_MCP_DOMAIN;
    if (
      typeof proof.payload.nonce !== "string" ||
      !nonceIsValid(proof.payload.nonce, "resource", domain, [agent.id, proof.jkt])
    ) {
      protectedChallenge(response, "invalid_dpop_proof");
      return undefined;
    }
    const replay = claimReplay(domain, proof, request.method ?? "", expectedHtu);
    if (replay === "key_capacity") {
      noStoreJson(response, 429, { error: "dpop_rate_limited" }, { "retry-after": "1" });
      return undefined;
    }
    if (replay === "domain_capacity") {
      noStoreJson(response, 503, { error: "temporarily_unavailable" });
      return undefined;
    }
    if (replay === "replayed") {
      protectedChallenge(response, "invalid_dpop_proof");
      return undefined;
    }
    if (now - nonceIssuedAt(proof.payload.nonce) >= 240) {
      response.setHeader("dpop-nonce", makeNonce("resource", domain, [agent.id, proof.jkt]));
    }
    return { agent, token };
  }

  resetV2State();

  function applicationError(
    status: number,
    code: string,
    retryAfterMs: number | null = null,
  ): CoreResult {
    return { status, body: { error: { code, retry_after_ms: retryAfterMs } } };
  }

  function validBoundedString(
    value: unknown,
    minimum: number,
    maximumCharacters: number,
    maximumBytes = maximumCharacters,
  ): value is string {
    return (
      typeof value === "string" &&
      value.length >= minimum &&
      value.length <= maximumCharacters &&
      Buffer.byteLength(value, "utf8") <= maximumBytes &&
      value.trim() === value &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    );
  }

  function validEmail(value: unknown): value is string {
    return (
      validBoundedString(value, 3, 254) &&
      Buffer.byteLength(value, "utf8") <= 254 &&
      EMAIL.test(value)
    );
  }

  function validUsername(value: unknown): value is string {
    return validBoundedString(value, 3, 50, 200);
  }

  function payloadText(value: unknown): string | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const payload = value as Record<string, unknown>;
    if (!exactKeys(payload, ["text"])) return undefined;
    if (typeof payload.text !== "string") return undefined;
    const size = Buffer.byteLength(payload.text, "utf8");
    if (size < 1 || size > 262_144) return undefined;
    return payload.text;
  }

  function objectValue(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  function listActionTypes(agent: V2Agent, input: Record<string, unknown>): CoreResult {
    if (!exactKeys(input, []) || !agent.verified) {
      return applicationError(400, "invalid_request");
    }
    return { status: 200, body: { action_types: ["fixture.echo"] } };
  }

  function requestPermission(agent: V2Agent, input: Record<string, unknown>): CoreResult {
    const scope =
      input.scope === undefined || input.scope === null ? null : objectValue(input.scope);
    if (
      !exactKeys(input, ["target_username", "action_type"], ["scope"]) ||
      !validUsername(input.target_username) ||
      input.action_type !== "fixture.echo" ||
      scope === undefined
    ) {
      return applicationError(400, "invalid_request");
    }
    const target = agentsByUsername.get(input.target_username);
    if (target === undefined || !target.verified) {
      return applicationError(404, "permission_not_found");
    }
    const permissionId = `permission_fixture_${(permissionSequence++).toString().padStart(6, "0")}`;
    permissionsV2.set(permissionId, {
      id: permissionId,
      requesterAgentId: agent.id,
      targetAgentId: target.id,
      actionType: input.action_type,
      scope,
      status: "pending",
    });
    return { status: 200, body: { permission_id: permissionId, status: "pending" } };
  }

  function respondToPermission(agent: V2Agent, input: Record<string, unknown>): CoreResult {
    if (
      !exactKeys(input, ["permission_id", "decision"]) ||
      typeof input.permission_id !== "string" ||
      !URI_UNRESERVED_ID.test(input.permission_id) ||
      (input.decision !== "granted" && input.decision !== "denied")
    ) {
      return applicationError(400, "invalid_request");
    }
    const permission = permissionsV2.get(input.permission_id);
    if (permission === undefined || permission.targetAgentId !== agent.id) {
      return applicationError(404, "permission_not_found");
    }
    if (permission.status !== "pending" && permission.status !== input.decision) {
      return applicationError(409, "idempotency_conflict");
    }
    permission.status = input.decision;
    return {
      status: 200,
      body: { permission_id: permission.id, status: permission.status },
    };
  }

  function getMyPermissions(agent: V2Agent, input: Record<string, unknown>): CoreResult {
    if (!exactKeys(input, [], ["status"])) return applicationError(400, "invalid_request");
    const status = input.status ?? "all";
    if (status !== "all" && status !== "pending" && status !== "granted" && status !== "denied") {
      return applicationError(400, "invalid_request");
    }
    const permissions = [...permissionsV2.values()]
      .filter(
        (permission) =>
          permission.requesterAgentId === agent.id &&
          (status === "all" || permission.status === status),
      )
      .map((permission) => ({
        permission_id: permission.id,
        target_username: agentsById.get(permission.targetAgentId)?.username ?? "",
        action_type: permission.actionType,
        scope: permission.scope,
        status: permission.status,
      }));
    return { status: 200, body: { permissions } };
  }

  function callAction(agent: V2Agent, input: Record<string, unknown>): CoreResult {
    if (
      !exactKeys(input, ["target_username", "action_type", "payload"]) ||
      !validUsername(input.target_username) ||
      input.action_type !== "fixture.echo" ||
      objectValue(input.payload) === undefined
    ) {
      return applicationError(400, "invalid_request");
    }
    const target = agentsByUsername.get(input.target_username);
    const permission = [...permissionsV2.values()].find(
      (record) =>
        target !== undefined &&
        record.requesterAgentId === agent.id &&
        record.targetAgentId === target.id &&
        record.actionType === input.action_type &&
        record.status === "granted",
    );
    if (target === undefined || permission === undefined) {
      return applicationError(404, "action_not_authorized");
    }
    const actionId = `action_fixture_${(actionSequence++).toString().padStart(6, "0")}`;
    return { status: 200, body: { action_id: actionId, status: "queued" } };
  }

  function createMessage(
    senderAgentId: string,
    recipientAgentId: string,
    conversationId: string,
    text: string,
    inReplyToMessageId: string | null,
  ): MessageRecordV2 {
    const message: ConversationMessage = {
      id: nextMessageId(),
      conversation_id: conversationId,
      sender_agent_id: senderAgentId,
      message_type: "conversation_turn",
      in_reply_to_message_id: inReplyToMessageId,
      payload: { text },
      created_at: new Date(now * 1_000).toISOString(),
    };
    const record: MessageRecordV2 = {
      message,
      recipientAgentId,
      leaseUntil: null,
      terminal: null,
      acknowledged: false,
    };
    messagesV2.set(message.id, record);
    return record;
  }

  function activateDelivery(agent: V2Agent): CoreResult {
    if (agent.deliveryVersion === "v2") {
      return { status: 200, body: { delivery_version: "v2", status: "active" } };
    }
    if (agent.legacyMigrationBlocked) return applicationError(409, "migration_incomplete");
    agent.deliveryVersion = "v2";
    return { status: 200, body: { delivery_version: "v2", status: "active" } };
  }

  function startConversation(agent: V2Agent, input: Record<string, unknown>): CoreResult {
    if (!exactKeys(input, ["recipient_username", "payload", "request_id"])) {
      return applicationError(400, "invalid_request");
    }
    if (!validUsername(input.recipient_username) || typeof input.request_id !== "string") {
      return applicationError(400, "invalid_request");
    }
    const text = payloadText(input.payload);
    if (text === undefined || !UUID_V4.test(input.request_id)) {
      return applicationError(400, "invalid_request");
    }
    pruneIdempotencyRecords();
    const key = `${agent.id}\0${input.request_id}`;
    const existing = starts.get(key);
    if (existing !== undefined) {
      if (
        existing.recipientUsername !== input.recipient_username ||
        existing.fingerprint !== fingerprint(existing.recipientAgentId, text)
      ) {
        return applicationError(409, "idempotency_conflict");
      }
      return {
        status: 200,
        body: {
          message_id: existing.messageId,
          conversation_id: existing.conversationId,
          status: "accepted",
        },
      };
    }
    const namespace = idempotencyNamespaces.get(input.request_id);
    if (namespace?.operation === "reissue") {
      return applicationError(409, "idempotency_conflict");
    }
    const recipient = agentsByUsername.get(input.recipient_username);
    if (
      recipient === undefined ||
      recipient.deliveryVersion !== "v2" ||
      !recipient.grants.has(agent.id)
    ) {
      return applicationError(404, "recipient_unavailable");
    }
    const requestFingerprint = fingerprint(recipient.id, text);
    const conversationId = nextConversationId();
    const message = createMessage(agent.id, recipient.id, conversationId, text, null);
    starts.set(key, {
      senderAgentId: agent.id,
      requestId: input.request_id,
      recipientAgentId: recipient.id,
      recipientUsername: recipient.username,
      fingerprint: requestFingerprint,
      messageId: message.message.id,
      conversationId,
      createdAt: now,
    });
    idempotencyNamespaces.set(input.request_id, {
      operation: "start",
      expiresAt: Math.max(namespace?.expiresAt ?? 0, now + START_RECORD_SECONDS),
    });
    return {
      status: 201,
      body: {
        message_id: message.message.id,
        conversation_id: conversationId,
        status: "accepted",
      },
    };
  }

  function getConversationStart(agent: V2Agent, requestId: string): CoreResult {
    if (!UUID_V4.test(requestId)) return applicationError(400, "invalid_request");
    const key = `${agent.id}\0${requestId}`;
    const record = starts.get(key);
    if (record !== undefined && record.createdAt + START_RECORD_SECONDS <= now) {
      starts.delete(key);
    }
    const current = starts.get(key);
    if (current === undefined) {
      return {
        status: 200,
        body: {
          request_id: requestId,
          status: "not_found",
          message_id: null,
          conversation_id: null,
        },
      };
    }
    return {
      status: 200,
      body: {
        request_id: requestId,
        status: "accepted",
        message_id: current.messageId,
        conversation_id: current.conversationId,
      },
    };
  }

  function receiveMessages(agent: V2Agent, timeout: number, limit: number): CoreResult {
    if (agent.deliveryVersion !== "v2") return applicationError(409, "protocol_mismatch");
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30) {
      return applicationError(400, "invalid_request");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return applicationError(400, "invalid_request");
    }
    const eligible = [...messagesV2.values()]
      .filter(
        (record) =>
          record.recipientAgentId === agent.id &&
          !record.acknowledged &&
          (record.leaseUntil === null || record.leaseUntil <= now),
      )
      .sort((left, right) => {
        const byTime = left.message.created_at.localeCompare(right.message.created_at);
        return byTime === 0 ? left.message.id.localeCompare(right.message.id) : byTime;
      });
    const selected: MessageRecordV2[] = [];
    for (const candidate of eligible) {
      if (selected.length >= limit) break;
      const nextMessages = [...selected.map((record) => record.message), candidate.message];
      if (
        Buffer.byteLength(JSON.stringify({ messages: nextMessages }), "utf8") > MAX_RECEIVE_BYTES
      ) {
        if (selected.length === 0) return applicationError(503, "temporarily_unavailable");
        break;
      }
      selected.push(candidate);
    }
    for (const record of selected) record.leaseUntil = now + LEASE_SECONDS;
    return { status: 200, body: { messages: selected.map((record) => record.message) } };
  }

  function replyMessage(
    agent: V2Agent,
    messageId: string,
    input: Record<string, unknown>,
    idempotencyKey: string | undefined,
  ): CoreResult {
    if (!URI_UNRESERVED_ID.test(messageId) || !exactKeys(input, ["payload"])) {
      return applicationError(400, "invalid_request");
    }
    const text = payloadText(input.payload);
    if (text === undefined) return applicationError(400, "invalid_request");
    const expectedKey = `reply.v1.${base64url(sha256(messageId))}`;
    if (idempotencyKey !== expectedKey) return applicationError(400, "invalid_request");
    const record = messagesV2.get(messageId);
    if (record === undefined || record.recipientAgentId !== agent.id) {
      return applicationError(404, "message_not_found");
    }
    const replyFingerprint = fingerprint(text);
    if (record.terminal?.kind === "replied") {
      if (record.terminal.fingerprint !== replyFingerprint) {
        return applicationError(409, "idempotency_conflict");
      }
      return {
        status: 200,
        body: {
          message_id: record.terminal.replyMessageId,
          conversation_id: record.message.conversation_id,
          status: "accepted",
        },
      };
    }
    if (record.terminal !== null) return applicationError(409, "message_already_terminal");
    const reply = createMessage(
      agent.id,
      record.message.sender_agent_id,
      record.message.conversation_id,
      text,
      record.message.id,
    );
    record.terminal = {
      kind: "replied",
      replyMessageId: reply.message.id,
      fingerprint: replyFingerprint,
    };
    return {
      status: 200,
      body: {
        message_id: reply.message.id,
        conversation_id: record.message.conversation_id,
        status: "accepted",
      },
    };
  }

  const completionReasons: Record<string, readonly string[]> = {
    completed_without_reply: ["no_reply_required"],
    unsupported: ["unsupported_message_type", "unsupported_payload"],
    failed: ["provider_start_failed", "provider_execution_failed", "provider_result_invalid"],
    cancelled: ["cancelled_before_execution", "cancelled_during_safe_wait"],
    uncertain: ["provider_outcome_unknown"],
  };

  function completeMessage(
    agent: V2Agent,
    messageId: string,
    input: Record<string, unknown>,
  ): CoreResult {
    if (
      !URI_UNRESERVED_ID.test(messageId) ||
      !exactKeys(input, ["outcome", "reason_code"]) ||
      typeof input.outcome !== "string" ||
      typeof input.reason_code !== "string" ||
      !completionReasons[input.outcome]?.includes(input.reason_code)
    ) {
      return applicationError(400, "invalid_request");
    }
    const record = messagesV2.get(messageId);
    if (record === undefined || record.recipientAgentId !== agent.id) {
      return applicationError(404, "message_not_found");
    }
    if (record.terminal?.kind === "replied") {
      return applicationError(409, "message_already_terminal");
    }
    if (record.terminal?.kind === "completed") {
      if (
        record.terminal.outcome !== input.outcome ||
        record.terminal.reasonCode !== input.reason_code
      ) {
        return applicationError(409, "idempotency_conflict");
      }
    } else {
      record.terminal = {
        kind: "completed",
        outcome: input.outcome,
        reasonCode: input.reason_code,
      };
    }
    return {
      status: 200,
      body: { message_id: messageId, outcome: input.outcome, status: "recorded" },
    };
  }

  function messageOutcome(agent: V2Agent, messageId: string): CoreResult {
    if (!URI_UNRESERVED_ID.test(messageId)) return applicationError(400, "invalid_request");
    const record = messagesV2.get(messageId);
    if (
      record === undefined ||
      (record.recipientAgentId !== agent.id && record.message.sender_agent_id !== agent.id)
    ) {
      return applicationError(404, "message_not_found");
    }
    if (record.terminal === null) {
      return {
        status: 200,
        body: {
          message_id: messageId,
          conversation_id: record.message.conversation_id,
          status: "open",
          outcome: null,
          reply_message_id: null,
        },
      };
    }
    return {
      status: 200,
      body: {
        message_id: messageId,
        conversation_id: record.message.conversation_id,
        status: "terminal",
        outcome: record.terminal.kind === "replied" ? "replied" : record.terminal.outcome,
        reply_message_id:
          record.terminal.kind === "replied" ? record.terminal.replyMessageId : null,
      },
    };
  }

  function acknowledgeMessage(agent: V2Agent, messageId: string): CoreResult {
    if (!URI_UNRESERVED_ID.test(messageId)) return applicationError(400, "invalid_request");
    const record = messagesV2.get(messageId);
    if (record === undefined || record.recipientAgentId !== agent.id) {
      return applicationError(404, "message_not_found");
    }
    if (record.terminal === null) return applicationError(409, "message_not_terminal");
    record.acknowledged = true;
    record.leaseUntil = null;
    return { status: 200, body: { message_id: messageId, status: "acked" } };
  }

  function requestHasJsonContentType(request: IncomingMessage): boolean {
    const values = rawHeaderValues(request, "content-type");
    if (values.length !== 1) return false;
    return /^application\/json(?:;\s*charset=utf-8)?$/iu.test(values[0] ?? "");
  }

  function beginOperation(
    operation: V2FaultOperation,
    response: ServerResponse,
    protectedApplication: boolean,
  ): { dropAfterCommit: boolean } | undefined {
    const faults = nextFaults.get(operation);
    const fault = faults?.shift();
    if (faults?.length === 0) nextFaults.delete(operation);
    if (fault === "temporarily_unavailable") {
      const body = protectedApplication
        ? { error: { code: "temporarily_unavailable", retry_after_ms: null } }
        : { error: { code: "temporarily_unavailable" } };
      noStoreJson(response, 503, body);
      return undefined;
    }
    if (fault === "rate_limited") {
      const body = protectedApplication
        ? { error: { code: "rate_limited", retry_after_ms: 1_001 } }
        : { error: { code: "rate_limited" } };
      noStoreJson(response, 429, body, { "retry-after": "2" });
      return undefined;
    }
    return { dropAfterCommit: fault === "drop_after_commit" };
  }

  function finishOperation(
    response: ServerResponse,
    operation: { dropAfterCommit: boolean },
    result: CoreResult,
    headers: Record<string, string> = {},
  ): void {
    if (operation.dropAfterCommit && result.status >= 200 && result.status < 300) {
      response.socket?.destroy();
      return;
    }
    noStoreJson(response, result.status, result.body, headers);
  }

  async function bootstrapObject(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!requestHasJsonContentType(request)) throw new Error("invalid content type");
    return await readObject(request, 2_048, 16, 128);
  }

  async function protectedObject(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!requestHasJsonContentType(request)) throw new Error("invalid content type");
    return await readObject(request, 524_288, 100, 16_384);
  }

  function bootstrapHeadersAreSafe(request: IncomingMessage, verification: boolean): boolean {
    if (rawHeaderValues(request, "authorization").length !== 0) return false;
    const proofCount = rawHeaderValues(request, "dpop").length;
    return verification ? proofCount === 1 : proofCount === 0;
  }

  async function handleRegister(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const operation = beginOperation("register", response, false);
    if (operation === undefined) return;
    if (!bootstrapHeadersAreSafe(request, false)) {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    let input: Record<string, unknown>;
    try {
      input = await bootstrapObject(request);
    } catch {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    if (
      !exactKeys(input, ["email", "username"], ["display_name"]) ||
      !validEmail(input.email) ||
      !validUsername(input.username) ||
      (input.display_name !== undefined && !validBoundedString(input.display_name, 1, 128, 512))
    ) {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    if (agentsByEmail.has(input.email) || agentsByUsername.has(input.username)) {
      finishOperation(response, operation, {
        status: 409,
        body: { error: { code: "registration_conflict" } },
      });
      return;
    }
    const agent: V2Agent = {
      id: nextAgentId(),
      username: input.username,
      email: input.email,
      verified: false,
      deliveryVersion: "v1",
      grants: new Set<string>(),
      legacyMigrationBlocked: false,
    };
    addAgent(agent);
    codes.set(agent.email, { purpose: "enrollment", expiresAt: now + 600 });
    finishOperation(response, operation, {
      status: 200,
      body: {
        agent_id: agent.id,
        username: agent.username,
        email: agent.email,
        message: "Verification code sent.",
      },
    });
  }

  async function handleResend(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const operation = beginOperation("resend", response, false);
    if (operation === undefined) return;
    if (!bootstrapHeadersAreSafe(request, false)) {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    let input: Record<string, unknown>;
    try {
      input = await bootstrapObject(request);
    } catch {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    if (!exactKeys(input, ["email"]) || !validEmail(input.email)) {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    const agent = agentsByEmail.get(input.email);
    if (agent !== undefined) {
      codes.set(agent.email, {
        purpose: agent.verified ? "recovery" : "enrollment",
        expiresAt: now + 600,
      });
    }
    finishOperation(response, operation, {
      status: 200,
      body: { message: "Verification code resent." },
    });
  }

  async function handleVerify(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!bootstrapHeadersAreSafe(request, true)) {
      noStoreJson(response, 400, { error: "invalid_dpop_proof" });
      return;
    }
    const jkt = validateIssuanceProof(request, response, `${baseUrl}/api/verify_email`);
    if (jkt === undefined) return;
    const operation = beginOperation("verify", response, false);
    if (operation === undefined) return;
    let input: Record<string, unknown>;
    try {
      input = await bootstrapObject(request);
    } catch {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    if (
      !exactKeys(input, ["email", "code"]) ||
      !validEmail(input.email) ||
      typeof input.code !== "string" ||
      !/^[A-Za-z0-9]{6}$/u.test(input.code)
    ) {
      finishOperation(response, operation, {
        status: 422,
        body: { error: { code: "invalid_request" } },
      });
      return;
    }
    const agent = agentsByEmail.get(input.email);
    const code = codes.get(input.email);
    if (
      agent === undefined ||
      code === undefined ||
      code.expiresAt <= now ||
      input.code !== V2_VERIFICATION_CODE ||
      (agent.verified && code.purpose !== "recovery") ||
      (!agent.verified && code.purpose !== "enrollment")
    ) {
      finishOperation(response, operation, {
        status: 400,
        body: { error: { code: "verification_failed" } },
      });
      return;
    }
    if (code.purpose === "recovery") {
      for (const record of tokens.values()) {
        if (record.agentId === agent.id) record.revoked = true;
      }
      for (const record of legacyBearerTokens.values()) {
        if (record.agentId === agent.id) record.revoked = true;
      }
    }
    agent.verified = true;
    codes.delete(agent.email);
    const token = issueToken(agent, jkt);
    finishOperation(response, operation, {
      status: 200,
      body: {
        agent_id: agent.id,
        username: agent.username,
        token,
        token_type: "DPoP",
        expires_in: TOKEN_LIFETIME_SECONDS,
        message: "Email verified successfully.",
      },
    });
  }

  async function handleV2Rest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const bootstrapPath =
      url.pathname === "/api/register" ||
      url.pathname === "/api/resend_verification" ||
      url.pathname === "/api/verify_email";
    const isV2Path = url.pathname.startsWith("/api/v2/");
    if (!bootstrapPath && !isV2Path) return false;
    if (rawHeaderByteLength(request) > 16_384) {
      if (isV2Path) protectedChallenge(response, "invalid_token");
      else {
        noStoreJson(response, 422, { error: { code: "invalid_request" } });
      }
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/register") {
      await handleRegister(request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/resend_verification") {
      await handleResend(request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/verify_email") {
      await handleVerify(request, response);
      return true;
    }

    if (!isV2Path) return false;
    const identity = authenticateProtected(request, response, `${baseUrl}${url.pathname}`, "api");
    if (identity === undefined) return true;

    if (request.method === "POST" && url.pathname === "/api/v2/delivery/activate") {
      const operation = beginOperation("activate", response, true);
      if (operation === undefined) return true;
      try {
        if ((await readBytes(request, 1)).byteLength !== 0) throw new Error("body not empty");
      } catch {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      finishOperation(response, operation, activateDelivery(identity.agent));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/v2/conversations") {
      const operation = beginOperation("start", response, true);
      if (operation === undefined) return true;
      const keys = rawHeaderValues(request, "idempotency-key");
      let input: Record<string, unknown>;
      try {
        input = await protectedObject(request);
      } catch {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      if (keys.length !== 1 || !UUID_V4.test(keys[0] ?? "")) {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      finishOperation(
        response,
        operation,
        startConversation(identity.agent, { ...input, request_id: keys[0] }),
      );
      return true;
    }

    const startLookup = /^\/api\/v2\/conversation-starts\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && startLookup !== null) {
      const operation = beginOperation("start_lookup", response, true);
      if (operation === undefined) return true;
      finishOperation(
        response,
        operation,
        getConversationStart(identity.agent, startLookup[1] ?? ""),
      );
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/v2/messages/receive") {
      const operation = beginOperation("receive", response, true);
      if (operation === undefined) return true;
      if (
        [...url.searchParams.keys()].some((key) => key !== "timeout" && key !== "limit") ||
        url.searchParams.getAll("timeout").length !== 1 ||
        url.searchParams.getAll("limit").length !== 1
      ) {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      const timeout = Number(url.searchParams.get("timeout"));
      const limit = Number(url.searchParams.get("limit"));
      finishOperation(response, operation, receiveMessages(identity.agent, timeout, limit));
      return true;
    }

    const messageRoute = /^\/api\/v2\/messages\/([^/]+)\/(reply|complete|outcome|ack)$/u.exec(
      url.pathname,
    );
    if (messageRoute !== null) {
      const messageId = messageRoute[1] ?? "";
      const action = messageRoute[2];
      if (request.method === "POST" && action === "reply") {
        const operation = beginOperation("reply", response, true);
        if (operation === undefined) return true;
        let input: Record<string, unknown>;
        try {
          input = await protectedObject(request);
        } catch {
          finishOperation(response, operation, applicationError(400, "invalid_request"));
          return true;
        }
        const keys = rawHeaderValues(request, "idempotency-key");
        finishOperation(
          response,
          operation,
          replyMessage(identity.agent, messageId, input, keys.length === 1 ? keys[0] : undefined),
        );
        return true;
      }
      if (request.method === "POST" && action === "complete") {
        const operation = beginOperation("complete", response, true);
        if (operation === undefined) return true;
        let input: Record<string, unknown>;
        try {
          input = await protectedObject(request);
        } catch {
          finishOperation(response, operation, applicationError(400, "invalid_request"));
          return true;
        }
        finishOperation(response, operation, completeMessage(identity.agent, messageId, input));
        return true;
      }
      if (request.method === "GET" && action === "outcome") {
        const operation = beginOperation("outcome", response, true);
        if (operation === undefined) return true;
        finishOperation(response, operation, messageOutcome(identity.agent, messageId));
        return true;
      }
      if (request.method === "POST" && action === "ack") {
        const operation = beginOperation("ack", response, true);
        if (operation === undefined) return true;
        try {
          if ((await readBytes(request, 1)).byteLength !== 0) throw new Error("body not empty");
        } catch {
          finishOperation(response, operation, applicationError(400, "invalid_request"));
          return true;
        }
        finishOperation(response, operation, acknowledgeMessage(identity.agent, messageId));
        return true;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/v2/token/reissue") {
      const operation = beginOperation("reissue", response, true);
      if (operation === undefined) return true;
      const keys = rawHeaderValues(request, "idempotency-key");
      let input: Record<string, unknown>;
      try {
        input = await protectedObject(request);
      } catch {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      if (!exactKeys(input, []) || keys.length !== 1 || !UUID_V4.test(keys[0] ?? "")) {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      pruneIdempotencyRecords();
      const requestId = keys[0] ?? "";
      const namespace = idempotencyNamespaces.get(requestId);
      if (
        namespace?.operation === "start" ||
        (namespace?.operation === "reissue" && namespace.agentId !== identity.agent.id)
      ) {
        finishOperation(response, operation, applicationError(409, "idempotency_conflict"));
        return true;
      }
      const key = `${identity.agent.id}\0${requestId}`;
      const existing = reissues.get(key);
      if (existing !== undefined) {
        finishOperation(response, operation, {
          status: 200,
          body: { token: existing.token, token_type: "DPoP", expires_in: TOKEN_LIFETIME_SECONDS },
        });
        return true;
      }
      const retainedForIdentity = [...reissues.values()].filter(
        (record) => record.agentId === identity.agent.id,
      );
      const newKeysInDay = retainedForIdentity.filter(
        (record) => record.createdAt > now - TOKEN_LIFETIME_SECONDS,
      ).length;
      if (retainedForIdentity.length >= 8 || newKeysInDay >= 4) {
        finishOperation(response, operation, applicationError(429, "rate_limited", 1_000), {
          "retry-after": "1",
        });
        return true;
      }
      const activeForKey = [...tokens.values()].filter(
        (record) =>
          record.agentId === identity.agent.id &&
          record.jkt === identity.token.jkt &&
          !record.revoked &&
          record.expiresAt > now,
      );
      if (activeForKey.length >= 3) {
        finishOperation(response, operation, applicationError(429, "rate_limited", 1_000), {
          "retry-after": "1",
        });
        return true;
      }
      const token = issueToken(identity.agent, identity.token.jkt);
      reissues.set(key, { agentId: identity.agent.id, token, createdAt: now });
      idempotencyNamespaces.set(requestId, {
        operation: "reissue",
        agentId: identity.agent.id,
        expiresAt: now + START_RECORD_SECONDS,
      });
      finishOperation(response, operation, {
        status: 200,
        body: { token, token_type: "DPoP", expires_in: TOKEN_LIFETIME_SECONDS },
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/v2/token/revoke") {
      const operation = beginOperation("revoke", response, true);
      if (operation === undefined) return true;
      let input: Record<string, unknown>;
      try {
        input = await protectedObject(request);
      } catch {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      if (!exactKeys(input, ["scope"]) || input.scope !== "identity") {
        finishOperation(response, operation, applicationError(400, "invalid_request"));
        return true;
      }
      for (const token of tokens.values()) {
        if (token.agentId === identity.agent.id) token.revoked = true;
      }
      if (operation.dropAfterCommit) response.socket?.destroy();
      else {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
      }
      return true;
    }

    noStoreJson(response, 404, { error: { code: "message_not_found", retry_after_ms: null } });
    return true;
  }

  function mcpFailure(id: unknown, code: string): Record<string, unknown> {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32_002, message: "operation failed", data: { code } },
    };
  }

  async function handleV2Mcp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (request.method !== "POST" || url.pathname !== "/mcp") return false;
    const authorization = rawHeaderValues(request, "authorization");
    const bearerValue = authorization.length === 1 ? authorization[0]?.slice(7) : undefined;
    const hasTransportCredential =
      rawHeaderValues(request, "dpop").length > 0 ||
      authorization.some((value) => value.startsWith("DPoP")) ||
      (authorization.length === 1 &&
        authorization[0]?.startsWith("Bearer ") === true &&
        bearerValue !== undefined &&
        tokens.has(bearerValue));
    if (!hasTransportCredential) return false;
    if (rawHeaderByteLength(request) > 16_384) {
      protectedChallenge(response, "invalid_token");
      return true;
    }
    const identity = authenticateProtected(request, response, `${baseUrl}/mcp`, "mcp");
    if (identity === undefined) return true;
    let message: Record<string, unknown>;
    try {
      message = await readObject(request);
    } catch {
      json(response, 400, mcpFailure(null, "invalid_request"), { "cache-control": "no-store" });
      return true;
    }
    const id = message.id;
    if (message.method === "initialize") {
      noStoreJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "a2a-central-fixture", version: "2" },
        },
      });
      return true;
    }
    if (message.method === "notifications/initialized") {
      response.writeHead(202, { "cache-control": "no-store" });
      response.end();
      return true;
    }
    if (message.method === "tools/list") {
      noStoreJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: { tools: v2Tools },
      });
      return true;
    }
    if (message.method !== "tools/call") {
      noStoreJson(response, 200, mcpFailure(id, "invalid_request"));
      return true;
    }
    const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
    const name = String(params?.name);
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    if (args === null || typeof args !== "object" || Array.isArray(args) || "token" in args) {
      noStoreJson(response, 200, mcpFailure(id, "invalid_request"));
      return true;
    }
    let result: CoreResult;
    if (name === "list_action_types") {
      result = listActionTypes(identity.agent, args);
    } else if (name === "request_permission") {
      result = requestPermission(identity.agent, args);
    } else if (name === "respond_to_permission") {
      result = respondToPermission(identity.agent, args);
    } else if (name === "call_action") {
      result = callAction(identity.agent, args);
    } else if (name === "get_my_permissions") {
      result = getMyPermissions(identity.agent, args);
    } else if (name === "start_conversation") {
      result = startConversation(identity.agent, args);
    } else if (
      name === "get_conversation_start" &&
      exactKeys(args, ["request_id"]) &&
      typeof args.request_id === "string"
    ) {
      result = getConversationStart(identity.agent, args.request_id);
    } else if (
      name === "receive_messages" &&
      exactKeys(args, ["timeout_seconds", "limit"]) &&
      typeof args.timeout_seconds === "number" &&
      typeof args.limit === "number"
    ) {
      result = receiveMessages(identity.agent, args.timeout_seconds, args.limit);
    } else if (
      name === "reply_message" &&
      exactKeys(args, ["message_id", "payload"]) &&
      typeof args.message_id === "string"
    ) {
      result = replyMessage(
        identity.agent,
        args.message_id,
        { payload: args.payload },
        `reply.v1.${base64url(sha256(args.message_id))}`,
      );
    } else if (
      name === "complete_message" &&
      exactKeys(args, ["message_id", "outcome", "reason_code"]) &&
      typeof args.message_id === "string"
    ) {
      result = completeMessage(identity.agent, args.message_id, {
        outcome: args.outcome,
        reason_code: args.reason_code,
      });
    } else if (
      name === "get_message_outcome" &&
      exactKeys(args, ["message_id"]) &&
      typeof args.message_id === "string"
    ) {
      result = messageOutcome(identity.agent, args.message_id);
    } else if (
      name === "ack_message" &&
      exactKeys(args, ["message_id"]) &&
      typeof args.message_id === "string"
    ) {
      result = acknowledgeMessage(identity.agent, args.message_id);
    } else {
      result = applicationError(400, "invalid_request");
    }
    const error = result.body.error as { code?: unknown } | undefined;
    noStoreJson(
      response,
      200,
      error === undefined ? toolResult(id, result.body) : mcpFailure(id, String(error.code)),
    );
    return true;
  }

  const server = createServer({ maxHeaderSize: 32_768 }, async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await handleV2Mcp(request, response, url)) return;
      if (await handleV2Rest(request, response, url)) return;
      if (rawHeaderByteLength(request) > 16_384) {
        response.writeHead(431);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/poll_messages") {
        pollCount += 1;
        if (!apiPollAvailable) {
          json(response, 404, { detail: "not found" });
          return;
        }
        const authorization = request.headers.authorization;
        const bearerToken = authorization?.startsWith("Bearer ")
          ? authorization.slice(7)
          : undefined;
        const legacyBearer =
          bearerToken === undefined ? undefined : legacyBearerTokens.get(bearerToken);
        if (
          authorization !== `Bearer ${CENTRAL_JWT}` &&
          (legacyBearer === undefined || legacyBearer.revoked || legacyBearer.expiresAt <= now)
        ) {
          json(response, 401, { detail: "unauthorized" });
          return;
        }
        if (url.searchParams.get("timeout") !== "30") {
          json(response, 422, { detail: "invalid query" });
          return;
        }
        const queued = [...messages.values()].filter(
          (message) => !message.delivered && !message.contentAcknowledged,
        );
        for (const message of queued) message.delivered = true;
        json(
          response,
          200,
          pollResponse ?? {
            messages: queued.map((message) => ({ id: message.id, content: message.content })),
          },
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/mcp") {
        if (!mcpAvailable) {
          json(response, 503, { detail: "unavailable" });
          return;
        }
        const message = await readObject(request);
        const id = message.id;
        if (message.method === "initialize") {
          json(response, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "a2a-central-fixture", version: "1" },
            },
          });
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
          return;
        }
        if (message.method === "tools/list") {
          json(response, 200, {
            jsonrpc: "2.0",
            id,
            result: {
              tools: tools.map((definition) => {
                const name = String((definition as { name?: unknown }).name);
                const description = toolDescriptions.get(name);
                return description === undefined
                  ? definition
                  : { ...(definition as Record<string, unknown>), description };
              }),
            },
          });
          return;
        }
        if (message.method === "tools/call") {
          const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
          const name = String(params?.name);
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          calls.push({ name, args: { ...args } });
          if (name === "register_agent") {
            if (!hasExactKeys(args, ["username", "email"], ["display_name"])) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_602, message: "invalid arguments" },
              });
              return;
            }
            json(
              response,
              200,
              toolResult(id, {
                agent_id: "agent_fixture",
                username: args.username,
                email: args.email,
                message: "Verification code sent.",
              }),
            );
            return;
          }
          if (name === "verify_email") {
            if (!hasExactKeys(args, ["email", "code"])) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_602, message: "invalid arguments" },
              });
              return;
            }
            if (args.code !== VERIFICATION_CODE) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_002, message: "verification failed" },
              });
              return;
            }
            const result =
              verificationResult ??
              ({
                agent_id: "agent_fixture",
                username: "fixture-agent",
                token: CENTRAL_JWT,
                message: "Email verified successfully.",
              } satisfies Record<string, unknown>);
            json(
              response,
              200,
              typeof result === "string"
                ? {
                    jsonrpc: "2.0",
                    id,
                    result: {
                      _meta: {},
                      content: [{ type: "text", text: result }],
                      structuredContent: { result },
                      isError: false,
                    },
                  }
                : toolResult(id, result),
            );
            return;
          }
          if (name === "resend_verification") {
            if (!hasExactKeys(args, ["email"])) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_602, message: "invalid arguments" },
              });
              return;
            }
            json(
              response,
              200,
              toolResult(id, {
                message: "Verification code resent.",
                token: CENTRAL_JWT,
              }),
            );
            return;
          }
          if (
            (name === "poll_messages" && !hasExactKeys(args, ["token"], ["timeout"])) ||
            (name === "ack_message" && !hasExactKeys(args, ["token", "message_id"]))
          ) {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32_602, message: "invalid arguments" },
            });
            return;
          }
          if (args.token !== CENTRAL_JWT) {
            json(response, 200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32_001, message: "authentication failed" },
            });
            return;
          }
          if (name === "poll_messages") {
            if (mcpPollMode === "authentication_failure") {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_001, message: "authentication failed" },
              });
              return;
            }
            const queued = [...messages.values()].filter(
              (item) => !item.delivered && !item.contentAcknowledged,
            );
            for (const item of queued) item.delivered = true;
            if (mcpPollMode === "credential_result") {
              json(
                response,
                200,
                toolResult(id, {
                  messages: queued.map((item) => ({ id: item.id, content: item.content })),
                  token: CENTRAL_JWT,
                }),
              );
              return;
            }
            if (mcpPollMode === "invalid_result") {
              json(response, 200, toolResult(id, { unexpected: true }));
              return;
            }
            json(
              response,
              200,
              toolResult(id, {
                messages: queued.map((item) => ({ id: item.id, content: item.content })),
              }),
            );
            return;
          }
          if (name === "ack_message") {
            if (acknowledgementMode === "disconnect") {
              request.socket.destroy();
              return;
            }
            if (acknowledgementMode === "mismatch") {
              json(
                response,
                200,
                toolResult(id, { message_id: "different-message", status: "acked" }),
              );
              return;
            }
            if (acknowledgementMode === "failure") {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_002, message: "acknowledgement failed" },
              });
              return;
            }
            const item = messages.get(String(args.message_id));
            if (item === undefined || !item.delivered || item.contentAcknowledged) {
              json(response, 200, {
                jsonrpc: "2.0",
                id,
                error: { code: -32_002, message: "message not found" },
              });
              return;
            }
            item.contentAcknowledged = true;
            json(response, 200, toolResult(id, { message_id: item.id, status: "acked" }));
            return;
          }
        }
      }

      json(response, 404, { detail: "not found" });
    } catch {
      json(response, 500, { detail: "fixture error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    apiUrl: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    jwt: CENTRAL_JWT,
    v2Issuer: V2_ISSUER,
    v2Audiences: [V2_API_AUDIENCE, V2_MCP_AUDIENCE],
    pollCount: () => pollCount,
    calls,
    setApiPollAvailable(available) {
      apiPollAvailable = available;
    },
    setMcpPollMode(mode) {
      mcpPollMode = mode;
    },
    setPollResponse(response) {
      pollResponse = response;
    },
    setMcpAvailable(available) {
      mcpAvailable = available;
    },
    setAcknowledgementMode(mode) {
      acknowledgementMode = mode;
    },
    setToolDescription(name, description) {
      if (description === undefined) toolDescriptions.delete(name);
      else toolDescriptions.set(name, description);
    },
    setVerificationResult(result) {
      verificationResult = result;
    },
    injectMessage(id, content) {
      messages.set(id, {
        id,
        content,
        delivered: false,
        contentAcknowledged: false,
      });
    },
    messageState(id) {
      const message = messages.get(id);
      assert.ok(message !== undefined);
      return { ...message };
    },
    createDpopClient() {
      const client = new FixtureDpopClientImpl(clientSequence, () => now, clientSequence * 1_000);
      clientSequence += 1;
      return client;
    },
    seedClient(username) {
      const client = seedClients.get(username);
      assert.ok(client !== undefined);
      return client;
    },
    seededLegacyBearer(username) {
      const agent = agentsByUsername.get(username);
      assert.ok(agent !== undefined && agent.deliveryVersion === "v1");
      const record = [...legacyBearerTokens.values()].find(
        (candidate) => candidate.agentId === agent.id,
      );
      assert.ok(record !== undefined);
      return record.token;
    },
    advanceClock(seconds) {
      assert.ok(Number.isInteger(seconds) && seconds >= 0);
      now += seconds;
    },
    clock() {
      return now;
    },
    resetV2() {
      resetV2State();
    },
    refreshSeedCredentials() {
      for (const [username, client] of seedClients) {
        const agent = agentsByUsername.get(username);
        assert.ok(agent !== undefined);
        client.setAccessToken(issueToken(agent, client.jkt));
      }
    },
    currentV2Token(username) {
      const agent = agentsByUsername.get(username);
      assert.ok(agent !== undefined);
      const current = [...tokens.values()]
        .filter((record) => record.agentId === agent.id && !record.revoked)
        .sort(
          (left, right) =>
            left.issuedAt - right.issuedAt || left.tokenId.localeCompare(right.tokenId),
        )
        .at(-1);
      assert.ok(current !== undefined);
      return current.token;
    },
    failNextV2(operation, fault) {
      const queued = nextFaults.get(operation) ?? [];
      queued.push(fault);
      nextFaults.set(operation, queued);
    },
    setV1MigrationBlocked(username, blocked) {
      const agent = agentsByUsername.get(username);
      assert.ok(agent !== undefined);
      agent.legacyMigrationBlocked = blocked;
    },
    setConversationGrant(recipientUsername, senderUsername, granted) {
      const recipient = agentsByUsername.get(recipientUsername);
      const sender = agentsByUsername.get(senderUsername);
      assert.ok(recipient !== undefined && sender !== undefined);
      if (granted) recipient.grants.add(sender.id);
      else recipient.grants.delete(sender.id);
    },
    v2MessageState(id) {
      const record = messagesV2.get(id);
      assert.ok(record !== undefined);
      return {
        id: record.message.id,
        conversationId: record.message.conversation_id,
        recipientAgentId: record.recipientAgentId,
        terminalOutcome:
          record.terminal === null
            ? null
            : record.terminal.kind === "replied"
              ? "replied"
              : record.terminal.outcome,
        replyMessageId: record.terminal?.kind === "replied" ? record.terminal.replyMessageId : null,
        acknowledged: record.acknowledged,
        leaseUntil: record.leaseUntil,
      };
    },
  };
}
