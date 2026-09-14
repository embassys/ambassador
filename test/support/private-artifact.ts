import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { assertNativeWindowsAcl } from "./windows-acl.js";

export async function assertPrivateArtifact(path: string, kind: "file" | "directory") {
  if (process.platform === "win32") await assertNativeWindowsAcl(path, kind);
  else {
    const artifact = await stat(path);
    assert.equal(artifact.mode & 0o7777, kind === "file" ? 0o600 : 0o700);
    assert.equal(artifact.uid, process.getuid?.());
  }
}
