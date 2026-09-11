import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { build } from "esbuild";
import { instanceId, ownerId } from "./visual/data.mjs";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(desktop, "../.build/desktop-visual-review");
await mkdir(root, { recursive: true });
await build({
  entryPoints: [join(desktop, "scripts/visual/main.mjs")],
  outfile: join(root, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  target: "node24",
  banner: {
    js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);",
  },
});
await build({
  entryPoints: [join(desktop, "src/preload.cts")],
  outfile: join(root, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await build({
  stdin: {
    contents: `localStorage.setItem('embassys.onboarding.v1:${ownerId}:${instanceId}','done'); import('./src/app.tsx');`,
    resolveDir: desktop,
    sourcefile: "visual-entry.tsx",
  },
  outfile: join(root, "app.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
for (const file of ["index.html", "styles.css", "brand.svg"])
  await cp(join(desktop, "src", file), join(root, file));
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ name: "embassys-visual-review", type: "module", main: "main.js" }),
);
if (!process.argv.includes("--build-only")) {
  const profile = await mkdtemp(join(tmpdir(), "embassys-visual-review-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(
    electron,
    [
      root,
      `--user-data-dir=${profile}`,
      ...(process.argv.includes("--edge-cases") ? ["--edge-cases"] : []),
      ...(process.argv.includes("--chat-pages") ? ["--chat-pages"] : []),
    ],
    { env, stdio: "inherit" },
  );
  await writeFile(join(root, "profile.json"), JSON.stringify({ profile, pid: child.pid }, null, 2));
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
