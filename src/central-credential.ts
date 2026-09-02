import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { TextDecoder } from "node:util";

const ACCESS_TOKEN_MAX_BYTES = 4_096;
const PRIVATE_KEY_MAX_CHARACTERS = 1_024;
const CREDENTIAL_MAX_BYTES = 8_192;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ASCII_TOKEN = /^[\x21-\x7e]+$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const RECORD_KEYS = ["access_token", "credential_format", "dpop_private_key_pkcs8"] as const;

export interface CentralPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export interface CentralCredentialRecord {
  readonly credential_format: 1;
  readonly access_token: string;
  readonly dpop_private_key_pkcs8: string;
}

export interface CentralTokenClaims {
  readonly subject: string;
  readonly email: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyThumbprint: string;
}

export interface LoadedCentralCredential {
  readonly record: CentralCredentialRecord;
  readonly serialized: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: CentralPublicJwk;
  readonly keyThumbprint: string;
  readonly token: CentralTokenClaims;
}

export interface CentralKeyMaterial {
  readonly privateKey: KeyObject;
  readonly privateKeyPkcs8: string;
  readonly publicJwk: CentralPublicJwk;
  readonly thumbprint: string;
}

export class CentralCredentialError extends Error {
  constructor() {
    super("The central credential is invalid");
    this.name = "CentralCredentialError";
  }
}

function invalid(): never {
  throw new CentralCredentialError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class StrictJsonParser {
  #index = 0;
  #members = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const result = this.#value(0);
    this.#whitespace();
    if (this.#index !== this.text.length) invalid();
    return result;
  }

  #value(depth: number): unknown {
    if (depth > 16) invalid();
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
      if (this.text[this.#index] !== '"') invalid();
      const name = this.#string();
      if (names.has(name)) invalid();
      names.add(name);
      this.#members += 1;
      if (this.#members > 128) invalid();
      this.#whitespace();
      if (this.text[this.#index] !== ":") invalid();
      this.#index += 1;
      result[name] = this.#value(depth);
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "}") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") invalid();
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
      if (result.length > 128) invalid();
      this.#whitespace();
      const separator = this.text[this.#index];
      if (separator === "]") {
        this.#index += 1;
        return result;
      }
      if (separator !== ",") invalid();
      this.#index += 1;
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
          invalid();
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) invalid();
        return value;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) invalid();
    }
    return invalid();
  }

  #number(): number {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    match.lastIndex = this.#index;
    const parsed = match.exec(this.text);
    if (parsed === null) invalid();
    this.#index = match.lastIndex;
    const value = Number(parsed[0]);
    if (!Number.isFinite(value)) invalid();
    return value;
  }

  #whitespace(): void {
    while ([9, 10, 13, 32].includes(this.text.charCodeAt(this.#index))) this.#index += 1;
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function strictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

function decodeBase64url(value: unknown, maximumCharacters?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (maximumCharacters !== undefined && value.length > maximumCharacters) ||
    !BASE64URL.test(value)
  ) {
    invalid();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) invalid();
  return decoded;
}

function decodeJwtObject(segment: string): Record<string, unknown> {
  const bytes = decodeBase64url(segment, 6_000);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  const value = strictJson(text);
  if (!isRecord(value)) invalid();
  return value;
}

export function exactCentralPublicJwk(value: unknown): CentralPublicJwk {
  if (!isRecord(value)) invalid();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    !["crv", "kty", "x", "y"].every((name, index) => keys[index] === name) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string" ||
    decodeBase64url(value.x).byteLength !== 32 ||
    decodeBase64url(value.y).byteLength !== 32
  ) {
    invalid();
  }
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

export function centralJwkThumbprint(jwk: CentralPublicJwk): string {
  const exact = exactCentralPublicJwk(jwk);
  return createHash("sha256")
    .update(JSON.stringify({ crv: exact.crv, kty: exact.kty, x: exact.x, y: exact.y }), "utf8")
    .digest("base64url");
}

function importPrivateKey(value: unknown): KeyObject {
  const bytes = decodeBase64url(value, PRIVATE_KEY_MAX_CHARACTERS);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  } catch {
    return invalid();
  }
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    invalid();
  }
  return privateKey;
}

function publicJwkFromPrivateKey(privateKey: KeyObject): CentralPublicJwk {
  let exported: JsonWebKey;
  try {
    exported = createPublicKey(privateKey).export({ format: "jwk" });
  } catch {
    return invalid();
  }
  return exactCentralPublicJwk(exported);
}

function parseToken(
  accessToken: string,
  keyThumbprint: string,
  nowSeconds: () => number,
): CentralTokenClaims {
  if (
    !ASCII_TOKEN.test(accessToken) ||
    Buffer.byteLength(accessToken, "ascii") > ACCESS_TOKEN_MAX_BYTES
  ) {
    invalid();
  }
  const parts = accessToken.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) invalid();
  const header = decodeJwtObject(parts[0] as string);
  if (header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")) invalid();
  const payload = decodeJwtObject(parts[1] as string);
  if (
    typeof payload.sub !== "string" ||
    payload.sub.length < 1 ||
    payload.sub.length > 256 ||
    typeof payload.email !== "string" ||
    !EMAIL.test(payload.email) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    !isRecord(payload.cnf) ||
    typeof payload.cnf.jkt !== "string" ||
    !BASE64URL.test(payload.cnf.jkt) ||
    payload.cnf.jkt !== keyThumbprint
  ) {
    invalid();
  }
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  const now = Math.floor(nowSeconds());
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    issuedAt < 0 ||
    expiresAt <= issuedAt ||
    expiresAt <= now
  ) {
    invalid();
  }
  return {
    subject: payload.sub,
    email: payload.email,
    issuedAt,
    expiresAt,
    keyThumbprint,
  };
}

function recordFromUnknown(value: unknown): CentralCredentialRecord {
  if (!isRecord(value)) invalid();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== RECORD_KEYS.length ||
    !RECORD_KEYS.every((name, index) => keys[index] === name) ||
    value.credential_format !== 1 ||
    typeof value.access_token !== "string" ||
    typeof value.dpop_private_key_pkcs8 !== "string"
  ) {
    invalid();
  }
  return {
    credential_format: 1,
    access_token: value.access_token,
    dpop_private_key_pkcs8: value.dpop_private_key_pkcs8,
  };
}

