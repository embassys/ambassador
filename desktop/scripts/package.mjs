import { execFile } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packager } from "@electron/packager";
import { inventory, signingOptions } from "./artifact-tools.mjs";

const application = fileURLToPath(new URL("../../.build/desktop/app", import.meta.url));
const manifest = JSON.parse(await readFile(`${application}/build-manifest.json`, "utf8"));
const signing = signingOptions(process.platform, process.env);
const attestationPath = fileURLToPath(
  new URL("../../.build/desktop/package-attestation.json", import.meta.url),
);
await rm(attestationPath, { force: true });
const paths = await packager({
  dir: application,
  out: fileURLToPath(new URL("../../.build/desktop/packages", import.meta.url)),
  // Keep installation and executable paths space-free on every platform.
  name: "Embassys",
  executableName: "Embassys",
  appBundleId: "com.embassys.desktop.development",
  appCategoryType: "public.app-category.productivity",
  icon: `${application}/assets/app-icon.${process.platform === "darwin" ? "icns" : process.platform === "win32" ? "ico" : "png"}`,
  appVersion: manifest.app,
  electronVersion: manifest.electron,
  platform: process.platform,
  arch: process.arch,
  overwrite: true,
  asar: false,
  prune: false,
  ignore: /^\/gateway(?:\/|$)/u,
  // Packager's extraResource copy rewrites dependency links to absolute build
  // paths. Copy into Resources ourselves before signing and preserve links.
  afterCopy: [
    async ({ buildPath }) => {
      await cp(`${application}/gateway`, join(dirname(buildPath), "gateway"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    },
  ],
  ...signing.options,
});
if (process.platform === "darwin") {
  for (const path of paths) {
    const bundle = join(path, "Embassys.app");
    const run = promisify(execFile);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    if (signing.signed) {
      await run("/usr/sbin/spctl", ["--assess", "--type", "execute", bundle]);
      await run("/usr/bin/xcrun", ["stapler", "validate", bundle]);
    }
  }
}
if (signing.signed && process.platform === "win32") {
  for (const path of paths)
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./verify-windows-signatures.ps1", import.meta.url)),
        "-PackageRoot",
        path,
        "-Thumbprint",
        process.env.EMBASSYS_WINDOWS_CERTIFICATE_SHA1,
      ],
      { timeout: 120_000 },
    );
}
if (paths.length !== 1) throw new Error("Expected exactly one platform package.");
const files = await inventory(paths[0]);
await writeFile(
  attestationPath,
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      signed: signing.signed,
      adHocSigned: signing.adHocSigned === true,
      manifest,
      paths,
      inventory: files,
    },
    null,
    2,
  ),
);
for (const path of paths)
  console.log(`${signing.signed ? "Signed" : "Unsigned development"} desktop package: ${path}`);
