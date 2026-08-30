import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { TextDecoder } from "node:util";

const ACCESS_TOKEN_MAX_BYTES = 4_096;
const PRIVATE_KEY_MAX_BYTES = 1_024;
const CREDENTIAL_MAX_BYTES = 8_192;
const TOKEN_LIFETIME_SECONDS = 86_400;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const URI_UNRESERVED_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const CREDENTIAL_KEYS = [
  "access_token",
  "credential_version",
  "dpop_alg",
  "dpop_private_key_pkcs8",
  "token_type",
] as const;
const FORBIDDEN_TOKEN_CLAIM_NAMES = new Set([
  "access_token",
  "authorization",
  "code",
  "dpop_private_key_pkcs8",
  "dpop_proof",
  "email",
  "nonce",
  "private_key",
  "proof",
  "recovery_code",
  "token",
  "verification_code",
]);

export interface CentralCredentialV2Record {
  readonly credential_version: 2;
  readonly token_type: "DPoP";
  readonly access_token: string;
  readonly dpop_alg: "ES256";
  readonly dpop_private_key_pkcs8: string;
}

export interface CentralTokenClaims {
  readonly issuer: string;
  readonly audiences: readonly [string, string];
  readonly subject: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly tokenId: string;
  readonly keyThumbprint: string;
  readonly signingAlgorithm: "ES256";
}

export interface LoadedCentralCredentialV2 {
  readonly record: CentralCredentialV2Record;
  readonly serialized: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: Readonly<{
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
  }>;
  readonly keyThumbprint: string;
  readonly token: CentralTokenClaims;
}

export class CredentialV2Error extends Error {
  constructor() {
    super("The version 2 central credential is invalid");
    this.name = "CredentialV2Error";
  }
}

function invalidCredential(): never {
  throw new CredentialV2Error();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class StrictJsonParser {
  #index = 0;
  #members = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#index !== this.text.length) invalidCredential();
    return value;
  }

  #value(depth: number): unknown {
    if (depth > 16) invalidCredential();
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
    this.#index += 1;
    this.#whitespace();
    const result: Record<string, unknown> = {};
    const names = new Set<string>();
    if (this.text[this.#index] === "}") {
      this.#index += 1;
      return result;
    }
    while (true) {
      if (this.text[this.#index] !== '"') invalidCredential();
      const name = this.#string();
      if (names.has(name)) invalidCredential();
      names.add(name);
      this.#members += 1;
      if (this.#members > 128) invalidCredential();
      this.#whitespace();
      if (this.text[this.#index] !== ":") invalidCredential();
      this.#index += 1;
      result[name] = this.#value(depth);
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") invalidCredential();
      this.#index += 1;
      this.#whitespace();
    }
  }

  #array(depth: number): unknown[] {
    this.#index += 1;
    this.#whitespace();
    const result: unknown[] = [];
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.#value(depth));
      if (result.length > 128) invalidCredential();
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") invalidCredential();
      this.#index += 1;
      this.#whitespace();
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
          invalidCredential();
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) invalidCredential();
        return value;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) invalidCredential();
    }
    return invalidCredential();
  }

  #number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.#index;
    const parsed = match.exec(this.text);
    if (parsed === null) invalidCredential();
    this.#index = match.lastIndex;
    const value = Number(parsed[0]);
    if (!Number.isFinite(value)) invalidCredential();
    return value;
  }

  #whitespace(): void {
    while ([9, 10, 13, 32].includes(this.text.charCodeAt(this.#index))) {
      this.#index += 1;
    }
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

function parseStrictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

function decodeBase64url(value: string, maximumCharacters?: number): Buffer {
  if (
    value.length === 0 ||
    (maximumCharacters !== undefined && value.length > maximumCharacters) ||
    !BASE64URL_PATTERN.test(value)
  ) {
    invalidCredential();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) invalidCredential();
  return decoded;
}

function decodeJwtObject(segment: string): Record<string, unknown> {
  const decoded = decodeBase64url(segment);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return invalidCredential();
  }
  const parsed = parseStrictJson(text);
  if (!isRecord(parsed)) invalidCredential();
  return parsed;
}

function assertSafeTokenClaims(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTokenClaims(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [name, nested] of Object.entries(value)) {
    if (FORBIDDEN_TOKEN_CLAIM_NAMES.has(name.toLowerCase())) invalidCredential();
    assertSafeTokenClaims(nested);
  }
}

function publicJwk(privateKey: KeyObject): LoadedCentralCredentialV2["publicJwk"] {
  const exported = createPublicKey(privateKey).export({ format: "jwk" }) as JsonWebKey;
  if (
    exported.kty !== "EC" ||
    exported.crv !== "P-256" ||
    typeof exported.x !== "string" ||
    typeof exported.y !== "string" ||
    decodeBase64url(exported.x).length !== 32 ||
    decodeBase64url(exported.y).length !== 32
  ) {
    invalidCredential();
  }
  return { kty: "EC", crv: "P-256", x: exported.x, y: exported.y };
}

export function dpopJwkThumbprint(jwk: LoadedCentralCredentialV2["publicJwk"]): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

function importPrivateKey(encoded: string): {
  readonly key: KeyObject;
  readonly jwk: LoadedCentralCredentialV2["publicJwk"];
} {
  const der = decodeBase64url(encoded, PRIVATE_KEY_MAX_BYTES);
  if (der.byteLength === 0 || !derContainsOneValue(der)) invalidCredential();
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return invalidCredential();
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    invalidCredential();
  }
  return { key, jwk: publicJwk(key) };
}

function derContainsOneValue(der: Buffer): boolean {
  if (der[0] !== 0x30 || der.length < 2) return false;
  const first = der[1];
  if (first === undefined) return false;
  if ((first & 0x80) === 0) return first + 2 === der.length;
  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4 || der.length < 2 + lengthBytes) return false;
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    const byte = der[2 + index];
    if (byte === undefined || (index === 0 && byte === 0)) return false;
    length = length * 256 + byte;
  }
  return 2 + lengthBytes + length === der.length;
}

