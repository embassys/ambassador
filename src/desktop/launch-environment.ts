import { posix, win32 } from "node:path";

/** Fixed GUI-launch search locations. Provider credentials stay in their normal stores. */
export function desktopLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  runtimeDirectory: string,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(runtimeDirectory) || !path.isAbsolute(homeDirectory))
    throw new Error("The installed runtime or home directory is unavailable.");
  const environment = { ...source };
  const pathKey = Object.keys(source).find((key) =>
    platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH",
  );
  const inherited = pathKey ? (source[pathKey] ?? "") : "";
  if (inherited.length > 32768 || inherited.includes("\u0000"))
    throw new Error("The executable search path is invalid.");
  for (const key of Object.keys(environment)) {
    const normalized = platform === "win32" ? key.toUpperCase() : key;
    if (["PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(normalized))
      delete environment[key];
  }
  const fallback = [path.join(homeDirectory, ".local", "bin")];
  if (platform === "win32") {
    const appDataKey = Object.keys(source).find((key) => key.toUpperCase() === "APPDATA");
    const appData = appDataKey ? source[appDataKey] : undefined;
    fallback.push(
      path.join(
        appData && path.isAbsolute(appData)
          ? appData
          : path.join(homeDirectory, "AppData", "Roaming"),
        "npm",
      ),
    );
  } else {
    if (platform === "darwin") fallback.push("/opt/homebrew/bin");
    fallback.push("/usr/local/bin", "/usr/bin", "/bin");
  }
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [runtimeDirectory, ...inherited.split(path.delimiter), ...fallback]) {
    if (!path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(normalized);
  }
  const joined = directories.join(path.delimiter);
  if (directories.length > 128 || joined.length > 32768)
    throw new Error("The executable search path exceeds the supported limit.");
  environment.PATH = joined;
  return environment;
}
