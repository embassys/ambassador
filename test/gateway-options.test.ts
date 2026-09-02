import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GatewayOptionsError,
  parseGatewayStartOptions,
  resolveWebhookToken,
} from "../src/gateway-options.js";

const URL = "http://127.0.0.1:18789/hooks/agent";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

test("accepts exactly the two public start options in either order", () => {
  assert.deepEqual(
    parseGatewayStartOptions([
      "start",
      `--webhook-url=${URL}`,
      "--webhook-token-env=OPENCLAW_HOOK_TOKEN",
    ]),
    { webhookUrl: URL, webhookTokenEnv: "OPENCLAW_HOOK_TOKEN" },
  );
  assert.deepEqual(
    parseGatewayStartOptions([
      "start",
      "--webhook-token-env=OPENCLAW_HOOK_TOKEN",
      `--webhook-url=${URL}`,
    ]),
    { webhookUrl: URL, webhookTokenEnv: "OPENCLAW_HOOK_TOKEN" },
  );
});

test("rejects every extra, split, duplicate, remote, or secret-bearing option", () => {
  const cases = [
    [],
    ["start"],
    ["start", "--webhook-url", URL, "--webhook-token-env=TOKEN"],
    ["start", `--webhook-url=${URL}`, "--webhook-token-env=TOKEN", "--verbose=true"],
    ["start", `--webhook-url=${URL}`, `--webhook-url=${URL}`, "--webhook-token-env=TOKEN"],
    ["start", "--webhook-url=https://example.test/hook", "--webhook-token-env=TOKEN"],
    ["start", "--webhook-url=http://localhost:18789/hook", "--webhook-token-env=TOKEN"],
    ["start", `--webhook-url=${URL}`, "--webhook-token=literal"],
    ["start", `--webhook-url=${URL}`, "--webhook-token-env=bad-name"],
  ];
  for (const arguments_ of cases) {
    assert.throws(
      () => parseGatewayStartOptions(arguments_),
      (error: unknown) => error instanceof GatewayOptionsError && error.exitCode === 2,
    );
  }
});

test("resolves only a generated webhook token without reflecting it", () => {
  assert.equal(resolveWebhookToken({ HOOK_TOKEN: TOKEN }, "HOOK_TOKEN"), TOKEN);
  for (const value of [undefined, "", "A".repeat(48), "0".repeat(47), "0".repeat(49)]) {
    assert.throws(
      () => resolveWebhookToken({ HOOK_TOKEN: value }, "HOOK_TOKEN"),
      (error: unknown) =>
        error instanceof GatewayOptionsError &&
        error.exitCode === 4 &&
        (value === undefined || value === "" || !error.message.includes(value)),
    );
  }
});
