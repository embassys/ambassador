import assert from "node:assert/strict";
import test from "node:test";

import {
  isExactMissingCx03Entry,
  loadCx03Production,
  validateCx03ProductionModule,
} from "./support/codex-app-server/index.js";

test("CX02 support classifies only the exact absent CX03 adapter entry as reviewed red", () => {
  const entry = new URL(
    "file:///fixture/.test-dist/packages/codex-connector/src/app-server-adapter.js",
  );
  assert.equal(
    isExactMissingCx03Entry(
      Object.assign(new Error(`Cannot find module '${entry.pathname}' imported from fixture`), {
        code: "ERR_MODULE_NOT_FOUND",
        url: entry.href,
      }),
      entry,
    ),
    true,
  );
  assert.equal(
    isExactMissingCx03Entry(
      Object.assign(new Error(`Cannot find package 'transitive' imported from ${entry.pathname}`), {
        code: "ERR_MODULE_NOT_FOUND",
        url: "file:///fixture/node_modules/transitive/index.js",
      }),
      entry,
    ),
    false,
  );
  assert.equal(isExactMissingCx03Entry(new SyntaxError("invalid CX03 module"), entry), false);
  assert.throws(
    () =>
      validateCx03ProductionModule({
        CODEX_APP_SERVER_VERSION: "0.149.0",
        CODEX_APP_SERVER_SCHEMA_SHA256:
          "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9",
      }),
    (error: unknown) => error instanceof TypeError && !error.message.startsWith("[CX02-CX03:"),
  );
});

test("CX02-X26 rejects partial adapter modules and reviews only the exact absent entry", async () => {
  await loadCx03Production("CX02-CX03:X26");
});
