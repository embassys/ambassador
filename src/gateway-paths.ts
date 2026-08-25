import { posix, win32 } from "node:path";

export interface GatewayPaths {
  stateDirectory: string;
  journalPath: string;
  lockPath: string;
  credentialPath: string;
}

export function pathsForStateDirectory(
  stateDirectory: string,
  join: typeof posix.join = posix.join,
): GatewayPaths {
  return {
    stateDirectory,
    journalPath: join(stateDirectory, "notifications.sqlite"),
    lockPath: join(stateDirectory, "gateway.lock"),
    credentialPath: join(stateDirectory, "central-credential.json"),
  };
}

export function defaultGatewayPaths(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): GatewayPaths {
  if (homeDirectory.length === 0) {
    throw new Error("Home directory is unavailable");
  }

  if (platform === "darwin") {
    return pathsForStateDirectory(
      posix.join(homeDirectory, "Library", "Application Support", "a2a-gateway"),
    );
  }

  if (platform === "linux") {
    const stateRoot = environment.XDG_STATE_HOME || posix.join(homeDirectory, ".local", "state");
    return pathsForStateDirectory(posix.join(stateRoot, "a2a-gateway"));
  }

  if (platform === "win32") {
    const stateRoot = environment.LOCALAPPDATA || win32.join(homeDirectory, "AppData", "Local");
    return pathsForStateDirectory(win32.join(stateRoot, "a2a-gateway"), win32.join);
  }

  throw new Error("Unsupported platform");
}
