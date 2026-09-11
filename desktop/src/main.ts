import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import {
  AgentConnection,
  type ConnectionProvider,
  connectionAvailable,
  runConnectionCommand,
} from "../../src/desktop/agent-connections.js";
import { AgentSkill, agentSkillPath } from "../../src/desktop/agent-skill.js";
import {
  controlPalette,
  DesktopAppearance,
  windowAppearance,
} from "../../src/desktop/appearance.js";
import {
  prepareSupportExport,
  type SupportExport,
  saveSupportExport,
} from "../../src/desktop/diagnostics.js";
import { verifyMacDistribution } from "../../src/desktop/distribution.js";
import { BUNDLED_NODE_VERSION, verifyBundledEngine } from "../../src/desktop/engine.js";
import { verifyExecutorConnection } from "../../src/desktop/executor-connection.js";
import { DesktopInstances } from "../../src/desktop/instances.js";
import { desktopLaunchEnvironment } from "../../src/desktop/launch-environment.js";
import { DesktopLoginItem } from "../../src/desktop/login-item.js";
import { DesktopNotifications } from "../../src/desktop/notifications.js";
import { ownerCommandSchema } from "../../src/desktop/owner-protocol.js";
import { OwnerWorkerClient } from "../../src/desktop/owner-worker-client.js";
import {
  type DesktopCommand,
  type DesktopInstance,
  parseDesktopCommand,
} from "../../src/desktop/protocol.js";
import { DesktopQuitLifecycle } from "../../src/desktop/quit-lifecycle.js";
import { DesktopReviews } from "../../src/desktop/review.js";
import { SupervisedGateway } from "../../src/desktop/supervisor.js";
import { DesktopWindowLifecycle } from "../../src/desktop/window-lifecycle.js";
import { DesktopGatewayClient } from "../../src/desktop/worker-client.js";
import { applicationMenu } from "./application-menu.js";
import { providerDocument } from "./provider-config.js";

app.setName("Embassys");
let diagnosticsMode: "development" | "production" = "production";
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
let appearance: DesktopAppearance;
let notifications: DesktopNotifications;
let owner: OwnerWorkerClient | undefined;
let notificationTimer: NodeJS.Timeout | undefined;
let settingsRequest: string | undefined;
let navigation:
  | {
      id: string;
      instanceId: string;
      page: "attention" | "permissions";
      activity: "incoming" | "results";
    }
  | undefined;
const activeNotifications = new Set<Notification>();
const workers = new Map<string, SupervisedGateway>();
const setupTasks = new Map<Promise<void>, AbortController>();
const windowLifecycle = new DesktopWindowLifecycle(openWindow);
const reviews = new DesktopReviews(() => {
  if (reviews.current()) showWindow();
  changed();
});
const quitLifecycle = new DesktopQuitLifecycle({
  stop: async () => {
    reviews.cancelAll();
    if (notificationTimer) {
      clearInterval(notificationTimer);
      notificationTimer = undefined;
    }
    for (const notification of activeNotifications) notification.close();
    activeNotifications.clear();
    const activeSetup = [...setupTasks];
    for (const [, abort] of activeSetup) abort.abort();
    const activeWorkers = [...workers.values()];
    const activeOwner = owner;
    workers.clear();
    owner = undefined;
    const setupSettlement = Promise.allSettled(activeSetup.map(([task]) => task));
    const settled = await Promise.allSettled([
      ...activeWorkers.map((worker) => worker.close()),
      ...(activeOwner ? [activeOwner.close()] : []),
    ]);
    await setupSettlement;
    if (settled.some((result) => result.status === "rejected"))
      throw new Error("Desktop services did not finish shutting down.");
  },
  quit: () => app.quit(),
  failed: () => {
    startNotificationTimer();
    changed();
    showError();
  },
});
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

