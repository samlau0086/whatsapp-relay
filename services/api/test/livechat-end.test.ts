import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerLivechatRoutes} from "../src/livechat.js";

const rootId="11111111-1111-4111-8111-111111111111",targetId="22222222-2222-4222-8222-222222222222",accountId="33333333-3333-4333-8333-333333333333",userId="44444444-4444-4444-8444-444444444444",requestId="55555555-5555-4555-8555-555555555555";
test("后台结束会话：权限、成员隔离、分隔符、重试及回滚",async t=>{
  let found=true,permission=true,closed=false,failMarker=false,existing:Record<string,unknown>|undefined;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("FROM conversations root"))return result(found?[{conversation_id:targetId,account_id:accountId,contact_id:targetId,visitor_id:userId,status:closed?'closed':'open'}]:[]);
    if(sql.includes("FROM account_permissions"))return result(permission?[{account_id:accountId}]:[]);
    if(sql.startsWith("SELECT conversation_id,account_id,send_transcript"))return result(existing?[existing]:[]);
    if(sql.startsWith("INSERT INTO messages")&&failMarker)throw Error("marker_failed");
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const send=(role="admin",payload:unknown={clientRequestId:requestId,targetConversationId:targetId})=>app.inject({method:"POST",url:`/api/v1/conversations/${rootId}/end-chat`,headers:{authorization:`Bearer ${signToken({sub:userId,role},config.JWT_SECRET,3600)}`},payload});
  assert.equal((await app.inject({method:"POST",url:`/api/v1/conversations/${rootId}/end-chat`,payload:{}})).statusCode,401);
  assert.equal((await send("admin",{clientRequestId:"bad"})).statusCode,400);
  assert.equal(calls.length,0);
  const response=await send();assert.equal(response.statusCode,200,response.body);
  const context=calls.find(c=>c.sql.includes("FROM conversations root"))!;
  assert.deepEqual(context.values,[rootId,targetId]);assert.match(context.sql,/relay_conversation_members\(root.id\)/);assert.match(context.sql,/FOR UPDATE OF cv/);assert.match(context.sql,/cv.origin_mode='livechat'/);
  assert.deepEqual(calls.find(c=>c.sql.startsWith("UPDATE conversations"))?.values,[targetId]);
  assert.deepEqual(calls.find(c=>c.sql.startsWith("INSERT INTO livechat_end_requests"))?.values,[requestId,userId,targetId,accountId,targetId]);
  assert.match(calls.find(c=>c.sql.startsWith("INSERT INTO messages"))!.sql,/-------Chat Ended-------/);
  assert.ok(!calls.some(c=>c.sql.includes("email_messages")));
  assert.ok(calls.some(c=>c.sql.includes("livechat.end_chat")));assert.equal(calls.at(-1)?.sql,"COMMIT");
  existing={conversation_id:targetId,account_id:accountId,send_transcript:false};calls.length=0;
  assert.equal((await send()).json().deduplicated,true);assert.ok(!calls.some(c=>/^(INSERT|UPDATE)/.test(c.sql)));
  // 即使访客已经重开，旧请求重试也不能再次结束新段。
  existing.conversation_id=rootId;assert.equal((await send()).statusCode,409);existing=undefined;
  closed=true;calls.length=0;assert.equal((await send()).json().alreadyEnded,true);assert.ok(!calls.some(c=>/^(INSERT|UPDATE)/.test(c.sql)));closed=false;
  found=false;assert.equal((await send()).statusCode,404);found=true;
  permission=false;assert.equal((await send("agent")).statusCode,404);
  permission=true;assert.equal((await send("agent")).statusCode,200);
  failMarker=true;calls.length=0;assert.equal((await send()).statusCode,500);assert.equal(calls.at(-1)?.sql,"ROLLBACK");
});
