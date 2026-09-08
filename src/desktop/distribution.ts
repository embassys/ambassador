import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Verification failure leaves optional login startup unavailable. */
export async function verifyMacDistribution(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  bundle: string;
  run?: (executable: string, args: string[]) => Promise<void>;
}): Promise<boolean> {
  if (
    options.platform !== "darwin" ||
    !options.packaged ||
    !isAbsolute(options.bundle) ||
    !options.bundle.endsWith(".app")
  )
    return false;
  const run =
    options.run ??
    (async (executable, args) => {
      await execute(executable, args, { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
    });
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", options.bundle]);
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", options.bundle]);
    await run("/usr/bin/xcrun", ["stapler", "validate", options.bundle]);
    return true;
  } catch {
    return false;
  }
}
