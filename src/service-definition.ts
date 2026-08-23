import { posix } from "node:path";

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

function validateCommand(command: ServiceCommand): void {
  for (const value of [command.executable, ...command.arguments]) {
    if (value.length === 0 || /[\0\r\n]/.test(value)) {
      throw new Error("Service command contains an invalid argument");
    }
  }
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdArgument(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "$$")
    .replaceAll("%", "%%")}"`;
}

function windowsArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

export function buildServiceDefinition(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
  command: ServiceCommand,
): ServiceDefinition {
  validateCommand(command);
  const commandLine = [command.executable, ...command.arguments];

  if (platform === "darwin") {
    const argumentsXml = commandLine
      .map((value) => `      <string>${xml(value)}</string>`)
      .join("\n");
    return {
      kind: "file",
      path: posix.join(homeDirectory, "Library", "LaunchAgents", "com.a2a.sidecar.plist"),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.a2a.sidecar</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`,
    };
  }

  if (platform === "linux") {
    const configRoot = env.XDG_CONFIG_HOME || posix.join(homeDirectory, ".config");
    return {
      kind: "file",
      path: posix.join(configRoot, "systemd", "user", "a2a-sidecar.service"),
      content: `[Unit]
Description=A2A Sidecar
After=network-online.target

[Service]
Type=simple
ExecStart=${commandLine.map(systemdArgument).join(" ")}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`,
    };
  }

  if (platform === "win32") {
    return {
      kind: "windows_task",
      name: "A2A Sidecar",
      commandLine: commandLine.map(windowsArgument).join(" "),
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}
