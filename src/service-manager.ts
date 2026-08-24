import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";

import { SidecarError } from "./errors.js";
import {
  buildServiceDefinition,
  type ServiceCommand,
  type ServiceDefinition,
} from "./service-definition.js";

const SERVICE_ERROR = new SidecarError("service_error", "Service operation failed", 7);
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface CommandResult {
  exitCode: number;
  stdout: string;
}

export type CommandRunner = (executable: string, arguments_: string[]) => Promise<CommandResult>;

export interface UserServiceManagerOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  command: ServiceCommand;
  uid?: number;
  runCommand?: CommandRunner;
  windowsDefinitionPath?: string;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
}

async function runCommand(executable: string, arguments_: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (size > MAX_COMMAND_OUTPUT_BYTES) {
        reject(SERVICE_ERROR);
        return;
      }
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw SERVICE_ERROR;
  }
}

async function writeDefinition(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.a2a-service.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw SERVICE_ERROR;
  }
}

export class UserServiceManager {
  private readonly platform: NodeJS.Platform;
  private readonly definition: ServiceDefinition;
  private readonly runCommand: CommandRunner;
  private readonly launchdDomain: string | undefined;
  private readonly windowsDefinitionPath: string | undefined;

  constructor(options: UserServiceManagerOptions) {
    this.platform = options.platform;
    this.definition = buildServiceDefinition(
      options.platform,
      options.env,
      options.homeDirectory,
      options.command,
    );
    this.runCommand = options.runCommand ?? runCommand;

    if (options.platform === "darwin") {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw SERVICE_ERROR;
      this.launchdDomain = `gui/${uid}`;
    }
    if (options.platform === "win32") {
      const stateRoot =
        options.env.LOCALAPPDATA ?? win32.join(options.homeDirectory, "AppData", "Local");
      this.windowsDefinitionPath =
        options.windowsDefinitionPath ??
        win32.join(stateRoot, "a2a-sidecar", "a2a-sidecar-task.xml");
    }
  }

