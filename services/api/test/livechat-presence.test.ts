import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {registerLivechatPublicRoutes} from "../src/livechat-public.js";
import {registerLivechatRoutes} from "../src/livechat.js";

const channelId="11111111-1111-4111-8111-111111111111",accountId="22222222-2222-4222-8222-222222222222",contactId="33333333-3333-4333-8333-333333333333";
const origin="https://shop.example.com",authorization=`Bearer ${"a".repeat(64)}`;
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

test("访客心跳校验来源、身份和页面，仅更新独立状态表",async t=>{
  let enabled=true,visitorFound=true,hits=1;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  t.mock.method(pool,"query",async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("INSERT INTO livechat_rate_limits"))return result([{hits}]);
    if(sql.includes("FROM livechat_channels"))return result(enabled?[{account_id:accountId,enabled:true,allowed_origins:[origin]}]:[]);
    if(sql.includes("FROM livechat_visitors"))return result(visitorFound?[{id:contactId,contact_id:contactId}]:[]);
    if(sql.startsWith("INSERT INTO livechat_presence")||sql.startsWith("DELETE FROM livechat_presence"))return result();
    throw Error(`未预期 SQL: ${sql}`);
  });
  const app=Fastify();await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const payload={sessionId:channelId,sequence:1,visible:true,connected:true,pageUrl:origin+"/products?secret=1#private"};
  const send=(data:Record<string,unknown>=payload,headers:Record<string,string>={origin,authorization})=>app.inject({method:"POST",url:`/livechat/${channelId}/presence`,headers,payload:data});
  const response=await send();assert.equal(response.statusCode,200,response.body);assert.equal(response.headers["cache-control"],"no-store");
  const write=calls.find(c=>c.sql.startsWith("INSERT INTO livechat_presence"))!;
  assert.deepEqual(write.values,[contactId,channelId,1,true,true,origin+"/products"]);
  assert.match(write.sql,/ON CONFLICT\(visitor_id,session_id\)/);
  assert.match(write.sql,/WHERE livechat_presence.sequence<EXCLUDED.sequence/);
  assert.ok(!calls.some(c=>/UPDATE livechat_visitors|INSERT INTO messages/.test(c.sql)));
  assert.equal((await send({...payload,sessionId:accountId,sequence:2,connected:false})).statusCode,200);
  assert.equal((await send({...payload,pageUrl:"https://evil.test/products"})).statusCode,400);
  assert.equal((await send({...payload,pageUrl:"https://user:password@shop.example.com/products"})).statusCode,400);
  assert.equal((await send({...payload,sequence:-1})).statusCode,400);
  assert.equal((await send({...payload,visible:"yes"})).statusCode,400);
  assert.equal((await send(payload,{origin})).statusCode,401);
  assert.equal((await send(payload,{origin:"https://evil.test",authorization})).statusCode,403);
  visitorFound=false;assert.equal((await send()).statusCode,401);visitorFound=true;
  const identity=calls.filter(c=>c.sql.includes("FROM livechat_visitors")).at(-1)!;
  assert.match(identity.sql,/credential_hash=\$2 AND embed_origin=\$3 AND expires_at>now\(\)/);
  assert.deepEqual([identity.values[0],identity.values[2]],[accountId,origin]);
  hits=601;assert.equal((await send()).statusCode,429);hits=1;
  enabled=false;assert.equal((await send()).statusCode,404);
});

test("工作台批量读取状态受认证和账号范围约束，过期心跳不作为在线",async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  t.mock.method(pool,"query",async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("FROM api_keys"))return result([{id:channelId,scopes:["*"],account_ids:[accountId]}]);
    if(sql.startsWith("UPDATE api_keys"))return result();
    if(sql.startsWith("SELECT v.contact_id"))return result([{contactId,status:"online",pageUrl:origin+"/current"}]);
    throw Error(`未预期 SQL: ${sql}`);
  });
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const send=(headers:Record<string,string>={},contactIds:unknown=[contactId])=>app.inject({method:"POST",url:"/api/v1/livechat/presence/query",headers,payload:{contactIds}});
  assert.equal((await send()).statusCode,401);
  const headers={authorization:"Bearer rdk_presence_test"};
  assert.equal((await send(headers,["invalid"])).statusCode,400);
  assert.equal((await send(headers,Array(501).fill(contactId))).statusCode,400);
  const response=await send(headers);assert.equal(response.statusCode,200,response.body);assert.equal(response.headers["cache-control"],"no-store");
  assert.deepEqual(response.json(),{data:[{contactId,status:"online",pageUrl:origin+"/current"}]});
  const query=calls.find(c=>c.sql.startsWith("SELECT v.contact_id"))!;
  assert.deepEqual(query.values,[[contactId],[accountId]]);
  assert.match(query.sql,/connected AND updated_at>now\(\)-interval '45 seconds'/);
  assert.match(query.sql,/ORDER BY visible DESC,updated_at DESC/);
  assert.match(query.sql,/v.expires_at>now\(\) AND channel.enabled AND channel.archived_at IS NULL/);
  assert.match(query.sql,/CASE WHEN p.visible THEN p.page_url ELSE NULL END/);
  assert.match(query.sql,/v.account_id=ANY\(\$2::uuid\[\]\)/);
});
