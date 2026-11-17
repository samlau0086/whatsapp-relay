import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import Fastify from "fastify";
import {ImapFlow} from "imapflow";
import nodemailer from "nodemailer";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {encryptAtRest,signToken} from "../src/security.js";
import {registerMailboxRoutes} from "../src/mailbox-routes.js";
import {syncOneMailbox,verifyMailbox} from "../src/mailboxes.js";

const accountId="123e4567-e89b-42d3-a456-426614174000",mailboxId="123e4567-e89b-42d3-a456-426614174001";
const headers={authorization:`Bearer ${signToken({sub:accountId,role:"admin"},config.JWT_SECRET)}`};
const settings={accountId,address:"support@example.com",displayName:"客服",isPrimary:false,enabled:true,imapHost:"imap.example.com",imapPort:993,imapUsername:"support",imapPassword:"secret",smtpHost:"smtp.example.com",smtpPort:465,smtpTls:"tls" as const,smtpUsername:"support",smtpPassword:"secret"};
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

test("密码邮箱按启用方向验证连接，停用方向不阻止保存",async t=>{
  let imap=0,smtp=0;
  t.mock.method(ImapFlow.prototype,"connect",async()=>{imap++;});
  t.mock.method(ImapFlow.prototype,"mailboxOpen",async()=>({uidValidity:7n,uidNext:4}));
  t.mock.method(ImapFlow.prototype,"logout",async()=>{});
  t.mock.method(nodemailer,"createTransport",()=>({verify:async()=>{smtp++;return true;}}));
  for(const [receiveEnabled,sendEnabled] of [[true,false],[false,true],[false,false],[true,true]]){
    imap=0;smtp=0;
    const verified=await verifyMailbox({...settings,receiveEnabled,sendEnabled});
    assert.equal(imap,Number(receiveEnabled));assert.equal(smtp,Number(sendEnabled));
    assert.equal(verified.uidValidity,receiveEnabled?"7":"");
  }
});

test("邮箱方向：新增、编辑、OAuth 设置持久化独立开关，兼容旧 enabled",async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.startsWith("SELECT auth_type"))return result([{auth_type:"password"}]);
    if(sql.startsWith("SELECT imap_secret"))return result([{imap_secret_encrypted:encryptAtRest("secret",config.DATA_ENCRYPTION_KEY),smtp_secret_encrypted:encryptAtRest("secret",config.DATA_ENCRYPTION_KEY)}]);
    if(sql.includes("FROM channel_accounts"))return result([{}]);
    if(sql.startsWith("SELECT account_id"))return result([{account_id:accountId}]);
    if(sql.startsWith("INSERT INTO account_email_mailboxes"))return result([{id:mailboxId}]);
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  t.mock.method(ImapFlow.prototype,"connect",async()=>{});
  t.mock.method(ImapFlow.prototype,"mailboxOpen",async()=>({uidValidity:1n,uidNext:1}));
  t.mock.method(ImapFlow.prototype,"logout",async()=>{});
  t.mock.method(nodemailer,"createTransport",()=>({verify:async()=>true}));
  const app=Fastify();registerMailboxRoutes(app);t.after(()=>app.close());
  for(const [flags,expected] of [
    [{receiveEnabled:false,sendEnabled:true},[true,false,true]],
    [{receiveEnabled:true,sendEnabled:false},[true,true,false]],
    [{receiveEnabled:false,sendEnabled:false},[false,false,false]],
    [{enabled:false},[false,false,false]],
    [{enabled:true},[true,true,true]],
  ] as const){
    calls.length=0;
    const created=await app.inject({method:"POST",url:"/api/v1/admin/mailboxes",headers,payload:{...settings,...flags}});
    assert.equal(created.statusCode,201,created.body);
    const insert=calls.find(c=>c.sql.startsWith("INSERT INTO account_email_mailboxes"))!;
    assert.deepEqual([insert.values[4],...insert.values.slice(14)],expected);
    const updated=await app.inject({method:"PUT",url:`/api/v1/admin/mailboxes/${mailboxId}`,headers,payload:{...settings,...flags,imapPassword:"",smtpPassword:""}});
    assert.equal(updated.statusCode,200,updated.body);
    const update=calls.find(c=>c.sql.startsWith("UPDATE account_email_mailboxes SET account_id"))!;
    assert.deepEqual([update.values[5],...update.values.slice(15,17)],expected);
    assert.equal(update.values[17],false);
    assert.match(update.sql,/ELSE uid_validity END/);assert.match(update.sql,/ELSE last_uid END/);
    const preferences=await app.inject({method:"PUT",url:`/api/v1/admin/mailboxes/${mailboxId}/preferences`,headers,payload:{displayName:"客服",isPrimary:false,...flags}});
    assert.equal(preferences.statusCode,200,preferences.body);
    assert.deepEqual(calls.find(c=>c.sql.startsWith("UPDATE account_email_mailboxes SET display_name"))!.values.slice(3),expected);
  }
  const denied={authorization:`Bearer ${signToken({sub:accountId,role:"agent"},config.JWT_SECRET)}`};
  assert.equal((await app.inject({method:"PUT",url:`/api/v1/admin/mailboxes/${mailboxId}/preferences`,headers:denied,payload:{displayName:"",isPrimary:false,receiveEnabled:false,sendEnabled:false}})).statusCode,403);
});

