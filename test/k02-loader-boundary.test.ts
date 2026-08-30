import assert from "node:assert/strict";
import test from "node:test";

import {
  isExactMissingK03Entry,
  validateK02ProductionModule,
} from "./support/connector/k02-production.js";

test("K02 support classifies only the exact absent K03 entry as reviewed red", () => {
  const entry = new URL("file:///fixture/.test-dist/packages/connector-core/src/index.js");
  assert.equal(
    isExactMissingK03Entry(
      Object.assign(new Error(`Cannot find module '${entry.pathname}' imported from fixture`), {
        code: "ERR_MODULE_NOT_FOUND",
        url: entry.href,
      }),
      entry,
    ),
    true,
  );
  assert.equal(
    isExactMissingK03Entry(
      Object.assign(new Error(`Cannot find package 'transitive' imported from ${entry.pathname}`), {
        code: "ERR_MODULE_NOT_FOUND",
        url: "file:///fixture/node_modules/transitive/index.js",
      }),
      entry,
    ),
    false,
  );
  assert.equal(isExactMissingK03Entry(new SyntaxError("invalid K03 module"), entry), false);
  assert.throws(
    () => validateK02ProductionModule({ startConnectorFoundation() {} }),
    (error: unknown) => error instanceof TypeError && !error.message.startsWith("[K02-K03:"),
  );
});
