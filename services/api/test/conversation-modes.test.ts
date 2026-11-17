import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerConversationModeRoutes} from "../src/conversation-modes.js";
import {registerMailboxRoutes} from "../src/mailbox-routes.js";

const root="11111111-1111-4111-8111-111111111111",target="22222222-2222-4222-8222-222222222222",account="33333333-3333-4333-8333-333333333333",user="44444444-4444-4444-8444-444444444444",sendId="55555555-5555-4555-8555-555555555555";
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
const headers=(role="admin")=>({authorization:`Bearer ${signToken({sub:user,role},config.JWT_SECRET,3600)}`});

test("会话模式：成员读取、WhatsApp 幂等准备、资料与账号权限校验",async t=>{
  let phone:string|null="+8613800138000",read=true,send=true;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("FROM account_permissions"))return result((sql.includes("can_send")?send:read)?[{account_id:account}]:[]);
    if(sql.includes("SELECT DISTINCT c.account_id"))return result([{account_id:account}]);
    if(sql.includes("FOR UPDATE OF c,co"))return result([{id:root,account_id:account,phone_e164:phone,entity_type:"person"},{id:target,account_id:account,phone_e164:phone,entity_type:"person"}]);
    if(sql.includes("conversation_mode"))return result([{id:root,account_id:account,conversation_mode:"email",primary_email:"customer@example.com",has_email_provider:true}]);
    if(sql.startsWith("SELECT id FROM channel_accounts"))return result([{id:account}]);
    if(sql.startsWith("SELECT id FROM contacts"))return result([{id:target}]);
    if(sql.startsWith("INSERT INTO conversations"))return result([{id:target}]);
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();registerConversationModeRoutes(app);t.after(()=>app.close());
  const prepare=(role="admin")=>app.inject({method:"POST",url:`/api/v1/conversations/${root}/modes/whatsapp`,headers:headers(role),payload:{accountId:account}});
  assert.equal((await app.inject({url:`/api/v1/conversations/${root}/modes`})).statusCode,401);
  const modes=await app.inject({url:`/api/v1/conversations/${root}/modes`,headers:headers()});
  assert.equal(modes.statusCode,200);assert.equal(modes.json().data[0].conversation_mode,"email");
  assert.match(calls.find(c=>c.sql.includes("conversation_mode"))!.sql,/c.origin_mode/);
  assert.equal((await prepare()).statusCode,200);assert.equal((await prepare()).json().conversationId,target);
  assert.ok(!calls.some(c=>c.sql.startsWith("INSERT INTO contacts")||c.sql.startsWith("INSERT INTO conversation_timeline_merges")));
  assert.match(calls.find(c=>c.sql.startsWith("INSERT INTO conversations"))!.sql,/origin_mode.*'whatsapp'/);
  assert.equal(calls.at(-1)?.sql,"COMMIT");
  phone=null;calls.length=0;assert.equal((await prepare()).statusCode,409);
  assert.ok(!calls.some(c=>c.sql.startsWith("INSERT")));assert.equal(calls.at(-1)?.sql,"ROLLBACK");phone="+8613800138000";
  send=false;assert.equal((await prepare("agent")).statusCode,403);
  read=false;calls.length=0;assert.equal((await prepare("agent")).statusCode,404);
  assert.ok(!calls.some(c=>c.sql.startsWith("INSERT")));
});

test("Email 模式：仅 Provider 也可入队、保留快照、无效邮箱及停用绑定拒绝发送",async t=>{
  let provider=true,bound=false,existing=false;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.startsWith("SELECT co.id"))return result([{id:root,account_id:account,entity_type:"person"}]);
    if(sql.includes("JOIN email_provider_instances"))return result(provider?[{id:target,provider:"resend",config:{fromEmail:"support@example.com"},secret_encrypted:"encrypted-snapshot",explicit:true}]:[]);
    if(sql.startsWith("SELECT provider_id"))return result(bound?[{provider_id:target}]:[]);
    if(sql.startsWith("SELECT email FROM contact_emails"))return result([{email:"customer@example.com"}]);
    if(sql.startsWith("SELECT e.id,e.conversation_id"))return result(existing?[{id:sendId,conversation_id:root}]:[]);
    if(sql.startsWith("SELECT 1 FROM conversations"))return result([{exists:true}]);
    if(sql.startsWith("INSERT INTO conversations"))return result([{id:root}]);
    if(sql.startsWith("INSERT INTO email_messages")||sql.startsWith("INSERT INTO messages"))return result([{id:sendId}]);
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();registerMailboxRoutes(app);t.after(()=>app.close());
  const send=(extra={})=>app.inject({method:"POST",url:`/api/v1/conversations/${root}/email-sends/text`,headers:headers(),payload:{clientSendId:sendId,recipientEmail:"customer@example.com",subject:"邮件主题",body:"邮件正文",...extra}});
  const response=await send();assert.equal(response.statusCode,202,response.body);
  const job=calls.find(c=>c.sql.startsWith("INSERT INTO email_messages"))!;
  assert.deepEqual(job.values.slice(4,7),["resend",'{"fromEmail":"support@example.com"}',"encrypted-snapshot"]);
  assert.equal(job.values[11],null);
  assert.equal(calls.find(c=>c.sql.startsWith("INSERT INTO message_email_details"))?.values[1],null);
  existing=true;calls.length=0;assert.equal((await send()).json().deduplicated,true);
  assert.ok(!calls.some(c=>c.sql.startsWith("INSERT")));existing=false;
  assert.equal((await send({mailboxId:target})).statusCode,409);
  provider=false;assert.equal((await send()).statusCode,409);
  bound=true;const unavailable=await send();assert.equal(unavailable.statusCode,409);assert.equal(unavailable.json().message,"channel_email_provider_unavailable");
});
