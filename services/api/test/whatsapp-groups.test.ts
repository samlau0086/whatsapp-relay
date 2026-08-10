import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("group migration keeps group peers out of person CRM data",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/060_whatsapp_groups.sql",import.meta.url),"utf8");
  const migrator=await readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8");
  assert.match(migration,/contacts ADD COLUMN IF NOT EXISTS entity_type/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS whatsapp_groups/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS whatsapp_group_participants/);
  assert.match(migration,/sender_provider_user_id/);
  assert.match(migration,/last_message_sender_name/);
  assert.match(migrator,/060_whatsapp_groups\.sql/);
});

test("agent hub ingests authoritative group snapshots without enqueueing AI work",async()=>{
  const hub=await readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  assert.match(hub,/event\.kind==="group_snapshot"/);
  assert.match(hub,/event\.kind==="group_sync_complete"/);
  assert.match(hub,/DELETE FROM whatsapp_group_participants WHERE group_id/);
  assert.match(hub,/sync_id IS DISTINCT FROM/);
  const groupBranch=hub.slice(hub.indexOf('if(chatJid.endsWith("@g.us"))'),hub.indexOf("const phonePart="));
  assert.ok(groupBranch.length>100);
  assert.doesNotMatch(groupBranch,/enqueueInboundAgentWork/);
  assert.doesNotMatch(groupBranch,/INSERT INTO contacts\(account_id,provider_user_id,phone_e164/);
});

test("group API exposes members and blocks unsupported business automation",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const tasks=await readFile(new URL("../src/task-routes.ts",import.meta.url),"utf8");
  assert.match(server,/\/api\/v1\/conversations\/:id\/group/);
  assert.match(server,/\/api\/v1\/conversations\/:id\/group\/direct-conversation/);
  assert.match(server,/contact\.id contact_id/);
  assert.match(server,/group_participant\.open_direct/);
  assert.match(server,/participant_phone_unavailable/);
  assert.match(server,/group_chat_v1/);
  assert.match(server,/group_create_v1/);
  assert.match(server,/quotedParticipantJid/);
  assert.match(server,/group_feature_unavailable/);
  assert.match(server,/co\.entity_type='person'/);
  assert.match(tasks,/entity_type='person'/);
});
