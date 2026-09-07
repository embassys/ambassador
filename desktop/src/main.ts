import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  Tray,
} from "electron";
import {
  prepareSupportExport,
  type SupportExport,
  saveSupportExport,
} from "../../src/desktop/diagnostics.js";
import { DesktopInstances } from "../../src/desktop/instances.js";
import { DesktopLoginItem } from "../../src/desktop/login-item.js";
import {
  type DesktopCommand,
  type DesktopInstance,
  parseDesktopCommand,
} from "../../src/desktop/protocol.js";
import { SupervisedGateway } from "../../src/desktop/supervisor.js";
import { DesktopWindowLifecycle } from "../../src/desktop/window-lifecycle.js";
import { DesktopGatewayClient } from "../../src/desktop/worker-client.js";

app.setName("Ambassador Development");
protocol.registerSchemesAsPrivileged([
  { scheme: "ambassador", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.enableSandbox();
const uiOrigin = "ambassador://app";
const ownDirectory = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let instances: DesktopInstances;
let loginItem: DesktopLoginItem;
const workers = new Map<string, SupervisedGateway>();
const windowLifecycle = new DesktopWindowLifecycle(openWindow);
let quitting = false;
let pendingChanges = false;
let busy = false;
let initialLaunch = true;
let exportPreview:
  | { id: string; instanceId: string; expires: number; data: SupportExport }
  | undefined;

const runtimeRoot = app.isPackaged
  ? join(process.resourcesPath, "gateway")
  : join(ownDirectory, "gateway");
const nodePath = join(runtimeRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
const workerPath = join(runtimeRoot, "dist", "desktop", "worker.js");

async function snapshot() {
  return {
    appVersion: app.getVersion(),
    build: "Development preview",
    loginItem: await loginItem.read(),
    owner: {
      status: "unavailable",
      message: "Account sign-in is coming in the next development stage.",
    },
    instances: instances.list().map((instance) => ({
      ...instance,
      runtime: workers.get(instance.id)?.snapshot() ?? { id: instance.id, state: "stopped" },
    })),
  };
}

function changed(): void {
  if (pendingChanges) return;
  pendingChanges = true;
  setTimeout(() => {
    pendingChanges = false;
    if (!quitting) {
      window?.webContents.send("ambassador:changed");
      updateMenu();
    }
  }, 50);
}

function getWorker(instance: DesktopInstance): SupervisedGateway {
  let worker = workers.get(instance.id);
  if (worker === undefined) {
    worker = new SupervisedGateway({
      id: instance.id,
      create: (onChange) => new DesktopGatewayClient({ nodePath, workerPath, instance, onChange }),
      onChange: changed,
    });
    workers.set(instance.id, worker);
  }
  return worker;
}

async function stop(instance: DesktopInstance): Promise<void> {
  await instances.updateEnabled(instance.id, false);
  const worker = workers.get(instance.id);
  if (worker) {
    await worker.close();
    workers.delete(instance.id);
  }
  changed();
}

async function execute(input: unknown): Promise<unknown> {
  const command = parseDesktopCommand(input);
  const mutation = [
    "start",
    "stop",
    "clean",
    "create",
    "export_prepare",
    "export_save",
    "history_delete",
    "set_launch_at_login",
  ].includes(command.type);
  if (mutation && busy) throw new Error("An operation is already in progress.");
  if (mutation) busy = true;
  try {
    return await executeCommand(command);
  } finally {
    if (mutation) busy = false;
  }
}

async function executeCommand(command: DesktopCommand): Promise<unknown> {
  if (command.type === "snapshot") return snapshot();
  if (command.type === "set_launch_at_login") {
    await loginItem.set(command.enabled);
    changed();
    return snapshot();
  }
  if (command.type === "create") {
    let parentDirectory: string | undefined;
    if (command.chooseLocation) {
      const selection = await dialog.showOpenDialog({
        title: "Choose a location for this instance",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selection.canceled || !selection.filePaths[0]) return snapshot();
      parentDirectory = selection.filePaths[0];
    }
    const created = await instances.create({
      name: command.name,
      port: command.port,
      requestId: command.requestId,
      ...(parentDirectory ? { parentDirectory } : {}),
    });
    changed();
    await getWorker(created).request({ type: "start", instanceId: created.id });
    return { ...(await snapshot()), createdInstanceId: created.id };
  }
  const instance = instances.list().find((item) => item.id === command.instanceId);
  if (!instance) throw new Error("This instance is no longer available.");
  if (command.type === "history_delete") {
    const choice = await dialog.showMessageBox({
      type: "warning",
      message: "Delete this local conversation archive?",
      detail:
        "Only visible content saved by this app is deleted. Provider history, permissions, pending requests and unread agent results remain. A currently running turn may have a gap until the next request.",
      buttons: ["Cancel", "Delete local history"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1) return { deleted: false };
    return await getWorker(instance).request(command);
  }
  if (command.type === "reveal_logs") {
    const directory = join(instance.stateDirectory, "diagnostics");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await shell.openPath(directory)) throw new Error("The log folder could not open.");
    return { opened: true };
  }
  if (command.type === "export_prepare") {
    exportPreview = undefined;
    const data = await prepareSupportExport(join(instance.stateDirectory, "diagnostics"), {
      includeBodies: command.includeBodies,
      ...(command.query ? { query: command.query } : {}),
    });
    const preview = {
      id: randomUUID(),
      instanceId: instance.id,
      expires: Date.now() + 300_000,
      data,
    };
    exportPreview = preview;
    setTimeout(() => {
      if (exportPreview === preview) exportPreview = undefined;
    }, 300_000).unref();
    const { contents: _contents, ...details } = data;
    return { previewId: preview.id, ...details };
  }
  if (command.type === "export_save") {
    const preview = exportPreview;
    if (
      !preview ||
      preview.id !== command.previewId ||
      preview.instanceId !== instance.id ||
      preview.expires < Date.now()
    ) {
      exportPreview = undefined;
      throw new Error("This preview expired. Prepare a new export.");
    }
    const selection = await dialog.showSaveDialog({
      title: "Save diagnostic export",
      defaultPath: `ambassador-diagnostics-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`,
      filters: [{ name: "Diagnostic log", extensions: ["jsonl"] }],
    });
    if (selection.canceled || !selection.filePath) return { saved: false };
    await saveSupportExport(selection.filePath, preview.data);
    exportPreview = undefined;
    return { saved: true };
  }
  if (command.type === "stop") {
    await stop(instance);
    return snapshot();
  }
  if (command.type === "clean") {
    const first = await dialog.showMessageBox({
      type: "warning",
      title: `Review ${instance.name} before cleaning`,
      message: `Stop ${instance.name} to review its local data?`,
      detail:
        "The next screen shows its identity and saved work before anything is erased. Cancelling the review leaves this server stopped.",
      buttons: ["Cancel", "Stop and review"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (first.response !== 1) return snapshot();
    await stop(instance);
    const worker = getWorker(instance);
    const preview = (await worker.request({
      type: "clean_preview",
      instanceId: instance.id,
    })) as import("../../src/desktop/local-summary.js").LocalSummary & { previewId: string };
    try {
      const choice = await dialog.showMessageBox({
        type: "warning",
        title: `Clean ${instance.name}?`,
        message: `Erase local data for ${instance.name}?`,
        detail: [
          `Identity: ${preview.enrollment.email ?? "Not registered"}${preview.enrollment.agent_id ? ` · ${preview.enrollment.agent_id}` : ""}`,
          `Pending incoming actions: ${preview.pendingCalls}`,
          `Received results still saved: ${preview.receivedResults}`,
          `Unresolved message deliveries or receipts: ${preview.unresolvedNotifications}`,
          `Saved outbound requests: ${preview.savedOutboundRequests}`,
          `Saved owner questions: ${preview.savedOwnerQuestions}`,
          `Local session records: ${preview.sessionCount}`,
          "",
          "Counts can refer to the same request. Saved requests and questions include completed work.",
          "Local enrollment and work will be removed. Logs, provider configuration and provider history remain. Central registration remains, so Clean may leave you unable to register again until central identity recovery is available.",
        ].join("\n"),
        buttons: ["Cancel", "Erase local data"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice.response === 1) await worker.request({ ...command, previewId: preview.previewId });
    } finally {
      await worker.request({
        type: "clean_cancel",
        instanceId: instance.id,
        previewId: preview.previewId,
      });
      changed();
    }
    return snapshot();
  }
  if (command.type === "start") {
    await instances.updateEnabled(instance.id, true);
    await getWorker(instance).request(command);
    changed();
    return snapshot();
  }
  if (command.type === "setup") {
    return {
      endpoint: `http://127.0.0.1:${instance.port}/mcp`,
      guides: [
        {
          name: "Codex",
          instruction: `codex mcp add ambassador --url http://127.0.0.1:${instance.port}/mcp`,
          note: "Set tool_timeout_sec = 660 in the selected MCP entry, then reload Codex. Use a separate provider profile for a development instance.",
        },
        {
          name: "Claude Code",
          instruction: `claude mcp add --transport http --scope user ambassador http://127.0.0.1:${instance.port}/mcp`,
          note: "Set the MCP timeout to 660000 ms and reload Claude Code. Standalone Chat and Cowork need separate qualification.",
        },
        {
          name: "OpenClaw",
          instruction: `openclaw mcp set ambassador '{"url":"http://127.0.0.1:${instance.port}/mcp","transport":"streamable-http","enabled":true}'\nopenclaw mcp doctor ambassador --probe`,
          note: "Run in the intended OpenClaw profile. Set its tool timeout to at least 660 seconds, then reload when it is safe to interrupt chats.",
        },
        {
          name: "Hermes",
          instruction: `hermes mcp add ambassador --url http://127.0.0.1:${instance.port}/mcp\nhermes mcp test ambassador`,
          note: "Run in the intended Hermes profile. Set its tool timeout to at least 660 seconds, then start a fresh session or run /reload-mcp.",
        },
      ],
    };
  }
  if (["clean_preview", "clean_cancel"].includes(command.type))
    throw new Error("Clean review is managed by the app.");
  return await getWorker(instance).request(command);
}

function trusted(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(
    window &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url === `${uiOrigin}/index.html`,
  );
}

function showWindow(): void {
  if (!quitting) windowLifecycle.requestOpen();
}

function openWindow(): void {
  if (quitting) return;
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1140,
    height: 780,
    minWidth: 800,
    minHeight: 570,
    title: "Ambassador",
    backgroundColor: "#f7f8fa",
    show: false,
    webPreferences: {
      preload: join(ownDirectory, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", () => {
    window = undefined;
  });
  window.once("ready-to-show", () => window?.show());
  void window.loadURL(`${uiOrigin}/index.html`);
}

function updateMenu(): void {
  if (!tray) return;
  const records = instances.list();
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Open Ambassador", click: showWindow },
    { type: "separator" },
    ...records.map((record) => ({
      label: `${record.name} · ${workers.get(record.id)?.snapshot().state ?? "stopped"}`,
      submenu: [
        {
          label: "Start server",
          click: () => {
            void execute({ type: "start", instanceId: record.id }).catch(showError);
          },
        },
        {
          label: "Stop server",
          click: () => {
            void execute({ type: "stop", instanceId: record.id }).catch(showError);
          },
        },
      ],
    })),
    { type: "separator" },
    { label: "Quit Ambassador", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function showError(): void {
  showWindow();
  void dialog.showMessageBox({
    type: "error",
    message: "Ambassador could not finish that operation.",
    detail: "Check the selected instance and its Diagnostics view.",
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  app.on("second-instance", showWindow);
  app.on("activate", () => {
    if (!initialLaunch) showWindow();
  });
  app.on("window-all-closed", () => {
    /* Background workers remain owned by the tray host. */
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void Promise.all([...workers.values()].map((worker) => worker.close()))
      .then(() => {
        workers.clear();
        app.quit();
      })
      .catch(() => {
        quitting = false;
        showError();
      });
  });
  void app.whenReady().then(async () => {
    try {
      const configurationRoot = process.env.XDG_CONFIG_HOME;
      loginItem = new DesktopLoginItem({
        platform: process.platform,
        packaged: app.isPackaged,
        executable: process.execPath,
        macDistributionVerified: false,
        configurationDirectory:
          configurationRoot && isAbsolute(configurationRoot)
            ? configurationRoot
            : join(app.getPath("home"), ".config"),
        native: {
          read: (options) => app.getLoginItemSettings(options),
          write: (options) => app.setLoginItemSettings(options),
        },
      });
      instances = await DesktopInstances.open(join(app.getPath("userData"), "desktop"));
      if (instances.list().length === 0) await instances.create({ name: "Personal", port: 8787 });
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const assets: Record<string, { file: string; type: string }> = {
        "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
        "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
        "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
      };
      protocol.handle("ambassador", async (request) => {
        const url = new URL(request.url);
        const asset = assets[url.pathname];
        if (url.host !== "app" || !asset || request.method !== "GET")
          return new Response(null, { status: 404 });
        return new Response(await readFile(join(ownDirectory, asset.file)), {
          headers: {
            "Content-Type": asset.type,
            "Content-Security-Policy":
              "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      });
      ipcMain.handle("ambassador:command", async (event, input: unknown) => {
        if (!trusted(event)) throw new Error("Untrusted app window.");
        try {
          const parsed: DesktopCommand = parseDesktopCommand(input);
          const result = await execute(parsed);
          return { ok: true, result };
        } catch {
          return {
            ok: false,
            error: "This operation could not finish. Check the selected server and Diagnostics.",
          };
        }
      });
      ipcMain.handle("ambassador:copy", (event, value: unknown) => {
        if (!trusted(event) || typeof value !== "string" || value.length > 8192)
          throw new Error("Invalid copy request.");
        clipboard.writeText(value);
      });
      const pixels = Buffer.alloc(22 * 22 * 4);
      for (let y = 2; y < 20; y++) {
        for (let x = 1; x < 21; x++) {
          const distance = Math.abs(x - 10.5);
          const edge = (y - 2) * 0.52;
          if (distance <= edge && (distance >= edge - 3.5 || (y >= 13 && y <= 15))) {
            pixels[(y * 22 + x) * 4 + 3] = 255;
          }
        }
      }
      const icon = nativeImage.createFromBitmap(pixels, { width: 22, height: 22 });
      icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip("Ambassador");
      tray.on("click", showWindow);
      updateMenu();
      const openedAtLogin =
        process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin;
      windowLifecycle.ready(process.argv.includes("--background") || openedAtLogin);
      for (const instance of instances.list()) {
        if (quitting) break;
        if (instance.enabled)
          await getWorker(instance)
            .request({ type: "start", instanceId: instance.id })
            .catch(changed);
      }
      initialLaunch = false;
    } catch {
      dialog.showErrorBox(
        "Ambassador could not open",
        "The application data or bundled runtime is unavailable. No existing Ambassador process was stopped.",
      );
      app.quit();
    }
  });
}
