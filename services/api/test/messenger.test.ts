import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {messengerOutboundBody,validMessengerSignature} from "../src/messenger.js";
import {MessengerReplyWindowClosedError,queueChannelCommand} from "../src/whatsapp-outbound.js";

test("Messenger webhook signature validates the exact raw body",()=>{
  const raw=Buffer.from('{"object":"page","entry":[{"id":"123"}]}'),secret="messenger-app-secret";
  const signature=`sha256=${createHmac("sha256",secret).update(raw).digest("hex")}`;
  assert.equal(validMessengerSignature(raw,signature,secret),true);
  assert.equal(validMessengerSignature(Buffer.from(`${raw} `),signature,secret),false);
  assert.equal(validMessengerSignature(raw,"sha256=00",secret),false);
});

test("Messenger outbound text and reply use Send API wire shapes",async()=>{
  assert.deepEqual(await messengerOutboundBody({destinationId:"psid-1",type:"text",text:"hello"},"token","page-1"),{
    recipient:{id:"psid-1"},messaging_type:"RESPONSE",message:{text:"hello"},
  });
  assert.deepEqual(await messengerOutboundBody({destinationId:"psid-1",type:"text",text:"reply",quotedProviderMessageId:"mid.quoted"},"token","page-1"),{
    recipient:{id:"psid-1"},messaging_type:"RESPONSE",message:{text:"reply",reply_to:{mid:"mid.quoted"}},
  });
});

test("channel queue enforces the Messenger reply window",async()=>{
  const calls:string[]=[];
  const client={query:async(sql:string)=>{
    calls.push(sql);
    if(sql.includes("FROM channel_accounts"))return{rowCount:1,rows:[{platform:"messenger",transport:"cloud",agent_id:null,service_window_expires_at:new Date(Date.now()-1).toISOString()}]};
    if(sql.includes("INSERT INTO outbound_commands"))return{rowCount:1,rows:[{id:"command-1",sequence:1}]};
    throw new Error(`unexpected query: ${sql}`);
  }};
  const input={accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",payload:{accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",clientMessageId:"client-1",toJid:"psid-1",destinationId:"psid-1",type:"text",text:"hello"}};
  await assert.rejects(()=>queueChannelCommand(client as never,input),MessengerReplyWindowClosedError);
  assert.equal(calls.some(sql=>sql.includes("INSERT INTO outbound_commands")),false);
});

test("channel migration preserves WhatsApp data while adding Messenger tables",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/055_messenger_channels.sql",import.meta.url),"utf8");
  assert.match(migration,/ALTER TABLE whatsapp_accounts RENAME TO channel_accounts/);
  assert.match(migration,/ALTER TABLE contacts RENAME COLUMN wa_jid TO provider_user_id/);
  assert.match(migration,/ALTER TABLE messages RENAME COLUMN whatsapp_message_id TO provider_message_id/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS messenger_page_accounts/);
  assert.match(migration,/UNIQUE\(account_id,payload_hash\)/);
});

test("channel contact search keeps a Messenger-aware trigram index",async()=>{
  const [migration,migrator,server]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/056_channel_contact_search.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  const searchExpression=/COALESCE\((?:search_contact\.)?alias,''\) \|\| ' ' \|\| COALESCE\((?:search_contact\.)?display_name,''\) \|\| ' ' \|\|\s*COALESCE\((?:search_contact\.)?phone_e164,''\) \|\| ' ' \|\| (?:search_contact\.)?provider_user_id/;
  assert.match(migration,searchExpression);
  assert.match(server,searchExpression);
  assert.match(migration,/gin_trgm_ops/);
  assert.match(migration,/conversations_last_message_text_trgm_idx[\s\S]*last_message_text gin_trgm_ops/);
  assert.match(migrator,/"056_channel_contact_search\.sql"/);
});

test("Messenger routes split multi-Page webhooks and keep credentials redacted",async()=>{
  const [messenger,server]=await Promise.all([
    readFile(new URL("../src/messenger.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(messenger,/page_id=ANY\(\$1::text\[\]\)/);
  assert.match(messenger,/for\(const entry of entries\)/);
  assert.match(messenger,/ON CONFLICT\(account_id,payload_hash\) DO NOTHING/);
  assert.match(messenger,/encryptAtRest\(parsed\.data\.pageAccessToken/);
  const adminRead=messenger.slice(messenger.indexOf('app.get("/api/v1/admin/messenger/pages"'),messenger.indexOf('app.post("/api/v1/admin/messenger/pages"'));
  assert.doesNotMatch(adminRead,/decryptAtRest|page_access_token_encrypted|app_secret_encrypted/);
  assert.match(server,/"req\.body\.pageAccessToken"/);
});

test("Messenger processing covers echo, delivery, read watermarks, and Page-scoped contacts",async()=>{
  const messenger=await readFile(new URL("../src/messenger.ts",import.meta.url),"utf8");
  assert.match(messenger,/message\.is_echo/);
  assert.match(messenger,/provider_message_id=ANY\(\$2::text\[\]\)/);
  assert.match(messenger,/occurred_at<=to_timestamp\(\$2\/1000\.0\)/);
  assert.match(messenger,/ON CONFLICT\(account_id,provider_user_id\)/);
  assert.match(messenger,/platform:"messenger"/);
});
