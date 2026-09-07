import { z } from "zod";
import { capabilityForKind } from "../agent-capabilities.js";
import { type CentralEnrollmentClient, CentralEnrollmentError } from "../central-enrollment.js";
import {
  createDeliveryProfile,
  type DeliveryProfile,
  type DeliveryProfileStore,
  validateStoredDeliveryProfile,
} from "../delivery-profile.js";
import type { GatewayIdentity } from "../identity.js";
import { readLocalSettings, writeLocalSettings } from "./local-settings.js";

export const desktopExecutor = z.enum(["claude", "codex", "openclaw", "hermes"]);
export const registrationInput = z.strictObject({
  email: z
    .string()
    .trim()
    .min(3)
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  executor: desktopExecutor,
});
const recordSchema = registrationInput.extend({
  phase: z.enum([
    "awaiting_code",
    "registration_uncertain",
    "verification_uncertain",
    "rejected",
    "conflict",
  ]),
  agentId: z.string().max(256).optional(),
  displayName: z.string().min(1).max(128).optional(),
  message: z.string().max(512).optional(),
  resendAfter: z.number().int().nonnegative(),
});
type RegistrationRecord = z.infer<typeof recordSchema>;
export interface RegistrationSnapshot {
  phase: "new" | "registered" | RegistrationRecord["phase"];
  email?: string;
  executor?: z.infer<typeof desktopExecutor>;
  message?: string | undefined;
  resendAfter?: number;
  credentialStatus?: string;
}
interface Options {
  path: string;
  profileStore: DeliveryProfileStore;
  workingDirectory: string;
  identity: GatewayIdentity;
  client: Pick<CentralEnrollmentClient, "register" | "verify" | "resend">;
  activate(): Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
}

