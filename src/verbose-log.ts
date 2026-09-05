import { randomUUID } from "node:crypto";

const MAX_LOG_BYTES = 64 * 1024;
const responseTraces = new WeakMap<Response, (body: unknown) => void>();
const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /^(authorization|proxyauthorization|dpop|dpopnonce|dpopproof|dpopprivatekeypkcs8|jwk|publicjwk|publickeyjwk|token|accesstoken|refreshtoken|jwt|code|verificationcode|privatekey|proof|nonce|cookie|setcookie|secret|clientsecret|webhooksecret|xwebhooksignaturev2|apikey|password|wrappingkey)$/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const COMPACT_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;

export type VerboseLogger = (event: string, data?: unknown) => void;

const MAX_ERROR_TEXT = 2_048;
const MAX_ERROR_DEPTH = 4;

function boundedErrorText(value: string): string {
  return value.length <= MAX_ERROR_TEXT ? value : `${value.slice(0, MAX_ERROR_TEXT)}[bounded]`;
}

export function describeVerboseError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "NonError" };
  const diagnostic: Record<string, unknown> = {
    name: boundedErrorText(error.name),
    message: boundedErrorText(error.message),
  };
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly stage?: unknown;
    readonly cause?: unknown;
  };
  if (typeof candidate.code === "string") {
    diagnostic.error_code = boundedErrorText(candidate.code);
  }
  if (typeof candidate.stage === "string") diagnostic.stage = boundedErrorText(candidate.stage);
  if (candidate.cause !== undefined && depth + 1 < MAX_ERROR_DEPTH) {
    diagnostic.cause = describeVerboseError(candidate.cause, depth + 1);
  }
  return diagnostic;
}

function redactedString(value: string): string {
  return value
    .replaceAll(BEARER, `Bearer ${REDACTED}`)
    .replaceAll(COMPACT_JWT, REDACTED)
    .replaceAll(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/gu,
      REDACTED,
    );
}

export function redactVerboseValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key.replaceAll(/[_-]/gu, ""))) return REDACTED;
  if (typeof value === "string") return redactedString(value);
  if (Array.isArray(value)) return value.map((item) => redactVerboseValue(item));
  if (value !== null && typeof value === "object") {
    if (value instanceof Headers) {
      return Object.fromEntries(
        [...value.entries()].map(([name, item]) => [name, redactVerboseValue(item, name)]),
      );
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        redactVerboseValue(item, name),
      ]),
    );
  }
  return value;
}

function boundedJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(redactVerboseValue(value));
  } catch {
    serialized = JSON.stringify({ value: "[unserializable]" });
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_LOG_BYTES) return serialized;
  return JSON.stringify({
    value: "[bounded]",
    original_bytes: Buffer.byteLength(serialized, "utf8"),
  });
}

export function createVerboseLogger(
  write: (value: string) => void,
  now: () => Date = () => new Date(),
): VerboseLogger {
  return (event, data) => {
    const suffix = data === undefined ? "" : ` ${boundedJson(data)}`;
    write(`[verbose ${now().toISOString()}] ${event}${suffix}\n`);
  };
}

function requestBody(body: RequestInit["body"] | undefined): unknown {
  if (typeof body !== "string") return body === undefined || body === null ? undefined : "[binary]";
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export function finishResponseTrace(response: Response, value: unknown, bytes?: number): void {
  const trace = responseTraces.get(response);
  responseTraces.delete(response);
  if (trace === undefined) return;
  try {
    trace(bytes === undefined ? "[unavailable]" : bytes > MAX_LOG_BYTES ? "[bounded]" : value);
  } catch {
    // A diagnostic sink must not change the result of a validated response read.
  }
}

export function traceFetch(
  fetchImplementation: typeof fetch,
  log: VerboseLogger,
  prefix = "central",
): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    const request_id = randomUUID();
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? "GET";
    const headers = new Headers(init?.headers ?? request?.headers);
    log(`${prefix}.request`, { request_id, method, url, headers, body: requestBody(init?.body) });
    try {
      const response = await fetchImplementation(input, init);
      log(`${prefix}.response`, {
        request_id,
        method,
        url,
        status: response.status,
        duration_ms: Date.now() - started,
        headers: response.headers,
      });
      responseTraces.set(response, (body) =>
        log(`${prefix}.response.body`, { request_id, method, url, body }),
      );
      return response;
    } catch (error) {
      log(`${prefix}.error`, {
        request_id,
        method,
        url,
        duration_ms: Date.now() - started,
        error: describeVerboseError(error),
      });
      throw error;
    }
  };
}
