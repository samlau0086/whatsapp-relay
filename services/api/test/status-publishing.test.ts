import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("status publishing owns separate persistence, scheduling, and command result paths",()=>{
  const migration=readFileSync(new URL("../../../infra/postgres/migrations/048_whatsapp_status_campaigns.sql",import.meta.url),"utf8");
  const routes=readFileSync(new URL("../src/status-routes.ts",import.meta.url),"utf8");
  const engine=readFileSync(new URL("../src/status-engine.ts",import.meta.url),"utf8");
  const statusCenter=readFileSync(new URL("../../../app/status-center.tsx",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE IF NOT EXISTS status_campaigns/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS status_posts/);
  assert.match(migration,/status_post_id uuid REFERENCES status_posts/);
  assert.match(routes,/status-campaigns\/preview-schedule/);
  assert.match(routes,/status_campaign_recipients/);
  assert.match(engine,/command,payload\) VALUES\(\$1,\$2,\$3,'publish_status'/);
  assert.match(engine,/status='uncertain'/);
  assert.match(statusCenter,/编辑计划/);
  assert.match(statusCenter,/删除动态发布计划/);
  assert.match(statusCenter,/method:"PATCH"/);
});

test("status commands are capability-gated while protocol version remains compatible",()=>{
  const hub=readFileSync(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  const protocol=readFileSync(new URL("../../../packages/protocol/src/index.ts",import.meta.url),"utf8");
  assert.match(hub,/capabilities=\$5/);
  assert.match(protocol,/PROTOCOL_VERSION = 2/);
  assert.match(protocol,/"publish_status"/);
});

test("status posts preserve translated copy and its source text",()=>{
  const migration=readFileSync(new URL("../../../infra/postgres/migrations/049_status_post_translation.sql",import.meta.url),"utf8");
  const migrator=readFileSync(new URL("../src/migrate-agent.ts",import.meta.url),"utf8");
  const routes=readFileSync(new URL("../src/status-routes.ts",import.meta.url),"utf8");
  assert.match(migration,/translation_source_text text/);
  assert.match(migration,/translation_target_language varchar\(35\)/);
  assert.match(migration,/status_posts_translation_pair_check/);
  assert.match(migrator,/049_status_post_translation\.sql/);
  assert.match(routes,/translationSourceText/);
  assert.match(routes,/translationTargetLanguage/);
  assert.match(routes,/translation_source_text,translation_target_language/);
});
