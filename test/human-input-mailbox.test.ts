import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralMessage } from "../src/central-rest.js";
import { HumanInputMailbox } from "../src/human-input-mailbox.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

const answer = (requestId: string): CentralMessage => ({
  id: `response-${requestId}`,
  sender_agent_id: "owner",
  created_at: "2026-09-05T00:00:00Z",
  payload: { type: "human_input_response", request_id: requestId, text: "owner supplied text" },
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ambassador-human-input-"));
  const path = join(root, "answers.sqlite");
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  let mailbox = new HumanInputMailbox(path, credential);
  t.after(() => {
    mailbox.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get mailbox() {
      return mailbox;
    },
    restart() {
      mailbox.close();
      mailbox = new HumanInputMailbox(path, credential);
    },
  };
}
test("an answer received before the request returns survives restart and resolves its wait", async (t) => {
  const f = fixture(t);
  f.mailbox.capture(answer("first"));
  f.restart();
  assert.deepEqual(await f.mailbox.wait("first", new AbortController().signal), answer("first"));
});
test("only the matching response resolves a pending wait and duplicate conflicts are rejected", async (t) => {
  const f = fixture(t);
  let completed = false;
  const waiting = f.mailbox.wait("first", new AbortController().signal).then((result) => {
    completed = true;
    return result;
  });
  f.mailbox.capture(answer("other"));
  await Promise.resolve();
  assert.equal(completed, false);
  f.mailbox.capture(answer("first"));
  assert.deepEqual(await waiting, answer("first"));
  f.mailbox.capture(answer("first"));
  assert.throws(() =>
    f.mailbox.capture({
      ...answer("first"),
      payload: { ...answer("first").payload, text: "changed" },
    }),
  );
});
test("cancellation and shutdown free waiter capacity without consuming answers", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const waiting = f.mailbox.wait("first", controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  f.mailbox.capture(answer("first"));
  assert.deepEqual(await f.mailbox.wait("first", new AbortController().signal), answer("first"));
  const pending = f.mailbox.wait("later", new AbortController().signal);
  f.mailbox.close();
  await assert.rejects(pending);
});
