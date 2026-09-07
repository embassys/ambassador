import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopWindowLifecycle } from "../src/desktop/window-lifecycle.js";

test("duplicate launch during setup opens once after private IPC and assets are ready", () => {
  let opens = 0;
  const lifecycle = new DesktopWindowLifecycle(() => {
    opens++;
  });
  lifecycle.requestOpen();
  lifecycle.requestOpen();
  assert.equal(opens, 0);
  lifecycle.ready(true);
  assert.equal(opens, 1);
  lifecycle.ready(true);
  assert.equal(opens, 1);
});

test("background startup stays hidden until requested; normal startup opens immediately", () => {
  let opens = 0;
  const background = new DesktopWindowLifecycle(() => {
    opens++;
  });
  background.ready(true);
  assert.equal(opens, 0);
  background.requestOpen();
  assert.equal(opens, 1);
  new DesktopWindowLifecycle(() => {
    opens++;
  }).ready(false);
  assert.equal(opens, 2);
});
