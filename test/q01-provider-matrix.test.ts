import test from "node:test";

import { CODEX_Q01_PROVIDER_ROW, runQ01ProviderMatrix } from "./support/provider-matrix/index.js";

test(`Q01 runs the ${CODEX_Q01_PROVIDER_ROW.name} adapter through the shared matrix`, async (t) => {
  await runQ01ProviderMatrix(t, CODEX_Q01_PROVIDER_ROW);
});
