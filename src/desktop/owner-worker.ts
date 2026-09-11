import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { DiagnosticLog } from "../diagnostic-log.js";
import { desktopDiagnosticOptions } from "./diagnostic-policy.js";
import { OwnerAccount } from "./owner-account.js";
import { ownerCommandSchema } from "./owner-protocol.js";
import { OWNER_WORKER_STARTUP_MS } from "./owner-worker-startup.js";

const initSchema = z.strictObject({
  protocol: z.literal(1),
  type: z.literal("owner_initialize"),
  directory: z.string().min(1).max(4096).refine(isAbsolute),
  diagnostics: z.enum(["development", "production"]),
});
const requestSchema = z.strictObject({
  protocol: z.literal(1),
  requestId: z.uuid(),
  command: ownerCommandSchema,
});
let account: OwnerAccount | undefined;
let diagnostic: DiagnosticLog | undefined;
let initializing = false;
let closing = false;
let pending = 0;
const initializedBy = setTimeout(() => void shutdown(), OWNER_WORKER_STARTUP_MS);
function send(value: unknown) {
  if (process.connected && Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 * 1024)
    process.send?.(value, () => undefined);
}
async function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(initializedBy);
  const deadline = setTimeout(() => process.exit(1), 20000);
  try {
    await account?.close();
    await diagnostic?.close();
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("message", (raw: unknown) => {
  if (closing) return;
  if (Buffer.byteLength(JSON.stringify(raw)) > 32768) {
    void shutdown();
    return;
  }
  if (!account) {
    const parsed = initSchema.safeParse(raw);
    if (initializing || !parsed.success) {
      void shutdown();
      return;
    }
    initializing = true;
    process.title = "Embassys: Account";
    void (async () => {
      account = await OwnerAccount.open({
        directory: parsed.data.directory,
        onChange: (snapshot) => send({ protocol: 1, type: "state", snapshot }),
        log: (event, data) => diagnostic?.log(event, data),
      });
      if (closing) {
        await account.close();
        return;
      }
      diagnostic = new DiagnosticLog(
        join(parsed.data.directory, "diagnostics"),
        desktopDiagnosticOptions(parsed.data.diagnostics),
      );
      clearTimeout(initializedBy);
      send({ protocol: 1, type: "ready", runtime: process.version, snapshot: account.snapshot() });
    })().catch(() => void shutdown());
    return;
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success || pending >= 8) {
    void shutdown();
    return;
  }
  const { requestId, command } = parsed.data;
  pending++;
  void account
    .command(command)
    .then(
      (result) => send({ protocol: 1, type: "reply", requestId, ok: true, result }),
      () => send({ protocol: 1, type: "reply", requestId, ok: false }),
    )
    .finally(() => {
      pending--;
    });
});
if (!process.send) await shutdown();
