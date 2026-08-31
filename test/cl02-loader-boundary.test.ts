import assert from "node:assert/strict";
import test from "node:test";

import {
  isExactMissingCl03Entry,
  loadCl03Production,
  validateCl03AdapterModule,
  validateCl03MonitorModule,
} from "./support/claude-code/index.js";

test("CL02 support classifies only the exact absent CL03 adapter entry as reviewed red", () => {
  const entry = new URL(
    "file:///fixture/.test-dist/packages/claude-connector/src/claude-code-adapter.js",
  );
  assert.equal(
    isExactMissingCl03Entry(
      Object.assign(new Error(`Cannot find module '${entry.pathname}' imported from fixture`), {
        code: "ERR_MODULE_NOT_FOUND",
        url: entry.href,
      }),
      entry,
    ),
    true,
  );
  assert.equal(
    isExactMissingCl03Entry(
      Object.assign(new Error(`Cannot find package 'transitive' imported from ${entry.pathname}`), {
        code: "ERR_MODULE_NOT_FOUND",
        url: "file:///fixture/node_modules/transitive/index.js",
      }),
      entry,
    ),
    false,
  );
  assert.equal(isExactMissingCl03Entry(new SyntaxError("invalid CL03 module"), entry), false);
  assert.throws(
    () => validateCl03AdapterModule({ CLAUDE_CODE_VERSION: "2.1.251" }),
    (error: unknown) => error instanceof TypeError && !error.message.startsWith("[CL02-CL03:"),
  );
  assert.throws(
    () => validateCl03MonitorModule({ CLAUDE_LIFETIME_MONITOR_PROTOCOL: 1 }),
    (error: unknown) => error instanceof TypeError && !error.message.startsWith("[CL02-CL03:"),
  );
});

test("CL02-L23 rejects partial adapter and monitor modules at the strict production loader", async () => {
  await loadCl03Production("CL02-CL03:L23");
});
