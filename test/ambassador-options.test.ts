import assert from "node:assert/strict";
import { test } from "node:test";

import { AmbassadorOptionsError, parseAmbassadorStartOptions } from "../src/ambassador-options.js";

test("accepts only ambassador start without options", () => {
  assert.deepEqual(parseAmbassadorStartOptions(["start"]), {});
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
