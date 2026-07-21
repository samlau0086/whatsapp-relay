import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("translation routes enforce user preferences, admin-only credential access, access checks, and caching",async()=>{
  const [server,initialMigration,conversationMigration,audioMigration,outgoingSourceMigration]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/005_ai_translation.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/006_conversation_translation_preferences.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/007_audio_message_translations.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/008_outgoing_translation_source.sql",import.meta.url),"utf8"),
  ]);
  assert.match(server,/request\.principal\?\.kind!=="user"/);
  assert.match(server,/api\/v1\/me\/translation-preferences/);
  assert.match(server,/conversation_translation_preferences WHERE user_id=\$1 AND conversation_id=\$2/);
  assert.match(server,/api\/v1\/translations\/preview/);
  assert.match(server,/api\/v1\/translations\/messages/);
  assert.match(server,/canAccessAccount\(request\.principal,row\.account_id\)/);
  assert.match(server,/keyConfigured:Boolean\(row\?\.api_key_encrypted\)/);
  assert.match(server,/apiKey:row\?\.api_key_encrypted\?decryptAtRest/);
  assert.match(server,/ON CONFLICT\(message_id,target_language\) DO NOTHING/);
  assert.match(server,/ON CONFLICT\(message_id\) DO NOTHING/);
  assert.match(server,/transcribeAudio/);
  assert.match(server,/normalizeTranscriptionAudio/);
  assert.match(server,/transcription_endpoint_missing/);
  assert.match(server,/row\.translated_text\|\|parsed\.data\.generateAudio/);
  assert.match(server,/translation_source_text/);
  assert.match(server,/delete outboundMessage\.translationSourceText/);
  assert.match(initialMigration,/PRIMARY KEY \(message_id,target_language\)/);
  assert.match(initialMigration,/translation_provider_one_enabled_idx/);
  assert.match(conversationMigration,/PRIMARY KEY \(user_id,conversation_id\)/);
  assert.match(conversationMigration,/DROP TABLE IF EXISTS user_translation_preferences/);
  assert.match(audioMigration,/CREATE TABLE IF NOT EXISTS message_transcriptions/);
  assert.match(audioMigration,/transcription_model text NOT NULL DEFAULT 'gpt-4o-mini-transcribe'/);
  assert.match(outgoingSourceMigration,/ADD COLUMN IF NOT EXISTS translation_source_text text/);
  assert.match(outgoingSourceMigration,/never included in the WhatsApp outbound payload/);
});