test("停用收件拒绝手动同步，Worker 仅领取启用收件的邮箱",async t=>{
  let claims=0;
  t.mock.method(pool,"query",async(sql:string)=>{
    if(sql.startsWith("SELECT id,enabled"))return result([{id:mailboxId,enabled:true,receive_enabled:false}]);
    claims++;assert.match(sql,/AND enabled AND receive_enabled AND/);return result();
  });
  const app=Fastify();registerMailboxRoutes(app);t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:`/api/v1/admin/mailboxes/${mailboxId}/sync`,headers});
  assert.equal(response.statusCode,409);assert.equal(response.json().error,"mailbox_disabled");assert.equal(claims,0);
  assert.equal(await syncOneMailbox(mailboxId),false);assert.equal(claims,1);
});

test("停用邮箱发件拒绝显式选择，即使渠道存在独立 Provider",async t=>{
  let inserts=0;
  t.mock.method(pool,"query",async(sql:string)=>{
    if(sql.startsWith("SELECT co.id"))return result([{id:accountId,account_id:accountId,entity_type:"person"}]);
    if(sql.startsWith("SELECT * FROM account_email_mailboxes")){assert.match(sql,/AND enabled AND send_enabled/);return result();}
    if(sql.startsWith("SELECT email FROM contact_emails"))return result([{email:"customer@example.com"}]);
    if(sql.includes("JOIN email_provider_instances"))return result([{id:mailboxId,provider:"resend",config:{fromEmail:"support@example.com"},secret_encrypted:"secret",explicit:true}]);
    if(sql.startsWith("INSERT"))inserts++;
    return result();
  });
  const app=Fastify();registerMailboxRoutes(app);t.after(()=>app.close());
  const response=await app.inject({method:"POST",url:`/api/v1/contacts/${accountId}/email-sends`,headers,payload:{mailboxId,clientSendId:mailboxId,recipientEmail:"customer@example.com",subject:"测试",body:"测试正文"}});
  assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,"email_address_unavailable");assert.equal(inserts,0);
});

test("方向迁移保留旧 enabled 且幂等，重新授权不覆盖方向开关",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/108_mailbox_direction_switches.sql",import.meta.url),"utf8");
  for(const column of ["receive_enabled","send_enabled"]){
    assert.ok(migration.includes(`ADD COLUMN IF NOT EXISTS ${column}`));
    assert.ok(migration.includes(`SET ${column}=enabled WHERE ${column} IS NULL`));
  }
  for(const file of ["mailbox-oauth.ts","google-mailbox-oauth.ts"]){
    const source=await readFile(new URL(`../src/${file}`,import.meta.url),"utf8");
    const reauthorization=source.split("UPDATE account_email_mailboxes SET auth_type=")[1]?.split('"')[0];
    assert.ok(reauthorization);assert.doesNotMatch(reauthorization,/enabled\s*=/);
  }
});
