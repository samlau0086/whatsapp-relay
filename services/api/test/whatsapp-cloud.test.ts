import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {cloudOutboundBody,validMetaSignature,webhookPhoneNumberId} from "../src/whatsapp-cloud.js";
import {queueWhatsAppCommand,TemplateRequiredError} from "../src/whatsapp-outbound.js";

test("Meta webhook signature validates the exact raw request body",()=>{
  const raw=Buffer.from('{"entry":[{"changes":[]}]}'),secret="meta-app-secret";
  const signature=`sha256=${createHmac("sha256",secret).update(raw).digest("hex")}`;
  assert.equal(validMetaSignature(raw,signature,secret),true);
  assert.equal(validMetaSignature(Buffer.from(`${raw} `),signature,secret),false);
  assert.equal(validMetaSignature(raw,"sha256=00",secret),false);
});

test("webhook routing reads the metadata phone number ID",()=>{
  assert.equal(webhookPhoneNumberId({entry:[{changes:[{value:{metadata:{phone_number_id:"123456"}}}]}]}),"123456");
  assert.equal(webhookPhoneNumberId({entry:[]}),"");
});

test("Cloud outbound text and template payloads use Graph API wire shapes",async()=>{
  assert.deepEqual(await cloudOutboundBody({toJid:"8613800138000@s.whatsapp.net",type:"text",text:"hello"},"token","phone"),{
    messaging_product:"whatsapp",recipient_type:"individual",to:"8613800138000",type:"text",text:{preview_url:true,body:"hello"},
  });
  assert.deepEqual(await cloudOutboundBody({toJid:"8613800138000@s.whatsapp.net",type:"template",template:{name:"welcome",language:"en_US",components:[{type:"body",parameters:[{type:"text",text:"Sam"}]}]}},"token","phone"),{
    messaging_product:"whatsapp",recipient_type:"individual",to:"8613800138000",type:"template",template:{name:"welcome",language:{code:"en_US"},components:[{type:"body",parameters:[{type:"text",text:"Sam"}]}]},
  });
});

test("Cloud credentials are encrypted, redacted, and never returned by account reads",async()=>{
  const [cloud,server]=await Promise.all([
    readFile(new URL("../src/whatsapp-cloud.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(cloud,/encryptAtRest\(parsed\.data\.accessToken/);
  assert.match(cloud,/encryptAtRest\(parsed\.data\.appSecret/);
  const adminRead=cloud.slice(cloud.indexOf('app.get("/api/v1/admin/whatsapp-cloud/accounts"'),cloud.indexOf('app.post("/api/v1/admin/whatsapp-cloud/accounts"'));
  assert.doesNotMatch(adminRead,/decryptAtRest|access_token_encrypted|app_secret_encrypted/);
  assert.match(server,/"req\.body\.accessToken","req\.body\.appSecret"/);
});

test("production deployment supplies the required Graph API version",async()=>{
  const workflow=await readFile(new URL("../../../.github/workflows/deploy-vps.yml",import.meta.url),"utf8");
  assert.match(workflow,/META_GRAPH_API_VERSION: \$\{\{ vars\.META_GRAPH_API_VERSION \|\| 'v26\.0' \}\}/);
  assert.match(workflow,/"META_GRAPH_API_VERSION"/);
  assert.match(workflow,/META_GRAPH_API_VERSION: process\.env\.META_GRAPH_API_VERSION/);
});

test("all outbound command inserts pass through the shared transport guard",async()=>{
  const files=["server.ts","agent-engine.ts","task-engine.ts"];
  for(const file of files){
    const source=await readFile(new URL(`../src/${file}`,import.meta.url),"utf8");
    assert.doesNotMatch(source,/INSERT INTO outbound_commands/,`${file} bypasses queueWhatsAppCommand`);
  }
});

test("the shared queue enforces Cloud service windows without changing Web behavior",async()=>{
  function clientFor(row:{transport:"web"|"cloud";agent_id:string|null;service_window_expires_at:string|null},approved=true){
    const calls:string[]=[];
    return{
      calls,
      client:{query:async(sql:string)=>{
        calls.push(sql);
        if(sql.includes("FROM whatsapp_accounts"))return{rowCount:1,rows:[row]};
        if(sql.includes("FROM whatsapp_message_templates"))return{rowCount:approved?1:0,rows:approved?[{exists:1}]:[]};
        if(sql.includes("INSERT INTO outbound_commands"))return{rowCount:1,rows:[{id:"command-1",sequence:4}]};
        throw new Error(`unexpected query: ${sql}`);
      }},
    };
  }
  const input={accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",payload:{accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",clientMessageId:"client-1",toJid:"8613800138000@s.whatsapp.net",type:"text",text:"hello"}};
  const expired=clientFor({transport:"cloud",agent_id:null,service_window_expires_at:new Date(Date.now()-1).toISOString()});
  await assert.rejects(()=>queueWhatsAppCommand(expired.client as never,input),TemplateRequiredError);
  assert.equal(expired.calls.some(sql=>sql.includes("INSERT INTO outbound_commands")),false);

  const open=clientFor({transport:"cloud",agent_id:null,service_window_expires_at:new Date(Date.now()+60_000).toISOString()});
  const cloudQueued=await queueWhatsAppCommand(open.client as never,input);
  assert.equal(cloudQueued.transport,"cloud");
  assert.equal(cloudQueued.agentId,null);

  const web=clientFor({transport:"web",agent_id:"agent-1",service_window_expires_at:null});
  const webQueued=await queueWhatsAppCommand(web.client as never,input);
  assert.equal(webQueued.transport,"web");
  assert.equal(webQueued.agentId,"agent-1");
});

test("approved templates may open a Cloud conversation outside the service window",async()=>{
  const queries:string[]=[];
  const client={query:async(sql:string)=>{
    queries.push(sql);
    if(sql.includes("FROM whatsapp_accounts"))return{rowCount:1,rows:[{transport:"cloud",agent_id:null,service_window_expires_at:null}]};
    if(sql.includes("FROM whatsapp_message_templates"))return{rowCount:1,rows:[{exists:1}]};
    if(sql.includes("INSERT INTO outbound_commands"))return{rowCount:1,rows:[{id:"command-2",sequence:5}]};
    throw new Error(`unexpected query: ${sql}`);
  }};
  const queued=await queueWhatsAppCommand(client as never,{accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",payload:{accountId:"account-1",conversationId:"conversation-1",messageId:"message-1",clientMessageId:"client-1",toJid:"8613800138000@s.whatsapp.net",type:"template",template:{name:"welcome",language:"en_US",components:[]}}});
  assert.equal(queued.transport,"cloud");
  assert.ok(queries.some(sql=>sql.includes("whatsapp_message_templates")));
});
