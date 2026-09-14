import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function checkControls(win, directory, reviews) {
  await mkdir(directory, { recursive: true });
  const checks = [];
  const js = (code) => win.webContents.executeJavaScript(code, true);
  async function until(code) {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await delay(100);
    }
    throw new Error(`Control did not settle: ${code}`);
  }
  async function click(label) {
    const find = `[...([...document.querySelectorAll('dialog:modal')].at(-1) ?? document).querySelectorAll('button')].find(b=>b.getClientRects().length && b.textContent.trim()===${JSON.stringify(label)})`;
    await until(`Boolean(${find})`);
    const point = await js(
      `(()=>{const b=${find}; b.scrollIntoView({block:'nearest'}); const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await delay(100);
  }
  async function capture(name) {
    await delay(200);
    await writeFile(join(directory, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  async function pressEscape() {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await delay(100);
  }
  async function tab() {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await delay(50);
  }
  try {
    await until("document.querySelector('.inbox-row') !== null");
    assert.equal(await js("document.querySelectorAll('details, summary').length"), 0);
    await capture("01-request");
    await click("Settings");
    await until("document.querySelector('.page-account') !== null");
    assert.equal(await js("document.querySelector('.back-control').textContent.trim()"), "Back");
    await capture("02-settings");
    await click("Advanced");
    await until("document.querySelector('.detail-sheet[open]') !== null");
    assert.equal(await js("document.activeElement.textContent.trim()"), "Done");
    await capture("03-advanced");
    await pressEscape();
    await until("document.querySelector('.detail-sheet[open]') === null");
    assert.equal(await js("document.activeElement.textContent.trim()"), "Advanced");
    checks.push("Settings opens a separate sheet; Escape restores focus without navigation");
    await click("Devices & agents");
    await until("document.querySelector('.detail-sheet[open] .settings-row') !== null");
    await capture("11-devices");
    await click("Review setup");
    await until("document.querySelectorAll('dialog[open]').length === 2");
    await pressEscape();
    await until("document.querySelectorAll('dialog[open]').length === 1");
    assert.equal(await js("document.activeElement.textContent.trim()"), "Review setup");
    await click("Done");
    checks.push(
      "Device settings open separately; cancelling device review returns to its unchanged list",
    );

    await js("document.querySelector('input[name=appearance][value=dark]').click()");
    await until("document.documentElement.dataset.theme === 'dark'");
    await capture("04-settings-dark");
    await click("Advanced");
    await capture("05-advanced-dark");
    await click("Server controls");
    await until(
      "document.querySelector('.page-settings') !== null && !document.querySelector('.detail-sheet[open]')",
    );
    await click("Back");
    await until("document.querySelector('.inbox-row') !== null");
    checks.push("Navigation from a sheet closes it, and Back returns to the selected request");

    await js("document.querySelector('.session-row:not(.request-nav-row)').click()");
    await until("document.querySelector('.chat-bubble') !== null");
    await capture("06-conversation-dark");
    await click("Settings");
    await js("document.querySelector('input[name=appearance][value=light]').click()");
    await until("document.documentElement.dataset.theme === 'light'");
    await click("Back");
    await js("document.querySelector('.session-row:not(.request-nav-row)').click()");
    await until("document.querySelector('.chat-bubble') !== null");
    await capture("07-conversation");

    reviews.open();
    await until("document.querySelector('.review-sheet[open]') !== null");
    await js("document.querySelector('.review-sheet input[type=radio]').click()");
    const choice = await js("document.querySelector('.review-sheet input:checked').value");
    await click("Technical details");
    await until("document.querySelectorAll('dialog[open]').length === 2");
    await capture("08-request-details");
    for (let i = 0; i < 3; i++) {
      await tab();
      assert.equal(
        await js("document.querySelector('.detail-sheet[open]').contains(document.activeElement)"),
        true,
      );
    }
    await pressEscape();
    await until("document.querySelectorAll('dialog[open]').length === 1");
    assert.equal(reviews.answers.length, 0);
    assert.equal(await js("document.querySelector('.review-sheet input:checked').value"), choice);
    assert.equal(await js("document.activeElement.textContent.trim()"), "Technical details");
    await capture("09-approval");
    checks.push(
      "Nested Escape preserves the pending approval and exact selected option without submitting",
    );
    win.setSize(680, 540);
    await click("Technical details");
    await capture("10-details-compact");
    assert.equal(
      await js(
        "document.querySelector('.detail-sheet[open]').getBoundingClientRect().bottom <= innerHeight",
      ),
      true,
    );
    assert.equal(
      await js(
        "document.querySelector('.detail-sheet[open]').scrollWidth <= document.querySelector('.detail-sheet[open]').clientWidth",
      ),
      true,
    );
    await click("Done");
    assert.equal(reviews.answers.length, 0);
    await click("Cancel");
    await until("document.querySelectorAll('dialog[open]').length === 0");
    assert.deepEqual(reviews.answers, [null]);
    checks.push(
      "Compact sheets contain long paths; Done only closes details; explicit Cancel settles the parent",
    );
    win.setSize(840, 680);
    await js("document.querySelector('button[aria-label=More]').click()");
    await click("Connect agents");
    await until("document.querySelectorAll('.agent-card').length === 4");
    await capture("12-agents");
    await click("Options");
    await click("Setup instructions");
    await until("document.querySelectorAll('dialog[open]').length === 2");
    await capture("13-manual-setup");
    await pressEscape();
    await until("document.querySelectorAll('dialog[open]').length === 1");
    assert.equal(await js("document.activeElement.textContent.trim()"), "Setup instructions");
    await pressEscape();
    await until("document.querySelectorAll('dialog[open]').length === 0");
    assert.equal(await js("document.activeElement.textContent.trim()"), "Options");
    checks.push(
      "Agent options and nested manual instructions restore focus without starting setup",
    );
    await writeFile(
      join(directory, "checks.json"),
      JSON.stringify({ passed: true, checks }, null, 2),
    );
  } catch (error) {
    await capture("failure");
    await writeFile(
      join(directory, "checks.json"),
      JSON.stringify({ passed: false, checks, error: String(error) }, null, 2),
    );
    throw error;
  }
}
