import {
  type CentralCredentialRecord,
  createCentralCredentialRecord,
  parseCentralCredential,
} from "./central-credential.js";
import {
  assertNoCentralCredentialFields,
  CentralJsonError,
  isCentralRecord,
  readCentralJson,
} from "./central-json.js";
import { generateDpopKeyMaterial } from "./dpop.js";
import type { CentralToolDefinition } from "./mcp-contract.js";

const DEFAULT_DEADLINE_MS = 30_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const EMAIL = /^[\w.-]+@[\w.-]+\.\w+$/u;
const CODE = /^\d{6}$/u;
const AGENT_ID = /^[A-Za-z0-9._~-]{1,256}$/u;

export type CentralEnrollmentErrorCode =
  | "central_enrollment_contract_failed"
  | "central_enrollment_outcome_uncertain"
  | "central_rate_limited"
  | "central_verification_credential_invalid"
  | "central_verification_response_unsafe"
  | "registration_conflict"
  | "verification_failed";

export class CentralEnrollmentError extends Error {
  constructor(readonly code: CentralEnrollmentErrorCode) {
    super("Central enrollment failed");
    this.name = "CentralEnrollmentError";
  }
}

export interface CentralEnrollmentClientOptions {
  readonly centralOrigin: string;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
  readonly deadlineSignal?: (milliseconds: number) => AbortSignal;
  readonly nowSeconds?: () => number;
}

export interface VerificationEnrollmentSuccess {
  readonly credential: CentralCredentialRecord;
  readonly localResult: {
    readonly verified: true;
    readonly agent_id: string;
    readonly email: string;
    readonly message: "Email verified successfully.";
  };
}

function schema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

export const REST_BOOTSTRAP_TOOLS: readonly CentralToolDefinition[] = [
  {
    name: "register_agent",
    description: "Register an email identity with the central service.",
    inputSchema: schema(
      {
        email: { type: "string", minLength: 3, maxLength: 254 },
        display_name: { type: "string", minLength: 1, maxLength: 128 },
      },
      ["email"],
    ),
  },
  {
    name: "verify_email",
    description: "Verify the six-digit code sent to the registered email.",
    inputSchema: schema(
      {
        email: { type: "string", minLength: 3, maxLength: 254 },
        code: { type: "string", pattern: "^[0-9]{6}$" },
      },
      ["email", "code"],
    ),
  },
  {
    name: "resend_verification",
    description: "Send a new verification code to an unverified email identity.",
    inputSchema: schema({ email: { type: "string", minLength: 3, maxLength: 254 } }, ["email"]),
  },
] as const;

function failure(code: CentralEnrollmentErrorCode): CentralEnrollmentError {
  return new CentralEnrollmentError(code);
}

function exactOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw failure("central_enrollment_contract_failed");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(origin.hostname);
  if (
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw failure("central_enrollment_contract_failed");
  }
  return origin;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isCentralRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((name) => Object.hasOwn(value, name)) &&
    Object.keys(value).every((name) => allowed.has(name))
  );
}

function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL.test(value)) {
    throw failure("central_enrollment_contract_failed");
  }
  return value;
}

function safeString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw failure("central_enrollment_contract_failed");
  }
  return value;
}

