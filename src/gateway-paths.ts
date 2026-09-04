import { posix, win32 } from "node:path";

export interface GatewayPaths {
  stateDirectory: string;
  journalPath: string;
  lockPath: string;
  credentialPath: string;
  credentialKeyPath: string;
  webhookSecretPath: string;
  webhookSecretKeyPath: string;
  localControlSecretPath: string;
  localControlSecretKeyPath: string;
  pendingActionPath: string;
  actionResultPath: string;
  acpSessionPath: string;
  profilePath: string;
}

export function pathsForStateDirectory(
  stateDirectory: string,
  join: typeof posix.join = posix.join,
): GatewayPaths {
  return {
    stateDirectory,
    journalPath: join(stateDirectory, "notifications.sqlite"),
    lockPath: join(stateDirectory, "ambassador.lock"),
    credentialPath: join(stateDirectory, "central-credential.json"),
    credentialKeyPath: join(stateDirectory, "central-credential.key"),
    webhookSecretPath: join(stateDirectory, "webhook-secret.json"),
    webhookSecretKeyPath: join(stateDirectory, "webhook-secret.key"),
    localControlSecretPath: join(stateDirectory, "local-control-secret.json"),
    localControlSecretKeyPath: join(stateDirectory, "local-control-secret.key"),
    pendingActionPath: join(stateDirectory, "pending-actions.sqlite"),
    actionResultPath: join(stateDirectory, "action-results.sqlite"),
    acpSessionPath: join(stateDirectory, "acp-sessions.sqlite"),
    profilePath: join(stateDirectory, "delivery-profile.json"),
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
      posix.join(homeDirectory, "Library", "Application Support", "ambassador"),
    );
  }

  if (platform === "linux") {
    const stateRoot = environment.XDG_STATE_HOME || posix.join(homeDirectory, ".local", "state");
    return pathsForStateDirectory(posix.join(stateRoot, "ambassador"));
  }

  if (platform === "win32") {
    const stateRoot = environment.LOCALAPPDATA || win32.join(homeDirectory, "AppData", "Local");
    return pathsForStateDirectory(win32.join(stateRoot, "ambassador"), win32.join);
  }

  throw new Error("Unsupported platform");
}
