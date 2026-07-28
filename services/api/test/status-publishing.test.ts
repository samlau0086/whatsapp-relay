import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("status publishing owns separate persistence, scheduling, and command result paths",()=>{
  const migration=readFileSync(new URL("../../../infra/postgres/migrations/048_whatsapp_status_campaigns.sql",import.meta.url),"utf8");
  const routes=readFileSync(new URL("../src/status-routes.ts",import.meta.url),"utf8");
  const engine=readFileSync(new URL("../src/status-engine.ts",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE IF NOT EXISTS status_campaigns/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS status_posts/);
  assert.match(migration,/status_post_id uuid REFERENCES status_posts/);
  assert.match(routes,/status-campaigns\/preview-schedule/);
  assert.match(routes,/status_campaign_recipients/);
  assert.match(engine,/command,payload\) VALUES\(\$1,\$2,\$3,'publish_status'/);
  assert.match(engine,/status='uncertain'/);
});

test("status commands are capability-gated while protocol version remains compatible",()=>{
  const hub=readFileSync(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  const protocol=readFileSync(new URL("../../../packages/protocol/src/index.ts",import.meta.url),"utf8");
  assert.match(hub,/capabilities=\$5/);
  assert.match(protocol,/PROTOCOL_VERSION = 2/);
  assert.match(protocol,/"publish_status"/);
});
