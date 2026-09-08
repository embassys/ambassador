import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import electron from "electron";

const application = fileURLToPath(new URL("../../.build/desktop/app", import.meta.url));
await access(`${application}/main.js`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [application, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: environment,
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
