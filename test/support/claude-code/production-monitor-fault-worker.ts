import { validateCl03MonitorModule } from "./cl03-production.js";
import type { ClaudeLifetimeMonitorBarrier } from "./types.js";

const barriers = new Set<ClaudeLifetimeMonitorBarrier>([
  "before_monitor_ready",
  "during_start_record",
  "before_claude_spawn",
  "after_claude_spawn",
  "before_child_started",
]);

const candidate = process.argv[2];
const mode = process.argv[3] ?? "fault";
if (
  !barriers.has(candidate as ClaudeLifetimeMonitorBarrier) ||
  !["fault", "continue"].includes(mode) ||
  ![3, 4].includes(process.argv.length)
) {
  throw new Error("invalid CL02 production monitor fault barrier");
}
const barrier = candidate as ClaudeLifetimeMonitorBarrier;

const monitorUrl = new URL(
  "../../../packages/claude-connector/src/claude-lifetime-monitor.js",
  import.meta.url,
);
const monitor = validateCl03MonitorModule(await import(monitorUrl.href));
const postSpawn = ["after_claude_spawn", "before_child_started"].includes(barrier);
let releaseFault: (() => void) | undefined;
const faultRelease = new Promise<void>((resolve) => {
  releaseFault = resolve;
});
if (postSpawn || mode === "continue") process.once("SIGUSR2", () => releaseFault?.());
if (mode === "continue") {
  process.on("SIGTERM", () => process.stderr.write("sealed\n"));
}
await monitor.runClaudeLifetimeMonitorForTest(
  barrier,
  postSpawn || mode === "continue"
    ? async () => {
        if (mode === "continue") process.stderr.write(`barrier:${barrier}\n`);
        await faultRelease;
      }
    : undefined,
  mode !== "continue",
);
