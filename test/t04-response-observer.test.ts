import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { startT04ResponseObserver } from "./support/t04-response-observer.js";
import { startV2ManagedProcess, v2NodeProcessEnvironment } from "./support/v2-process-runtime.js";

test("T04 support holds a completed upstream response until explicit release", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"committed"}');
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });
  t.after(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const { port } = upstream.address() as AddressInfo;
  const upstreamOrigin = `http://127.0.0.1:${port}`;
  const observer = await startT04ResponseObserver(t, {
    targetOrigin: upstreamOrigin,
    targetPath: "/committed-operation",
    targetMethod: "POST",
  });
  const preload = new URL("./support/t04-response-observer.js", import.meta.url).href;
  const child = startV2ManagedProcess(t, {
    command: process.execPath,
    args: [
      "--eval",
      "await fetch(process.env.T04_TEST_UPSTREAM, { method: 'POST' }); process.stdout.write('T04_FETCH_RESOLVED\\n');",
    ],
    cwd: process.cwd(),
    env: v2NodeProcessEnvironment({
      NODE_OPTIONS: `--import=${preload}`,
      T04_TEST_UPSTREAM: `${upstreamOrigin}/committed-operation`,
      ...observer.environment,
    }),
  });

  const committed = await observer.waitForCommit();
  assert.deepEqual(committed, {
    method: "POST",
    pathname: "/committed-operation",
    status: 200,
  });
  assert.equal(child.stdout(), "", "the preload returned the upstream response before release");
  observer.release();
  await child.waitForOutput("stdout", "T04_FETCH_RESOLVED");
  assert.deepEqual(await child.waitForExit(), { code: 0, signal: null });
  assert.equal(child.stderr(), "");
});
