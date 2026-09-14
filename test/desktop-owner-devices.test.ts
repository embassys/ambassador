import assert from "node:assert/strict";
import { test } from "node:test";
import { OwnerDeviceReviews } from "../src/desktop/owner-devices.js";

const id = "00000000-0000-4000-8000-000000000001";
test("a device confirmation is bounded, one-use and bound to the signed-in context", () => {
  const reviews = new OwnerDeviceReviews();
  const input = {
    operation: "revoke" as const,
    device: {
      id,
      device_name: "Mac",
      platform: "darwin",
      jkt: "fixture",
      created_at: "2026-09-14T12:00:00Z",
      last_seen_at: null,
      revoked_at: null,
      executes_agent_ids: [id],
      is_current: true,
    },
  };
  const review = reviews.create("owner-one", input, 1000);
  assert.equal(reviews.get("another-owner", review.review_id, 1001), undefined);
  assert.equal(reviews.get("owner-one", review.review_id, 302000), undefined);
  assert.equal(reviews.consume("owner-one", review.review_id, 1001)?.device.device_name, "Mac");
  assert.equal(reviews.consume("owner-one", review.review_id, 1001), undefined);
});