  private async required(executable: string, arguments_: string[]): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.runCommand(executable, arguments_);
    } catch {
      throw SERVICE_ERROR;
    }
    if (result.exitCode !== 0) throw SERVICE_ERROR;
    return result;
  }

  async install(): Promise<void> {
    if (this.platform === "darwin") {
      if (this.definition.kind !== "file") throw SERVICE_ERROR;
      await writeDefinition(this.definition.path, this.definition.content);
      return;
    }
    if (this.platform === "linux") {
      if (this.definition.kind !== "file") throw SERVICE_ERROR;
      await writeDefinition(this.definition.path, this.definition.content);
      await this.required("systemctl", ["--user", "daemon-reload"]);
      await this.required("systemctl", ["--user", "enable", "a2a-sidecar.service"]);
      return;
    }
    if (this.platform === "win32") {
      if (this.definition.kind !== "windows_task" || this.windowsDefinitionPath === undefined) {
        throw SERVICE_ERROR;
      }
      await writeDefinition(this.windowsDefinitionPath, this.definition.content);
      await this.required("schtasks.exe", [
        "/Create",
        "/TN",
        this.definition.name,
        "/XML",
        this.windowsDefinitionPath,
        "/F",
      ]);
      return;
    }
    throw SERVICE_ERROR;
  }

  async start(): Promise<void> {
    if (this.platform === "darwin") {
      if (this.definition.kind !== "file" || this.launchdDomain === undefined) throw SERVICE_ERROR;
      await this.required("launchctl", ["bootstrap", this.launchdDomain, this.definition.path]);
      return;
    }
    if (this.platform === "linux") {
      await this.required("systemctl", ["--user", "start", "a2a-sidecar.service"]);
      return;
    }
    if (this.platform === "win32") {
      await this.required("schtasks.exe", ["/Run", "/TN", "A2A Sidecar"]);
      return;
    }
    throw SERVICE_ERROR;
  }

  async stop(): Promise<void> {
    if (this.platform === "darwin") {
      if (this.launchdDomain === undefined) throw SERVICE_ERROR;
      await this.required("launchctl", ["bootout", `${this.launchdDomain}/com.a2a.sidecar`]);
      return;
    }
    if (this.platform === "linux") {
      await this.required("systemctl", ["--user", "stop", "a2a-sidecar.service"]);
      return;
    }
    if (this.platform === "win32") {
      await this.required("schtasks.exe", ["/End", "/TN", "A2A Sidecar"]);
      return;
    }
    throw SERVICE_ERROR;
  }

  async restart(): Promise<void> {
    if (this.platform === "darwin") {
      if (this.launchdDomain === undefined) throw SERVICE_ERROR;
      await this.required("launchctl", [
        "kickstart",
        "-k",
        `${this.launchdDomain}/com.a2a.sidecar`,
      ]);
      return;
    }
    if (this.platform === "linux") {
      await this.required("systemctl", ["--user", "restart", "a2a-sidecar.service"]);
      return;
    }
    if (this.platform === "win32") {
      await this.runCommand("schtasks.exe", ["/End", "/TN", "A2A Sidecar"]).catch(() => undefined);
      await this.required("schtasks.exe", ["/Run", "/TN", "A2A Sidecar"]);
      return;
    }
    throw SERVICE_ERROR;
  }

  async status(): Promise<ServiceStatus> {
    if (this.platform === "darwin") {
      if (this.definition.kind !== "file" || this.launchdDomain === undefined) throw SERVICE_ERROR;
      const installed = await exists(this.definition.path);
      if (!installed) return { installed: false, running: false };
      const result = await this.runCommand("launchctl", [
        "print",
        `${this.launchdDomain}/com.a2a.sidecar`,
      ]).catch(() => ({ exitCode: 1, stdout: "" }));
      return { installed: true, running: result.exitCode === 0 };
    }
    if (this.platform === "linux") {
      if (this.definition.kind !== "file") throw SERVICE_ERROR;
      const installed = await exists(this.definition.path);
      if (!installed) return { installed: false, running: false };
      const result = await this.runCommand("systemctl", [
        "--user",
        "is-active",
        "a2a-sidecar.service",
      ]).catch(() => ({ exitCode: 1, stdout: "" }));
      return { installed: true, running: result.exitCode === 0 };
    }
    if (this.platform === "win32") {
      const result = await this.runCommand("schtasks.exe", ["/Query", "/TN", "A2A Sidecar"]).catch(
        () => ({ exitCode: 1, stdout: "" }),
      );
      return {
        installed: result.exitCode === 0,
        running: result.exitCode === 0 && /\brunning\b/i.test(result.stdout),
      };
    }
    throw SERVICE_ERROR;
  }

  async uninstall(): Promise<void> {
    if (this.platform === "darwin") {
      if (this.definition.kind !== "file" || this.launchdDomain === undefined) throw SERVICE_ERROR;
      await this.runCommand("launchctl", [
        "bootout",
        `${this.launchdDomain}/com.a2a.sidecar`,
      ]).catch(() => undefined);
      await rm(this.definition.path, { force: true }).catch(() => {
        throw SERVICE_ERROR;
      });
      return;
    }
    if (this.platform === "linux") {
      if (this.definition.kind !== "file") throw SERVICE_ERROR;
      await this.required("systemctl", ["--user", "disable", "--now", "a2a-sidecar.service"]);
      await rm(this.definition.path, { force: true }).catch(() => {
        throw SERVICE_ERROR;
      });
      await this.required("systemctl", ["--user", "daemon-reload"]);
      return;
    }
    if (this.platform === "win32") {
      await this.required("schtasks.exe", ["/Delete", "/TN", "A2A Sidecar", "/F"]);
      if (this.windowsDefinitionPath !== undefined) {
        await rm(this.windowsDefinitionPath, { force: true }).catch(() => {
          throw SERVICE_ERROR;
        });
      }
      return;
    }
    throw SERVICE_ERROR;
  }
}
