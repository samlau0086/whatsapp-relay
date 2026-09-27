import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {queueChannelCommand} from "../src/whatsapp-outbound.js";

test("saving an unchanged empty phone preserves the synchronized LID",async()=>{
  const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(source,/const nextProviderUserId=phoneChanged\?/);
  const agent=await readFile(new URL("../../../apps/agent/src/account-worker.ts",import.meta.url),"utf8");
  assert.match(agent,/if\(!toJid&&toUsername\)/);
});

for(const historicalJid of ["123456789@lid","8613800138000@s.whatsapp.net",null]){
  test(`username sends recover a confirmed conversation target: ${historicalJid}`,async()=>{
    let queued:Record<string,unknown>|undefined;
    const client={query:async(sql:string,args:unknown[])=>{
      if(sql.includes("FROM channel_accounts"))return{rowCount:1,rows:[{platform:"whatsapp",transport:"web",agent_id:"agent-1"}]};
      if(sql.includes("SELECT oc.payload")){
        assert.match(sql,/oc.account_id=\$1 AND m.conversation_id=\$2/);
        assert.match(sql,/m.status IN \('sent','delivered','read'\)/);
        assert.deepEqual(args,["account-1","conversation-1"]);
        return{rowCount:historicalJid?1:0,rows:historicalJid?[{jid:historicalJid}]:[]};
      }
      if(sql.includes("INSERT INTO outbound_commands")){queued=JSON.parse(String(args[3]));return{rowCount:1,rows:[{id:"command-1",sequence:1}]};}
      throw new Error(`unexpected query: ${sql}`);
    }};
    const payload={accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",clientMessageId:"client-1",type:"text",text:"hello",toUsername:"customer"};
    await queueChannelCommand(client as never,{accountId:payload.accountId,conversationId:payload.conversationId,messageId:payload.messageId,payload});
    assert.equal(queued?.toJid,historicalJid??undefined);
    assert.equal(queued?.toUsername,historicalJid?undefined:"customer");
    assert.equal(payload.toUsername,"customer");
  });
}

test("unconfirmed WhatsApp Web sends stop as uncertain instead of being resent",async()=>{
  const worker=await readFile(new URL("../src/worker.ts",import.meta.url),"utf8");
  const requeue=worker.slice(worker.indexOf("async function requeueCommands"),worker.indexOf("async function enforceRetention"));
  assert.match(requeue,/a\.transport='web'.*state='uncertain'/s);
  assert.doesNotMatch(requeue,/a\.transport='web'.*state='pending'/s);
  assert.match(requeue,/automatic retry stopped to prevent duplicates/);
});

test("message retry preserves a username destination when the phone JID is absent",async()=>{
  const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const retry=source.slice(source.indexOf('app.post("/api/v1/messages/:id/retry"'),source.indexOf('app.delete("/api/v1/messages/:id"'));
  assert.match(retry,/co\.provider_user_id,co\.whatsapp_username/);
  assert.match(retry,/String\(row\.provider_user_id\?\?""\)\.trim\(\),toUsername=String\(row\.whatsapp_username\?\?""\)/);
  assert.match(retry,/if\(!toJid&&!toUsername\)throw/);
  assert.match(retry,/destinationId:toJid/);
});

test("direct WhatsApp messages preserve a username destination when the phone JID is absent",async()=>{
  const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const send=source.slice(source.indexOf('app.post("/api/v1/messages"'),source.indexOf('app.post("/api/v1/messages/:id/retry"'));
  assert.match(send,/co\.provider_user_id,co\.whatsapp_username/);
  assert.match(send,/const toJid=String\(conversation\.rows\[0\]\.provider_user_id\?\?""\)\.trim\(\),toUsername=String\(conversation\.rows\[0\]\.whatsapp_username\?\?""\)/);
  assert.match(send,/if\(!toJid&&!toUsername\)throw/);
  assert.match(send,/\.\.\.\(toJid\?\{toJid,destinationId:toJid\}:\{toUsername\}\)/);
});
