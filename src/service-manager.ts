import { NotImplementedError } from "./errors.js";
import type { ServiceCommand } from "./service-definition.js";

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
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
}

export class UserServiceManager {
  constructor(_options: UserServiceManagerOptions) {
    throw new NotImplementedError("UserServiceManager.constructor");
  }

  async install(): Promise<void> {
    throw new NotImplementedError("UserServiceManager.install");
  }

  async start(): Promise<void> {
    throw new NotImplementedError("UserServiceManager.start");
  }

  async stop(): Promise<void> {
    throw new NotImplementedError("UserServiceManager.stop");
  }

  async restart(): Promise<void> {
    throw new NotImplementedError("UserServiceManager.restart");
  }

  async status(): Promise<ServiceStatus> {
    throw new NotImplementedError("UserServiceManager.status");
  }

  async uninstall(): Promise<void> {
    throw new NotImplementedError("UserServiceManager.uninstall");
  }
}
