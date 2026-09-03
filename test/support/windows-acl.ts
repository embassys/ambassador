import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";

const SYSTEM_SID = "S-1-5-18";

const OBSERVE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { exit 61 }
$target = [Environment]::GetEnvironmentVariable('AMBASSADOR_TEST_ACL_PATH', 'Process')
$kind = [Environment]::GetEnvironmentVariable('AMBASSADOR_TEST_ACL_KIND', 'Process')
if ([String]::IsNullOrEmpty($target)) { exit 62 }
$attributes = [System.IO.File]::GetAttributes($target)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 63 }
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if (($kind -eq 'directory') -ne $isDirectory) { exit 64 }
$artifact = if ($isDirectory) {
  [System.IO.DirectoryInfo]::new($target)
} else {
  [System.IO.FileInfo]::new($target)
}
$acl = $artifact.GetAccessControl(
  [System.Security.AccessControl.AccessControlSections]'Access,Owner'
)
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$expected = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)
[void]$expected.Add($currentSid)
[void]$expected.Add('${SYSTEM_SID}')
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid) { exit 65 }
if (-not $acl.AreAccessRulesProtected) { exit 66 }
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
if ($rules.Count -ne $expected.Count) { exit 67 }
$expectedInheritance = if ($kind -eq 'directory') { 3 } else { 0 }
foreach ($rule in $rules) {
  if (-not $expected.Contains($rule.IdentityReference.Value)) { exit 68 }
  if ($rule.IsInherited) { exit 69 }
  if ([int]$rule.AccessControlType -ne 0) { exit 70 }
  if ([int]$rule.FileSystemRights -ne 2032127) { exit 71 }
  if ([int]$rule.InheritanceFlags -ne $expectedInheritance) { exit 72 }
  if ([int]$rule.PropagationFlags -ne 0) { exit 73 }
}
[Console]::Out.Write('AMBASSADOR_TEST_ACL_OK')
`;

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  assert.ok(
    systemRoot !== undefined &&
      isAbsolute(systemRoot) &&
      !systemRoot.includes("\u0000") &&
      !systemRoot.includes("\r") &&
      !systemRoot.includes("\n"),
  );
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function assertNativeWindowsAcl(
  path: string,
  kind: "directory" | "file",
): Promise<void> {
  assert.equal(process.platform, "win32");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      powershellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(OBSERVE_ACL_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AMBASSADOR_TEST_ACL_PATH: path,
          AMBASSADOR_TEST_ACL_KIND: kind,
        },
        maxBuffer: 32 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null || stderr.length !== 0) {
          reject(new Error("Native Windows ACL observation failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
  assert.equal(output, "AMBASSADOR_TEST_ACL_OK");
}