async function providerConfiguration(
  provider: ConnectionProvider,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (provider === "codex" || provider === "hermes") {
    const root =
      provider === "codex"
        ? environment.CODEX_HOME || join(app.getPath("home"), ".codex")
        : environment.HERMES_HOME || join(app.getPath("home"), ".hermes");
    if (!isAbsolute(root)) throw new Error("Use an absolute provider configuration location.");
    if (provider === "hermes") {
      if (environment.HERMES_PROFILE || environment.HERMES_CONFIG || environment.HERMES_ENV)
        throw new Error("Use manual setup for this Hermes profile.");
      if (!environment.HERMES_HOME) {
        try {
          const path = join(root, "active_profile");
          const stat = await lstat(path);
          if (
            !stat.isFile() ||
            stat.size > 512 ||
            (await readFile(path, "utf8")).trim() !== "default"
          )
            throw new Error("Use manual setup for the active Hermes profile.");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
            throw error;
        }
      }
    }
    return join(root, provider === "codex" ? "config.toml" : "config.yaml");
  }
  if (provider === "claude_code") {
    const root = environment.CLAUDE_CONFIG_DIR || app.getPath("home");
    if (!isAbsolute(root)) throw new Error("Use an absolute provider configuration location.");
    return join(root, ".claude.json");
  }
  if (
    (environment.OPENCLAW_HOME || environment.OPENCLAW_PROFILE) &&
    !environment.OPENCLAW_CONFIG_PATH
  )
    throw new Error("Use manual setup for this OpenClaw profile.");
  const path =
    environment.OPENCLAW_CONFIG_PATH ||
    join(environment.OPENCLAW_STATE_DIR || join(app.getPath("home"), ".openclaw"), "openclaw.json");
  if (!isAbsolute(path)) throw new Error("Use an absolute provider configuration location.");
  environment.OPENCLAW_CONFIG_PATH = path;
  return path;
}

async function snapshot() {
  let accent: string | undefined;
  try {
    accent = systemPreferences.getAccentColor();
  } catch {
    // Some Linux desktops do not expose an accent to Electron.
  }
  return {
    appVersion: app.getVersion(),
    build: "Development preview",
    cliCommand:
      process.platform === "win32"
        ? `& '${nodePath.replaceAll("'", "''")}' '${join(runtimeRoot, "dist", "cli.js").replaceAll("'", "''")}' start`
        : `'${nodePath.replaceAll("'", "'\\''")}' '${join(runtimeRoot, "dist", "cli.js").replaceAll("'", "'\\''")}' start`,
    diagnosticsMode,
    platform: process.platform,
    appearance: appearance.value,
    dark: nativeTheme.shouldUseDarkColors,
    focused: window?.isFocused() ?? false,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    palette: controlPalette(accent, nativeTheme.shouldUseDarkColors),
    notifications: { enabled: notifications.enabled, supported: Notification.isSupported() },
    navigation,
    settingsRequest,
    loginItem: await loginItem.read(),
    owner: getOwner().snapshot(),
    review: reviews.current(),
    instances: instances.list().map((instance) => ({
      ...instance,
      runtime: workers.get(instance.id)?.snapshot() ?? { id: instance.id, state: "stopped" },
    })),
  };
}

function getOwner(): OwnerWorkerClient {
  if (!owner) {
    owner = new OwnerWorkerClient({
      directory: join(instances.directory, "account"),
      nodePath,
      workerPath: join(runtimeRoot, "dist", "desktop", "owner-worker.js"),
      expectedRuntime: `v${BUNDLED_NODE_VERSION}`,
      diagnostics: diagnosticsMode,
      onChange: changed,
    });
  }
  return owner;
}

function changed(): void {
  if (pendingChanges) return;
  pendingChanges = true;
  setTimeout(() => {
    pendingChanges = false;
    if (!quitLifecycle.stopping) {
      window?.webContents.send("ambassador:changed");
      updateMenu();
    }
  }, 50);
}

function startNotificationTimer(): void {
  if (notificationTimer) return;
  notificationTimer = setInterval(() => {
    void notifications.flush().catch(() => undefined);
  }, 10_000);
  notificationTimer.unref();
}

