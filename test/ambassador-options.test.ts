import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AmbassadorOptionsError,
  parseAmbassadorStartOptions,
  resolveLocalToken,
} from "../src/ambassador-options.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

test("accepts only ambassador start with one local-token environment name", () => {
  assert.deepEqual(parseAmbassadorStartOptions(["start", "--local-token-env=AMBASSADOR_TOKEN"]), {
    localTokenEnv: "AMBASSADOR_TOKEN",
  });
});

test("rejects old, split, duplicate, positional, configuration, and secret-value options", () => {
  const cases = [
    [],
    ["start"],
    ["start", "--local-token-env", "AMBASSADOR_TOKEN"],
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

test("resolves only a generated local token without reflecting it", () => {
  assert.equal(resolveLocalToken({ AMBASSADOR_TOKEN: TOKEN }, "AMBASSADOR_TOKEN"), TOKEN);
  for (const value of [undefined, "", "A".repeat(48), "0".repeat(47), "0".repeat(49)]) {
    assert.throws(
      () => resolveLocalToken({ AMBASSADOR_TOKEN: value }, "AMBASSADOR_TOKEN"),
      (error: unknown) =>
        error instanceof AmbassadorOptionsError &&
        error.exitCode === 4 &&
        (value === undefined || value === "" || !error.message.includes(value)),
    );
  }
});
