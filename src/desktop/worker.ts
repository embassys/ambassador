import { DesktopGateway } from "./gateway.js";
import { DESKTOP_PROTOCOL, workerInitSchema, workerRequestSchema } from "./protocol.js";

let gateway: DesktopGateway | undefined;
let closing = false;
const maximumBytes = 4 * 1024 * 1024;
const initializedBy = setTimeout(() => {
  void shutdown();
}, 15_000);
let pending = 0;

function send(value: unknown): void {
  if (process.connected && Buffer.byteLength(JSON.stringify(value)) <= maximumBytes) {
    process.send?.(value, () => undefined);
  }
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearTimeout(initializedBy);
  const deadline = setTimeout(() => process.exit(1), 35_000);
  try {
    await gateway?.stop();
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}

process.on("disconnect", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

process.on("message", (raw: unknown) => {
  if (closing) return;
  if (gateway === undefined) {
    const initial = workerInitSchema.safeParse(raw);
    if (!initial.success) {
      void shutdown();
      return;
    }
    const instance = initial.data.instance;
    process.title = `Embassys: ${instance.name}`;
    gateway = new DesktopGateway({
      ...instance,
      environment: process.env,
      onChange: (snapshot) => send({ protocol: DESKTOP_PROTOCOL, type: "state", snapshot }),
    });
    clearTimeout(initializedBy);
    send({
      protocol: DESKTOP_PROTOCOL,
      type: "ready",
      snapshot: gateway.snapshot(),
      runtime: process.version,
    });
    return;
  }
  const parsed = workerRequestSchema.safeParse(raw);
  if (!parsed.success || pending >= 16) {
    void shutdown();
    return;
  }
  const { command, requestId } = parsed.data;
  if (!("instanceId" in command) || command.instanceId !== gateway.options.id) {
    send({
      protocol: DESKTOP_PROTOCOL,
      type: "reply",
      requestId,
      ok: false,
      error: "The command does not belong to this instance.",
    });
    return;
  }
  const current = gateway;
  pending++;
  void (async () => {
    let result: unknown;
    switch (command.type) {
      case "start":
        await current.start();
        result = current.snapshot();
        break;
      case "stop":
        await current.stop();
        result = current.snapshot();
        break;
      case "clean":
        if (!command.previewId) throw new Error("Review this instance before cleaning.");
        await current.clean(command.previewId);
        result = current.snapshot();
        break;
      case "clean_preview":
        result = await current.prepareClean();
        break;
      case "clean_cancel":
        await current.cancelClean(command.previewId);
        result = current.snapshot();
        break;
      case "sessions":
        result = await current.sessions();
        break;
      case "history":
        result = await current.history(command.sessionId, command.after);
        break;
      case "history_delete":
        await current.deleteHistory(command.sessionId);
        result = { deleted: true };
        break;
      case "logs":
        result = await current.logs(command.query);
        break;
      default:
        throw new Error("Command unavailable in this worker.");
    }
    const reply = { protocol: DESKTOP_PROTOCOL, type: "reply", requestId, ok: true, result };
    if (Buffer.byteLength(JSON.stringify(reply)) > maximumBytes)
      throw new Error("Response exceeds the desktop limit.");
    send(reply);
  })()
    .catch(() => {
      send({
        protocol: DESKTOP_PROTOCOL,
        type: "reply",
        requestId,
        ok: false,
        error: "The operation could not finish. Check the server state and Diagnostics.",
      });
    })
    .finally(() => {
      pending--;
    });
});

if (process.send === undefined) await shutdown();
