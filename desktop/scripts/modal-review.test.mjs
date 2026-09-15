import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "embassys-modal-review-"));
await build({
  entryPoints: ["src/modal-review.ts"],
  outfile: join(root, "modal-review.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
});
const { openModalReview } = await import(pathToFileURL(join(root, "modal-review.mjs")));
test.after(() => rm(root, { recursive: true, force: true }));

function fixture() {
  const calls = [];
  const scroll = { scrollTop: 220, scrollLeft: 8, isConnected: true };
  const target = (name) => ({
    isConnected: true,
    disabled: false,
    matches() {
      return this.disabled;
    },
    closest() {
      return scroll;
    },
    focus(options) {
      calls.push([name, options]);
    },
  });
  const trigger = target("trigger");
  const fallback = target("fallback");
  const document = { querySelector: () => null };
  const dialog = {
    open: false,
    ownerDocument: document,
    showModal() {
      calls.push("open");
      this.open = true;
      scroll.scrollTop = 0;
    },
    close() {
      calls.push("close");
      this.open = false;
    },
  };
  return { calls, scroll, trigger, fallback, document, dialog };
}

test("modal opening and closing preserve background scroll and return focus without scrolling", async () => {
  const f = fixture();
  const close = openModalReview(f.dialog, f.trigger, f.fallback);
  assert.equal(f.dialog.open, true);
  assert.equal(f.scroll.scrollTop, 220);
  f.scroll.scrollTop = 0;
  close();
  await Promise.resolve();
  assert.equal(f.dialog.open, false);
  assert.deepEqual(f.calls, ["open", "close", ["trigger", { preventScroll: true }]]);
  assert.equal(f.scroll.scrollTop, 220);
  assert.equal(f.scroll.scrollLeft, 8);
});

test("a removed or disabled request returns focus to its surviving account view", async () => {
  for (const property of ["isConnected", "disabled"]) {
    const f = fixture();
    const close = openModalReview(f.dialog, f.trigger, f.fallback);
    f.trigger[property] = property === "disabled";
    close();
    await Promise.resolve();
    assert.deepEqual(f.calls.at(-1), ["fallback", { preventScroll: true }]);
  }
});

test("closing a review cannot steal focus from a newer modal or a different page", async () => {
  for (const scenario of ["new-modal", "unmounted"]) {
    const f = fixture();
    const close = openModalReview(f.dialog, f.trigger, f.fallback);
    if (scenario === "new-modal") f.document.querySelector = () => ({});
    else {
      f.trigger.isConnected = false;
      f.fallback.isConnected = false;
      f.scroll.scrollTop = 440;
    }
    close();
    await Promise.resolve();
    assert.deepEqual(f.calls, ["open", "close"]);
    if (scenario === "unmounted") assert.equal(f.scroll.scrollTop, 440);
  }
});
