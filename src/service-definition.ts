import { NotImplementedError } from "./errors.js";

export interface ServiceCommand {
  executable: string;
  arguments: string[];
}

export interface FileServiceDefinition {
  kind: "file";
  path: string;
  content: string;
}

export interface WindowsTaskDefinition {
  kind: "windows_task";
  name: "A2A Sidecar";
  commandLine: string;
}

export type ServiceDefinition = FileServiceDefinition | WindowsTaskDefinition;

export function buildServiceDefinition(
  _platform: NodeJS.Platform,
  _env: NodeJS.ProcessEnv,
  _homeDirectory: string,
  _command: ServiceCommand,
): ServiceDefinition {
  throw new NotImplementedError("buildServiceDefinition");
}
