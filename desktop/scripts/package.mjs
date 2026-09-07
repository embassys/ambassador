import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const application = fileURLToPath(new URL("../../.build/desktop/app", import.meta.url));
const manifest = JSON.parse(await readFile(`${application}/build-manifest.json`, "utf8"));
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
  extraResource: [`${application}/gateway`],
  osxSign: false,
  osxNotarize: false,
});
for (const path of paths) console.log(`Unsigned desktop package: ${path}`);
