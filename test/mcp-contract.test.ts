import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertSafeUpstreamResult,
  McpContractError,
  safeLocalToolArguments,
} from "../src/mcp-contract.js";

const CREDENTIAL_BYTES = "credential-bytes-must-not-cross-local-mcp";

test("accepts ordinary local arguments and rejects credential selectors at any depth", () => {
  assert.deepEqual(safeLocalToolArguments({ reason: "calendar lookup", nested: { safe: true } }), {
    reason: "calendar lookup",
    nested: { safe: true },
  });
  for (const value of [
    null,
    [],
    { token: "caller supplied" },
    { nested: { authorization: "caller supplied" } },
    { items: [{ private_key: "caller supplied" }] },
  ]) {
    assert.throws(() => safeLocalToolArguments(value), McpContractError);
  }
});

test("fails closed on credential-shaped or credential-containing results", () => {
  for (const result of [
    { access_token: "unexpected" },
    { nested: { dpop: "unexpected" } },
    { message: `prefix ${CREDENTIAL_BYTES} suffix` },
    { [CREDENTIAL_BYTES]: "unexpected property" },
  ]) {
    assert.throws(() => assertSafeUpstreamResult(result, CREDENTIAL_BYTES), McpContractError);
  }
  assert.doesNotThrow(() =>
    assertSafeUpstreamResult({ agent_id: "agent.fixture", message: "safe" }, CREDENTIAL_BYTES),
  );
});
