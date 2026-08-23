import assert from "node:assert/strict";
import { test } from "node:test";

import { buildServiceDefinition } from "../src/service-definition.js";

const command = {
  executable: "/Applications/A2A & Tools/node",
  arguments: ["/Applications/A2A & Tools/dist/cli.js", "run", "--config", "/tmp/a2a <user>.json"],
};

test("builds an escaped per-user launchd agent", () => {
  const definition = buildServiceDefinition("darwin", {}, "/Users/local", command);
  assert.equal(definition.kind, "file");
  assert.equal(definition.path, "/Users/local/Library/LaunchAgents/com.a2a.sidecar.plist");
  assert.match(definition.content, /<string>com\.a2a\.sidecar<\/string>/);
  assert.match(definition.content, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(definition.content, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(definition.content, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
  assert.match(definition.content, /A2A &amp; Tools/);
  assert.match(definition.content, /a2a &lt;user&gt;\.json/);
  assert.doesNotMatch(definition.content, /<key>EnvironmentVariables<\/key>/);
});

test("builds a hardened systemd user unit with escaped arguments", () => {
  const definition = buildServiceDefinition(
    "linux",
    { XDG_CONFIG_HOME: "/home/local/.custom config" },
    "/home/local",
    command,
  );
  assert.equal(definition.kind, "file");
  assert.equal(definition.path, "/home/local/.custom config/systemd/user/a2a-sidecar.service");
  assert.match(definition.content, /^\[Unit\]/m);
  assert.match(definition.content, /^ExecStart="\/Applications\/A2A & Tools\/node" /m);
  assert.match(definition.content, /"\/tmp\/a2a <user>\.json"/);
  assert.match(definition.content, /^Restart=on-failure$/m);
  assert.match(definition.content, /^RestartSec=5$/m);
  assert.match(definition.content, /^NoNewPrivileges=true$/m);
  assert.match(definition.content, /^PrivateTmp=true$/m);
  assert.match(definition.content, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(definition.content, /Environment=/);
});

test("builds a quoted per-user Windows task command", () => {
  const definition = buildServiceDefinition(
    "win32",
    { APPDATA: "C:\\Users\\local\\AppData\\Roaming" },
    "C:\\Users\\local",
    {
      executable: "C:\\Program Files\\A2A\\node.exe",
      arguments: [
        "C:\\Program Files\\A2A\\dist\\cli.js",
        "run",
        "--config",
        "C:\\Users\\local\\A2A Config\\config.json",
      ],
    },
  );
  assert.deepEqual(definition, {
    kind: "windows_task",
    name: "A2A Sidecar",
    commandLine:
      '"C:\\Program Files\\A2A\\node.exe" "C:\\Program Files\\A2A\\dist\\cli.js" run --config "C:\\Users\\local\\A2A Config\\config.json"',
  });
});

test("rejects command arguments containing line breaks", () => {
  assert.throws(
    () =>
      buildServiceDefinition("linux", {}, "/home/local", {
        executable: "/usr/bin/node",
        arguments: ["run", "--config", "/tmp/config.json\nEnvironment=LEAK=value"],
      }),
    (error: unknown) => error instanceof Error && error.name !== "NotImplementedError",
  );
});
