export function assertDesktopTarget(platform, arch) {
  if (
    ((platform === "darwin" || platform === "linux") && ["arm64", "x64"].includes(arch)) ||
    (platform === "win32" && arch === "x64")
  )
    return;
  throw new Error(
    "This desktop target has not been approved. Raspberry Pi requires 64-bit Linux (arm64).",
  );
}
