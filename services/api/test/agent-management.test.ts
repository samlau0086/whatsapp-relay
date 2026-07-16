import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

test("agent management routes and legacy demo cleanup are shipped", async () => {
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const hub=await readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  const cleanup=await readFile(new URL("../../../infra/postgres/migrations/003_remove_legacy_demo.sql",import.meta.url),"utf8");
  assert.match(server,/app\.get\("\/api\/v1\/agents"/);
  assert.match(server,/app\.patch\("\/api\/v1\/agents\/:id"/);
  assert.match(server,/app\.delete\("\/api\/v1\/agents\/:id"/);
  assert.match(server,/removeLegacyDemoData/);
  assert.match(server,/markStaleAgentsOffline/);
  assert.match(hub,/HEARTBEAT_TIMEOUT_SECONDS = 45/);
  assert.match(hub,/agent_heartbeat_timeout/);
  assert.match(hub,/status IN \('offline','revoked'\)/);
  assert.match(hub,/liveAgents\.get\(agent\.id\) !== socket/);
  assert.match(hub,/wa\.status='online'/);
  assert.match(hub,/outcome==="deferred"/);
  assert.match(hub,/event\.cursor\?\?start\+index/);
  assert.match(hub,/failedCursor/);
  assert.match(hub,/unsupported_event_kind/);
  assert.match(cleanup,/10000000-0000-4000-8000-000000000001/);
  await assert.rejects(access(new URL("../../../infra/postgres/migrations/002_seed_demo.sql",import.meta.url)));
});
