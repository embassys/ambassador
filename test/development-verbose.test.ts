import assert from "node:assert/strict";
import test from "node:test";

import { DevelopmentVerboseTranscript } from "../src/development-verbose.js";

function transcript(): { trace: DevelopmentVerboseTranscript; read: () => string } {
  let output = "";
  return {
    trace: new DevelopmentVerboseTranscript(
      {
        write(chunk: string | Uint8Array): boolean {
          output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
      ["webhook-secret-value"],
    ),
    read: () => output,
  };
}

test("prints development request and response content while redacting credentials and codes", () => {
  const value = transcript();
  value.trace.record({
    boundary: "central_mcp",
    direction: "request",
    method: "POST",
    url: "https://central.example/mcp",
    headers: {
      authorization: "Bearer webhook-secret-value",
      cookie: "session=must-not-appear",
      "mcp-session-id": "session-visible",
      "set-cookie": "gateway-session=must-not-appear-either",
      "x-webhook-signature-v2": "signature-must-not-appear",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "verify_email",
        arguments: {
          email: "live-agent@nikrooz.com",
          code: "123456",
          note: "visible request content",
        },
      },
    }),
  });
  value.trace.record({
    boundary: "central_mcp",
    direction: "response",
    status: 200,
    body: JSON.stringify({
      result: {
        structuredContent: {
          result:
            "{'agent_id': 'agent_live', 'token': 'central-secret-value', 'message': 'verified'}",
        },
      },
    }),
  });

  const output = value.read();
  assert.match(output, /live-agent@nikrooz\.com/u);
  assert.match(output, /visible request content/u);
  assert.match(output, /agent_live/u);
  assert.match(output, /session-visible/u);
  for (const forbidden of [
    "webhook-secret-value",
    "central-secret-value",
    "123456",
    "must-not-appear",
    "must-not-appear-either",
    "signature-must-not-appear",
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
  assert.match(output, /<redacted>/u);
});

test("redacts known secrets even when they appear outside credential-named fields", () => {
  const value = transcript();
  value.trace.addSecret("central-secret-value");
  value.trace.record({
    boundary: "gateway",
    direction: "error",
    body: "upstream echoed central-secret-value and webhook-secret-value",
  });

  const output = value.read();
  assert.equal(output.includes("central-secret-value"), false);
  assert.equal(output.includes("webhook-secret-value"), false);
  assert.match(output, /upstream echoed <redacted> and <redacted>/u);
});
