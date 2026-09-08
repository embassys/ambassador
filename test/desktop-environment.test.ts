import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopLaunchEnvironment } from "../src/desktop/launch-environment.js";

test("desktop launch finds reviewed user installations without loading a shell", () => {
  const original = {
    PATH: "/usr/bin:/bin:relative::/usr/bin",
    NODE_OPTIONS: "--inspect",
    ELECTRON_RUN_AS_NODE: "1",
    LANG: "en_GB",
  };
  const environment = desktopLaunchEnvironment(original, "/app/runtime", "/Users/owner", "darwin");
  assert.deepEqual(environment.PATH?.split(":"), [
    "/app/runtime",
    "/usr/bin",
    "/bin",
    "/Users/owner/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]);
  assert.equal(environment.LANG, "en_GB");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(original.NODE_OPTIONS, "--inspect");
});

test("Windows desktop normalizes PATH casing and adds the fixed user npm location", () => {
  const environment = desktopLaunchEnvironment(
    {
      Path: "C:\\Windows\\System32;.;C:\\Tools",
      APPDATA: "C:\\Users\\owner\\AppData\\Roaming",
      Node_Options: "--inspect",
    },
    "C:\\App\\runtime",
    "C:\\Users\\owner",
    "win32",
  );
  assert.equal(environment.Path, undefined);
  assert.equal(environment.Node_Options, undefined);
  assert.deepEqual(environment.PATH?.split(";"), [
    "C:\\App\\runtime",
    "C:\\Windows\\System32",
    "C:\\Tools",
    "C:\\Users\\owner\\.local\\bin",
    "C:\\Users\\owner\\AppData\\Roaming\\npm",
  ]);
});

test("desktop executable search is bounded and never adds the current directory", () => {
  const environment = desktopLaunchEnvironment({}, "/app/runtime", "/home/owner", "linux");
  assert.deepEqual(environment.PATH?.split(":"), [
    "/app/runtime",
    "/home/owner/.local/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
  assert.throws(() =>
    desktopLaunchEnvironment({ PATH: "x".repeat(33000) }, "/app/runtime", "/home/owner", "linux"),
  );
  assert.throws(() =>
    desktopLaunchEnvironment({ PATH: "/bin\u0000/other" }, "/app/runtime", "/home/owner", "linux"),
  );
  assert.throws(() => desktopLaunchEnvironment({}, "relative", "/home/owner", "linux"));
});
