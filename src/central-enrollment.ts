import { signupUsername } from "./agent-address.js";
import {
  type CentralCredentialRecord,
  createCentralCredentialRecord,
  type LoadedCentralCredential,
  parseCentralCredential,
} from "./central-credential.js";
import {
  assertNoCentralCredentialFields,
  CentralJsonError,
  isCentralRecord,
  readCentralJson,
} from "./central-json.js";
import type { CentralVerificationKeys } from "./central-verification-keys.js";
import { generateDpopKeyMaterial } from "./dpop.js";
import type { CentralToolDefinition } from "./mcp-contract.js";

const DEFAULT_DEADLINE_MS = 30_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CODE = /^\d{6}$/u;
const AGENT_ID = /^[A-Za-z0-9._~-]{1,256}$/u;

export type CentralEnrollmentErrorCode =
  | "central_enrollment_contract_failed"
  | "central_enrollment_outcome_uncertain"
  | "central_rate_limited"
  | "central_verification_credential_invalid"
  | "central_verification_response_unsafe"
  | "username_unavailable"
  | "username_invalid"
  | "registration_conflict"
  | "unsupported_email_format"
  | "verification_failed";

function errorMessage(code: CentralEnrollmentErrorCode): string {
  switch (code) {
    case "unsupported_email_format":
      return "The current Embassys service rejected this email address format";
    case "username_unavailable":
      return "This username is unavailable. Choose another username.";
    case "username_invalid":
      return "Choose a username with 5–32 letters or numbers.";
    case "registration_conflict":
      return "The email is already registered with Embassys";
    case "central_rate_limited":
      return "Embassys rate-limited the enrollment request";
    case "verification_failed":
      return "Embassys rejected the verification email or code";
    default:
      return "The Embassys enrollment request failed its contract";
  }
}

export class CentralEnrollmentError extends Error {
  constructor(readonly code: CentralEnrollmentErrorCode) {
    super(errorMessage(code));
    this.name = "CentralEnrollmentError";
  }
}

