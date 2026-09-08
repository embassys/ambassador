import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMacDistribution } from "../src/desktop/distribution.js";

test("Mac startup requires signature, Gatekeeper and stapled notarization verification", async () => {
  const calls: string[] = [];
  assert.equal(
    await verifyMacDistribution({
      platform: "darwin",
      packaged: true,
      bundle: "/Applications/Embassys.app",
      run: async (executable, args) => {
        calls.push(executable);
        assert.equal(args.at(-1), "/Applications/Embassys.app");
        return "Authority=Developer ID Application: Embassys fixture\n";
      },
    }),
    true,
  );
  assert.deepEqual(calls, [
    "/usr/bin/codesign",
    "/usr/bin/codesign",
    "/usr/sbin/spctl",
    "/usr/bin/xcrun",
  ]);
  for (let rejectedAt = 0; rejectedAt < 4; rejectedAt++) {
    let count = 0;
    assert.equal(
      await verifyMacDistribution({
        platform: "darwin",
        packaged: true,
        bundle: "/Applications/Embassys.app",
        run: async () => {
          if (count++ === rejectedAt) throw new Error("Not verified");
          return "Authority=Developer ID Application: Embassys fixture\n";
        },
      }),
      false,
    );
    assert.equal(count, rejectedAt + 1);
  }
});

test("ad hoc previews cannot enable login startup or wait on notarization assessment", async () => {
  for (const output of ["Signature=adhoc\n", "", "Authority=Apple Development: Fixture\n"]) {
    const calls: string[] = [];
    assert.equal(
      await verifyMacDistribution({
        platform: "darwin",
        packaged: true,
        bundle: "/Applications/Embassys.app",
        run: async (executable, args) => {
          calls.push(`${executable} ${args[0]}`);
          return output;
        },
      }),
      false,
    );
    assert.deepEqual(calls, ["/usr/bin/codesign --display"]);
  }
});

test("development and other platforms never probe Mac release tools", async () => {
  for (const input of [
    { platform: "darwin" as const, packaged: false, bundle: "/Applications/Embassys.app" },
    { platform: "win32" as const, packaged: true, bundle: "C:\\Embassys.exe" },
    { platform: "darwin" as const, packaged: true, bundle: "relative.app" },
  ]) {
    assert.equal(
      await verifyMacDistribution({ ...input, run: async () => assert.fail("Unexpected command") }),
      false,
    );
  }
});
