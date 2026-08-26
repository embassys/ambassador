import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayOptionsError,
  parseGatewayStartOptions,
  resolveDevelopmentCentralUrls,
  resolveWebhookToken,
} from "../src/gateway-options.js";

const URL = "http://127.0.0.1:18789/hooks/agent";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

test("accepts exactly the two named start options in either order", () => {
  assert.deepEqual(
    parseGatewayStartOptions([
      "start",
      `--webhook-url=${URL}`,
      "--webhook-token-env=OPENCLAW_HOOK_TOKEN",
    ]),
    { webhookUrl: URL, webhookTokenEnv: "OPENCLAW_HOOK_TOKEN" },
  );
  assert.equal(
    parseGatewayStartOptions([
      "start",
      "--webhook-url=http://127.0.0.1:80/hooks/agent",
      "--webhook-token-env=OPENCLAW_HOOK_TOKEN",
    ]).webhookUrl,
    "http://127.0.0.1:80/hooks/agent",
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

test("rejects removed commands and invalid option forms without retaining their values", () => {
  const cases = [
    [],
    ["setup"],
    ["agent", "list"],
    ["run"],
    ["start", `--webhook-url=${URL}`],
    ["start", "--webhook-token-env=TOKEN"],
    ["start", "--webhook-url", URL, "--webhook-token-env=TOKEN"],
    ["start", `--webhook-url=${URL}`, `--webhook-url=${URL}`],
    ["start", `--webhook-url=${URL}`, "--webhook-token-env=TOKEN", "binding-id"],
    ["start", `--webhook-url=${URL}`, "--webhook-token=literal"],
  ];

  for (const args of cases) {
    assert.throws(
      () => parseGatewayStartOptions(args),
      (error: unknown) =>
        error instanceof GatewayOptionsError &&
        error.exitCode === 2 &&
        !error.message.includes(URL),
    );
  }
});

test("requires a literal loopback URL with an explicit valid port", () => {
  for (const webhookUrl of [
    "https://hooks.example/agent",
    "http://localhost:18789/hooks/agent",
    "http://127.0.0.2:18789/hooks/agent",
    "http://127.0.0.1/hooks/agent",
    "http://127.0.0.1:0/hooks/agent",
    "http://127.0.0.1:65536/hooks/agent",
    "http://user:password@127.0.0.1:18789/hooks/agent",
    "http://127.0.0.1:18789/hooks/agent#fragment",
  ]) {
    assert.throws(
      () =>
        parseGatewayStartOptions([
          "start",
          `--webhook-url=${webhookUrl}`,
          "--webhook-token-env=TOKEN",
        ]),
      (error: unknown) => error instanceof GatewayOptionsError && error.exitCode === 2,
    );
  }
});

test("resolves only a 192-bit lowercase hexadecimal hook token", () => {
  assert.equal(resolveWebhookToken({ OPENCLAW_HOOK_TOKEN: TOKEN }, "OPENCLAW_HOOK_TOKEN"), TOKEN);

  for (const value of [
    undefined,
    "",
    "a".repeat(47),
    "A".repeat(48),
    "g".repeat(48),
    `${TOKEN}\n`,
  ]) {
    assert.throws(
      () =>
        resolveWebhookToken(
          value === undefined ? {} : { OPENCLAW_HOOK_TOKEN: value },
          "OPENCLAW_HOOK_TOKEN",
        ),
      (error: unknown) =>
        error instanceof GatewayOptionsError &&
        error.exitCode === 4 &&
        error.message === "Invalid webhook token",
    );
  }
});

test("resolves only a complete safe pair of development central URLs", () => {
  assert.equal(resolveDevelopmentCentralUrls({}), undefined);
  assert.deepEqual(
    resolveDevelopmentCentralUrls({
      A2A_DEV_CENTRAL_API_URL: "http://127.0.0.1:8000",
      A2A_DEV_CENTRAL_MCP_URL: "http://127.0.0.1:8000/mcp",
    }),
    {
      centralApiUrl: "http://127.0.0.1:8000",
      centralMcpUrl: "http://127.0.0.1:8000/mcp",
    },
  );
  assert.deepEqual(
    resolveDevelopmentCentralUrls({
      A2A_DEV_CENTRAL_API_URL: "https://api.dev.example",
      A2A_DEV_CENTRAL_MCP_URL: "https://mcp.dev.example/mcp",
    }),
    {
      centralApiUrl: "https://api.dev.example",
      centralMcpUrl: "https://mcp.dev.example/mcp",
    },
  );
  assert.deepEqual(
    resolveDevelopmentCentralUrls({
      A2A_DEV_CENTRAL_API_URL: "http://localhost:8000",
      A2A_DEV_CENTRAL_MCP_URL: "http://[::1]:8000/mcp",
    }),
    {
      centralApiUrl: "http://localhost:8000",
      centralMcpUrl: "http://[::1]:8000/mcp",
    },
  );

  for (const environment of [
    { A2A_DEV_CENTRAL_API_URL: "http://127.0.0.1:8000" },
    { A2A_DEV_CENTRAL_MCP_URL: "http://127.0.0.1:8000/mcp" },
    { A2A_DEV_CENTRAL_API_URL: "", A2A_DEV_CENTRAL_MCP_URL: "http://127.0.0.1/mcp" },
    {
      A2A_DEV_CENTRAL_API_URL: "http://central.dev.example",
      A2A_DEV_CENTRAL_MCP_URL: "http://central.dev.example/mcp",
    },
    {
      A2A_DEV_CENTRAL_API_URL: "https://user:secret@api.dev.example",
      A2A_DEV_CENTRAL_MCP_URL: "https://mcp.dev.example/mcp",
    },
    {
      A2A_DEV_CENTRAL_API_URL: "https://api.dev.example?secret=value",
      A2A_DEV_CENTRAL_MCP_URL: "https://mcp.dev.example/mcp#fragment",
    },
    {
      A2A_DEV_CENTRAL_API_URL: "https://api.dev.example/embedded space",
      A2A_DEV_CENTRAL_MCP_URL: "https://mcp.dev.example/mcp",
    },
  ]) {
    assert.throws(
      () => resolveDevelopmentCentralUrls(environment),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Invalid development central endpoints" &&
        !error.message.includes("secret"),
    );
  }
});
