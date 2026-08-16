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
