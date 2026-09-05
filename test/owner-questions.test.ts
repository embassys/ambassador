import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { parseCentralCredential } from "../src/central-credential.js";
import type { CentralHumanInputRequest, CentralMessage } from "../src/central-rest.js";
import { OwnerQuestions } from "../src/owner-questions.js";
import { PendingActionInbox } from "../src/pending-action-inbox.js";
import { currentCredential, FIXTURE_NOW_SECONDS } from "./support/current-credential.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ambassador-owner-questions-"));
  const credential = parseCentralCredential(currentCredential(), () => FIXTURE_NOW_SECONDS);
  const pending = new PendingActionInbox(join(root, "pending.sqlite"), credential);
  const callId = randomUUID();
  const sourceId = randomUUID();
  const remoteId = randomUUID();
  pending.capture({
    id: sourceId,
    sender_agent_id: "remote-peer",
    action_type_id: "phone-type",
    created_at: new Date().toISOString(),
    payload: {
      type: "action_call",
      call_id: callId,
      action_type: "get_phone_number",
      payload: { reason: "contact" },
    },
  });
  const sent: CentralHumanInputRequest[] = [];
  const continuations: CentralMessage[] = [];
  let failEnqueue = false;
  const options = {
    path: join(root, "questions.sqlite"),
    credential,
    pending,
    enqueueContinuation(message: CentralMessage) {
      if (failEnqueue) throw new Error("interrupted local handoff");
      continuations.push(message);
    },
    transport: {
      async requestHumanInput(input: CentralHumanInputRequest) {
        sent.push(input);
        return {
          request_id: remoteId,
          status: "pending" as const,
          input_type: input.input_type,
          message: "Emailed",
          options: input.options ?? null,
        };
      },
    },
  };
  let questions = new OwnerQuestions(options);
  t.after(async () => {
    questions.close();
    pending.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = {
    request_id: randomUUID(),
    call_id: callId,
    question: "What number should I return?",
    input_type: "text" as const,
  };
  const answer = (): CentralMessage => ({
    id: randomUUID(),
    sender_agent_id: "local-owner",
    created_at: new Date().toISOString(),
    payload: {
      type: "human_input_response",
      request_id: remoteId,
      message_id: sourceId,
      action_type: "get_phone_number",
      input_type: "text",
      prompt: request.question,
      value: null,
      text: "private owner answer",
    },
  });
  return {
    root,
    pending,
    sent,
    continuations,
    failEnqueue(value: boolean) {
      failEnqueue = value;
    },
    callId,
    sourceId,
    request,
    answer,
    get questions() {
      return questions;
    },
    restart() {
      questions.close();
      questions = new OwnerQuestions(options);
    },
  };
}

test("owner question is durable, emails once and resumes the exact peer and pending call", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  assert.equal((await f.questions.ask(f.request, signal)).status, "waiting_for_owner");
  f.restart();
  await f.questions.ask(f.request, signal);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]?.message_id, f.sourceId);
  const response = f.answer();
  assert.equal(f.questions.capture(response), true);
  assert.equal(f.questions.capture(response), true);
  const resume = f.questions.deliveryMessage(response);
  assert.equal(resume?.sender_agent_id, "remote-peer");
  assert.equal(resume?.payload.call_id, f.callId);
  assert.equal(resume?.payload.text, "private owner answer");
  f.restart();
  assert.equal(f.questions.get(f.request.request_id).status, "answered");
  assert.ok(f.questions.deliveryMessage(response));
  const duplicate = { ...response, id: randomUUID() };
  assert.equal(f.questions.capture(duplicate), true);
  assert.equal(f.questions.deliveryMessage(duplicate), undefined);
  assert.equal(
    (await readFile(join(f.root, "questions.sqlite"))).includes(
      Buffer.from("private owner answer"),
    ),
    false,
  );
});

test("questions reject conflicting retries, parallel questions and stale or mismatched answers", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  await f.questions.ask(f.request, signal);
  await assert.rejects(f.questions.ask({ ...f.request, question: "changed" }, signal), {
    code: "request_id_conflict",
  });
  await assert.rejects(f.questions.ask({ ...f.request, request_id: randomUUID() }, signal), {
    code: "owner_question_pending",
  });
  for (const change of [
    { request_id: randomUUID() },
    { message_id: randomUUID() },
    { action_type: "other" },
    { prompt: "other" },
    { input_type: "buttons" },
    { text: "x".repeat(4001) },
  ]) {
    const response = f.answer();
    assert.equal(
      f.questions.capture({ ...response, payload: { ...response.payload, ...change } }),
      false,
    );
  }
  assert.equal(f.questions.get(f.request.request_id).status, "waiting_for_owner");
  f.pending.remove(f.callId);
  assert.equal(f.questions.capture(f.answer()), false);
});

