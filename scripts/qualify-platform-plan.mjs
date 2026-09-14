import { assertDesktopTarget } from "../desktop/scripts/platform-targets.mjs";

export function qualificationPlan(args, { platform, arch, env }) {
  if (env.CI)
    throw new Error(
      "Full platform qualification is local only; CI uses core and native component suites.",
    );
  try {
    assertDesktopTarget(platform, arch);
  } catch {
    throw new Error(`Unsupported host: ${platform}/${arch}`);
  }
  if (args.length > 1 || args.some((arg) => !/^--platform=(darwin|win32|linux)$/.test(arg))) {
    throw new Error("Unknown qualifier option; use --platform=darwin, win32 or linux.");
  }
  if (args[0] && args[0] !== `--platform=${platform}`)
    throw new Error(`Requested platform does not match this host (${platform}).`);
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error(
      "Linux needs a graphical display. Run xvfb-run -a pnpm qualify:platform on a headless machine.",
    );
  }
  const pnpm = (name, ...args) => ({ name, tool: "pnpm", args });
  const desktop = (name, script, ...args) =>
    pnpm(name, "--filter", "@embassys/desktop", "run", script, ...args);
  return [
    pnpm("full-tests", "run", "check"),
    desktop("desktop-types", "typecheck"),
    desktop("desktop-artifacts", "test:artifacts"),
    pnpm("pack", "pack", "--out", "{tarball}"),
    pnpm("clean-install", "--dir", "{install}", "--allow-build=better-sqlite3", "add", "{tarball}"),
    {
      name: "installed-flows",
      tool: "node",
      args: [
        "--test",
        ".test-dist/test/current-packed-platform.test.js",
        ".test-dist/test/current-packed-e2e.test.js",
      ],
    },
    desktop("desktop-build", "build"),
    desktop("desktop-worker", "verify"),
    desktop("desktop-package", "package"),
    desktop("desktop-portable", "verify:portable"),
    desktop("desktop-distribute", "distribute"),
    desktop("desktop-archives", "verify:distribution"),
    desktop(
      "desktop-host",
      "verify:package",
      ...(platform === "darwin" ? ["--measure-memory"] : []),
    ),
    desktop("cli-app-handoff", "verify:shared"),
  ];
}
