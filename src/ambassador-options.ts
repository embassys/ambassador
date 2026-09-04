export class AmbassadorOptionsError extends Error {
  readonly exitCode = 2;

  constructor() {
    super("Invalid command or arguments");
    this.name = "AmbassadorOptionsError";
  }
}

export interface AmbassadorStartOptions {
  readonly verbose: boolean;
}

export type AmbassadorCommand =
  | { readonly command: "start"; readonly verbose: boolean }
  | { readonly command: "webhook-secret" | "clean" }
  | { readonly command: "sessions"; readonly action: "list" }
  | {
      readonly command: "sessions";
      readonly action: "show";
      readonly sessionId: string;
      readonly verbose: boolean;
    }
  | {
      readonly command: "sessions";
      readonly action: "delete" | "forget";
      readonly sessionId: string;
    };

const SESSION_ID = /^[\x20-\x7e]{1,512}$/u;

export function parseAmbassadorCommand(args: readonly string[]): AmbassadorCommand {
  if (
    args[0] === "start" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--verbose"))
  ) {
    return { command: "start", verbose: args.length === 2 };
  }
  if (args.length === 1 && (args[0] === "webhook-secret" || args[0] === "clean")) {
    return { command: args[0] };
  }
  if (args[0] === "sessions") {
    if (args.length === 2 && args[1] === "list") {
      return { command: "sessions", action: "list" };
    }
    if (
      args[1] === "show" &&
      args[2] !== undefined &&
      SESSION_ID.test(args[2]) &&
      (args.length === 3 || (args.length === 4 && args[3] === "--verbose"))
    ) {
      return {
        command: "sessions",
        action: "show",
        sessionId: args[2],
        verbose: args.length === 4,
      };
    }
    if (
      (args[1] === "delete" || args[1] === "forget") &&
      args.length === 3 &&
      args[2] !== undefined &&
      SESSION_ID.test(args[2])
    ) {
      return { command: "sessions", action: args[1], sessionId: args[2] };
    }
  }
  throw new AmbassadorOptionsError();
}

export function parseAmbassadorStartOptions(args: readonly string[]): AmbassadorStartOptions {
  const command = parseAmbassadorCommand(args);
  if (command.command !== "start") throw new AmbassadorOptionsError();
  return { verbose: command.verbose };
}
