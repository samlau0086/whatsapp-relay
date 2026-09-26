import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("unconfirmed WhatsApp Web sends stop as uncertain instead of being resent",async()=>{
  const worker=await readFile(new URL("../src/worker.ts",import.meta.url),"utf8");
  const requeue=worker.slice(worker.indexOf("async function requeueCommands"),worker.indexOf("async function enforceRetention"));
  assert.match(requeue,/a\.transport='web'.*state='uncertain'/s);
  assert.doesNotMatch(requeue,/a\.transport='web'.*state='pending'/s);
  assert.match(requeue,/automatic retry stopped to prevent duplicates/);
});

test("message retry preserves a username destination when the phone JID is absent",async()=>{
  const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const retry=source.slice(source.indexOf('app.post("/api/v1/messages/:id/retry"'),source.indexOf('app.delete("/api/v1/messages/:id"'));
  assert.match(retry,/co\.provider_user_id,co\.whatsapp_username/);
  assert.match(retry,/String\(row\.provider_user_id\?\?""\)\.trim\(\),toUsername=String\(row\.whatsapp_username\?\?""\)/);
  assert.match(retry,/if\(!toJid&&!toUsername\)throw/);
  assert.match(retry,/destinationId:toJid/);
});
