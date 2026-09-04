const MAX_LOG_BYTES = 64 * 1024;
const REDACTED = "[redacted]";
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|dpop|dpop-nonce|token|access_token|jwt|code|verification_code|private_key|proof|nonce|cookie|set-cookie|secret|webhook_secret)$/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const COMPACT_JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;

export type VerboseLogger = (event: string, data?: unknown) => void;

function redactedString(value: string): string {
  return value.replaceAll(BEARER, `Bearer ${REDACTED}`).replaceAll(COMPACT_JWT, REDACTED);
}

export function redactVerboseValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
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

async function responseBody(response: Response): Promise<unknown> {
  try {
    const text = await response.clone().text();
    if (Buffer.byteLength(text, "utf8") > MAX_LOG_BYTES) return "[bounded]";
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return "[unavailable]";
  }
}

export function traceFetch(fetchImplementation: typeof fetch, log: VerboseLogger): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? "GET";
    const headers = new Headers(init?.headers ?? request?.headers);
    log("central.request", { method, url, headers, body: requestBody(init?.body) });
    try {
      const response = await fetchImplementation(input, init);
      log("central.response", {
        method,
        url,
        status: response.status,
        duration_ms: Date.now() - started,
        headers: response.headers,
        body: await responseBody(response),
      });
      return response;
    } catch (error) {
      log("central.error", {
        method,
        url,
        duration_ms: Date.now() - started,
        error: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
  };
}
