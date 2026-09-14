import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { DiagnosticLog } from "../diagnostic-log.js";
import { desktopDiagnosticOptions } from "./diagnostic-policy.js";
import { OwnerAccount } from "./owner-account.js";
import { OwnerFeed, type OwnerNotice } from "./owner-feed.js";
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
let feed: OwnerFeed | undefined;
let feedTimer: NodeJS.Timeout | undefined;
let feedRun: Promise<void> | undefined;
const receipts = new Map<string, (ok: boolean) => void>();
async function deliver(ownerId: string, events: OwnerNotice[]): Promise<void> {
  const deliveryId = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      receipts.delete(deliveryId);
      reject(new Error("Notification receipt timed out"));
    }, 5000);
    receipts.set(deliveryId, (ok) => {
      clearTimeout(timer);
      receipts.delete(deliveryId);
      if (ok) resolve();
      else reject(new Error("Notification custody failed"));
    });
    send({ protocol: 1, type: "notifications", deliveryId, ownerId, events });
  });
}
function synchronize() {
  if (feedRun || closing || !account || !feed) return;
  const current = account;
  const snapshot = current.snapshot();
  feedRun = feed
    .tick(snapshot, (command) => current.command(command), deliver)
    .then((cursor) => {
      if (cursor !== undefined) current.eventsChanged(snapshot.context, cursor);
    })
    .catch(() => undefined)
    .finally(() => {
      feedRun = undefined;
    });
}
const initializedBy = setTimeout(() => void shutdown(), OWNER_WORKER_STARTUP_MS);
function send(value: unknown) {
  if (process.connected && Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 * 1024)
    process.send?.(value, () => undefined);
}
async function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(initializedBy);
  clearInterval(feedTimer);
  for (const reply of receipts.values()) reply(false);
  const deadline = setTimeout(() => process.exit(1), 20000);
  try {
    await feedRun;
    feed?.close();
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
  if (raw && typeof raw === "object" && "type" in raw && raw.type === "notification_receipt") {
    const receipt = z
      .strictObject({
        protocol: z.literal(1),
        type: z.literal("notification_receipt"),
        deliveryId: z.uuid(),
        ok: z.boolean(),
      })
      .safeParse(raw);
    if (!receipt.success) {
      void shutdown();
      return;
    }
    receipts.get(receipt.data.deliveryId)?.(receipt.data.ok);
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
      feed = new OwnerFeed(account.store);
      feedTimer = setInterval(synchronize, 15000);
      feedTimer.unref();
      clearTimeout(initializedBy);
      send({ protocol: 1, type: "ready", runtime: process.version, snapshot: account.snapshot() });
      synchronize();
    })().catch(() => void shutdown());
    return;
  }
  if (raw && typeof raw === "object" && "type" in raw && raw.type === "execution_credential") {
    const parsed = z
      .strictObject({
        protocol: z.literal(1),
        type: z.literal("execution_credential"),
        requestId: z.uuid(),
        context: z.uuid(),
        agentId: z.uuid(),
      })
      .safeParse(raw);
    if (!parsed.success || pending >= 8) {
      void shutdown();
      return;
    }
    const { requestId, context, agentId } = parsed.data;
    pending++;
    void account
      .executionCredential(context, agentId)
      .then(
        (credential) => send({ protocol: 1, type: "execution_credential", requestId, credential }),
        () => send({ protocol: 1, type: "execution_credential", requestId }),
      )
      .finally(() => {
        pending--;
      });
    return;
  }
  if (raw && typeof raw === "object" && "type" in raw && raw.type === "wake") {
    synchronize();
    return;
  }
  if (raw && typeof raw === "object" && "type" in raw && raw.type === "native_push") {
    const parsed = z
      .strictObject({
        protocol: z.literal(1),
        type: z.literal("native_push"),
        requestId: z.uuid(),
        context: z.uuid(),
        token: z.string().max(512).nullable(),
      })
      .safeParse(raw);
    if (!parsed.success || pending >= 8) {
      void shutdown();
      return;
    }
    const { requestId, context, token } = parsed.data;
    pending++;
    void account
      .nativePush(context, token)
      .then(
        (result) => send({ protocol: 1, type: "reply", requestId, ok: true, result }),
        () => send({ protocol: 1, type: "reply", requestId, ok: false }),
      )
      .finally(() => {
        pending--;
      });
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
      synchronize();
    });
});
if (!process.send) await shutdown();
