import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Verification failure leaves optional login startup unavailable. */
export async function verifyMacDistribution(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  bundle: string;
  run?: (executable: string, args: string[]) => Promise<string>;
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
      const result = await execute(executable, args, {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        encoding: "utf8",
      });
      return result.stdout + result.stderr;
    });
  try {
    // An ad hoc preview cannot pass notarization. Avoid delaying app startup
    // on an assessment that can only leave this optional control unavailable.
    const identity = await run("/usr/bin/codesign", ["--display", "--verbose=2", options.bundle]);
    if (typeof identity !== "string" || !/^Authority=Developer ID Application:/mu.test(identity))
      return false;
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", options.bundle]);
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", options.bundle]);
    await run("/usr/bin/xcrun", ["stapler", "validate", options.bundle]);
    return true;
  } catch {
    return false;
  }
}
