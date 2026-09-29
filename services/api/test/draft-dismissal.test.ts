import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dismissing a reply suggestion clears older suggestions and cancels unfinished reply work", async () => {
  const [server, engine] = await Promise.all([
    readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/agent-engine.ts", import.meta.url), "utf8"),
  ]);
  const dismiss = server.slice(server.indexOf('app.post("/api/v1/ai-drafts/:id/dismiss"'), server.indexOf('app.get("/api/v1/conversations/:id/memory', server.indexOf('app.post("/api/v1/ai-drafts/:id/dismiss"')));
  const saveDraft = engine.slice(engine.indexOf("async function saveDraft("), engine.indexOf("async function queueAiMessage("));

  assert.match(dismiss, /UPDATE agent_jobs SET state='cancelled'.*state='pending'.*kind IN \('reply','followup'\)/);
  assert.match(dismiss, /UPDATE ai_drafts SET status='dismissed'.*WHERE id=\$1 AND status='pending'/);
  assert.match(dismiss, /UPDATE ai_drafts SET status='dismissed'/);
  assert.match(saveDraft, /SELECT id FROM conversations WHERE id=\$1 FOR UPDATE/);
  assert.match(saveDraft, /SELECT id FROM agent_jobs WHERE id=\$1 AND state='processing'/);
  assert.match(engine, /UPDATE agent_jobs SET state='pending'.*WHERE id=\$1 AND state='processing'/);
});
