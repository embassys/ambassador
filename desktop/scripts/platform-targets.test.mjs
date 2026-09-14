import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDesktopTarget } from "./platform-targets.mjs";

test("desktop builds accept Raspberry Pi's 64-bit Linux target alongside existing targets", () => {
  for (const [platform, arch] of [
    ["linux", "arm64"],
    ["linux", "x64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ]) {
    assert.doesNotThrow(() => assertDesktopTarget(platform, arch));
  }
});

test("32-bit Pi OS and unqualified operating-system combinations fail before any download", () => {
  for (const [platform, arch] of [
    ["linux", "arm"],
    ["linux", "armv7l"],
    ["linux", "ia32"],
    ["win32", "arm64"],
    ["freebsd", "arm64"],
    ["darwin", "arm"],
    ["linux", "../../arm64"],
  ]) {
    assert.throws(() => assertDesktopTarget(platform, arch), /desktop target/);
  }
});
