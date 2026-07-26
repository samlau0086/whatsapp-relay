import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("conversation list exposes the latest message direction", () => {
  assert.match(server, /m\.direction last_message_direction/);
  assert.match(server, /m\.status last_message_status/);
  assert.match(server, /SELECT text_content,kind,direction,status FROM messages/);
});
