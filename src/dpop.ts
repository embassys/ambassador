import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";

import {
  type CentralKeyMaterial,
  type CentralPublicJwk,
  centralJwkThumbprint,
  exactCentralPublicJwk,
} from "./central-credential.js";

const TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const METHOD = /^[A-Z]+$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NONCE = /^[A-Za-z0-9._~-]{1,512}$/u;
const PROOF_MAX_BYTES = 4_096;

export interface DpopKeyMaterial extends CentralKeyMaterial {}

export interface DpopProofInput {
  readonly method: string;
  readonly targetUri: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: CentralPublicJwk;
  readonly accessToken: string;
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

function invalid(): never {
  throw new DpopError();
}

function encodedJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function exactTarget(value: string): string {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return invalid();
  }
  if (
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== ""
  ) {
    invalid();
  }
  return target.href;
}

export function dpopJwkThumbprint(jwk: CentralPublicJwk): string {
  return centralJwkThumbprint(jwk);
}

export function dpopAccessTokenHash(accessToken: string): string {
  if (!TOKEN.test(accessToken)) invalid();
  return createHash("sha256").update(accessToken, "ascii").digest("base64url");
}

export function generateDpopKeyMaterial(): DpopKeyMaterial {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = exactCentralPublicJwk(pair.publicKey.export({ format: "jwk" }));
  const privateKeyPkcs8 = Buffer.from(
    pair.privateKey.export({ format: "der", type: "pkcs8" }),
  ).toString("base64url");
  if (privateKeyPkcs8.length > 1_024) invalid();
  return {
    privateKey: pair.privateKey,
    privateKeyPkcs8,
    publicJwk,
    thumbprint: dpopJwkThumbprint(publicJwk),
  };
}

export function createDpopProof(input: DpopProofInput): string {
  if (!METHOD.test(input.method) || !TOKEN.test(input.accessToken)) invalid();
  if (
    input.privateKey.asymmetricKeyType !== "ec" ||
    input.privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    invalid();
  }
  const suppliedPublic = exactCentralPublicJwk(input.publicJwk);
  const actualPublic = exactCentralPublicJwk(
    createPublicKey(input.privateKey).export({ format: "jwk" }),
  );
  if (dpopJwkThumbprint(suppliedPublic) !== dpopJwkThumbprint(actualPublic)) invalid();
  const jti = (input.uuid ?? randomUUID)();
  if (!UUID_V4.test(jti)) invalid();
  const iat = Math.floor((input.now ?? (() => Date.now() / 1_000))());
  if (!Number.isSafeInteger(iat) || iat < 0) invalid();
  const nonce = input.nonce === undefined ? undefined : parseDpopNonce(input.nonce);
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: actualPublic,
  } as const;
  const payload = {
    jti,
    htm: input.method,
    htu: exactTarget(input.targetUri),
    iat,
    ath: dpopAccessTokenHash(input.accessToken),
    ...(nonce === undefined ? {} : { nonce }),
  };
  const encodedHeader = encodedJson(header);
  const encodedPayload = encodedJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const proof = `${signingInput}.${signature}`;
  if (Buffer.byteLength(proof, "ascii") > PROOF_MAX_BYTES) invalid();
  return proof;
}

export function parseDpopNonce(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!NONCE.test(value)) invalid();
  return value;
}

export class DpopNonceCache {
  readonly #values = new Map<string, string>();

  get(origin: string): string | undefined {
    return this.#values.get(origin);
  }

  set(origin: string, value: string): void {
    this.#values.set(origin, parseDpopNonce(value) as string);
  }

  clear(): void {
    this.#values.clear();
  }
}