function noStore(headers: Headers): boolean {
  return (
    headers
      .get("cache-control")
      ?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store") === true
  );
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export class CentralEnrollmentClient {
  readonly #origin: URL;
  readonly #fetch: typeof fetch;
  readonly #deadlineMs: number;
  readonly #deadlineSignal: (milliseconds: number) => AbortSignal;
  readonly #nowSeconds: () => number;

  constructor(options: CentralEnrollmentClientOptions) {
    this.#origin = exactOrigin(options.centralOrigin);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.#deadlineSignal = options.deadlineSignal ?? AbortSignal.timeout;
    this.#nowSeconds = options.nowSeconds ?? (() => Date.now() / 1_000);
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 1) {
      throw failure("central_enrollment_contract_failed");
    }
  }

  async register(arguments_: unknown, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!exactKeys(arguments_, ["email"], ["display_name"])) {
      throw failure("central_enrollment_contract_failed");
    }
    const requestEmail = email(arguments_.email);
    const displayName =
      arguments_.display_name === undefined ? undefined : safeString(arguments_.display_name, 128);
    const response = await this.#post(
      "/api/register_agent",
      { email: requestEmail, ...(displayName === undefined ? {} : { display_name: displayName }) },
      signal,
    );
    if (response.status === 409) {
      await cancel(response);
      throw failure("registration_conflict");
    }
    const result = await this.#success(response);
    if (
      !exactKeys(result, ["agent_id", "email", "message"]) ||
      typeof result.agent_id !== "string" ||
      !AGENT_ID.test(result.agent_id) ||
      result.email !== requestEmail ||
      typeof result.message !== "string" ||
      result.message.length < 1 ||
      result.message.length > 512
    ) {
      throw failure("central_enrollment_contract_failed");
    }
    assertNoCentralCredentialFields(result);
    return { agent_id: result.agent_id, email: requestEmail, message: result.message };
  }

  async resend(arguments_: unknown, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!exactKeys(arguments_, ["email"])) {
      throw failure("central_enrollment_contract_failed");
    }
    const response = await this.#post(
      "/api/resend_verification",
      { email: email(arguments_.email) },
      signal,
    );
    const result = await this.#success(response);
    if (
      !exactKeys(result, ["message"]) ||
      typeof result.message !== "string" ||
      result.message.length < 1 ||
      result.message.length > 512
    ) {
      throw failure("central_enrollment_contract_failed");
    }
    assertNoCentralCredentialFields(result);
    return { message: result.message };
  }

  async verify(arguments_: unknown, signal?: AbortSignal): Promise<VerificationEnrollmentSuccess> {
    if (!exactKeys(arguments_, ["email", "code"])) {
      throw failure("central_enrollment_contract_failed");
    }
    const requestEmail = email(arguments_.email);
    if (typeof arguments_.code !== "string" || !CODE.test(arguments_.code)) {
      throw failure("central_enrollment_contract_failed");
    }
    const key = generateDpopKeyMaterial();
    const response = await this.#post(
      "/api/verify_email",
      { email: requestEmail, code: arguments_.code, jwk: key.publicJwk },
      signal,
    );
    if (response.status >= 400 && response.status < 500) {
      await cancel(response);
      throw failure(response.status === 429 ? "central_rate_limited" : "verification_failed");
    }
    if (!response.ok || !noStore(response.headers) || response.headers.has("set-cookie")) {
      await cancel(response);
      throw failure("central_verification_response_unsafe");
    }
    let result: unknown;
    try {
      result = await readCentralJson(response, RESPONSE_MAX_BYTES);
    } catch {
      throw failure("central_verification_response_unsafe");
    }
    if (
      !exactKeys(result, ["agent_id", "email", "token", "message"], ["jkt"]) ||
      typeof result.agent_id !== "string" ||
      !AGENT_ID.test(result.agent_id) ||
      result.email !== requestEmail ||
      typeof result.token !== "string" ||
      typeof result.message !== "string" ||
      (result.jkt !== undefined && result.jkt !== key.thumbprint)
    ) {
      throw failure("central_verification_credential_invalid");
    }
    let credential: CentralCredentialRecord;
    try {
      credential = createCentralCredentialRecord(result.token, key);
      const loaded = parseCentralCredential(credential, this.#nowSeconds);
      if (
        loaded.token.subject !== result.agent_id ||
        loaded.token.email !== requestEmail ||
        loaded.keyThumbprint !== key.thumbprint
      ) {
        throw new Error("binding mismatch");
      }
      assertNoCentralCredentialFields({
        agent_id: result.agent_id,
        email: result.email,
        message: result.message,
      });
    } catch {
      throw failure("central_verification_credential_invalid");
    }
    return {
      credential,
      localResult: {
        verified: true,
        agent_id: result.agent_id,
        email: requestEmail,
        message: "Email verified successfully.",
      },
    };
  }

  async #post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let deadline: AbortSignal;
    try {
      deadline = this.#deadlineSignal(this.#deadlineMs);
    } catch {
      throw failure("central_enrollment_contract_failed");
    }
    const requestSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    try {
      return await this.#fetch(new URL(path, this.#origin), {
        method: "POST",
        headers: { "accept-encoding": "identity", "content-type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "manual",
        signal: requestSignal,
      });
    } catch {
      throw failure("central_enrollment_outcome_uncertain");
    }
  }

  async #success(response: Response): Promise<unknown> {
    if (response.status === 429) {
      await cancel(response);
      throw failure("central_rate_limited");
    }
    if (
      !response.ok ||
      response.status < 200 ||
      response.status >= 300 ||
      response.headers.has("set-cookie")
    ) {
      await cancel(response);
      throw failure("central_enrollment_contract_failed");
    }
    try {
      return await readCentralJson(response, RESPONSE_MAX_BYTES);
    } catch (error) {
      if (error instanceof CentralJsonError) throw failure("central_enrollment_contract_failed");
      throw failure("central_enrollment_contract_failed");
    }
  }
}
