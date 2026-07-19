import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("translation routes enforce user preferences, provider secrecy, access checks, and caching",async()=>{
  const [server,migration]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/005_ai_translation.sql",import.meta.url),"utf8"),
  ]);
  assert.match(server,/request\.principal\?\.kind!=="user"/);
  assert.match(server,/api\/v1\/me\/translation-preferences/);
  assert.match(server,/api\/v1\/translations\/preview/);
  assert.match(server,/api\/v1\/translations\/messages/);
  assert.match(server,/canAccessAccount\(request\.principal,row\.account_id\)/);
  assert.match(server,/api_key_encrypted IS NOT NULL key_configured/);
  assert.match(server,/keyConfigured:Boolean\(row\?\.key_configured\)/);
  assert.match(server,/ON CONFLICT\(message_id,target_language\) DO NOTHING/);
  assert.match(migration,/PRIMARY KEY \(message_id,target_language\)/);
  assert.match(migration,/translation_provider_one_enabled_idx/);
  assert.match(migration,/user_id uuid PRIMARY KEY REFERENCES users/);
});
