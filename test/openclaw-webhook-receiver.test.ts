import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("does not ship an Ambassador-specific OpenClaw receiver", async () => {
  await assert.rejects(
    readFile(join(process.cwd(), "integrations", "openclaw-ambassador", "package.json")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});
