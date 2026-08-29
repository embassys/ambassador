import {
  createECDH,
  createHash,
  createPrivateKey,
  sign as cryptoSign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import type { V2FixtureClock } from "./v2-process-clock.js";

interface PublicEcJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

interface PrivateEcJwk extends PublicEcJwk {
  readonly d: string;
}

interface SenderIdentity {
  readonly agentId: string;
  readonly username: string;
  readonly keyThumbprint: string;
}

const UUID_PREFIX = "00000000-0000-4000-8000-";
const NONCE = /^[A-Za-z0-9_-]{76}$/u;
const UNRESERVED = /^[A-Za-z0-9._~-]$/u;

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function senderKey(scalar: number): { privateKey: KeyObject; publicJwk: PublicEcJwk } {
  if (!Number.isSafeInteger(scalar) || scalar < 2 || scalar > 0xffff_ffff) {
    throw new Error("invalid fixture sender key scalar");
  }
  const privateBytes = Buffer.alloc(32);
  privateBytes.writeUInt32BE(scalar, 28);
  const curve = createECDH("prime256v1");
  curve.setPrivateKey(privateBytes);
  const publicBytes = curve.getPublicKey(undefined, "uncompressed");
  const jwk: PrivateEcJwk = {
    kty: "EC",
    crv: "P-256",
    x: base64url(publicBytes.subarray(1, 33)),
    y: base64url(publicBytes.subarray(33, 65)),
    d: base64url(privateBytes),
  };
  return {
    privateKey: createPrivateKey({ key: jwk as JsonWebKey, format: "jwk" }),
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
}

function thumbprint(jwk: PublicEcJwk): string {
  return base64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

function normalizeHtu(target: string): string {
  const url = new URL(target);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("invalid DPoP target URI");
  }
  url.search = "";
  url.hash = "";
  if (/%(?![0-9a-fA-F]{2})/u.test(url.pathname)) {
    throw new Error("invalid DPoP target percent encoding");
  }
  url.pathname =
    url.pathname.replace(/%[0-9a-fA-F]{2}/gu, (encoded) => {
      const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
      return UNRESERVED.test(character) ? character : `%${encoded.slice(1).toUpperCase()}`;
    }) || "/";
  return url.toString().replace(/\/$/u, url.pathname.endsWith("/") ? "/" : "");
}

function fixedUuid(sequence: number): string {
  return `${UUID_PREFIX}${sequence.toString(16).padStart(12, "0")}`;
}

function exactObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fixture sender received a non-object response");
  }
  return value as Record<string, unknown>;
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > 65_536) {
    await response.body?.cancel();
    throw new Error("fixture sender response is too large");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > 65_536) {
        await reader.cancel();
        throw new Error("fixture sender response is too large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return exactObject(JSON.parse(text) as unknown);
}

function nonceFrom(response: Response): string | undefined {
  const nonce = response.headers.get("dpop-nonce") ?? undefined;
  if (nonce !== undefined && !NONCE.test(nonce)) throw new Error("invalid fixture DPoP nonce");
  return nonce;
}

function challengeIsSafe(response: Response, issuance: boolean): boolean {
  if (
    !response.headers
      .get("cache-control")
      ?.split(",")
      .some((item) => item.trim() === "no-store")
  ) {
    return false;
  }
  if (issuance) return response.status === 400;
  return (
    response.status === 401 &&
    response.headers.get("www-authenticate") === 'DPoP error="use_dpop_nonce"'
  );
}

/**
 * A test sender with its own key and proof implementation. It does not import
 * the fake central client or any future gateway DPoP implementation.
 */
export class IndependentV2SenderClient {
  readonly publicJwk: PublicEcJwk;
  readonly keyThumbprint: string;
  readonly #apiOrigin: URL;
  readonly #clock: V2FixtureClock;
  readonly #privateKey: KeyObject;
  readonly #nonces = new Map<"api" | "issuance" | "mcp", string>();
  #proofSequence: number;
  #accessToken: string | undefined;

  constructor(options: {
    readonly apiOrigin: string;
    readonly clock: V2FixtureClock;
    readonly keyScalar?: number;
    readonly firstProofSequence?: number;
  }) {
    const apiOrigin = new URL(options.apiOrigin);
    if (
      (apiOrigin.protocol !== "http:" && apiOrigin.protocol !== "https:") ||
      apiOrigin.username !== "" ||
      apiOrigin.password !== "" ||
      apiOrigin.pathname !== "/" ||
      apiOrigin.search !== "" ||
      apiOrigin.hash !== ""
    ) {
      throw new Error("fixture sender requires an HTTP origin");
    }
    if (apiOrigin.protocol === "http:" && apiOrigin.hostname !== "127.0.0.1") {
      throw new Error("plain HTTP fixture sender requires literal loopback");
    }
    const key = senderKey(options.keyScalar ?? 700);
    this.#apiOrigin = apiOrigin;
    this.#clock = options.clock;
    this.#privateKey = key.privateKey;
    this.publicJwk = key.publicJwk;
    this.keyThumbprint = thumbprint(this.publicJwk);
    this.#proofSequence = options.firstProofSequence ?? 700_000;
  }

  async enroll(input: {
    readonly email: string;
    readonly username: string;
    readonly code: string;
    readonly displayName?: string;
  }): Promise<SenderIdentity> {
    if (this.#accessToken !== undefined) throw new Error("fixture sender is already enrolled");
    const registration = await fetch(new URL("/api/register", this.#apiOrigin), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        email: input.email,
        username: input.username,
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
      }),
    });
    if (registration.status !== 200) {
      await registration.body?.cancel();
      throw new Error("fixture sender registration failed");
    }
    await jsonObject(registration);

    const target = new URL("/api/verify_email", this.#apiOrigin).toString();
    const send = async (nonce?: string): Promise<Response> => {
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      headers.set("dpop", this.#proof("POST", target, undefined, nonce));
      return await fetch(target, {
        method: "POST",
        redirect: "manual",
        headers,
        body: JSON.stringify({ email: input.email, code: input.code }),
      });
    };
    const first = await send();
    let verification = first;
    if (first.status === 400) {
      const challenge = await jsonObject(first);
      const nonce = nonceFrom(first);
      if (
        !challengeIsSafe(first, true) ||
        Object.keys(challenge).length !== 1 ||
        challenge.error !== "use_dpop_nonce" ||
        nonce === undefined
      ) {
        throw new Error("fixture sender received an invalid issuance challenge");
      }
      this.#nonces.set("issuance", nonce);
      verification = await send(nonce);
    }
    if (verification.status !== 200) {
      await verification.body?.cancel();
      throw new Error("fixture sender verification failed");
    }
    if (!verification.headers.get("cache-control")?.includes("no-store")) {
      await verification.body?.cancel();
      throw new Error("fixture sender received an unsafe credential response");
    }
    const result = await jsonObject(verification);
    if (
      typeof result.agent_id !== "string" ||
      result.username !== input.username ||
      typeof result.token !== "string" ||
      result.token_type !== "DPoP" ||
      result.expires_in !== 86_400
    ) {
      throw new Error("fixture sender received an invalid credential response");
    }
    if (
      result.token.length > 4_096 ||
      !/^[\x21-\x7e]+$/u.test(result.token) ||
      result.token.includes("=")
    ) {
      throw new Error("fixture sender received an invalid access token");
    }
    const segments = result.token.split(".");
    if (
      segments.length !== 3 ||
      segments[1] === undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(segments[1])
    ) {
      throw new Error("fixture sender received an invalid access token");
    }
    const payloadBytes = Buffer.from(segments[1], "base64url");
    if (payloadBytes.toString("base64url") !== segments[1]) {
      throw new Error("fixture sender received an invalid access token");
    }
    const payload = exactObject(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)) as unknown,
    );
    if (
      payload.sub !== result.agent_id ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp !== (payload.iat as number) + 86_400 ||
      exactObject(payload.cnf).jkt !== this.keyThumbprint
    ) {
      throw new Error("fixture sender received a wrongly bound access token");
    }
    this.#accessToken = result.token;
    return {
      agentId: result.agent_id,
      username: result.username,
      keyThumbprint: this.keyThumbprint,
    };
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.#accessToken;
    if (token === undefined) throw new Error("fixture sender is not enrolled");
    const target = new URL(path, this.#apiOrigin);
    if (target.origin !== this.#apiOrigin.origin) {
      throw new Error("fixture sender target changed origin");
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (init.body !== undefined && typeof init.body !== "string") {
      throw new Error("fixture sender retries only replayable string bodies");
    }
    const domain = target.pathname === "/mcp" ? "mcp" : "api";
    const suppliedHeaders = new Headers(init.headers);
    if (suppliedHeaders.has("authorization") || suppliedHeaders.has("dpop")) {
      throw new Error("fixture sender owns DPoP transport headers");
    }
    const send = async (nonce?: string): Promise<Response> => {
      const headers = new Headers(suppliedHeaders);
      headers.set("authorization", `DPoP ${token}`);
      headers.set("dpop", this.#proof(method, target.toString(), token, nonce));
      return await fetch(target, { ...init, method, redirect: "manual", headers });
    };

    const first = await send(this.#nonces.get(domain));
    if (!challengeIsSafe(first, false)) {
      const replacement = nonceFrom(first);
      if (replacement !== undefined && first.status !== 401) this.#nonces.set(domain, replacement);
      return first;
    }
    const nonce = nonceFrom(first);
    if (nonce === undefined) return first;
    await first.body?.cancel();
    this.#nonces.set(domain, nonce);
    const second = await send(nonce);
    const replacement = nonceFrom(second);
    if (replacement !== undefined && second.status !== 401) this.#nonces.set(domain, replacement);
    return second;
  }

  #proof(method: string, target: string, token?: string, nonce?: string): string {
    const payload: Record<string, unknown> = {
      jti: fixedUuid(this.#proofSequence++),
      htm: method,
      htu: normalizeHtu(target),
      iat: this.#clock.now(),
    };
    if (nonce !== undefined) payload.nonce = nonce;
    if (token !== undefined) payload.ath = base64url(sha256(token));
    const encodedHeader = base64url(
      Buffer.from(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: this.publicJwk }), "utf8"),
    );
    const encodedPayload = base64url(Buffer.from(JSON.stringify(payload), "utf8"));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = cryptoSign("sha256", Buffer.from(signingInput, "ascii"), {
      key: this.#privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${base64url(signature)}`;
  }
}
