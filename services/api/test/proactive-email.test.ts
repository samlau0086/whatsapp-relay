import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import type {PoolClient} from "pg";
import {queueProactiveEmail,outreachEmailDestination} from "../src/proactive-email.js";

function database(options:{state?:Record<string,unknown>;destination?:boolean;auth?:string;resend?:string;parent?:boolean}={}){
  const calls:Array<{sql:string;params:unknown[]}> = [];
  const client={query:async(sql:string,params:unknown[]=[])=>{
    calls.push({sql,params});
    let rows:Record<string,unknown>[]=[];
    if(sql.includes("FROM contacts co"))rows=[{proactive_email_allowed:true,enabled:true,email_enabled:true,status:"open",mode:"cautious",...options.state}];
    else if(sql.includes("CROSS JOIN contact_emails"))rows=options.destination===false?[]:[{mailbox_id:"mailbox",from_email:"sender@example.com",to_email:"customer@example.com"}];
    else if(sql.startsWith("SELECT * FROM account_email_mailboxes"))rows=[{id:"mailbox",address:"sender@example.com",auth_type:options.auth??"password",smtp_host:"smtp.example.com",smtp_port:587,smtp_tls:"starttls",smtp_username:"sender@example.com",smtp_secret_encrypted:options.auth==="microsoft"?"":"encrypted-password"}];
    else if(sql.includes("FROM email_provider_settings"))rows=options.resend?[{config:{fromEmail:options.resend},secret_encrypted:"encrypted-api-key"}]:[];
    else if(sql.includes("FROM message_email_details"))rows=options.parent?[{rfc_message_id:"<previous@example.com>",references_header:"<first@example.com>",subject:"RE(2): Hello",message_id:"previous-message"}]:[];
    else if(sql.startsWith("INSERT INTO email_messages"))rows=[{id:"email-job"}];
    else if(sql.startsWith("INSERT INTO messages"))rows=[{id:"bubble"}];
    return{rows,rowCount:rows.length};
  }} as unknown as PoolClient;
  return{client,calls};
}
const input={jobId:"job",accountId:"account",contactId:"contact",conversationId:"conversation",subject:"Hello",body:"A useful update"};

test("only the enabled primary sender and primary recipient are eligible",async()=>{
  const db=database();await outreachEmailDestination(db.client,"account","contact");
  assert.match(db.calls[0].sql,/mb\.is_primary AND mb\.enabled/);
  assert.match(db.calls[0].sql,/ce\.is_primary/);
  assert.equal(await outreachEmailDestination(database({destination:false}).client,"account","contact"),null);
});

test("Microsoft outreach uses the mailbox OAuth transport, not global Resend",async()=>{
  const db=database({auth:"microsoft",resend:"another@example.com"});
  assert.equal(await queueProactiveEmail(db.client,input),"bubble");
  const values=db.calls.find(call=>call.sql.startsWith("INSERT INTO email_messages"))!.params;
  assert.equal(values[4],"smtp");assert.equal(values[6],"");
  assert.equal(JSON.parse(String(values[5])).oauthMailboxId,"mailbox");
  assert.equal(db.calls.some(call=>call.sql.includes("FROM email_provider_settings")),false);
});

test("Resend is used only when its sender is the configured primary mailbox",async()=>{
  for(const sender of ["sender@example.com","another@example.com"]){
    const db=database({resend:sender});await queueProactiveEmail(db.client,input);
    const values=db.calls.find(call=>call.sql.startsWith("INSERT INTO email_messages"))!.params;
    assert.equal(values[4],sender==="sender@example.com"?"resend":"smtp");
    assert.equal(JSON.parse(String(values[5])).fromEmail,"sender@example.com");
  }
});

test("permission, suppression and existing WhatsApp identifiers block email enqueue",async()=>{
  for(const state of [{proactive_email_allowed:false},{proactive_suppressed_at:new Date()},{enabled:false},{email_enabled:false},{mode:"human_paused"},{provider_user_id:"jid"},{phone_e164:"+12025550123"},{whatsapp_username:"customer"}]){
    const db=database({state});
    await assert.rejects(queueProactiveEmail(db.client,input),/email_outreach_not_permitted/);
    assert.equal(db.calls.some(call=>call.sql.startsWith("INSERT")),false);
  }
});

test("missing primary mailbox never falls back to another sender",async()=>{
  const db=database({destination:false});
  await assert.rejects(queueProactiveEmail(db.client,input),/primary_email_unavailable/);
  assert.equal(db.calls.some(call=>call.sql.startsWith("INSERT")),false);
});

test("follow-up emails retain standard thread headers and opt-out instructions",async()=>{
  const db=database({parent:true});await queueProactiveEmail(db.client,input);
  const values=db.calls.find(call=>call.sql.startsWith("INSERT INTO email_messages"))!.params;
  assert.equal(values[8],"RE: Hello");assert.equal(values[12],"<previous@example.com>");
  assert.equal(values[13],"<first@example.com> <previous@example.com>");
  assert.match(String(values[9]),/退订/);
  assert.match(db.calls.find(call=>call.sql.startsWith("UPDATE proactive_outreach_jobs"))!.sql,/state='queued'/);
  assert.equal(db.calls.some(call=>call.sql.includes("outbound_commands")),false);
});

test("delivery is counted only after provider acceptance and guard checks replies",async()=>{
  const source=await readFile(new URL("../src/email.ts",import.meta.url),"utf8");
  assert.match(source,/await sendSmtp.*await sendResend/);
  assert.match(source,/email_provider_accepted/);
  assert.match(source,/row\.customer_replied/);
  assert.match(source,/row\.mode==="human_paused"/);
  assert.match(source,/if\(temporary&&job\.attempt<5\)/);
});