function getWorker(instance: DesktopInstance): SupervisedGateway {
  let worker = workers.get(instance.id);
  if (worker === undefined) {
    worker = new SupervisedGateway({
      id: instance.id,
      create: (onChange) =>
        new DesktopGatewayClient({
          nodePath,
          workerPath,
          expectedRuntime: `v${BUNDLED_NODE_VERSION}`,
          diagnostics: diagnosticsMode,
          instance,
          onChange,
          approveSetup: async (permission, signal) => {
            if (quitLifecycle.stopping || signal.aborted) return undefined;
            return reviews.ask(
              { kind: "permission", instanceName: instance.name, permission },
              signal,
            );
          },
          checkExecutor: async (context) => {
            const provider = context.agent === "claude" ? "claude_code" : context.agent;
            const environment = desktopLaunchEnvironment(
              process.env,
              dirname(nodePath),
              app.getPath("home"),
            );
            return verifyExecutorConnection({
              provider,
              configurationPath: await providerConfiguration(provider, environment),
              workingDirectory: context.workingDirectory,
              port: instance.port,
              document: providerDocument(provider),
            });
          },
          onNotification: (event) => {
            if (!quitLifecycle.stopping)
              void notifications.receive(instance.id, event).catch(() => undefined);
          },
        }),
      onChange: changed,
      onHandoff: () => {
        void instances.updateEnabled(instance.id, false).then(changed).catch(showError);
      },
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

async function confirmHandoff(instance: DesktopInstance): Promise<boolean> {
  const worker = getWorker(instance);
  const running = (await worker.request({ type: "external_process", instanceId: instance.id })) as {
    processInstanceId?: string;
  };
  if (!running.processInstanceId) return true;
  const answer = await dialog.showMessageBox({
    type: "question",
    message: "Another Ambassador is using this installation.",
    detail: "Stop that server and continue here? Its identity and saved work will stay in place.",
    buttons: ["Cancel", "Stop and continue"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (answer.response !== 1) return false;
  await worker.request({
    type: "external_stop",
    instanceId: instance.id,
    processInstanceId: running.processInstanceId,
  });
  return true;
}

async function execute(input: unknown): Promise<unknown> {
  const command = parseDesktopCommand(input);
  const mutation = [
    "start",
    "attach_cli",
    "stop",
    "clean",
    "create",
    "clear_logs",
    "export_prepare",
    "export_save",
    "history_delete",
    "set_launch_at_login",
    "agent_connection",
    "set_appearance",
    "set_notifications",
    "enrollment_register",
    "enrollment_verify",
    "enrollment_resend",
    "enrollment_executor",
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
  if (command.type === "review_answer")
    return { accepted: reviews.answer(command.reviewId, command.choice) };
  if (command.type === "attach_cli") {
    const attached = await instances.attachCli();
    return { ...(await snapshot()), createdInstanceId: attached.id };
  }
  const accountCommand = ownerCommandSchema.safeParse(command);
  if (accountCommand.success) {
    if (accountCommand.data.type === "owner_open_web") {
      await shell.openExternal("https://mcp.embassys.ai/app/");
      return { opened: true };
    }
    if (accountCommand.data.type === "owner_reveal_logs") {
      const directory = join(instances.directory, "account", "diagnostics");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await shell.openPath(directory))
        throw new Error("The account log folder could not open.");
      return { opened: true };
    }
    if (accountCommand.data.type === "owner_status" && owner && !owner.available()) {
      await owner.close();
      owner = undefined;
    }
    return getOwner().request(accountCommand.data);
  }
  if (command.type === "set_notifications") {
    await notifications.setEnabled(command.enabled);
    changed();
    return snapshot();
  }
  if (command.type === "set_appearance") {
    await appearance.set(command.appearance);
    nativeTheme.themeSource = appearance.value;
    changed();
    return snapshot();
  }
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
  if (!("instanceId" in command)) throw new Error("Select an instance for this operation.");
  const instance = instances.list().find((item) => item.id === command.instanceId);
  if (!instance) throw new Error("This instance is no longer available.");
  if (command.type === "agent_connection") {
    if (!connectionAvailable(process.platform, process.arch))
      return {
        state: "unavailable",
        owned: false,
        message:
          "Use the setup instructions on this platform. Automatic setup is awaiting native qualification.",
      };
    const name = {
      claude_code: "Claude Code",
      openclaw: "OpenClaw",
      codex: "Codex",
      hermes: "Hermes",
    }[command.provider];
    const environment = desktopLaunchEnvironment(
      process.env,
      dirname(nodePath),
      app.getPath("home"),
    );
    const configurationPath = await providerConfiguration(command.provider, environment);
    const setup = new AgentConnection({
      provider: command.provider,
      document: providerDocument(command.provider),
      configurationPath,
      ownershipPath: join(
        instances.directory,
        "connections",
        `${command.provider}-${createHash("sha256").update(configurationPath).digest("hex")}.json`,
      ),
      run: (executable, args) => {
        const abort = new AbortController();
        const task = runConnectionCommand(
          executable,
          args,
          instance.workingDirectory,
          environment,
          abort.signal,
        );
        setupTasks.set(task, abort);
        void task.finally(() => setupTasks.delete(task)).catch(() => undefined);
        return task;
      },
    });
    const skillPath = agentSkillPath(command.provider, configurationPath, app.getPath("home"));
    const skill = new AgentSkill({
      path: skillPath,
      ownershipPath: join(
        instances.directory,
        "connections",
        `skill-${createHash("sha256").update(skillPath).digest("hex")}.json`,
      ),
      content: await readFile(
        join(ownDirectory, "assets", "skills", "embassys", "SKILL.md"),
        "utf8",
      ),
    });
    const skillState = await skill.inspect();
    if (command.operation === "check") {
      const connection = await setup.inspect(instance.port);
      return {
        ...connection,
        message: `${connection.message} ${skillState.message} Use Test connection to check the agent itself.`,
      };
    }
    if (
      command.operation !== "disconnect" &&
      workers.get(instance.id)?.snapshot().state !== "running"
    )
      return {
        state: "unavailable",
        owned: false,
        message: "Start this instance's server before connecting an agent.",
      };
    if (command.operation === "test") {
      const connection = await setup.inspect(instance.port);
      if (connection.state !== "configured") return connection;
      if (skillState.state !== "installed")
        return {
          state: "configured",
          message: `${skillState.message} Choose Connect to finish setup.`,
        };
      return getWorker(instance).request({
        type: "agent_test",
        instanceId: instance.id,
        provider: command.provider,
      });
    }
    const preview = await setup.prepare(command.operation, instance.port);
    if (preview.state === "conflict" || preview.state === "unavailable") return preview;
    if (skillState.state === "conflict")
      return { ...preview, state: "conflict", message: skillState.message };
    const remove = command.operation === "disconnect";
    const action = remove ? "Disconnect" : command.operation === "repair" ? "Repair" : "Connect";
    const choice = await reviews.ask({
      kind: "connection",
      instanceName: instance.name,
      providerName: name,
      action,
      endpoint: `http://127.0.0.1:${instance.port}/mcp`,
      configurationPath,
      skillPath,
    });
    if (choice !== "confirm")
      return {
        state: "cancelled",
        owned: false,
        message: "Setup cancelled. The provider's settings were left untouched.",
      };
    if (
      quitLifecycle.stopping ||
      (!remove && workers.get(instance.id)?.snapshot().state !== "running")
    )
      return {
        state: "unavailable",
        owned: false,
        message: "The server stopped during setup. Review the connection again.",
      };
    const connected = preview.previewId ? await setup.apply(preview.previewId) : preview;
    if (remove) {
      if (connected.state === "conflict" || connected.state === "unavailable") return connected;
      const removedSkill = await skill.remove();
      if (removedSkill.state === "conflict")
        return { ...connected, state: "conflict", message: removedSkill.message };
      return {
        ...connected,
        message: `${connected.message} ${removedSkill.owned ? removedSkill.message : "Any unchanged app-owned skill was removed; manually installed files were kept."}`,
      };
    }
    if (connected.state !== "configured") return connected;
    const installed = await skill.install();
    if (installed.state !== "installed")
      return { ...connected, message: `Connection saved. ${installed.message}` };
    const worker = getWorker(instance);
    const registration = (await worker.request({
      type: "enrollment_status",
      instanceId: instance.id,
    })) as { needsExecutor?: boolean; phase?: string };
    if (registration.phase === "registered" && registration.needsExecutor)
      await worker.request({
        type: "enrollment_executor",
        instanceId: instance.id,
        executor: command.provider === "claude_code" ? "claude" : command.provider,
      });
    return worker.request({
      type: "agent_test",
      instanceId: instance.id,
      provider: command.provider,
    });
  }
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
  if (command.type === "clear_logs") {
    const choice = await dialog.showMessageBox({
      type: "warning",
      message: `Clear diagnostic logs for ${instance.name}?`,
      detail: `Remove the retained diagnostic files in ${join(instance.stateDirectory, "diagnostics")}. Up to 1 GiB may be removed. Conversations and pending work are kept. New events will still be recorded.`,
      buttons: ["Cancel", "Clear logs"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1) return { cleared: false };
    exportPreview = undefined;
    return getWorker(instance).request(command);
  }
  if (command.type === "reveal_logs") {
    const directory = join(instance.stateDirectory, "diagnostics");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await shell.openPath(directory)) throw new Error("The log folder could not open.");
    return { opened: true };
  }
  if (command.type === "export_prepare") {
    exportPreview = undefined;
    await getWorker(instance).request({
      type: "logs",
      instanceId: instance.id,
      query: { limit: 1 },
    });
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
      defaultPath: `embassys-diagnostics-${new Date().toISOString().replace(/[:.]/gu, "-")}.jsonl`,
      filters: [{ name: "Diagnostic log", extensions: ["jsonl"] }],
    });
    if (selection.canceled || !selection.filePath) return { saved: false };
    await saveSupportExport(selection.filePath, preview.data);
    exportPreview = undefined;
    return { saved: true };
  }
  if (command.type === "stop") {
    if (!(await confirmHandoff(instance))) return snapshot();
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
    if (!(await confirmHandoff(instance))) return snapshot();
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
    if (!(await confirmHandoff(instance))) return snapshot();
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
          ...(connectionAvailable(process.platform, process.arch) ? { connect: "codex" } : {}),
          instruction: `codex mcp add ambassador --url http://127.0.0.1:${instance.port}/mcp`,
          note: "Guided setup saves the address and allows a ten-minute wait. Reload Codex afterward. Project-specific settings can override this connection.",
        },
        {
          name: "Claude Code",
          ...(connectionAvailable(process.platform, process.arch)
            ? { connect: "claude_code" }
            : {}),
          instruction: `claude mcp add-json --scope user ambassador '{"type":"http","url":"http://127.0.0.1:${instance.port}/mcp","timeout":660000}'`,
          note: "These settings let Claude Code wait for a reply for up to ten minutes. Reload Claude Code afterward. Standalone Chat and Cowork need the separate local desktop connection.",
        },
        {
          name: "OpenClaw",
          ...(connectionAvailable(process.platform, process.arch) ? { connect: "openclaw" } : {}),
          instruction: `openclaw mcp set ambassador '{"url":"http://127.0.0.1:${instance.port}/mcp","transport":"streamable-http","requestTimeoutMs":660000}'\nopenclaw mcp doctor ambassador --probe`,
          note: "Use the intended OpenClaw profile. These settings allow a ten-minute wait. Reload OpenClaw when it is safe to interrupt chats.",
        },
        {
          name: "Hermes",
          ...(connectionAvailable(process.platform, process.arch) ? { connect: "hermes" } : {}),
          instruction: `hermes mcp add ambassador --url http://127.0.0.1:${instance.port}/mcp\nhermes mcp test ambassador`,
          note: "Guided setup saves the address and allows a ten-minute wait in this Hermes profile. Start a fresh session or run /reload-mcp afterward.",
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
  if (!quitLifecycle.stopping) windowLifecycle.requestOpen();
}

function openSettings(): void {
  settingsRequest = randomUUID();
  showWindow();
  changed();
}

function openWindow(): void {
  if (quitLifecycle.stopping) return;
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 540,
    title: "Embassys",
    icon: join(ownDirectory, "assets", "app-icon.png"),
    ...windowAppearance(
      process.platform,
      nativeTheme.shouldUseDarkColors,
      nativeTheme.prefersReducedTransparency,
    ),
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
  window.webContents.on("render-process-gone", () => reviews.cancelAll());
  window.on("close", () => {
    window = undefined;
    reviews.cancelAll();
  });
  window.once("ready-to-show", () => window?.show());
  window.on("focus", changed);
  window.on("blur", changed);
  void window.loadURL(`${uiOrigin}/index.html`);
}

function updateMenu(): void {
  if (!tray) return;
  const records = instances.list();
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Open Embassys", click: showWindow },
    { label: "Settings…", click: openSettings },
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
    { label: "Quit Embassys", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function showError(): void {
  showWindow();
  void dialog.showMessageBox({
    type: "error",
    message: "Embassys could not finish that operation.",
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
    if (quitLifecycle.request()) event.preventDefault();
  });
  void app.whenReady().then(async () => {
    try {
      const manifest = await verifyBundledEngine({
        manifestPath: join(ownDirectory, "build-manifest.json"),
        gateway: runtimeRoot,
        app: app.getVersion(),
        electron: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
      });
      diagnosticsMode = manifest.diagnostics;
      const configurationRoot = process.env.XDG_CONFIG_HOME;
      loginItem = new DesktopLoginItem({
        platform: process.platform,
        packaged: app.isPackaged,
        executable: process.execPath,
        macDistributionVerified: await verifyMacDistribution({
          platform: process.platform,
          packaged: app.isPackaged,
          bundle: join(dirname(process.execPath), "../.."),
        }),
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
      appearance = await DesktopAppearance.open(instances.directory);
      notifications = await DesktopNotifications.open({
        path: join(instances.directory, "notifications.json"),
        show: (banner) => {
          if (
            !Notification.isSupported() ||
            quitLifecycle.stopping ||
            !instances.list().some((item) => item.id === banner.instanceId)
          )
            return;
          const notification = new Notification({
            title: "Embassys",
            body:
              banner.count === 1
                ? "Your agent has an update. Open Embassys to review it."
                : "Your agent has new updates. Open Embassys to review them.",
            silent: true,
          });
          activeNotifications.add(notification);
          notification.on("click", () => {
            if (
              quitLifecycle.stopping ||
              !instances.list().some((item) => item.id === banner.instanceId)
            )
              return;
            navigation = {
              id: randomUUID(),
              instanceId: banner.instanceId,
              page: banner.page,
              activity: banner.activity,
            };
            showWindow();
            changed();
          });
          const release = () => activeNotifications.delete(notification);
          notification.once("close", release);
          notification.once("failed", release);
          notification.show();
          setTimeout(() => {
            notification.close();
            release();
          }, 60_000).unref();
        },
      });
      startNotificationTimer();
      nativeTheme.themeSource = appearance.value;
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(applicationMenu(process.platform, openSettings)),
      );
      if (process.platform !== "darwin") systemPreferences.on("accent-color-changed", changed);
      if (process.platform === "win32") systemPreferences.on("color-changed", changed);
      nativeTheme.on("updated", () => {
        if (window) {
          window.setBackgroundColor(
            windowAppearance(
              process.platform,
              nativeTheme.shouldUseDarkColors,
              nativeTheme.prefersReducedTransparency,
            ).backgroundColor,
          );
          if (process.platform === "darwin")
            window.setVibrancy(nativeTheme.prefersReducedTransparency ? null : "under-window");
        }
        changed();
      });
      if (instances.list().length === 0) await instances.attachCli(true);
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const assets: Record<string, { file: string; type: string }> = {
        "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
        "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
        "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
        "/brand.svg": { file: "brand.svg", type: "image/svg+xml" },
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
          const lobes =
            ((x - 7) / 6) ** 2 + ((y - 11) / 8) ** 2 < 1 ||
            ((x - 15) / 6) ** 2 + ((y - 11) / 8) ** 2 < 1;
          const notch = x >= 7 && x <= 14 && Math.abs(y - 11) < 1.8 + (x - 7) * 0.55;
          if (lobes && !notch) {
            pixels[(y * 22 + x) * 4 + 3] = 255;
          }
        }
      }
      const icon = nativeImage.createFromBitmap(pixels, { width: 22, height: 22 });
      icon.setTemplateImage(process.platform === "darwin");
      // A packaged Mac app already uses its bundle icon. Replacing it retains
      // another decoded Dock bitmap throughout the background host's lifetime.
      if (process.platform === "darwin") {
        if (!app.isPackaged)
          app.dock?.setIcon(
            nativeImage
              .createFromPath(join(ownDirectory, "assets", "app-icon.png"))
              .resize({ width: 256, height: 256 }),
          );
        tray = new Tray(icon);
      } else {
        tray = new Tray(
          nativeImage
            .createFromPath(join(ownDirectory, "assets", "app-icon.png"))
            .resize({ width: 22, height: 22 }),
        );
      }
      tray.setToolTip("Embassys");
      tray.on("click", showWindow);
      updateMenu();
      const openedAtLogin =
        process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin;
      const backgroundLaunch = process.argv.includes("--background") || openedAtLogin;
      windowLifecycle.ready(backgroundLaunch);
      for (const instance of instances.list()) {
        if (quitLifecycle.stopping) break;
        if (!instance.enabled) continue;
        try {
          if (!backgroundLaunch && !(await confirmHandoff(instance))) {
            await instances.updateEnabled(instance.id, false);
            changed();
            continue;
          }
          await getWorker(instance).request({ type: "start", instanceId: instance.id });
        } catch {
          if (!backgroundLaunch)
            dialog.showErrorBox(
              "The server could not start",
              "Check Device settings and Logs before trying again. Any other running server was left alone.",
            );
          changed();
        }
      }
      initialLaunch = false;
    } catch {
      dialog.showErrorBox(
        "Embassys could not open",
        "The application data or bundled runtime is unavailable. No existing Embassys process was stopped.",
      );
      app.quit();
    }
  });
}
