import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultPaths } from "../src/paths.js";

test("uses macOS Application Support for configuration and state", () => {
  assert.deepEqual(defaultPaths("darwin", {}, "/Users/local"), {
    configPath: "/Users/local/Library/Application Support/a2a-sidecar/config.json",
    stateDirectory: "/Users/local/Library/Application Support/a2a-sidecar",
    journalPath: "/Users/local/Library/Application Support/a2a-sidecar/journal.sqlite",
    lockPath: "/Users/local/Library/Application Support/a2a-sidecar/daemon.lock",
  });
});

test("uses XDG roots on Linux with home-directory fallbacks", () => {
  assert.deepEqual(
    defaultPaths("linux", { XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" }, "/home/local"),
    {
      configPath: "/config/a2a-sidecar/config.json",
      stateDirectory: "/state/a2a-sidecar",
      journalPath: "/state/a2a-sidecar/journal.sqlite",
      lockPath: "/state/a2a-sidecar/daemon.lock",
    },
  );
  assert.deepEqual(defaultPaths("linux", {}, "/home/local"), {
    configPath: "/home/local/.config/a2a-sidecar/config.json",
    stateDirectory: "/home/local/.local/state/a2a-sidecar",
    journalPath: "/home/local/.local/state/a2a-sidecar/journal.sqlite",
    lockPath: "/home/local/.local/state/a2a-sidecar/daemon.lock",
  });
});

test("uses Windows roaming configuration and local state", () => {
  assert.deepEqual(
    defaultPaths(
      "win32",
      { APPDATA: "C:\\Users\\local\\AppData\\Roaming", LOCALAPPDATA: "D:\\Local" },
      "C:\\Users\\local",
    ),
    {
      configPath: "C:\\Users\\local\\AppData\\Roaming\\a2a-sidecar\\config.json",
      stateDirectory: "D:\\Local\\a2a-sidecar",
      journalPath: "D:\\Local\\a2a-sidecar\\journal.sqlite",
      lockPath: "D:\\Local\\a2a-sidecar\\daemon.lock",
    },
  );
});
