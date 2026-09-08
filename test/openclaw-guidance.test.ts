import assert from "node:assert/strict";
import { test } from "node:test";
import { registerOpenClawGuidance } from "../src/openclaw-guidance.js";

test("OpenClaw discovery guidance is fixed, uses configured tools, and does not claim delivery", () => {
  let hook: (() => { prependSystemContext: string } | undefined) | undefined;
  registerOpenClawGuidance({
    config: { mcp: { servers: { ambassador: { url: "http://127.0.0.1:9797/mcp" } } } },
    on(name, callback) {
      assert.equal(name, "before_prompt_build");
      hook = callback;
    },
  });
  const text = hook?.()?.prependSystemContext;
  assert.ok(text);
  assert.match(text, /Embassys.*Ambassador/);
  assert.match(text, /register_agent.*verify_email/);
  assert.match(text, /host.*forbids.*codes.*Embassys app.*same installation/);
  assert.match(text, /same request ID/);
  assert.match(text, /Do not create.*task/);
  assert.match(text, /experimental/);
  assert.doesNotMatch(text, /9797|auto.approve|bypass|guarantee/);
  assert.ok(text.length < 1300);
});

test("missing or disabled MCP connections contribute no registration or return instructions", () => {
  for (const config of [
    {},
    { mcp: { servers: { ambassador: { url: "http://127.0.0.1:9797/mcp", enabled: false } } } },
  ]) {
    registerOpenClawGuidance({
      config,
      on(_name, callback) {
        assert.equal(callback(), undefined);
      },
    });
  }
});
