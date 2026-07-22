import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the central ingest boundary ignores WhatsApp broadcast conversations", () => {
  const source=readFileSync(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  assert.match(source,/chatJid\.endsWith\("@broadcast"\)/);
});
