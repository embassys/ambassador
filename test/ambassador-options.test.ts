import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AmbassadorOptionsError,
  parseAmbassadorCommand,
  parseAmbassadorStartOptions,
} from "../src/ambassador-options.js";

test("accepts ambassador start with optional verbose output", () => {
  assert.deepEqual(parseAmbassadorStartOptions(["start"]), { verbose: false });
  assert.deepEqual(parseAmbassadorStartOptions(["start", "--verbose"]), { verbose: true });
});

test("accepts the explicit utility and session commands", () => {
  assert.deepEqual(parseAmbassadorCommand(["webhook-secret"]), { command: "webhook-secret" });
  assert.deepEqual(parseAmbassadorCommand(["clean"]), { command: "clean" });
  assert.deepEqual(parseAmbassadorCommand(["start"]), { command: "start", verbose: false });
  assert.deepEqual(parseAmbassadorCommand(["sessions", "list"]), {
    command: "sessions",
    action: "list",
  });
  assert.deepEqual(parseAmbassadorCommand(["sessions", "show", "session-1"]), {
    command: "sessions",
    action: "show",
    sessionId: "session-1",
    verbose: false,
  });
  assert.deepEqual(parseAmbassadorCommand(["sessions", "show", "session-1", "--verbose"]), {
    command: "sessions",
    action: "show",
    sessionId: "session-1",
    verbose: true,
  });
  assert.deepEqual(parseAmbassadorCommand(["sessions", "delete", "session-1"]), {
    command: "sessions",
    action: "delete",
    sessionId: "session-1",
  });
  assert.deepEqual(parseAmbassadorCommand(["sessions", "forget", "session-1"]), {
    command: "sessions",
    action: "forget",
    sessionId: "session-1",
  });
  assert.throws(() => parseAmbassadorCommand(["webhook-secret", "extra"]));
  assert.throws(() => parseAmbassadorCommand(["webhook-secret", "--json"]));
  assert.throws(() => parseAmbassadorCommand(["clean", "extra"]));
  assert.throws(() => parseAmbassadorCommand(["clean", "--force"]));
  assert.throws(() => parseAmbassadorCommand(["sessions"]));
  assert.throws(() => parseAmbassadorCommand(["sessions", "show"]));
  assert.throws(() => parseAmbassadorCommand(["sessions", "delete", "session-1", "extra"]));
  assert.throws(() => parseAmbassadorCommand(["sessions", "forget", "session-1", "--force"]));
});

test("rejects old, split, duplicate, positional, configuration, and secret-value options", () => {
  const cases = [
    [],
    ["start", "--local-token-env", "AMBASSADOR_TOKEN"],
    ["start", "--local-token-env=AMBASSADOR_TOKEN"],
    ["start", "--local-token-env=AMBASSADOR_TOKEN", "--local-token-env=SECOND_TOKEN"],
    ["start", "--local-token-env=AMBASSADOR_TOKEN", "extra"],
    ["start", "--local-token=literal"],
    ["start", "--webhook-url=https://example.test/hook"],
    ["start", "--webhook-token-env=HOOK_TOKEN"],
    ["start", "--agent=openclaw"],
    ["start", "--acp-agent=openclaw"],
    ["start", "--delivery=direct"],
    ["start", "--central-url=https://example.test"],
    ["start", "--config=/tmp/config.json"],
    ["start", "--local-token-env=bad-name"],
  ];
  for (const arguments_ of cases) {
    assert.throws(
      () => parseAmbassadorStartOptions(arguments_),
      (error: unknown) => error instanceof AmbassadorOptionsError && error.exitCode === 2,
    );
  }
});