test("explicit answers preserve exact button values and cannot answer another question", async (t) => {
  const f = await fixture(t);
  const input = {
    ...f.request,
    input_type: "buttons" as const,
    options: [
      { label: "Use home", value: "home-id" },
      { label: "No", value: "no-id" },
    ],
  };
  await f.questions.ask(input, new AbortController().signal);
  const answer = {
    request_id: randomUUID(),
    question_id: input.request_id,
    call_id: f.callId,
    value: "home-id",
  };
  assert.throws(() => f.questions.answer({ ...answer, value: "allow_once" }), {
    code: "invalid_owner_answer",
  });
  assert.throws(() => f.questions.answer({ ...answer, call_id: randomUUID() }), {
    code: "invalid_owner_answer",
  });
  assert.equal(f.questions.answer(answer).status, "answered");
  assert.equal(f.questions.answer(answer).value, "home-id");
  assert.equal(f.continuations.length, 1);
  assert.equal(f.continuations[0]?.payload.value, "home-id");
  assert.equal(f.continuations[0]?.sender_agent_id, "remote-peer");
  assert.throws(() => f.questions.answer({ ...answer, value: "no-id" }), {
    code: "request_id_conflict",
  });
  assert.deepEqual(f.sent[0]?.options, input.options);
});

test("an email answer cannot dispatch a second continuation after a foreground answer", async (t) => {
  const f = await fixture(t);
  await f.questions.ask(f.request, new AbortController().signal);
  f.questions.answer({
    request_id: randomUUID(),
    question_id: f.request.request_id,
    call_id: f.callId,
    text: "private owner answer",
  });
  const response = f.answer();
  assert.equal(f.questions.capture(response), true);
  assert.equal(f.questions.deliveryMessage(response), undefined);
  assert.equal(f.continuations.length, 1);
});

test("restart repairs an interrupted foreground answer handoff without resubmitting the question", async (t) => {
  const f = await fixture(t);
  await f.questions.ask(f.request, new AbortController().signal);
  const answer = {
    request_id: randomUUID(),
    question_id: f.request.request_id,
    call_id: f.callId,
    text: "private owner answer",
  };
  f.failEnqueue(true);
  assert.throws(() => f.questions.answer(answer), /interrupted local handoff/u);
  assert.equal(f.questions.get(f.request.request_id).status, "answered");
  f.restart();
  f.failEnqueue(false);
  assert.equal(f.questions.recoverLocalContinuations(), false);
  assert.equal(f.continuations.length, 1);
  assert.equal(f.continuations[0]?.id, answer.request_id);
  assert.equal(f.continuations[0]?.payload.call_id, f.callId);
  assert.equal(f.continuations[0]?.payload.text, answer.text);
  f.questions.answer(answer);
  f.restart();
  assert.equal(f.questions.recoverLocalContinuations(), false);
  assert.equal(f.continuations.length, 1);
  assert.equal(f.sent.length, 1);
});

test("a completed action cannot be resumed by a saved foreground owner answer", async (t) => {
  const f = await fixture(t);
  await f.questions.ask(f.request, new AbortController().signal);
  f.failEnqueue(true);
  assert.throws(() =>
    f.questions.answer({
      request_id: randomUUID(),
      question_id: f.request.request_id,
      call_id: f.callId,
      text: "private owner answer",
    }),
  );
  f.pending.remove(f.callId);
  f.failEnqueue(false);
  f.restart();
  assert.equal(f.questions.recoverLocalContinuations(), false);
  assert.equal(f.continuations.length, 0);
});

test("retrying an older answer cannot replace a later owner question", async (t) => {
  const f = await fixture(t);
  await f.questions.ask(f.request, new AbortController().signal);
  const answer = {
    request_id: randomUUID(),
    question_id: f.request.request_id,
    call_id: f.callId,
    text: "private owner answer",
  };
  f.failEnqueue(true);
  assert.throws(() => f.questions.answer(answer));
  const next = { ...f.request, request_id: randomUUID(), question: "Which extension?" };
  await f.questions.ask(next, new AbortController().signal);
  f.failEnqueue(false);
  f.questions.answer(answer);
  assert.equal(f.continuations.length, 0);
  assert.equal(f.questions.forCall(f.callId)?.request_id, next.request_id);
});
