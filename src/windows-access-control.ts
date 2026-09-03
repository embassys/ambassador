import { execFile, execFileSync } from "node:child_process";
import { win32 } from "node:path";

export type WindowsArtifactKind = "directory" | "file";

export interface WindowsAccessControl {
  secure(path: string, kind: WindowsArtifactKind): Promise<void>;
}

const SYSTEM_SID = "S-1-5-18";
const POWERSHELL_TIMEOUT_MS = 30_000;
const WINDOWS_HELPER_ENVIRONMENT_NAMES = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
] as const;

const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { exit 41 }
$target = [Environment]::GetEnvironmentVariable('AMBASSADOR_ACL_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('AMBASSADOR_ACL_KIND', 'Process')
if ([String]::IsNullOrEmpty($target)) { exit 42 }
$attributes = [System.IO.File]::GetAttributes($target)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 43 }
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if (($kind -eq 'directory') -ne $isDirectory) { exit 44 }
if ($kind -ne 'directory' -and $kind -ne 'file') { exit 45 }
$userIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$userSid = $userIdentity.Value
$artifact = if ($isDirectory) {
  [System.IO.DirectoryInfo]::new($target)
} else {
  [System.IO.FileInfo]::new($target)
}
$security = if ($isDirectory) {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$security.SetOwner($userIdentity)
$security.SetAccessRuleProtection($true, $false)
$inheritance = if ($isDirectory) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$expected = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
[void]$expected.Add($userSid)
[void]$expected.Add('${SYSTEM_SID}')
foreach ($sid in $expected) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
}
$artifact.SetAccessControl($security)
$actual = $artifact.GetAccessControl(
  [System.Security.AccessControl.AccessControlSections]'Access,Owner'
)
if (-not $actual.AreAccessRulesProtected) { exit 46 }
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $userSid) {
  exit 47
}
$rules = @($actual.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne $expected.Count) { exit 48 }
foreach ($rule in $rules) {
  if (-not $expected.Contains($rule.IdentityReference.Value)) { exit 49 }
  if ($rule.IsInherited) { exit 50 }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
    exit 51
  }
  if ([int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl) {
    exit 52
  }
  if ($rule.InheritanceFlags -ne $inheritance) { exit 53 }
  if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) {
    exit 54
  }
}
[Console]::Out.Write('AMBASSADOR_ACL_OK')
`;

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (
    systemRoot === undefined ||
    !win32.isAbsolute(systemRoot) ||
    systemRoot.includes("\u0000") ||
    systemRoot.includes("\r") ||
    systemRoot.includes("\n")
  ) {
    throw new Error("Windows state access control failed");
  }
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function helperEnvironment(path: string, kind: WindowsArtifactKind): NodeJS.ProcessEnv {
  if (path.length < 1 || path.length > 32_768 || path.includes("\u0000")) {
    throw new Error("Windows state access control failed");
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const name of WINDOWS_HELPER_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.AMBASSADOR_ACL_PATH = path;
  environment.AMBASSADOR_ACL_KIND = kind;
  return environment;
}

function arguments_(): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
  ];
}

function options(path: string, kind: WindowsArtifactKind) {
  return {
    encoding: "utf8" as const,
    env: helperEnvironment(path, kind),
    maxBuffer: 32 * 1024,
    timeout: POWERSHELL_TIMEOUT_MS,
    windowsHide: true,
  };
}

export async function secureWindowsArtifact(
  path: string,
  kind: WindowsArtifactKind,
): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(powershellExecutable(), arguments_(), options(path, kind), (error, stdout, stderr) => {
      if (error !== null || stderr.length !== 0 || stdout !== "AMBASSADOR_ACL_OK") {
        reject(new Error("Windows state access control failed"));
        return;
      }
      resolve(stdout);
    });
  });
  if (output !== "AMBASSADOR_ACL_OK") throw new Error("Windows state access control failed");
}

export function secureWindowsArtifactSync(path: string, kind: WindowsArtifactKind): void {
  let output: string;
  try {
    output = execFileSync(powershellExecutable(), arguments_(), options(path, kind));
  } catch {
    throw new Error("Windows state access control failed");
  }
  if (output !== "AMBASSADOR_ACL_OK") throw new Error("Windows state access control failed");
}
