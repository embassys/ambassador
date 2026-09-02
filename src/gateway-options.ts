export class GatewayOptionsError extends Error {
  readonly exitCode: 2 | 4;

  constructor(exitCode: 2 | 4) {
    super(exitCode === 2 ? "Invalid command or arguments" : "Invalid webhook token");
    this.name = "GatewayOptionsError";
    this.exitCode = exitCode;
  }
}

export interface GatewayStartOptions {
  readonly webhookUrl: string;
  readonly webhookTokenEnv: string;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const GENERATED_HOOK_TOKEN = /^[0-9a-f]{48}$/u;
const LOOPBACK_AUTHORITY = /^https?:\/\/127\.0\.0\.1:([0-9]{1,5})(?:[/?]|$)/u;

function parseWebhookUrl(value: string): string {
  const authority = LOOPBACK_AUTHORITY.exec(value);
  const port = Number(authority?.[1]);
  if (
    authority === null ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    value.trim() !== value ||
    /[\r\n]/u.test(value)
  ) {
    throw new GatewayOptionsError(2);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayOptionsError(2);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new GatewayOptionsError(2);
  }
  return value;
}

export function parseGatewayStartOptions(args: string[]): GatewayStartOptions {
  if (args.length !== 3 || args[0] !== "start") throw new GatewayOptionsError(2);
  let webhookUrl: string | undefined;
  let webhookTokenEnv: string | undefined;
  for (const argument of args.slice(1)) {
    if (argument.startsWith("--webhook-url=") && webhookUrl === undefined) {
      webhookUrl = parseWebhookUrl(argument.slice("--webhook-url=".length));
      continue;
    }
    if (argument.startsWith("--webhook-token-env=") && webhookTokenEnv === undefined) {
      const value = argument.slice("--webhook-token-env=".length);
      if (!ENVIRONMENT_NAME.test(value)) throw new GatewayOptionsError(2);
      webhookTokenEnv = value;
      continue;
    }
    throw new GatewayOptionsError(2);
  }
  if (webhookUrl === undefined || webhookTokenEnv === undefined) throw new GatewayOptionsError(2);
  return { webhookUrl, webhookTokenEnv };
}

export function resolveWebhookToken(environment: NodeJS.ProcessEnv, variableName: string): string {
  const value = environment[variableName];
  if (value === undefined || !GENERATED_HOOK_TOKEN.test(value)) throw new GatewayOptionsError(4);
  return value;
}
