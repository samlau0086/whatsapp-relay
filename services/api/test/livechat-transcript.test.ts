import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerLivechatRoutes} from "../src/livechat.js";

const rootId="11111111-1111-4111-8111-111111111111",targetId="22222222-2222-4222-8222-222222222222",accountId="33333333-3333-4333-8333-333333333333",userId="44444444-4444-4444-8444-444444444444",sendId="55555555-5555-4555-8555-555555555555",emailId="66666666-6666-4666-8666-666666666666";
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

test("后台 transcript：授权、访客隔离、Provider 快照、去重及事务回滚",async t=>{
  let found=true,permission=true,recipient:string|null="visitor@example.com",provider=true,boundUnavailable=false,existing:Record<string,unknown>|undefined,failBubble=false;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("FROM conversations root"))return result(found?[{conversation_id:values[1],account_id:accountId,contact_id:values[1],recipient_email:recipient}]:[]);
    if(sql.includes("FROM account_permissions"))return result(permission?[{account_id:accountId}]:[]);
    if(sql.startsWith("SELECT id,status,conversation_id"))return result(existing?[existing]:[]);
    if(sql.includes("JOIN email_provider_instances"))return result(provider?[{provider:"resend",config:{fromEmail:"bound@example.com"},secret_encrypted:"bound-secret",explicit:true}]:[]);
    if(sql.includes("FROM account_email_providers"))return result(boundUnavailable?[{provider_id:emailId}]:[]);
    if(sql.includes("FROM messages m"))return result([{direction:"in",text_content:"<script>alert(1)</script>"+"x".repeat(6000),file_name:"report.pdf",occurred_at:"2026-11-17T00:00:00Z"}]);
    if(sql.startsWith("INSERT INTO email_messages"))return result([{id:emailId,status:"queued"}]);
    if(sql.startsWith("INSERT INTO messages")){if(failBubble)throw Error("bubble_failed");return result([{id:sendId}]);}
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const send=(role="admin",payload:Record<string,unknown>={clientSendId:sendId,targetConversationId:targetId})=>app.inject({method:"POST",url:`/api/v1/conversations/${rootId}/transcript`,headers:{authorization:`Bearer ${signToken({sub:userId,role},config.JWT_SECRET,3600)}`},payload});
  assert.equal((await app.inject({method:"POST",url:`/api/v1/conversations/${rootId}/transcript`,payload:{}})).statusCode,401);
  assert.equal((await send("admin",{clientSendId:"bad"})).statusCode,400);
  assert.ok(!calls.some(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)));
  const response=await send();assert.equal(response.statusCode,202,response.body);assert.equal(response.json().queued,true);
  const context=calls.find(c=>c.sql.includes("FROM conversations root"))!;
  assert.deepEqual(context.values,[rootId,targetId]);assert.doesNotMatch(context.sql,/cv.account_id=root.account_id/);assert.match(context.sql,/relay_conversation_members\(root.id\)/);assert.match(context.sql,/channel.enabled AND channel.archived_at IS NULL/);
  const history=calls.find(c=>c.sql.includes("FROM messages m"))!;
  assert.deepEqual(history.values,[targetId]);assert.match(history.sql,/m.conversation_id=\$1/);assert.match(history.sql,/NOT EXISTS\(SELECT 1 FROM message_email_details/);assert.match(history.sql,/m.status IN \('sent','delivered','read'\)/);assert.match(history.sql,/ORDER BY m.occurred_at,m.id/);
  const job=calls.find(c=>c.sql.startsWith("INSERT INTO email_messages"))!;
  assert.deepEqual(job.values.slice(0,8),[sendId,targetId,targetId,"resend",'{"fromEmail":"bound@example.com"}',"bound-secret",'[{"email":"visitor@example.com","label":"LiveChat visitor"}]',"Your LiveChat transcript"]);
  assert.equal(job.values[10],userId);assert.ok(String(job.values[8]).length>6000);assert.match(String(job.values[8]),/Attachment: report.pdf/);assert.match(String(job.values[9]),/&lt;script&gt;/);assert.doesNotMatch(String(job.values[9]),/<script>/);
  assert.equal(calls.find(c=>c.sql.startsWith("INSERT INTO message_email_details"))?.values[2],"bound@example.com");
  assert.ok(calls.some(c=>c.sql.includes("livechat.send_transcript")));assert.ok(!calls.some(c=>c.sql.startsWith("UPDATE conversations")||c.sql.includes("INSERT INTO livechat_end_requests")));assert.equal(calls.at(-1)?.sql,"COMMIT");
  calls.length=0;existing={id:emailId,status:"accepted",conversation_id:targetId,sender_user_id:userId,content_type:"livechat_transcript"};
  provider=false;recipient=null;
  const duplicate=await send();assert.equal(duplicate.statusCode,202);assert.equal(duplicate.json().deduplicated,true);assert.equal(duplicate.json().status,"accepted");assert.ok(!calls.some(c=>c.sql.startsWith("INSERT")));
  for(const field of ["conversation_id","sender_user_id","content_type"]){const previous=existing[field];existing[field]="other";assert.equal((await send()).statusCode,409);existing[field]=previous;}
  existing=undefined;
  assert.equal((await send()).json().error,"visitor_email_required");
  recipient="visitor@example.com";assert.equal((await send()).json().error,"email_provider_not_configured");
  boundUnavailable=true;assert.equal((await send()).json().error,"channel_email_provider_unavailable");boundUnavailable=false;provider=true;
  permission=false;calls.length=0;assert.equal((await send("agent")).statusCode,404);assert.ok(!calls.some(c=>c.sql.startsWith("INSERT")));
  permission=true;assert.equal((await send("agent")).statusCode,202);
  calls.length=0;assert.equal((await send("admin",{clientSendId:sendId})).statusCode,202);
  assert.deepEqual(calls.find(c=>c.sql.includes("FROM conversations root"))?.values,[rootId,rootId]);
  assert.deepEqual(calls.find(c=>c.sql.includes("FROM messages m"))?.values,[rootId]);
  found=false;calls.length=0;assert.equal((await send()).statusCode,404);assert.ok(!calls.some(c=>c.sql.startsWith("INSERT")));found=true;
  failBubble=true;calls.length=0;assert.equal((await send()).statusCode,500);assert.equal(calls.at(-1)?.sql,"ROLLBACK");
});
