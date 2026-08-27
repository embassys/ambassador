export type DevelopmentVerboseBoundary =
  | "central_mcp"
  | "central_rest"
  | "gateway"
  | "local_mcp"
  | "webhook";

export interface DevelopmentVerboseEvent {
  boundary: DevelopmentVerboseBoundary;
  direction: "error" | "request" | "response";
  method?: string;
  url?: string;
  status?: number;
  headers?: Headers | Record<string, unknown>;
  body?: unknown;
}

interface TranscriptWriter {
  write(chunk: string | Uint8Array): boolean;
}

const REDACTED = "<redacted>";
const SENSITIVE_KEYS = new Set([
  "access_token",
  "authorization",
  "cookie",
  "jwt",
  "set_cookie",
  "token",
  "webhook_token",
  "x_webhook_signature_v2",
]);
const VERIFICATION_CODE_KEYS = new Set(["code", "verification_code"]);

function normalizedKey(key: string): string {
  return key.trim().toLowerCase().replaceAll("-", "_");
}

function replaceAll(value: string, search: string, replacement: string): string {
  return search.length === 0 ? value : value.split(search).join(replacement);
}

function requestBody(value: RequestInit["body"]): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof URLSearchParams) return value.toString();
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return `<${value.constructor.name} body>`;
}

function headersRecord(value: RequestInit["headers"] | Headers): Record<string, string> {
  if (value === undefined) return {};
  return Object.fromEntries(new Headers(value).entries());
}

function responseBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class DevelopmentVerboseTranscript {
  readonly #secrets = new Set<string>();

  constructor(
    private readonly writer: TranscriptWriter,
    initialSecrets: readonly string[] = [],
  ) {
    for (const secret of initialSecrets) this.addSecret(secret);
  }

  addSecret(secret: string): void {
    if (secret.length > 0) this.#secrets.add(secret);
  }

  record(event: DevelopmentVerboseEvent): void {
    const sanitized = this.#sanitize({ event: "a2a_gateway_verbose", ...event });
    this.writer.write(`${JSON.stringify(sanitized)}\n`);
  }

  recordHttpRequest(
    boundary: DevelopmentVerboseBoundary,
    url: string | URL,
    init: RequestInit | undefined,
  ): void {
    this.record({
      boundary,
      direction: "request",
      method: init?.method ?? "GET",
      url: String(url),
      headers: headersRecord(init?.headers),
      body: requestBody(init?.body),
    });
  }

  recordError(boundary: DevelopmentVerboseBoundary, error: unknown): void {
    this.record({
      boundary,
      direction: "error",
      body:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { value: String(error) },
    });
  }

  wrapHttpResponse(boundary: DevelopmentVerboseBoundary, response: Response): Response {
    const base = {
      boundary,
      direction: "response" as const,
      status: response.status,
      headers: headersRecord(response.headers),
    };
    if (response.body === null) {
      this.record(base);
      return response;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let recorded = false;
    const record = (body: unknown): void => {
      if (recorded) return;
      recorded = true;
      this.record({ ...base, body });
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            record(responseBytes(chunks, size));
            controller.close();
            return;
          }
          const copy = item.value.slice();
          chunks.push(copy);
          size += copy.byteLength;
          controller.enqueue(item.value);
        } catch (error) {
          record({ transcript_error: error instanceof Error ? error.message : String(error) });
          controller.error(error);
        }
      },
      async cancel(reason) {
        record("<response body cancelled before it was read>");
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  #sanitize(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
    if (key !== undefined) {
      const normalized = normalizedKey(key);
      if (SENSITIVE_KEYS.has(normalized)) return REDACTED;
      if (
        VERIFICATION_CODE_KEYS.has(normalized) &&
        typeof value === "string" &&
        /^\d{6}$/u.test(value)
      ) {
        return REDACTED;
      }
    }

    if (typeof value === "string") return this.#sanitizeString(value);
    if (value instanceof Uint8Array) {
      return this.#sanitizeString(new TextDecoder("utf-8", { fatal: false }).decode(value));
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "<circular>";
    seen.add(value);

    if (value instanceof Headers) {
      return this.#sanitize(headersRecord(value), undefined, seen);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.#sanitize(item, undefined, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [nestedKey, nested] of Object.entries(value)) {
      result[nestedKey] = this.#sanitize(nested, nestedKey, seen);
    }
    return result;
  }

  #sanitizeString(value: string): string | unknown {
    let sanitized = value;
    for (const secret of this.#secrets) sanitized = replaceAll(sanitized, secret, REDACTED);
    sanitized = sanitized
      .replace(/Bearer\s+[^\s"']+/giu, `Bearer ${REDACTED}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
      .replace(
        /(["'](?:access_token|authorization|jwt|token|webhook_token)["']\s*:\s*["'])[^"']*(["'])/giu,
        `$1${REDACTED}$2`,
      )
      .replace(/(["'](?:code|verification_code)["']\s*:\s*["'])\d{6}(["'])/giu, `$1${REDACTED}$2`);

    try {
      return this.#sanitize(JSON.parse(sanitized) as unknown);
    } catch {
      return sanitized;
    }
  }
}
