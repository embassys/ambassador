import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";

import {
  type CentralCredentialV2Record,
  dpopJwkThumbprint,
  type LoadedCentralCredentialV2,
} from "./credential-v2.js";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{76}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const PROOF_MAX_BYTES = 4_096;

export type DpopSecurityDomain = "issuance" | "api" | "mcp";

export interface DpopKeyMaterial {
  readonly privateKey: KeyObject;
  readonly privateKeyPkcs8: string;
  readonly publicJwk: LoadedCentralCredentialV2["publicJwk"];
  readonly thumbprint: string;
}

export interface DpopProofInput {
  readonly method: string;
  readonly targetUri: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: LoadedCentralCredentialV2["publicJwk"];
  readonly accessToken?: string;
  readonly nonce?: string;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export class DpopError extends Error {
  constructor() {
    super("The DPoP operation is invalid");
    this.name = "DpopError";
  }
}

function invalidDpop(): never {
  throw new DpopError();
}

function exactPublicJwk(value: unknown): LoadedCentralCredentialV2["publicJwk"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidDpop();
  const exported = value as JsonWebKey;
  const keys = Object.keys(exported).sort();
  if (
    !["crv", "kty", "x", "y"].every((name, index) => keys[index] === name) ||
    keys.length !== 4 ||
    exported.kty !== "EC" ||
    exported.crv !== "P-256" ||
    typeof exported.x !== "string" ||
    typeof exported.y !== "string" ||
    Buffer.from(exported.x, "base64url").byteLength !== 32 ||
    Buffer.from(exported.y, "base64url").byteLength !== 32
  ) {
    invalidDpop();
  }
  return { kty: "EC", crv: "P-256", x: exported.x, y: exported.y };
}

function publicJwk(key: KeyObject): LoadedCentralCredentialV2["publicJwk"] {
  return exactPublicJwk(key.export({ format: "jwk" }));
}

export function generateDpopKeyMaterial(): DpopKeyMaterial {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicJwk(pair.publicKey);
  const privateKeyPkcs8 = Buffer.from(
    pair.privateKey.export({ format: "der", type: "pkcs8" }),
  ).toString("base64url");
  if (privateKeyPkcs8.length > 1_024) invalidDpop();
  return {
    privateKey: pair.privateKey,
    privateKeyPkcs8,
    publicJwk: jwk,
    thumbprint: dpopJwkThumbprint(jwk),
  };
}

export function dpopKeyMaterialFromCredential(
  credential: LoadedCentralCredentialV2,
): DpopKeyMaterial {
  return {
    privateKey: credential.privateKey,
    privateKeyPkcs8: credential.record.dpop_private_key_pkcs8,
    publicJwk: credential.publicJwk,
    thumbprint: credential.keyThumbprint,
  };
}

export function createCentralCredentialV2Record(
  accessToken: string,
  key: DpopKeyMaterial,
): CentralCredentialV2Record {
  return {
    credential_version: 2,
    token_type: "DPoP",
    access_token: accessToken,
    dpop_alg: "ES256",
    dpop_private_key_pkcs8: key.privateKeyPkcs8,
  };
}

export function normalizeDpopTargetUri(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalidDpop();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    invalidDpop();
  }
  url.search = "";
  url.hash = "";
  if (/%(?![0-9a-fA-F]{2})/.test(url.pathname)) invalidDpop();
  const normalizedPath = url.pathname.replace(/%[0-9a-fA-F]{2}/g, (encoded) => {
    const byte = Number.parseInt(encoded.slice(1), 16);
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9._~-]/.test(character) ? character : `%${encoded.slice(1).toUpperCase()}`;
  });
  url.pathname = normalizedPath === "" ? "/" : normalizedPath;
  return url.href;
}

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function dpopAccessTokenHash(accessToken: string): string {
  if (!TOKEN_PATTERN.test(accessToken)) invalidDpop();
  return createHash("sha256").update(accessToken, "ascii").digest("base64url");
}

export function createDpopProof(input: DpopProofInput): string {
  if (!/^[A-Z]+$/.test(input.method)) invalidDpop();
  if (input.privateKey.asymmetricKeyType !== "ec") invalidDpop();
  const details = input.privateKey.asymmetricKeyDetails;
  if (details?.namedCurve !== "prime256v1") invalidDpop();
  const suppliedPublic = exactPublicJwk(input.publicJwk);
  const actualPublic = publicJwk(createPublicKey(input.privateKey));
  if (dpopJwkThumbprint(actualPublic) !== dpopJwkThumbprint(suppliedPublic)) invalidDpop();
  const jti = (input.uuid ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(jti)) invalidDpop();
  const iat = Math.floor((input.now ?? (() => Date.now() / 1_000))());
  if (!Number.isSafeInteger(iat) || iat < 0) invalidDpop();
  if (input.nonce !== undefined && !NONCE_PATTERN.test(input.nonce)) invalidDpop();

  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: actualPublic,
  } as const;
  const payload = {
    jti,
    htm: input.method,
    htu: normalizeDpopTargetUri(input.targetUri),
    iat,
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    ...(input.accessToken === undefined ? {} : { ath: dpopAccessTokenHash(input.accessToken) }),
  };
  const encodedHeader = encodedJson(header);
  const encodedPayload = encodedJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const proof = `${signingInput}.${signature}`;
  if (Buffer.byteLength(proof, "ascii") > PROOF_MAX_BYTES) invalidDpop();
  return proof;
}

export function importDpopPrivateKey(pkcs8: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(pkcs8)) invalidDpop();
  const der = Buffer.from(pkcs8, "base64url");
  if (der.toString("base64url") !== pkcs8) invalidDpop();
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    return invalidDpop();
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    invalidDpop();
  }
  return key;
}

export function parseDpopNonce(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!NONCE_PATTERN.test(value)) invalidDpop();
  return value;
}

export class DpopNonceCache {
  readonly #values = new Map<DpopSecurityDomain, string>();

  get(domain: DpopSecurityDomain): string | undefined {
    return this.#values.get(domain);
  }

  set(domain: DpopSecurityDomain, value: string): void {
    this.#values.set(domain, parseDpopNonce(value) as string);
  }

  updateFromHeader(domain: DpopSecurityDomain, value: string | null): boolean {
    const parsed = parseDpopNonce(value);
    if (parsed === undefined) return false;
    this.#values.set(domain, parsed);
    return true;
  }

  clear(): void {
    this.#values.clear();
  }
}
