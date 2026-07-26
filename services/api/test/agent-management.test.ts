import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";

test("agent management routes and legacy demo cleanup are shipped", async () => {
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const hub=await readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  const worker=await readFile(new URL("../src/worker.ts",import.meta.url),"utf8");
  const cleanup=await readFile(new URL("../../../infra/postgres/migrations/003_remove_legacy_demo.sql",import.meta.url),"utf8");
  assert.match(server,/app\.get\("\/api\/v1\/agents"/);
  assert.match(server,/app\.patch\("\/api\/v1\/agents\/:id"/);
  assert.match(server,/app\.delete\("\/api\/v1\/agents\/:id"/);
  assert.match(server,/app\.get\("\/api\/v1\/media"/);
  assert.match(server,/app\.get\("\/api\/v1\/media\/:id"/);
  assert.match(server,/app\.delete\("\/api\/v1\/media\/:id"/);
  assert.match(server,/app\.patch\("\/api\/v1\/knowledge-bases\/:id"/);
  assert.match(server,/app\.delete\("\/api\/v1\/knowledge-bases\/:id"/);
  assert.match(server,/media_in_use/);
  assert.match(server,/account_id=\$2 OR account_id IS NULL/);
  assert.match(server,/removeLegacyDemoData/);
  assert.match(server,/markStaleAgentsOffline/);
  assert.match(server,/COALESCE\(m\.status::text,o\.status\) message_status/);
  assert.match(hub,/HEARTBEAT_TIMEOUT_SECONDS = 45/);
  assert.match(hub,/agent queue dispatch watchdog failed/);
  assert.match(hub,/dispatchWatchdog\?\?=setInterval/);
  assert.match(hub,/agent_heartbeat_timeout/);
  assert.match(hub,/status IN \('offline','revoked'\)/);
  assert.match(hub,/liveAgents\.get\(agent\.id\) !== socket/);
  assert.match(hub,/wa\.status='online'/);
  assert.match(hub,/outcome==="deferred"/);
  assert.match(hub,/failure_code=CASE WHEN \$2 IN \('failed','uncertain'\) THEN \$4 ELSE NULL END/);
  assert.match(hub,/failure_message=CASE WHEN \$2 IN \('failed','uncertain'\) THEN \$5 ELSE NULL END/);
  assert.match(hub,/event\.cursor\?\?start\+index/);
  assert.match(hub,/failedCursor/);
  assert.match(hub,/unsupported_event_kind/);
  assert.match(hub,/event\.kind==="contact_identity"/);
  assert.match(hub,/mergeContactIdentity/);
  assert.match(hub,/UPDATE messages SET conversation_id=\$1 WHERE conversation_id=\$2/);
  assert.match(hub,/UPDATE messages SET sender_contact_id=\$1 WHERE sender_contact_id=\$2/);
  assert.match(hub,/status=\$2::wa_account_status/);
  assert.match(hub,/\$2::wa_account_status='online'::wa_account_status/);
  assert.match(hub,/status_reason=CASE WHEN \$2::wa_account_status='online'::wa_account_status THEN NULL/);
  assert.match(hub,/last_connected_at=CASE WHEN \$2::wa_account_status='online'::wa_account_status THEN now\(\)/);
  assert.ok(worker.indexOf("let lastRetention=0")<worker.indexOf("while(!stopping)"));
  assert.match(cleanup,/10000000-0000-4000-8000-000000000001/);
  await assert.rejects(access(new URL("../../../infra/postgres/migrations/002_seed_demo.sql",import.meta.url)));
});

test("quoted replies require the v2 Windows Agent protocol",async()=>{
  const [server,hub,agentMain,protocol,agentPackage]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../apps/agent/src/main.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../packages/protocol/src/index.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../apps/agent/package.json",import.meta.url),"utf8"),
  ]);
  assert.match(hub,/const PROTOCOL_VERSION = 2/);
  assert.match(agentMain,/const PROTOCOL_VERSION = 2/);
  assert.match(protocol,/PROTOCOL_VERSION = 2/);
  assert.match(hub,/socket\.close\(4002,"protocol_upgrade_required"\)/);
  assert.doesNotMatch(hub,/liveAgents\.set\(agent\.id, socket\);[\s\S]{0,500}dispatchPending\(agent\.id, socket\)/);
  assert.match(server,/agent_upgrade_required/);
  assert.match(server,/agent_protocol_version\)!==2/);
  assert.equal(JSON.parse(agentPackage).version,"0.1.26");
});

test("new conversations inherit the account default takeover mode without rewriting existing conversations", async () => {
  const migration=await readFile(new URL("../../../infra/postgres/migrations/037_account_default_conversation_mode.sql",import.meta.url),"utf8");
  const migrator=await readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8");
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(migration,/ADD COLUMN IF NOT EXISTS default_conversation_mode/);
  assert.match(migration,/CHECK \(default_conversation_mode IN \('cautious', 'full', 'human_paused'\)\)/);
  assert.match(migration,/AFTER INSERT ON conversations/);
  assert.match(migration,/ON CONFLICT\(conversation_id\) DO NOTHING/);
  assert.doesNotMatch(migration,/UPDATE conversation_agent_state/);
  assert.match(migrator,/037_account_default_conversation_mode\.sql/);
  assert.match(server,/default_conversation_mode/);
  assert.match(server,/defaultConversationMode/);
});

test("OpenRouter and SiliconFlow agent provider presets are wired end to end",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const engine=await readFile(new URL("../src/agent-engine.ts",import.meta.url),"utf8");
  const runner=await readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8");
  const migration=await readFile(new URL("../../../infra/postgres/migrations/022_agent_provider_presets.sql",import.meta.url),"utf8");
  const ui=await readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
  assert.match(ui,/<option value="openrouter">OpenRouter<\/option>/);
  assert.match(ui,/<option value="siliconflow">SiliconFlow<\/option>/);
  assert.match(server,/https:\/\/openrouter\.ai\/api\/v1/);
  assert.match(server,/https:\/\/api\.siliconflow\.cn\/v1/);
  assert.match(server,/"openai","openrouter","siliconflow","openai_compatible"/);
  assert.match(engine,/provider\.provider==="siliconflow"\)requestBody\.dimensions=1536/);
  assert.match(runner,/022_agent_provider_presets\.sql/);
  assert.match(migration,/CHECK\(provider IN \('openai','openrouter','siliconflow','openai_compatible'\)\)/);
});
