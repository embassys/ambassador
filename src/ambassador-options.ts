export class AmbassadorOptionsError extends Error {
  readonly exitCode = 2;

  constructor() {
    super("Invalid command or arguments");
    this.name = "AmbassadorOptionsError";
  }
}

export type AmbassadorStartOptions = Record<string, never>;

export type AmbassadorCommand = { readonly command: "start" | "webhook-secret" | "clean" };

export function parseAmbassadorCommand(args: readonly string[]): AmbassadorCommand {
  if (
    args.length !== 1 ||
    (args[0] !== "start" && args[0] !== "webhook-secret" && args[0] !== "clean")
  ) {
    throw new AmbassadorOptionsError();
  }
  return { command: args[0] };
}

export function parseAmbassadorStartOptions(args: readonly string[]): AmbassadorStartOptions {
  if (parseAmbassadorCommand(args).command !== "start") throw new AmbassadorOptionsError();
  return {};
}
