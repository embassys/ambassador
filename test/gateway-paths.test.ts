import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultGatewayPaths, pathsForStateDirectory } from "../src/gateway-paths.js";

test("uses only a private gateway state root on macOS", () => {
  assert.deepEqual(defaultGatewayPaths("darwin", {}, "/Users/local"), {
    stateDirectory: "/Users/local/Library/Application Support/a2a-gateway",
    journalPath: "/Users/local/Library/Application Support/a2a-gateway/notifications.sqlite",
    lockPath: "/Users/local/Library/Application Support/a2a-gateway/gateway.lock",
    credentialPath: "/Users/local/Library/Application Support/a2a-gateway/central-credential.json",
  });
});

test("uses the XDG state root on Linux without a configuration path", () => {
  assert.deepEqual(defaultGatewayPaths("linux", { XDG_STATE_HOME: "/state" }, "/home/local"), {
    stateDirectory: "/state/a2a-gateway",
    journalPath: "/state/a2a-gateway/notifications.sqlite",
    lockPath: "/state/a2a-gateway/gateway.lock",
    credentialPath: "/state/a2a-gateway/central-credential.json",
  });
  assert.equal(
    defaultGatewayPaths("linux", {}, "/home/local").stateDirectory,
    "/home/local/.local/state/a2a-gateway",
  );
});

test("uses local application data on Windows", () => {
  assert.deepEqual(
    defaultGatewayPaths("win32", { LOCALAPPDATA: "D:\\Local" }, "C:\\Users\\local"),
    {
      stateDirectory: "D:\\Local\\a2a-gateway",
      journalPath: "D:\\Local\\a2a-gateway\\notifications.sqlite",
      lockPath: "D:\\Local\\a2a-gateway\\gateway.lock",
      credentialPath: "D:\\Local\\a2a-gateway\\central-credential.json",
    },
  );
});

test("uses an injected state root exactly once", () => {
  assert.equal(
    pathsForStateDirectory("/test/state/a2a-gateway").journalPath,
    "/test/state/a2a-gateway/notifications.sqlite",
  );
});
