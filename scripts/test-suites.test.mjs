import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { selectTests, testOptions } from "./test-suites.mjs";

test("core and platform partition every current and newly nested test", () => {
  const root = join(process.cwd(), "compiled");
  const paths = [
    "flow.test.js",
    "nested/new.test.js",
    "platform/crypto.test.js",
    "platform/nested/new.test.js",
  ].map((file) => join(root, file));
  const inputs = [...paths, join(root, "t03-retired.test.js"), join(root, "helper.js")];
  const core = selectTests(root, inputs, "core");
  const platform = selectTests(root, inputs, "platform");
  assert.deepEqual(core, paths.slice(0, 2).sort());
  assert.deepEqual(platform, paths.slice(2).sort());
  assert.deepEqual([...core, ...platform].sort(), selectTests(root, inputs, "all"));
  assert.equal(new Set([...core, ...platform]).size, paths.length);
});

test("empty suites and invalid flags cannot silently pass or run another suite", () => {
  assert.deepEqual(testOptions([]), { suite: "all", coverage: false, list: false });
  assert.deepEqual(testOptions(["--suite=core", "--coverage", "--list"]), {
    suite: "core",
    coverage: true,
    list: true,
  });
  for (const args of [["--suite=native"], ["--suite=core", "--suite=all"], ["--sutie=core"]]) {
    assert.throws(() => testOptions(args));
  }
  const root = join(process.cwd(), "compiled");
  assert.throws(() => selectTests(root, [], "core"), /No compiled tests/);
  assert.throws(
    () => selectTests(root, [join(root, "flow.test.js")], "platform"),
    /No compiled tests/,
  );
  assert.throws(
    () => selectTests(root, [join(root, "..", "outside.test.js")], "core"),
    /outside root/,
  );
});
