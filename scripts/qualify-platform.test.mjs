import assert from "node:assert/strict";
import { test } from "node:test";
import { qualificationPlan } from "./qualify-platform-plan.mjs";

test("full local qualification includes both suites, installed flows, packaged host and CLI handoff on every OS", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const plan = qualificationPlan([], { platform, arch: "arm64", env: { DISPLAY: ":99" } });
    assert.ok(plan.some((step) => step.args.includes("check")));
    assert.ok(plan.some((step) => step.args.includes("test:artifacts")));
    assert.ok(plan.some((step) => step.name === "installed-flows"));
    assert.ok(plan.some((step) => step.args.includes("verify:distribution")));
    assert.ok(plan.some((step) => step.args.includes("verify:shared")));
    assert.equal(
      plan.some((step) => step.args.includes("--measure-memory")),
      platform === "darwin",
    );
  }
});

test("local qualifier refuses CI, wrong host, unsupported host and unknown options before work starts", () => {
  const host = { platform: "darwin", arch: "arm64", env: {} };
  assert.throws(() => qualificationPlan([], { ...host, env: { CI: "true" } }), /local/);
  assert.throws(() => qualificationPlan(["--platform=win32"], host), /host/);
  assert.throws(() => qualificationPlan(["--no-check"], host), /Unknown/);
  assert.throws(() => qualificationPlan([], { ...host, platform: "freebsd" }), /Unsupported/);
  assert.throws(
    () => qualificationPlan([], { platform: "linux", arch: "x64", env: {} }),
    /display/,
  );
});
