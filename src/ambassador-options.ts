export class AmbassadorOptionsError extends Error {
  readonly exitCode: 2 | 4;

  constructor(exitCode: 2 | 4) {
    super(exitCode === 2 ? "Invalid command or arguments" : "Invalid local token");
    this.name = "AmbassadorOptionsError";
    this.exitCode = exitCode;
  }
}

export interface AmbassadorStartOptions {
  readonly localTokenEnv: string;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const GENERATED_LOCAL_TOKEN = /^[0-9a-f]{48}$/u;
const OPTION_PREFIX = "--local-token-env=";

export function parseAmbassadorStartOptions(args: readonly string[]): AmbassadorStartOptions {
  if (args.length !== 2 || args[0] !== "start") throw new AmbassadorOptionsError(2);
  const option = args[1];
  if (option === undefined || !option.startsWith(OPTION_PREFIX)) {
    throw new AmbassadorOptionsError(2);
  }
  const localTokenEnv = option.slice(OPTION_PREFIX.length);
  if (!ENVIRONMENT_NAME.test(localTokenEnv)) throw new AmbassadorOptionsError(2);
  return { localTokenEnv };
}

export function resolveLocalToken(environment: NodeJS.ProcessEnv, variableName: string): string {
  const value = environment[variableName];
  if (value === undefined || !GENERATED_LOCAL_TOKEN.test(value)) {
    throw new AmbassadorOptionsError(4);
  }
  return value;
}
