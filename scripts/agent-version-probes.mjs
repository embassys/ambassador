import { spawn } from "node:child_process";

const VERSION = /(?:^|\D)(\d+\.\d+\.\d+)(?:$|\D)/u;

export const AGENT_VERSION_PROBES = new Map([
  ["openclaw", { command: "openclaw", args: ["--version"] }],
  ["hermes", { command: "hermes", args: ["--version"] }],
  ["codex", { command: "codex-acp", args: ["--version"] }],
  ["claude", { command: "claude-agent-acp", args: ["--version"] }],
  ["gemini", { command: "gemini", args: ["--version"] }],
]);

function probeEnvironment(environment) {
  return {
    ...(environment.HOME === undefined ? {} : { HOME: environment.HOME }),
    ...(environment.PATH === undefined ? {} : { PATH: environment.PATH }),
    ...(environment.USERPROFILE === undefined ? {} : { USERPROFILE: environment.USERPROFILE }),
  };
}

export async function observeAgentVersion(kind, environment = process.env) {
  const probe = AGENT_VERSION_PROBES.get(kind);
  if (probe === undefined) {
    return { status: "unavailable", reported_version: null };
  }

  let child;
  try {
    child = spawn(probe.command, probe.args, {
      env: probeEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { status: "unavailable", reported_version: null };
  }

  const chunks = [];
  let size = 0;
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, 5_000);
  timeout.unref();
  child.stdout.on("data", (chunk) => {
    size += chunk.byteLength;
    if (size <= 4_096) chunks.push(chunk);
    else child.kill("SIGKILL");
  });

  let code;
  try {
    code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
  } catch {
    return { status: "unavailable", reported_version: null };
  } finally {
    clearTimeout(timeout);
  }

  const match = VERSION.exec(Buffer.concat(chunks).toString("utf8"));
  if (expired || code !== 0 || size > 4_096 || match?.[1] === undefined) {
    return { status: "unavailable", reported_version: null };
  }
  return { status: "observed", reported_version: match[1] };
}
