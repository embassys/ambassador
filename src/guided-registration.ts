import {
  type AgentCapability,
  type AgentClientInfo,
  PRODUCTION_AGENT_CAPABILITIES,
  resolveAgentCapability,
} from "./agent-capabilities.js";
import {
  createDeliveryProfile,
  type DeliveryInput,
  type DeliveryProfileStore,
} from "./delivery-profile.js";

export type GuidedRegistrationErrorCode = "invalid_arguments" | "registration_failed";

export class GuidedRegistrationError extends Error {
  constructor(readonly code: GuidedRegistrationErrorCode) {
    super("Guided registration failed");
    this.name = "GuidedRegistrationError";
  }
}

export interface CentralRegistrationArguments {
  readonly email: string;
  readonly display_name?: string;
}

export interface GuidedRegistrationOptions {
  readonly registry?: readonly AgentCapability[];
  readonly profileStore: DeliveryProfileStore;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly registerCentral: (
    arguments_: CentralRegistrationArguments,
    signal: AbortSignal,
  ) => Promise<Record<string, string>>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function invalid(): GuidedRegistrationError {
  return new GuidedRegistrationError("invalid_arguments");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function centralArguments(value: Record<string, unknown>): CentralRegistrationArguments {
  if (typeof value.email !== "string" || value.email.length > 254 || !EMAIL.test(value.email)) {
    throw invalid();
  }
  if (
    value.display_name !== undefined &&
    (typeof value.display_name !== "string" ||
      value.display_name.length < 1 ||
      value.display_name.length > 128)
  ) {
    throw invalid();
  }
  return {
    email: value.email,
    ...(value.display_name === undefined ? {} : { display_name: value.display_name as string }),
  };
}

function deliveryInput(value: unknown): DeliveryInput {
  if (!isRecord(value) || typeof value.mode !== "string") throw invalid();
  if (value.mode === "direct" && exactKeys(value, ["mode"])) return { mode: "direct" };
  if (
    value.mode === "webhook" &&
    exactKeys(value, ["mode", "url", "secret_env"]) &&
    typeof value.url === "string" &&
    typeof value.secret_env === "string"
  ) {
    return { mode: "webhook", url: value.url, secret_env: value.secret_env };
  }
  throw invalid();
}

export class GuidedRegistration {
  readonly #registry: readonly AgentCapability[];
  readonly #profileStore: DeliveryProfileStore;
  readonly #workingDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #registerCentral: GuidedRegistrationOptions["registerCentral"];

  constructor(options: GuidedRegistrationOptions) {
    this.#registry = options.registry ?? PRODUCTION_AGENT_CAPABILITIES;
    this.#profileStore = options.profileStore;
    this.#workingDirectory = options.workingDirectory;
    this.#environment = options.environment;
    this.#registerCentral = options.registerCentral;
  }

  async register(
    untrustedArguments: unknown,
    clientInfo: AgentClientInfo | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const resolution = resolveAgentCapability(clientInfo, this.#registry);
    if (resolution.status === "unsupported") {
      return {
        status: "unsupported_agent",
        message: "This MCP client is not supported by this Ambassador version.",
      };
    }
    if (
      !isRecord(untrustedArguments) ||
      !exactKeys(untrustedArguments, ["email"], ["display_name", "delivery"])
    ) {
      throw invalid();
    }
    const registration = centralArguments(untrustedArguments);
    const capability = resolution.profile;
    const suppliedDelivery =
      untrustedArguments.delivery === undefined
        ? undefined
        : deliveryInput(untrustedArguments.delivery);

    let delivery: DeliveryInput;
    if (suppliedDelivery === undefined) {
      if (capability.modes.length !== 1 || capability.modes[0] !== "direct") {
        return {
          status: "input_required",
          prompt: "How should incoming requests reach this agent?",
          required: ["delivery"],
          default: "direct",
          choices: [
            {
              value: "direct",
              label: `Send directly to this ${capability.displayName} agent`,
            },
            { value: "webhook", label: "Send to a webhook" },
          ],
        };
      }
      delivery = { mode: "direct" };
    } else {
      delivery = suppliedDelivery;
    }

    if (!capability.modes.includes(delivery.mode)) throw invalid();
    try {
      const profile = await createDeliveryProfile(
        capability,
        delivery,
        this.#workingDirectory,
        this.#environment,
      );
      await this.#profileStore.save(profile);
      return await this.#registerCentral(registration, signal);
    } catch (error) {
      if (error instanceof GuidedRegistrationError) throw error;
      throw new GuidedRegistrationError("registration_failed");
    }
  }
}
