import { posix, win32 } from "node:path";

export interface SidecarPaths {
  configPath: string;
  stateDirectory: string;
  journalPath: string;
  lockPath: string;
}

function paths(
  configDirectory: string,
  stateDirectory: string,
  join: typeof posix.join,
): SidecarPaths {
  return {
    configPath: join(configDirectory, "config.json"),
    stateDirectory,
    journalPath: join(stateDirectory, "journal.sqlite"),
    lockPath: join(stateDirectory, "daemon.lock"),
  };
}

export function defaultPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): SidecarPaths {
  if (homeDirectory.length === 0) throw new Error("Home directory is unavailable");

  if (platform === "darwin") {
    const root = posix.join(homeDirectory, "Library", "Application Support", "a2a-sidecar");
    return paths(root, root, posix.join);
  }

  if (platform === "linux") {
    const configRoot = env.XDG_CONFIG_HOME || posix.join(homeDirectory, ".config");
    const stateRoot = env.XDG_STATE_HOME || posix.join(homeDirectory, ".local", "state");
    return paths(
      posix.join(configRoot, "a2a-sidecar"),
      posix.join(stateRoot, "a2a-sidecar"),
      posix.join,
    );
  }

  if (platform === "win32") {
    const configRoot = env.APPDATA || win32.join(homeDirectory, "AppData", "Roaming");
    const stateRoot = env.LOCALAPPDATA || win32.join(homeDirectory, "AppData", "Local");
    return paths(
      win32.join(configRoot, "a2a-sidecar"),
      win32.join(stateRoot, "a2a-sidecar"),
      win32.join,
    );
  }

  throw new Error(`Unsupported platform: ${platform}`);
}
