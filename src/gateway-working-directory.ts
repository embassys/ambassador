import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DeliveryProfileStore } from "./delivery-profile.js";

/** Both local hosts use the same owner-saved executor directory. */
export async function gatewayWorkingDirectory(
  profilePath: string,
  fallback: string,
): Promise<string> {
  const profile = await new DeliveryProfileStore(profilePath).load();
  const path = profile?.mode === "direct" ? profile.working_directory : fallback;
  if (!isAbsolute(path)) throw new Error("The saved agent directory is unavailable.");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory() || (profile?.mode === "direct" && canonical !== path))
    throw new Error("The saved agent directory changed. Restore it before starting.");
  return canonical;
}
