import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionCheck } from "../src/desktop/connection-check.js";

test("only the current instance's active challenge verifies its exact enrollment", () => {
  let now = 100;
  const check = new ConnectionCheck(() => now);
  const other = new ConnectionCheck(() => now);
  const challenge = check.begin("agent-a");
  assert.equal(check.observed(challenge), false);
  assert.equal(other.receive(challenge, "agent-a"), false);
  assert.equal(check.receive(challenge, "agent-b"), false);
  assert.equal(check.receive(challenge, "agent-a"), true);
  assert.equal(check.observed(challenge), true);
  check.end(challenge);
  assert.equal(check.receive(challenge, "agent-a"), false);
  const next = check.begin("agent-a");
  assert.notEqual(next, challenge);
  assert.throws(() => check.begin("agent-a"));
  now += 180001;
  assert.equal(check.receive(next, "agent-a"), false);
  assert.equal(check.observed(next), false);
});
