import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import {
  type CommandResult,
  type CommandRunner,
  UserServiceManager,
} from "../src/service-manager.js";

interface Invocation {
  executable: string;
  arguments: string[];
}

async function temporaryHome(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a2a-service-test-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function recorder(results: CommandResult[] = []): {
  invocations: Invocation[];
  run: CommandRunner;
} {
  const invocations: Invocation[] = [];
  return {
    invocations,
    run: async (executable, arguments_) => {
      invocations.push({ executable, arguments: [...arguments_] });
      return results.shift() ?? { exitCode: 0, stdout: "" };
    },
  };
}

const command = {
  executable: "/opt/a2a/node",
  arguments: ["/opt/a2a/dist/cli.js", "run", "--config", "/home/local/config.json"],
};

test("installs and controls a launchd user agent without embedding an environment", async (t) => {
  const home = await temporaryHome(t);
  const commands = recorder([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "service = running" },
    { exitCode: 0, stdout: "" },
  ]);
  const manager = new UserServiceManager({
    platform: "darwin",
    env: {},
    homeDirectory: home,
    command,
    uid: 501,
    runCommand: commands.run,
  });

  await manager.install();
  const definitionPath = join(home, "Library", "LaunchAgents", "com.a2a.sidecar.plist");
  const definition = await readFile(definitionPath, "utf8");
  assert.doesNotMatch(definition, /EnvironmentVariables/);
  await manager.start();
  assert.deepEqual(await manager.status(), { installed: true, running: true });
  await manager.restart();
  await manager.stop();

  assert.deepEqual(commands.invocations, [
    { executable: "launchctl", arguments: ["bootstrap", "gui/501", definitionPath] },
    { executable: "launchctl", arguments: ["print", "gui/501/com.a2a.sidecar"] },
    { executable: "launchctl", arguments: ["kickstart", "-k", "gui/501/com.a2a.sidecar"] },
    { executable: "launchctl", arguments: ["bootout", "gui/501/com.a2a.sidecar"] },
  ]);

  await manager.uninstall();
  await assert.rejects(access(definitionPath), { code: "ENOENT" });
  assert.deepEqual(commands.invocations.at(-1), {
    executable: "launchctl",
    arguments: ["bootout", "gui/501/com.a2a.sidecar"],
  });
});

test("installs, enables, and controls a systemd user service", async (t) => {
  const home = await temporaryHome(t);
  const configRoot = join(home, "xdg config");
  const commands = recorder([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "active\n" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
  ]);
  const manager = new UserServiceManager({
    platform: "linux",
    env: { XDG_CONFIG_HOME: configRoot },
    homeDirectory: home,
    command,
    runCommand: commands.run,
  });

  await manager.install();
  const definitionPath = join(configRoot, "systemd", "user", "a2a-sidecar.service");
  await access(definitionPath);
  await manager.start();
  assert.deepEqual(await manager.status(), { installed: true, running: true });
  await manager.restart();
  await manager.stop();
  await manager.uninstall();
  await assert.rejects(access(definitionPath), { code: "ENOENT" });

  assert.deepEqual(commands.invocations, [
    { executable: "systemctl", arguments: ["--user", "daemon-reload"] },
    { executable: "systemctl", arguments: ["--user", "enable", "a2a-sidecar.service"] },
    { executable: "systemctl", arguments: ["--user", "start", "a2a-sidecar.service"] },
    { executable: "systemctl", arguments: ["--user", "is-active", "a2a-sidecar.service"] },
    { executable: "systemctl", arguments: ["--user", "restart", "a2a-sidecar.service"] },
    { executable: "systemctl", arguments: ["--user", "stop", "a2a-sidecar.service"] },
    { executable: "systemctl", arguments: ["--user", "disable", "--now", "a2a-sidecar.service"] },
    { executable: "systemctl", arguments: ["--user", "daemon-reload"] },
  ]);
});

test("creates and controls a restarting per-user Windows scheduled task", async (t) => {
  const home = await temporaryHome(t);
  const definitionPath = join(home, "a2a-sidecar-task.xml");
  const commands = recorder([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "Status: Running" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
  ]);
  const manager = new UserServiceManager({
    platform: "win32",
    env: {},
    homeDirectory: home,
    command: {
      executable: "C:\\Program Files\\A2A\\node.exe",
      arguments: ["C:\\Program Files\\A2A\\cli.js", "run"],
    },
    runCommand: commands.run,
    windowsDefinitionPath: definitionPath,
  });

  await manager.install();
  const definition = await readFile(definitionPath, "utf8");
  assert.match(definition, /<RestartOnFailure>/);
  assert.match(definition, /<Interval>PT1M<\/Interval>/);
  await manager.start();
  assert.deepEqual(await manager.status(), { installed: true, running: true });
  await manager.restart();
  await manager.stop();
  await manager.uninstall();

  assert.deepEqual(commands.invocations, [
    {
      executable: "schtasks.exe",
      arguments: ["/Create", "/TN", "A2A Sidecar", "/XML", definitionPath, "/F"],
    },
    { executable: "schtasks.exe", arguments: ["/Run", "/TN", "A2A Sidecar"] },
    { executable: "schtasks.exe", arguments: ["/Query", "/TN", "A2A Sidecar"] },
    { executable: "schtasks.exe", arguments: ["/End", "/TN", "A2A Sidecar"] },
    { executable: "schtasks.exe", arguments: ["/Run", "/TN", "A2A Sidecar"] },
    { executable: "schtasks.exe", arguments: ["/End", "/TN", "A2A Sidecar"] },
    { executable: "schtasks.exe", arguments: ["/Delete", "/TN", "A2A Sidecar", "/F"] },
  ]);
  await assert.rejects(access(definitionPath), { code: "ENOENT" });
});

test("returns installed but stopped when the native status command is inactive", async (t) => {
  const home = await temporaryHome(t);
  const commands = recorder([
    { exitCode: 0, stdout: "" },
    { exitCode: 0, stdout: "" },
    { exitCode: 3, stdout: "inactive\n" },
  ]);
  const manager = new UserServiceManager({
    platform: "linux",
    env: {},
    homeDirectory: home,
    command,
    runCommand: commands.run,
  });
  await manager.install();

  assert.deepEqual(await manager.status(), { installed: true, running: false });
});
