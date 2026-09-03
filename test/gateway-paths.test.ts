import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultGatewayPaths, pathsForStateDirectory } from "../src/gateway-paths.js";

test("uses only a private Ambassador state root on macOS", () => {
  assert.deepEqual(defaultGatewayPaths("darwin", {}, "/Users/local"), {
    stateDirectory: "/Users/local/Library/Application Support/ambassador",
    journalPath: "/Users/local/Library/Application Support/ambassador/notifications.sqlite",
    lockPath: "/Users/local/Library/Application Support/ambassador/ambassador.lock",
    credentialPath: "/Users/local/Library/Application Support/ambassador/central-credential.json",
    credentialKeyPath: "/Users/local/Library/Application Support/ambassador/central-credential.key",
    profilePath: "/Users/local/Library/Application Support/ambassador/delivery-profile.json",
  });
});

test("uses the XDG state root on Linux without a configuration path", () => {
  assert.deepEqual(defaultGatewayPaths("linux", { XDG_STATE_HOME: "/state" }, "/home/local"), {
    stateDirectory: "/state/ambassador",
    journalPath: "/state/ambassador/notifications.sqlite",
    lockPath: "/state/ambassador/ambassador.lock",
    credentialPath: "/state/ambassador/central-credential.json",
    credentialKeyPath: "/state/ambassador/central-credential.key",
    profilePath: "/state/ambassador/delivery-profile.json",
  });
  assert.equal(
    defaultGatewayPaths("linux", {}, "/home/local").stateDirectory,
    "/home/local/.local/state/ambassador",
  );
});

test("uses local application data on Windows", () => {
  assert.deepEqual(
    defaultGatewayPaths("win32", { LOCALAPPDATA: "D:\\Local" }, "C:\\Users\\local"),
    {
      stateDirectory: "D:\\Local\\ambassador",
      journalPath: "D:\\Local\\ambassador\\notifications.sqlite",
      lockPath: "D:\\Local\\ambassador\\ambassador.lock",
      credentialPath: "D:\\Local\\ambassador\\central-credential.json",
      credentialKeyPath: "D:\\Local\\ambassador\\central-credential.key",
      profilePath: "D:\\Local\\ambassador\\delivery-profile.json",
    },
  );
});

test("uses an injected state root exactly once", () => {
  assert.equal(
    pathsForStateDirectory("/test/state/ambassador").journalPath,
    "/test/state/ambassador/notifications.sqlite",
  );
});