export interface CentralEnrollmentClientOptions {
  readonly centralOrigin: string;
  readonly fetch?: typeof fetch;
  readonly deadlineMs?: number;
  readonly deadlineSignal?: (milliseconds: number) => AbortSignal;
  readonly nowSeconds?: () => number;
  readonly verificationKeys?: CentralVerificationKeys;
  readonly recoveryKeys?: CentralVerificationKeys;
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
    description:
      "Register this local agent with Embassys Ambassador. Call this tool when the user says 'register me', 'sign me up', 'connect me to Embassys', or 'register me in Ambassador'. Use the supplied email and chosen username (5–32 letters or numbers). If the username is missing, ask the user to choose it; never claim a public handle on their behalf. Do not ask for a website URL or password. Follow any setup question returned by the tool.",
    inputSchema: schema(
      {
        email: { type: "string", minLength: 3, maxLength: 254 },
        username: { type: "string", minLength: 5, maxLength: 32, pattern: "^[A-Za-z0-9]{5,32}$" },
        display_name: { type: "string", minLength: 1, maxLength: 128 },
        delivery: {
          oneOf: [
            {
              type: "object",
              properties: { mode: { const: "direct" } },
              required: ["mode"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                mode: { const: "webhook" },
                url: { type: "string", minLength: 1, maxLength: 2_048 },
              },
              required: ["mode"],
              additionalProperties: false,
            },
          ],
        },
      },
      ["email"],
    ),
  },
  {
    name: "verify_email",
    description:
      "Finish Embassys registration through Ambassador. Call this tool when the user gives the six-digit code emailed after register_agent; use the same email and never ask for a password.",
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
    description:
      "Ask Embassys through Ambassador to email another registration code. Call this tool when the user says to resend the verification code for their unverified email.",
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
  return value.trim().toLowerCase();
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
  readonly #verificationKeys: CentralVerificationKeys | undefined;
  readonly #recoveryKeys: CentralVerificationKeys | undefined;

  constructor(options: CentralEnrollmentClientOptions) {
    this.#origin = exactOrigin(options.centralOrigin);
    this.#verificationKeys = options.verificationKeys;
    this.#recoveryKeys = options.recoveryKeys;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.#deadlineSignal = options.deadlineSignal ?? AbortSignal.timeout;
    this.#nowSeconds = options.nowSeconds ?? (() => Date.now() / 1_000);
    if (!Number.isSafeInteger(this.#deadlineMs) || this.#deadlineMs < 1) {
      throw failure("central_enrollment_contract_failed");
    }
  }

  async register(arguments_: unknown, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!exactKeys(arguments_, ["email", "username"], ["display_name"])) {
      throw failure("central_enrollment_contract_failed");
    }
    const requestEmail = email(arguments_.email).trim().toLowerCase();
    const parsedUsername = signupUsername.safeParse(arguments_.username);
    if (!parsedUsername.success) throw failure("username_invalid");
    const username = parsedUsername.data;
    const displayName =
      arguments_.display_name === undefined ? undefined : safeString(arguments_.display_name, 128);
    const response = await this.#post(
      "/api/register_agent",
      {
        email: requestEmail,
        username,
        ...(displayName === undefined ? {} : { display_name: displayName }),
      },
      signal,
    );
    if (response.status === 409) {
      let detail: unknown;
      try {
        detail = await readCentralJson(response, RESPONSE_MAX_BYTES);
      } catch {
        await cancel(response);
      }
      if (
        isCentralRecord(detail) &&
        typeof detail.detail === "string" &&
        /^Username .* (?:is already taken|is reserved)$/u.test(detail.detail)
      )
        throw failure("username_unavailable");
      throw failure("registration_conflict");
    }
    if (response.status === 422 && requestEmail.includes("+")) {
      await cancel(response);
      throw failure("unsupported_email_format");
    }
    const result = await this.#success(response);
    if (
      !exactKeys(result, ["agent_id", "email", "username", "message"]) ||
      result.username !== username ||
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
    return { agent_id: result.agent_id, email: requestEmail, username, message: result.message };
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
    const key = (await this.#verificationKeys?.forEmail(requestEmail)) ?? generateDpopKeyMaterial();
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
      !exactKeys(result, ["agent_id", "email", "token", "message"], ["jkt", "replayed"]) ||
      typeof result.agent_id !== "string" ||
      !AGENT_ID.test(result.agent_id) ||
      result.email !== requestEmail ||
      typeof result.token !== "string" ||
      typeof result.message !== "string" ||
      (result.replayed !== undefined && typeof result.replayed !== "boolean") ||
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

  async startRecovery(arguments_: unknown, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!exactKeys(arguments_, ["email"])) throw failure("central_enrollment_contract_failed");
    const result = await this.#success(
      await this.#post("/api/start_recovery", { email: email(arguments_.email) }, signal),
    );
    if (
      !exactKeys(result, ["message"]) ||
      typeof result.message !== "string" ||
      result.message.length > 2048
    )
      throw failure("central_enrollment_contract_failed");
    return { message: result.message };
  }
  async completeRecovery(
    arguments_: unknown,
    signal?: AbortSignal,
    previous?: LoadedCentralCredential,
  ): Promise<VerificationEnrollmentSuccess> {
    if (
      !exactKeys(arguments_, ["email", "code"]) ||
      typeof arguments_.code !== "string" ||
      !CODE.test(arguments_.code)
    )
      throw failure("central_enrollment_contract_failed");
    const requestEmail = email(arguments_.email);
    if (previous && (previous.token.email !== requestEmail || previous.token.executionDeviceId))
      throw failure("central_enrollment_contract_failed");
    const key = previous
      ? {
          privateKey: previous.privateKey,
          privateKeyPkcs8: previous.record.dpop_private_key_pkcs8,
          publicJwk: previous.publicJwk,
          thumbprint: previous.keyThumbprint,
        }
      : ((await this.#recoveryKeys?.forEmail(requestEmail)) ?? generateDpopKeyMaterial());
    const response = await this.#post(
      "/api/complete_recovery",
      { email: requestEmail, code: arguments_.code, jwk: key.publicJwk },
      signal,
    );
    if (!response.ok) {
      await cancel(response);
      throw failure(
        response.status === 429
          ? "central_rate_limited"
          : response.status >= 500
            ? "central_enrollment_outcome_uncertain"
            : "verification_failed",
      );
    }
    if (!noStore(response.headers) || response.headers.has("set-cookie")) {
      await cancel(response);
      throw failure("central_verification_response_unsafe");
    }
    const result = await readCentralJson(response, RESPONSE_MAX_BYTES);
    if (
      !exactKeys(result, [
        "agent_id",
        "email",
        "token",
        "jkt",
        "expires_at",
        "revoked_keys",
        "message",
      ]) ||
      typeof result.token !== "string" ||
      result.email !== requestEmail ||
      typeof result.agent_id !== "string" ||
      !AGENT_ID.test(result.agent_id) ||
      result.jkt !== key.thumbprint ||
      !Number.isSafeInteger(result.revoked_keys) ||
      Number(result.revoked_keys) < 0 ||
      typeof result.expires_at !== "string" ||
      !Number.isFinite(Date.parse(result.expires_at)) ||
      typeof result.message !== "string" ||
      result.message.length > 2048
    )
      throw failure("central_verification_credential_invalid");
    const credential = createCentralCredentialRecord(result.token, key);
    const loaded = parseCentralCredential(credential, this.#nowSeconds);
    if (
      loaded.token.email !== requestEmail ||
      loaded.token.subject !== result.agent_id ||
      (previous && previous.token.subject !== result.agent_id)
    )
      throw failure("central_verification_credential_invalid");
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
  async recoveryCommitted(): Promise<void> {
    await this.#recoveryKeys?.clear();
  }
  async verificationCommitted(): Promise<void> {
    await this.#verificationKeys?.clear();
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
