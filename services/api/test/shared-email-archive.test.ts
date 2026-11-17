import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {pool} from "../src/db.js";
import {archiveInbound} from "../src/mailboxes.js";

test("同邮箱多个联系人只归档一份来信，并更新每个会话；重复同步跳过",async()=>{
  const account=randomUUID(),mailbox=randomUUID(),message=randomUUID();
  const contacts=[randomUUID(),randomUUID()],conversations=[randomUUID(),randomUUID()];
  const statements:Array<{sql:string;values?:unknown[]}>=[];
  let duplicate=false,released=0;
  const query=async(sql:string,values?:unknown[])=>{
    statements.push({sql,values});
    if(sql.startsWith("SELECT message_id FROM gmail_inbound_receipts"))return{rows:duplicate?[{message_id:message}]:[],rowCount:duplicate?1:0};
    if(sql.startsWith("SELECT DISTINCT co.id"))return{rows:contacts.map(id=>({id})),rowCount:2};
    if(sql.startsWith("INSERT INTO messages("))return{rows:[{id:message}],rowCount:1};
    if(sql.startsWith("UPDATE conversations SET status='open'"))return{rows:conversations.map((id,i)=>({id,contact_id:contacts[i]})),rowCount:2};
    return{rows:[],rowCount:0};
  };
  const oldConnect=pool.connect,oldQuery=pool.query;
  try{
    pool.connect=(async()=>({query,release(){released++;}})) as unknown as typeof pool.connect;
    pool.query=query as unknown as typeof pool.query;
    const settings={id:mailbox,account_id:account,address:"support@example.com",display_name:"Support",imap_host:"",imap_port:993,imap_username:"",imap_secret_encrypted:"",smtp_host:"",smtp_port:465,smtp_username:"",smtp_secret_encrypted:"",smtp_tls:"tls" as const,uid_validity:null,last_uid:null};
    const source=Buffer.from("From: Sam <sam@example.com>\r\nTo: support@example.com\r\nMessage-ID: <shared-test@example.com>\r\nSubject: Test\r\n\r\nNew message");
    await archiveInbound(settings,"gmail",0,source,new Date("2026-01-01"),"gmail-test");
    const inserts=statements.filter(item=>item.sql.startsWith("INSERT INTO messages("));
    assert.equal(inserts.length,1);assert.doesNotMatch(inserts[0].sql,/conversation_id|sender_contact_id/);
    assert.deepEqual(inserts[0].values?.slice(0,2),[account,"New message"]);
    assert.equal(statements.filter(item=>item.sql.startsWith("INSERT INTO message_email_details")).length,1);
    assert.equal(statements.filter(item=>item.sql.startsWith("INSERT INTO gmail_inbound_receipts")).length,1);
    assert.equal(statements.some(item=>item.sql.startsWith("INSERT INTO contacts(")),false);
    assert.deepEqual(statements.find(item=>item.sql.startsWith("UPDATE conversations SET status='open'"))?.values,[account,contacts]);
    assert.deepEqual(statements.filter(item=>item.sql.startsWith("UPDATE proactive_outreach_jobs SET state='cancelled'")).map(item=>item.values?.[0]),conversations);
    const firstCount=statements.length;duplicate=true;
    await archiveInbound(settings,"gmail",0,source,new Date("2026-01-01"),"gmail-test");
    assert.equal(statements.slice(firstCount).some(item=>item.sql.startsWith("INSERT")||item.sql.startsWith("UPDATE")),false);
    assert.equal(released,2);
  }finally{pool.connect=oldConnect;pool.query=oldQuery;}
});

test("私有邮件读取、回复和翻译适配共享档案，公开访客仍只读原始会话",async()=>{
  const load=(file:string)=>readFile(new URL(file,import.meta.url),"utf8");
  const [server,routes,publicApi,transcript,migrator]=await Promise.all([
    load("../src/server.ts"),load("../src/mailbox-routes.ts"),load("../src/livechat-public.ts"),load("../src/livechat-transcript.ts"),load("../src/migrate-agent.ts"),
  ]);
  assert.match(server,/JOIN relay_conversation_messages\(\$1\) visible ON visible.message_id=msg.id/);
  assert.equal(server.includes("m.id IN (SELECT message_id FROM relay_conversation_messages(root.id))"),true);
  assert.match(routes,/m.account_id=\$2 AND EXISTS\(SELECT 1 FROM email_archive_addresses/);
  assert.match(server,/FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id LEFT JOIN contacts co/);
  assert.match(server,/eligible.filter\(row=>row.conversation_id\)/);
  assert.match(migrator,/110_shared_email_archive.sql/);
  assert.doesNotMatch(publicApi,/relay_conversation_messages|email_archive_addresses/);
  assert.doesNotMatch(transcript,/relay_conversation_messages|email_archive_addresses/);
});
