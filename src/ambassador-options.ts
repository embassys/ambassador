export class AmbassadorOptionsError extends Error {
  readonly exitCode = 2;

  constructor() {
    super("Invalid command or arguments");
    this.name = "AmbassadorOptionsError";
  }
}

export type AmbassadorStartOptions = Record<string, never>;

export function parseAmbassadorStartOptions(args: readonly string[]): AmbassadorStartOptions {
  if (args.length !== 1 || args[0] !== "start") throw new AmbassadorOptionsError();
  return {};
}
