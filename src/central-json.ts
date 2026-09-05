import { TextDecoder } from "node:util";
import { finishResponseTrace } from "./verbose-log.js";

export const CENTRAL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 100;
const MAX_STRUCTURAL_TOKENS = 16_384;
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const CREDENTIAL_FIELDS = new Set([
  "access_token",
  "authorization",
  "dpop",
  "dpop_proof",
  "jwt",
  "private_key",
  "proof",
  "token",
]);

export class CentralJsonError extends Error {
  constructor() {
    super("The central JSON value is invalid");
    this.name = "CentralJsonError";
  }
}

function invalid(): never {
  throw new CentralJsonError();
}

export function isCentralRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class Parser {
  #index = 0;
  #tokens = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#index !== this.text.length) invalid();
    return value;
  }

  #value(depth: number): unknown {
    if (depth > MAX_DEPTH) invalid();
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
    this.#container();
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
    }
  }

  #array(depth: number): unknown[] {
    this.#container();
    this.#index += 1;
    this.#whitespace();
    const result: unknown[] = [];
    if (this.text[this.#index] === "]") {
      this.#index += 1;
      return result;
    }
    while (true) {
      result.push(this.#value(depth));
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

  #container(): void {
    this.#tokens += 1;
    if (this.#tokens > MAX_STRUCTURAL_TOKENS) invalid();
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
          return invalid();
        }
        if (typeof value !== "string" || hasLoneSurrogate(value)) invalid();
        return value;
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) invalid();
    }
    return invalid();
  }

  #number(): number {
    const pattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    pattern.lastIndex = this.#index;
    const match = pattern.exec(this.text);
    if (match === null) invalid();
    this.#index = pattern.lastIndex;
    const value = Number(match[0]);
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

export function parseStrictCentralJson(text: string): unknown {
  return new Parser(text).parse();
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) invalid();
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        invalid();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof CentralJsonError) throw error;
    return invalid();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readCentralJson(
  response: Response,
  maximumBytes = CENTRAL_RESPONSE_MAX_BYTES,
): Promise<unknown> {
  try {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      !JSON_MEDIA_TYPE.test(response.headers.get("content-type") ?? "") ||
      response.headers.has("content-encoding")
    ) {
      invalid();
    }
    const bytes = await readBoundedBytes(response, maximumBytes);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return invalid();
    }
    const result = parseStrictCentralJson(text);
    finishResponseTrace(response, result, bytes.byteLength);
    return result;
  } catch (error) {
    finishResponseTrace(response, undefined);
    throw error;
  }
}

export function assertNoCentralCredentialFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCentralCredentialFields(item);
    return;
  }
  if (!isCentralRecord(value)) return;
  for (const [name, nested] of Object.entries(value)) {
    if (CREDENTIAL_FIELDS.has(name.toLowerCase())) invalid();
    assertNoCentralCredentialFields(nested);
  }
}
