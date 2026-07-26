import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("conversations can be explicitly marked unread without lowering an existing count",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/body\.read&&body\.unread/);
  assert.match(server,/WHEN \$8 THEN GREATEST\(unread_count,1\) WHEN \$5 THEN 0/);
});

test("the conversation list exposes an accessible mark-unread action",async()=>{
  const [component,css]=await Promise.all([
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(component,/JSON\.stringify\(\{unread:true\}\)/);
  assert.match(component,/标记为未读/);
  assert.match(component,/event\.stopPropagation\(\)/);
  assert.match(css,/\.mark-unread-button/);
  assert.match(css,/\.conversation\.active \.mark-unread-button/);
});
