import test from "node:test";

import {
  CLAUDE_Q01_PROVIDER_ROW,
  CODEX_Q01_PROVIDER_ROW,
  runQ01ProviderMatrix,
} from "./support/provider-matrix/index.js";

for (const row of [CODEX_Q01_PROVIDER_ROW, CLAUDE_Q01_PROVIDER_ROW]) {
  test(`Q01 runs the ${row.name} adapter through the shared matrix`, async (t) => {
    await runQ01ProviderMatrix(t, row);
  });
}
