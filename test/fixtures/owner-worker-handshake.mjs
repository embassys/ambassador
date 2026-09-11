import { existsSync } from "node:fs";
import { join } from "node:path";

let timer;
process.on("message", (message) => {
  if (message.type !== "owner_initialize") return;
  const snapshot = { context: "00000000-0000-4000-8000-000000000001", status: "loading" };
  process.send({ protocol: 1, type: "state", snapshot });
  timer = setInterval(() => {
    if (!existsSync(join(message.directory, "ready"))) return;
    clearInterval(timer);
    process.send({
      protocol: 1,
      type: "ready",
      runtime: process.version,
      snapshot: { ...snapshot, status: "signed_out" },
    });
  }, 10);
});
process.on("disconnect", () => {
  clearInterval(timer);
  process.exit(0);
});
