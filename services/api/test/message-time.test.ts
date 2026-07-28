import assert from "node:assert/strict";
import test from "node:test";
import {formatMessageTime,formatMessageTimeTitle} from "../../../app/message-time";

test("message time uses the clock only for messages from today", () => {
  const now = new Date(2026, 6, 28, 23, 30);
  assert.equal(formatMessageTime(new Date(2026, 6, 28, 8, 5), now), "08:05");
});

test("message time uses relative labels for yesterday and the day before", () => {
  const now = new Date(2026, 6, 28, 0, 15);
  assert.equal(formatMessageTime(new Date(2026, 6, 27, 23, 45), now), "昨天");
  assert.equal(formatMessageTime(new Date(2026, 6, 26, 23, 45), now), "前天");
});

test("message time uses an explicit date for older messages", () => {
  const now = new Date(2026, 6, 28, 12);
  assert.equal(formatMessageTime(new Date(2026, 6, 25, 18, 40), now), "2026/07/25");
  assert.equal(formatMessageTimeTitle(new Date(2026, 6, 25, 18, 40)), "2026/07/25 18:40");
});

test("message time ignores invalid dates", () => {
  assert.equal(formatMessageTime("not-a-date"), "");
  assert.equal(formatMessageTimeTitle("not-a-date"), "");
});
