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
    webhookSecretPath: "/Users/local/Library/Application Support/ambassador/webhook-secret.json",
    webhookSecretKeyPath: "/Users/local/Library/Application Support/ambassador/webhook-secret.key",
    localControlSecretPath:
      "/Users/local/Library/Application Support/ambassador/local-control-secret.json",
    localControlSecretKeyPath:
      "/Users/local/Library/Application Support/ambassador/local-control-secret.key",
    pendingActionPath: "/Users/local/Library/Application Support/ambassador/pending-actions.sqlite",
    actionResultPath: "/Users/local/Library/Application Support/ambassador/action-results.sqlite",
    acpSessionPath: "/Users/local/Library/Application Support/ambassador/acp-sessions.sqlite",
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
    webhookSecretPath: "/state/ambassador/webhook-secret.json",
    webhookSecretKeyPath: "/state/ambassador/webhook-secret.key",
    localControlSecretPath: "/state/ambassador/local-control-secret.json",
    localControlSecretKeyPath: "/state/ambassador/local-control-secret.key",
    pendingActionPath: "/state/ambassador/pending-actions.sqlite",
    actionResultPath: "/state/ambassador/action-results.sqlite",
    acpSessionPath: "/state/ambassador/acp-sessions.sqlite",
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
      webhookSecretPath: "D:\\Local\\ambassador\\webhook-secret.json",
      webhookSecretKeyPath: "D:\\Local\\ambassador\\webhook-secret.key",
      localControlSecretPath: "D:\\Local\\ambassador\\local-control-secret.json",
      localControlSecretKeyPath: "D:\\Local\\ambassador\\local-control-secret.key",
      pendingActionPath: "D:\\Local\\ambassador\\pending-actions.sqlite",
      actionResultPath: "D:\\Local\\ambassador\\action-results.sqlite",
      acpSessionPath: "D:\\Local\\ambassador\\acp-sessions.sqlite",
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
