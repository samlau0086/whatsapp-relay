import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("translation routes enforce user preferences, provider secrecy, access checks, and caching",async()=>{
  const [server,initialMigration,conversationMigration]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/005_ai_translation.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/006_conversation_translation_preferences.sql",import.meta.url),"utf8"),
  ]);
  assert.match(server,/request\.principal\?\.kind!=="user"/);
  assert.match(server,/api\/v1\/me\/translation-preferences/);
  assert.match(server,/conversation_translation_preferences WHERE user_id=\$1 AND conversation_id=\$2/);
  assert.match(server,/api\/v1\/translations\/preview/);
  assert.match(server,/api\/v1\/translations\/messages/);
  assert.match(server,/canAccessAccount\(request\.principal,row\.account_id\)/);
  assert.match(server,/api_key_encrypted IS NOT NULL key_configured/);
  assert.match(server,/keyConfigured:Boolean\(row\?\.key_configured\)/);
  assert.match(server,/ON CONFLICT\(message_id,target_language\) DO NOTHING/);
  assert.match(initialMigration,/PRIMARY KEY \(message_id,target_language\)/);
  assert.match(initialMigration,/translation_provider_one_enabled_idx/);
  assert.match(conversationMigration,/PRIMARY KEY \(user_id,conversation_id\)/);
  assert.match(conversationMigration,/DROP TABLE IF EXISTS user_translation_preferences/);
});