export class DesktopRegistration {
  #record: RegistrationRecord | undefined;
  #busy = false;
  #verifiedResult: Record<string, unknown> | undefined;
  #resendResult: Record<string, string> | undefined;
  #lastError: CentralEnrollmentError | undefined;
  private constructor(
    readonly options: Options,
    record?: RegistrationRecord,
  ) {
    this.#record = record;
  }
  static async open(options: Options): Promise<DesktopRegistration> {
    return new DesktopRegistration(options, await readLocalSettings(options.path, recordSchema));
  }
  snapshot(): RegistrationSnapshot {
    if (this.options.identity.enrolled)
      return {
        phase: "registered",
        email: String(this.options.identity.enrollment.email),
        credentialStatus: this.options.identity.expired ? "expired" : "active",
        ...(this.#record ? { executor: this.#record.executor } : {}),
      };
    return this.#record ? { ...this.#record } : { phase: "new" };
  }
  async #save(record: RegistrationRecord): Promise<void> {
    await writeLocalSettings(this.options.path, record);
    this.#record = record;
  }
  async #exclusive(operation: () => Promise<void>): Promise<RegistrationSnapshot> {
    if (this.options.identity.enrolled) return this.snapshot();
    if (this.#busy) throw new Error("Registration is already in progress.");
    this.#busy = true;
    this.#lastError = undefined;
    try {
      await operation();
      return this.snapshot();
    } finally {
      this.#busy = false;
    }
  }
  register(
    raw: unknown,
    prepared?: DeliveryProfile,
    displayName?: string,
  ): Promise<RegistrationSnapshot> {
    return this.#exclusive(async () => {
      const input = registrationInput.parse(raw);
      const previous = this.#record;
      if (previous && previous.phase !== "rejected") {
        if (
          previous.email !== input.email ||
          previous.executor !== input.executor ||
          previous.displayName !== displayName
        )
          throw new Error("Finish the saved registration first.");
        if (
          prepared &&
          JSON.stringify(await this.options.profileStore.load()) !== JSON.stringify(prepared)
        )
          throw new Error("Finish registration with the saved delivery profile.");
        return;
      }
      const capability = capabilityForKind(input.executor);
      if (!capability?.direct) throw new Error("This executor is unavailable.");
      if (prepared) {
        await validateStoredDeliveryProfile(prepared, this.options.workingDirectory);
        if (prepared.agent_kind !== input.executor)
          throw new Error("The selected executor changed.");
      }
      await this.options.profileStore.save(
        prepared ??
          (await createDeliveryProfile(
            capability,
            { mode: "direct" },
            this.options.workingDirectory,
          )),
      );
      const record: RegistrationRecord = {
        ...input,
        ...(displayName ? { displayName } : {}),
        phase: "registration_uncertain",
        resendAfter: (this.options.now?.() ?? Date.now()) + 60_000,
        message:
          "Registration was sent, but its outcome is unconfirmed. Enter the emailed code if it arrived. This request will not be repeated automatically.",
      };
      await this.#save(record);
      try {
        const result = await this.options.client.register(
          { email: input.email, ...(displayName ? { display_name: displayName } : {}) },
          this.options.signal,
        );
        await this.#save({
          ...record,
          agentId: result.agent_id,
          phase: "awaiting_code",
          message: "Enter the six-digit code sent to your email.",
        });
      } catch (error) {
        if (error instanceof CentralEnrollmentError) this.#lastError = error;
        if (
          error instanceof CentralEnrollmentError &&
          ["registration_conflict", "unsupported_email_format", "central_rate_limited"].includes(
            error.code,
          )
        ) {
          await this.#save({
            ...record,
            phase: error.code === "registration_conflict" ? "conflict" : "rejected",
            message:
              error.code === "registration_conflict"
                ? "This email is already registered. Open its shared CLI installation, or use Account to sign in. Account sign-in cannot restore a lost local agent; Clean will not fix that."
                : error.code === "central_rate_limited"
                  ? "Too many requests. Wait before trying again."
                  : "The server rejected this email format. It does not support +tag addresses yet.",
          });
        }
      }
    });
  }
  async registerFromTools(
    arguments_: { email: string; display_name?: string },
    profile: DeliveryProfile,
  ): Promise<Record<string, unknown>> {
    const state = await this.register(
      { email: arguments_.email, executor: profile.agent_kind },
      profile,
      arguments_.display_name,
    );
    if (this.#lastError) throw this.#lastError;
    if (state.phase === "conflict") throw new CentralEnrollmentError("registration_conflict");
    if (state.phase !== "awaiting_code" || !this.#record?.agentId)
      throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
    return { agent_id: this.#record.agentId, email: state.email, message: state.message };
  }
  async verifyFromTools(raw: unknown): Promise<Record<string, unknown>> {
    const input = z
      .strictObject({ email: registrationInput.shape.email, code: z.string().regex(/^\d{6}$/u) })
      .parse(raw);
    if (!this.#record || input.email !== this.#record.email)
      throw new Error("Use the email from the saved registration.");
    const result = await this.verify(input.code);
    if (this.#lastError) throw this.#lastError;
    if (result.phase === "awaiting_code") throw new CentralEnrollmentError("verification_failed");
    if (result.phase !== "registered" || !this.#verifiedResult)
      throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
    return this.#verifiedResult;
  }
  async resendFromTools(raw: unknown): Promise<Record<string, unknown>> {
    const input = z.strictObject({ email: registrationInput.shape.email }).parse(raw);
    if (!this.#record || input.email !== this.#record.email)
      throw new Error("Use the email from the saved registration.");
    await this.resend();
    if (this.#lastError) throw this.#lastError;
    if (!this.#resendResult)
      throw new CentralEnrollmentError("central_enrollment_outcome_uncertain");
    return this.#resendResult;
  }
  verify(code: string): Promise<RegistrationSnapshot> {
    return this.#exclusive(async () => {
      z.string()
        .regex(/^\d{6}$/u)
        .parse(code);
      const record = this.#record;
      if (!record || record.phase === "rejected" || record.phase === "conflict")
        throw new Error("Register this instance first.");
      if (record.phase === "verification_uncertain") return;
      await this.#save({
        ...record,
        phase: "verification_uncertain",
        message:
          "Verification may have completed centrally, but no local credential was confirmed. Do not register again or use Clean. Central identity recovery is required.",
      });
      try {
        this.#verifiedResult = await this.options.identity.enroll(async () => {
          const result = await this.options.client.verify(
            { email: record.email, code },
            this.options.signal,
          );
          if (record.agentId && result.localResult.agent_id !== record.agentId)
            throw new Error("Verification identity mismatch.");
          return result;
        });
      } catch (error) {
        if (error instanceof CentralEnrollmentError) this.#lastError = error;
        if (
          error instanceof CentralEnrollmentError &&
          ["verification_failed", "central_rate_limited"].includes(error.code)
        )
          await this.#save({
            ...record,
            phase: "awaiting_code",
            message:
              error.code === "central_rate_limited"
                ? "Too many verification attempts. Wait before trying again."
                : "The code was rejected. Check the email and try the latest six-digit code.",
          });
        return;
      }
      // Credential custody is authoritative even if delivery activation fails afterward.
      await this.options.activate();
    });
  }
  resend(): Promise<RegistrationSnapshot> {
    return this.#exclusive(async () => {
      this.#resendResult = undefined;
      const record = this.#record;
      if (!record || !["awaiting_code", "registration_uncertain"].includes(record.phase))
        throw new Error("No resend is available for this registration.");
      const now = this.options.now?.() ?? Date.now();
      if (now < record.resendAfter)
        throw new Error("Wait one minute before requesting another code.");
      await this.#save({
        ...record,
        resendAfter: now + 60_000,
        message: "Another code was requested. Check your email; delivery is not yet confirmed.",
      });
      try {
        this.#resendResult = await this.options.client.resend(
          { email: record.email },
          this.options.signal,
        );
        await this.#save({
          ...record,
          phase: "awaiting_code",
          resendAfter: now + 60_000,
          message: "Enter the latest code sent to your email.",
        });
      } catch (error) {
        if (error instanceof CentralEnrollmentError) this.#lastError = error;
        /* Preserve the request time so repeated clicks cannot send more mail. */
      }
    });
  }
}
