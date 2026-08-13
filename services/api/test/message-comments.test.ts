import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("message comments are migrated and kept internal to the inbox API",async()=>{
  const [migration,migrator,server,schemas,ui]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/065_message_comments.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);

  assert.match(migration,/CREATE TABLE IF NOT EXISTS message_comments/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS message_comment_votes/);
  assert.match(migration,/CHECK \(value IN \(-1,1\)\)/);
  assert.match(migrator,/065_message_comments\.sql/);
  assert.match(schemas,/messageCommentSchema/);
  assert.match(schemas,/messageCommentVoteSchema/);
  assert.match(server,/messages\/:messageId\/comments/);
  assert.match(server,/message_comment_votes/);
  assert.match(ui,/内部评论（客户不可见）/);
  assert.match(ui,/仅团队可见/);
});