export function serializeCentralCredential(record: CentralCredentialRecord): string {
  const exact = recordFromUnknown(record);
  const serialized = JSON.stringify(exact);
  if (Buffer.byteLength(serialized, "utf8") > CREDENTIAL_MAX_BYTES) invalid();
  return serialized;
}

export function parseCentralCredential(
  value: string | CentralCredentialRecord | unknown,
  nowSeconds: () => number = () => Date.now() / 1_000,
): LoadedCentralCredential {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > CREDENTIAL_MAX_BYTES) invalid();
    parsed = strictJson(value);
  }
  const record = recordFromUnknown(parsed);
  const privateKey = importPrivateKey(record.dpop_private_key_pkcs8);
  const publicJwk = publicJwkFromPrivateKey(privateKey);
  const keyThumbprint = centralJwkThumbprint(publicJwk);
  const token = parseToken(record.access_token, keyThumbprint, nowSeconds);
  const serialized = serializeCentralCredential(record);
  return { record, serialized, privateKey, publicJwk, keyThumbprint, token };
}

export function createCentralCredentialRecord(
  accessToken: string,
  key: CentralKeyMaterial,
): CentralCredentialRecord {
  const record: CentralCredentialRecord = {
    credential_format: 1,
    access_token: accessToken,
    dpop_private_key_pkcs8: key.privateKeyPkcs8,
  };
  const loaded = parseCentralCredential(record, () => {
    const payload = decodeJwtObject(accessToken.split(".")[1] ?? "");
    return typeof payload.iat === "number" ? payload.iat : 0;
  });
  if (loaded.keyThumbprint !== key.thumbprint) invalid();
  return record;
}
