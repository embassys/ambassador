import { NotImplementedError } from "./errors.js";

export interface SidecarPaths {
  configPath: string;
  stateDirectory: string;
  journalPath: string;
  lockPath: string;
}

export function defaultPaths(
  _platform: NodeJS.Platform,
  _env: NodeJS.ProcessEnv,
  _homeDirectory: string,
): SidecarPaths {
  throw new NotImplementedError("defaultPaths");
}