export function parseCentralAccessToken(accessToken: string): CentralTokenClaims {
  if (
    typeof accessToken !== "string" ||
    Buffer.byteLength(accessToken, "ascii") > ACCESS_TOKEN_MAX_BYTES ||
    !/^[\x21-\x7e]+$/.test(accessToken)
  ) {
    invalidCredential();
  }
  const segments = accessToken.split(".");
  if (segments.length !== 3) invalidCredential();
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    invalidCredential();
  }
  const header = decodeJwtObject(headerSegment);
  const payload = decodeJwtObject(payloadSegment);
  if (decodeBase64url(signatureSegment).length !== 64) invalidCredential();
  assertSafeTokenClaims(payload);
  if (header.alg !== "ES256" || (header.typ !== undefined && header.typ !== "JWT")) {
    invalidCredential();
  }
  if (
    typeof payload.iss !== "string" ||
    payload.iss.length === 0 ||
    !Array.isArray(payload.aud) ||
    payload.aud.length !== 2 ||
    typeof payload.aud[0] !== "string" ||
    payload.aud[0].length === 0 ||
    typeof payload.aud[1] !== "string" ||
    payload.aud[1].length === 0 ||
    typeof payload.sub !== "string" ||
    !URI_UNRESERVED_PATTERN.test(payload.sub) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    (payload.iat as number) < 0 ||
    (payload.exp as number) - (payload.iat as number) !== TOKEN_LIFETIME_SECONDS ||
    typeof payload.jti !== "string" ||
    !UUID_V4_PATTERN.test(payload.jti) ||
    !isRecord(payload.cnf) ||
    Object.keys(payload.cnf).length !== 1 ||
    typeof payload.cnf.jkt !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.cnf.jkt) ||
    decodeBase64url(payload.cnf.jkt).length !== 32
  ) {
    invalidCredential();
  }
  return {
    issuer: payload.iss,
    audiences: [payload.aud[0], payload.aud[1]],
    subject: payload.sub,
    issuedAt: payload.iat as number,
    expiresAt: payload.exp as number,
    tokenId: payload.jti,
    keyThumbprint: payload.cnf.jkt,
    signingAlgorithm: "ES256",
  };
}

export function parseCentralCredentialV2(serialized: string): LoadedCentralCredentialV2 {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > CREDENTIAL_MAX_BYTES
  ) {
    invalidCredential();
  }
  const value = parseStrictJson(serialized);
  if (!isRecord(value)) invalidCredential();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== CREDENTIAL_KEYS.length ||
    !keys.every((key, index) => key === CREDENTIAL_KEYS[index]) ||
    value.credential_version !== 2 ||
    value.token_type !== "DPoP" ||
    value.dpop_alg !== "ES256" ||
    typeof value.access_token !== "string" ||
    typeof value.dpop_private_key_pkcs8 !== "string"
  ) {
    invalidCredential();
  }
  const imported = importPrivateKey(value.dpop_private_key_pkcs8);
  const keyThumbprint = dpopJwkThumbprint(imported.jwk);
  const token = parseCentralAccessToken(value.access_token);
  if (token.keyThumbprint !== keyThumbprint) invalidCredential();
  const record: CentralCredentialV2Record = {
    credential_version: 2,
    token_type: "DPoP",
    access_token: value.access_token,
    dpop_alg: "ES256",
    dpop_private_key_pkcs8: value.dpop_private_key_pkcs8,
  };
  return {
    record,
    serialized,
    privateKey: imported.key,
    publicJwk: imported.jwk,
    keyThumbprint,
    token,
  };
}

export function serializeCentralCredentialV2(record: CentralCredentialV2Record): string {
  const serialized = JSON.stringify(record);
  parseCentralCredentialV2(serialized);
  return serialized;
}

export function assertSameKeyCredentialReplacement(
  current: LoadedCentralCredentialV2,
  replacement: LoadedCentralCredentialV2,
): void {
  const oldToken = current.token;
  const newToken = replacement.token;
  if (
    oldToken.issuer !== newToken.issuer ||
    oldToken.subject !== newToken.subject ||
    oldToken.audiences[0] !== newToken.audiences[0] ||
    oldToken.audiences[1] !== newToken.audiences[1] ||
    oldToken.signingAlgorithm !== newToken.signingAlgorithm ||
    oldToken.keyThumbprint !== newToken.keyThumbprint ||
    current.keyThumbprint !== replacement.keyThumbprint ||
    current.record.dpop_private_key_pkcs8 !== replacement.record.dpop_private_key_pkcs8 ||
    oldToken.tokenId === newToken.tokenId ||
    newToken.expiresAt <= oldToken.expiresAt
  ) {
    invalidCredential();
  }
}
