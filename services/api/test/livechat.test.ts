import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerLivechatRoutes,processOneLivechatOutbound} from "../src/livechat.js";
import {registerLivechatPublicRoutes,livechatCorsOrigin,livechatCredential,livechatOrigin,allowedLivechatFile} from "../src/livechat-public.js";
import {queueChannelCommand} from "../src/whatsapp-outbound.js";

const channelId="11111111-1111-4111-8111-111111111111",accountId="22222222-2222-4222-8222-222222222222",contactId="33333333-3333-4333-8333-333333333333",messageId="44444444-4444-4444-8444-444444444444";
const origin="https://shop.example.com",authorization=`Bearer ${"a".repeat(64)}`;
const row={account_id:accountId,allowed_origins:[origin],display_name:"客服",enabled:true,language:"en"};
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

test("LiveChat 凭证与来源必须精确匹配",()=>{
  assert.equal(livechatCredential(authorization).length,64);
  for(const header of [undefined,"Bearer public-channel-id",`Bearer ${"A".repeat(64)}`,"Basic abc"])assert.throws(()=>livechatCredential(header));
  assert.equal(livechatOrigin(origin,[origin]),origin);
  for(const value of [undefined,"null","https://shop.example.com.evil.test","http://shop.example.com"])assert.throws(()=>livechatOrigin(value,[origin]));
});

test("LiveChat 附件限制验证文件签名而非只信任 MIME",()=>{
  assert.equal(allowedLivechatFile("image/png",Buffer.from([137,80,78,71,13,10,26,10])),true);
  assert.equal(allowedLivechatFile("application/pdf",Buffer.from("%PDF-1.7")),true);
  assert.equal(allowedLivechatFile("text/plain",Buffer.from("文字")),true);
  for(const mime of ["image/png","image/jpeg","image/webp","application/pdf","text/html","image/svg+xml","audio/ogg"])assert.equal(allowedLivechatFile(mime,Buffer.from("<script>alert(1)</script>")),false);
  assert.equal(allowedLivechatFile("text/plain",Buffer.from([0,1])),false);
});

test("LiveChat 公开接口安全边界",async t=>{
  let enabled=true,hits=1,visitorFound=true;
  let language:string|undefined=row.language,iconUrl="";
  const attachment=false;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  t.mock.method(pool,"query",async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("INSERT INTO livechat_rate_limits"))return result([{hits}]);
    if(sql.startsWith("SELECT 1 FROM livechat_channels"))return result(enabled&&values[1]===origin?[{}]:[]);
    if(sql.includes("FROM livechat_channels"))return result(enabled?[{...row,language,icon_url:iconUrl}]:[]);
    if(sql.includes("FROM livechat_visitors"))return result(visitorFound?[{id:contactId,contact_id:contactId}]:[]);
    if(sql.startsWith("WITH visible"))return result([]);
    if(sql.startsWith("SELECT md.*"))return result(attachment?[{}]:[]);
    throw Error(`未预期 SQL: ${sql}`);
  });
  const app=Fastify();await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const get=(suffix:string,headers:Record<string,string>={origin,authorization})=>app.inject({url:`/livechat/${channelId}/${suffix}`,headers});
  await t.test("配置和 iframe 仅暴露公开信息",async()=>{
    const response=await get("config");assert.equal(response.statusCode,200);assert.equal(response.json().name,"客服");assert.equal(response.json().language,"en");assert.equal(response.json().account_id,undefined);
    const frame=await get("widget");assert.match(String(frame.headers["content-security-policy"]),/frame-ancestors https:\/\/shop.example.com;/);assert.equal(frame.headers["x-frame-options"],undefined);
    assert.equal(response.json().iconUrl,"");
    iconUrl="https://cdn.example.com/brand.png";
    assert.equal((await get("config")).json().iconUrl,iconUrl);
    assert.match(String(frame.headers["content-security-policy"]),/img-src blob: https:;/);
  });
  await t.test("未配置语言默认英语，明确选择中文时保持中文",async()=>{
    try{
      language=undefined;assert.equal((await get("config")).json().language,"en");
      language="zh-CN";assert.equal((await get("config")).json().language,"zh-CN");
    }finally{language=row.language;}
  });
  await t.test("拒绝非法来源与缺失凭证",async()=>{
    assert.equal((await get("messages",{origin:"https://evil.test",authorization})).statusCode,403);
    assert.equal((await get("messages",{origin})).statusCode,401);
    assert.equal((await get("messages",{authorization})).statusCode,403);
  });
  await t.test("同源 GET 仅允许浏览器同源 Referer",async()=>{
    assert.equal((await get("messages",{authorization,referer:`${origin}/page`,"sec-fetch-site":"same-origin"})).statusCode,200);
    assert.equal((await get("messages",{authorization,referer:`${origin}/page`,"sec-fetch-site":"cross-site"})).statusCode,403);
  });
  await t.test("历史查询按渠道联系人隔离并采用发送时间游标",async()=>{
    assert.equal((await get(`messages?after=${messageId}`)).statusCode,200);
    const query=calls.filter(c=>c.sql.startsWith("WITH visible")).at(-1)!;
    assert.deepEqual(query.values,[accountId,contactId,messageId]);assert.match(query.sql,/receipt.status='sent'/);assert.match(query.sql,/visible_at,id\) >/);
    assert.match(query.sql,/SS.US/);assert.match(query.sql,/sort_at/);
    assert.match(query.sql,/NOT EXISTS\(SELECT 1 FROM message_email_details/);
    assert.doesNotMatch(query.sql,/m\.kind\s*<>\s*'email'/);
    assert.equal((await get(`messages?before=${messageId}&after=${messageId}`)).statusCode,400);
  });
  await t.test("不存在、跨渠道或过期访客无法读取历史",async()=>{
    visitorFound=false;assert.equal((await get("messages")).statusCode,401);visitorFound=true;
    const query=calls.filter(c=>c.sql.includes("FROM livechat_visitors")).at(-1)!;
    assert.match(query.sql,/account_id=\$1 AND credential_hash=\$2 AND embed_origin=\$3 AND expires_at>now\(\)/);assert.equal(query.values[2],origin);
  });
  await t.test("附件读取要求消息引用授权",async()=>{
    assert.equal((await get(`media/${messageId}`)).statusCode,404);
    const query=calls.find(c=>c.sql.startsWith("SELECT md.*"))!;
    assert.deepEqual(query.values,[messageId,accountId,contactId]);assert.match(query.sql,/cv.account_id=\$2 AND cv.contact_id=\$3/);
  });
  await t.test("停用渠道、限流和 CORS 白名单",async()=>{
    assert.equal(await livechatCorsOrigin(`/livechat/${channelId}/messages`,origin),true);
    assert.equal(await livechatCorsOrigin(`/livechat/${channelId}/messages`,"https://evil.test"),false);
    hits=601;assert.equal((await get("config")).statusCode,429);hits=1;
    enabled=false;assert.equal((await get("messages")).statusCode,404);assert.equal((await get("widget")).statusCode,404);
    assert.equal(await livechatCorsOrigin(`/livechat/${channelId}/messages`,origin),false);
  });
});

test("LiveChat 结束会话正确入队邮件、完整记录和事务内去重",async t=>{
  let providerConfigured=true,active=true,existing:Record<string,unknown>|undefined,requestExisting:Record<string,unknown>|undefined;
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    assert.doesNotMatch(sql,/m\.kind\s*<>\s*'email'|'out','email'/);
    if(sql.includes("INSERT INTO livechat_rate_limits"))return result([{hits:1}]);
    if(sql.includes("JOIN channel_accounts"))return result([row]);
    if(sql.includes("FROM livechat_visitors"))return result([{id:channelId,contact_id:contactId}]);
    if(sql.includes("FROM livechat_channels")&&sql.includes("FOR SHARE"))return result(active?[{}]:[]);
    if(sql.includes("FROM livechat_end_requests r"))return result(requestExisting&&values[0]===channelId?[requestExisting]:[]);
    if(sql.includes("FROM email_messages e"))return result(existing?[existing]:[]);
    if(sql.includes("SELECT cv.id conversation_id"))return result([{conversation_id:contactId,account_id:accountId,contact_id:contactId,recipient_email:"sam@example.com"}]);
    if(sql.includes("FROM email_provider_settings"))return result(providerConfigured?[{provider:"smtp",config:{fromEmail:"support@example.com"},secret_encrypted:"encrypted"}]:[]);
    if(sql.includes("FROM messages m"))return result([{direction:"in",text_content:"<script>"+"x".repeat(6000),file_name:"quote.pdf",occurred_at:new Date("2026-11-15T00:00:00Z")}]);
    if(sql.startsWith("INSERT INTO email_messages"))return result([{id:messageId,status:"queued"}]);
    if(sql.startsWith("INSERT INTO messages"))return result([{id:channelId}]);
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const end=(sendTranscript=true,clientRequestId=messageId)=>app.inject({method:"POST",url:`/livechat/${channelId}/end-chat`,headers:{origin,authorization},payload:{clientRequestId,sendTranscript}});
  providerConfigured=false;calls.length=0;
  const closeOnly=await end(false,channelId);assert.equal(closeOnly.statusCode,202,closeOnly.body);assert.equal(closeOnly.json().queued,false);assert.equal(closeOnly.json().closed,true);
  assert.ok(calls.some(c=>c.sql.startsWith("INSERT INTO livechat_end_requests")&&c.sql.includes("false")));
  assert.ok(!calls.some(c=>c.sql.includes("FROM email_provider_settings")||c.sql.startsWith("INSERT INTO email_messages")));
  assert.match(String(calls.find(c=>c.sql.startsWith("INSERT INTO audit_log"))?.values[1]),/"sendTranscript":false/);
  requestExisting={visitor_id:channelId,account_id:accountId,contact_id:contactId,send_transcript:false,email_id:null,status:null};
  assert.equal((await end(false,channelId)).json().deduplicated,true);
  assert.equal((await end(true,channelId)).statusCode,409);
  requestExisting=undefined;
  calls.length=0;
  providerConfigured=false;
  assert.equal((await end()).json().message,"email_provider_not_configured");
  assert.ok(!calls.some(c=>c.sql.startsWith("UPDATE conversations")));assert.equal(calls.at(-1)?.sql,"ROLLBACK");
  providerConfigured=true;calls.length=0;
  const response=await end();assert.equal(response.statusCode,202,response.body);assert.equal(response.json().queued,true);
  const transcript=calls.find(c=>c.sql.includes("FROM messages m"))!;
  assert.match(transcript.sql,/NOT EXISTS\(SELECT 1 FROM message_email_details/);
  assert.match(transcript.sql,/m.status IN \('sent','delivered','read'\)/);
  const job=calls.find(c=>c.sql.startsWith("INSERT INTO email_messages"))!;
  assert.ok(String(job.values[8]).length>6000);assert.match(String(job.values[8]),/\[Attachment: quote.pdf\]/);
  assert.match(String(job.values[9]),/&lt;script&gt;/);assert.doesNotMatch(String(job.values[9]),/<script>/);
  assert.match(job.sql,/\$8,'',\$9,\$10/);
  assert.ok(calls.some(c=>c.sql.startsWith("INSERT INTO livechat_end_requests")&&c.sql.includes("true")));
  assert.deepEqual(calls.find(c=>c.sql.startsWith("INSERT INTO message_email_details"))?.values,[channelId,"Your LiveChat transcript","support@example.com",'["sam@example.com"]',`<email-${messageId}@relaydesk.local>`,messageId]);
  assert.ok(calls.some(c=>c.sql.includes("SET status='closed'")));assert.equal(calls.at(-1)?.sql,"COMMIT");
  existing={id:messageId,status:"queued",account_id:accountId,contact_id:contactId,content_type:"livechat_transcript"};calls.length=0;
  assert.equal((await end(false)).statusCode,409);
  const duplicate=await end();assert.equal(duplicate.statusCode,202);assert.equal(duplicate.json().deduplicated,true);
  assert.ok(!calls.some(c=>c.sql.startsWith("INSERT INTO email_messages")));
  existing={...existing,contact_id:accountId};assert.equal((await end()).statusCode,409);
  existing={...existing,contact_id:contactId,account_id:contactId};assert.equal((await end()).statusCode,409);
  existing=undefined;active=false;assert.equal((await end()).statusCode,404);
});

test("LiveChat 结束请求迁移已加入启动序列并约束 transcript 邮件",async()=>{
  const [migration,migrator]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/101_livechat_end_requests.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/request_id uuid PRIMARY KEY/);
  assert.match(migration,/send_transcript boolean NOT NULL/);
  assert.match(migration,/CHECK \(NOT send_transcript OR email_id IS NOT NULL\)/);
  assert.match(migration,/email_id uuid REFERENCES email_messages\(id\) ON DELETE RESTRICT/);
  assert.match(migrator,/101_livechat_end_requests\.sql/);
});

test("LiveChat 入站幂等、跨渠道凭证和事务保护",async t=>{
  let visitorAccount=accountId,duplicateText="hello",active=true;
  const calls:string[]=[];
  const query=async(sql:string)=>{
    calls.push(sql);
    if(sql.includes("INSERT INTO livechat_rate_limits"))return result([{hits:1}]);
    if(sql.includes("JOIN channel_accounts"))return result([row]);
    if(sql.includes("FOR SHARE"))return result(active?[{}]:[]);
    if(sql.includes("FROM livechat_visitors"))return result([{account_id:visitorAccount,contact_id:contactId,embed_origin:origin,expires_at:new Date(Date.now()+86400000)}]);
    if(sql.includes("FROM messages"))return result([{id:messageId,direction:"in",sender_contact_id:contactId,text_content:duplicateText,media_id:null}]);
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const send=()=>app.inject({method:"POST",url:`/livechat/${channelId}/messages`,headers:{origin,authorization},payload:{clientMessageId:messageId,text:"hello"}});
  assert.equal((await send()).statusCode,201);assert.ok(!calls.some(sql=>sql.startsWith("INSERT INTO messages")));assert.ok(calls.includes("COMMIT"));
  duplicateText="different";assert.equal((await send()).statusCode,409);assert.equal(calls.at(-1),"ROLLBACK");
  visitorAccount=contactId;assert.equal((await send()).statusCode,401);
  active=false;assert.equal((await send()).statusCode,404);
  assert.ok(calls.some(sql=>sql.includes("pg_advisory_xact_lock")));
});

test("LiveChat 出站无 24 小时限制，但拒绝专属消息及不支持附件",async()=>{
  let enabled=true,mime="application/pdf",size=1024;
  const query=async(sql:string)=>{
    if(sql.includes("FROM channel_accounts"))return result([{platform:"livechat",transport:"cloud",agent_id:null,service_window_expires_at:null}]);
    if(sql.includes("FROM media"))return result([{mime_type:mime,byte_size:size}]);
    if(sql.includes("FROM livechat_channels"))return result(enabled?[{}]:[]);
    if(sql.includes("INSERT INTO outbound_commands"))return result([{id:messageId,sequence:1}]);
    throw Error(sql);
  };
  const client={query} as never;
  const send=(type:string)=>queueChannelCommand(client,{accountId,conversationId:contactId,messageId,payload:{accountId,conversationId:contactId,messageId,clientMessageId:messageId,type,text:"hello",mediaId:messageId}});
  assert.equal((await send("text")).platform,"livechat");await send("document");
  for(const type of ["template","audio","video","sticker"])await assert.rejects(()=>send(type),/livechat_message_type_unsupported/);
  mime="text/html";await assert.rejects(()=>send("document"),/livechat_attachment_unsupported/);
  mime="application/pdf";size=10485761;await assert.rejects(()=>send("document"),/livechat_attachment_unsupported/);
  enabled=false;await assert.rejects(()=>send("text"),/livechat_channel_disabled/);
});

test("LiveChat 管理接口需要管理员，归档保留历史并记录审计",async t=>{
  const calls:string[]=[];
  const query=async(sql:string)=>{calls.push(sql);return result(sql.startsWith("UPDATE livechat_channels")?[{account_id:accountId}]:[]);};
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const url=`/api/v1/admin/livechat/channels/${accountId}`;
  assert.equal((await app.inject({method:"DELETE",url})).statusCode,401);
  const token=(role:string)=>`Bearer ${signToken({sub:contactId,role},config.JWT_SECRET,60)}`;
  assert.equal((await app.inject({method:"DELETE",url,headers:{authorization:token("agent")}})).statusCode,403);
  const response=await app.inject({method:"DELETE",url,headers:{authorization:token("admin")}});
  assert.equal(response.statusCode,200);assert.equal(response.json().historyPreserved,true);
  assert.ok(calls.some(sql=>sql.includes("archived_at=now()")));assert.ok(calls.some(sql=>sql.includes("livechat.archive")));assert.ok(!calls.some(sql=>sql.startsWith("DELETE")));
});

test("LiveChat Worker 将停用渠道待发消息标为失败",async t=>{
  const calls:string[]=[];
  const query=async(sql:string)=>{calls.push(sql);return result(sql.includes("FROM outbound_commands")?[{id:messageId,message_id:messageId,enabled:false}]:[]);};
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  assert.equal(await processOneLivechatOutbound(),true);assert.ok(calls.some(sql=>sql.includes("SET status='failed'")));assert.equal(calls.at(-1),"COMMIT");
});

test("LiveChat 首次匿名消息创建独立客户并进入统一 Agent 流程",async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  let existingVisitor=false;
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes("INSERT INTO livechat_rate_limits"))return result([{hits:1}]);
    if(sql.includes("JOIN channel_accounts"))return result([row]);
    if(sql.includes("FROM livechat_channels")&&sql.includes("FOR SHARE"))return result([{}]);
    if(sql.startsWith("SELECT * FROM livechat_visitors"))return result(existingVisitor?[{id:channelId,account_id:accountId,contact_id:contactId,embed_origin:origin,expires_at:new Date(Date.now()+86400000)}]:[]);
    if(sql.startsWith("INSERT INTO contacts"))return result([{id:contactId}]);
    if(sql.startsWith("INSERT INTO livechat_visitors"))return result([{id:channelId,contact_id:contactId}]);
    if(sql.startsWith("INSERT INTO conversations"))return result([{id:contactId}]);
    if(sql.startsWith("INSERT INTO messages"))return result([{id:messageId}]);
    if(sql.startsWith("INSERT INTO webhook_events"))return result([{id:messageId}]);
    return result();
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const payload={clientMessageId:messageId,text:"我想咨询产品",name:"Sam",email:"sam@example.com",company:"Example Ltd",whatsapp:"+12025550123",context:{browserLanguage:"en-US",timeZone:"Asia/Shanghai",pageUrl:`${origin}/products?secret=123#private`},ip:"203.0.113.99"};
  for(const invalid of [
    {...payload,name:undefined},{...payload,name:"   "},{...payload,email:undefined},
    {...payload,email:"invalid"},{...payload,text:" "},{...payload,context:{timeZone:"Invalid/Zone"}},
    {...payload,context:{browserLanguage:"x".repeat(81)}},{...payload,mediaId:messageId},
  ]){
    const rejected=await app.inject({method:"POST",url:`/livechat/${channelId}/messages`,headers:{origin,authorization},payload:invalid});
    assert.equal(rejected.statusCode,400,rejected.body);
  }
  assert.equal(calls.some(call=>call.sql.startsWith("INSERT INTO contacts")),false);
  const response=await app.inject({method:"POST",url:`/livechat/${channelId}/messages`,headers:{origin,authorization,"user-agent":"Test Browser","x-forwarded-for":"203.0.113.88"},payload});
  assert.equal(response.statusCode,201,response.body);
  assert.equal(response.json().id,messageId);
  const contact=calls.find(call=>call.sql.startsWith("INSERT INTO contacts"))!;
  assert.equal(contact.values[0],accountId);assert.equal(contact.values[2],"Sam");assert.equal(contact.values[3],"Example Ltd");
  const visitor=calls.find(call=>call.sql.startsWith("INSERT INTO livechat_visitors"))!;
  assert.equal(visitor.values[3],origin);assert.equal(visitor.values[2],livechatCredential(authorization));
  assert.equal(visitor.values[4],"127.0.0.1");
  const context=calls.find(call=>call.sql.startsWith("UPDATE livechat_visitors"))!;
  assert.equal(context.values[1],"127.0.0.1");
  assert.deepEqual(JSON.parse(String(context.values[2])),{userAgent:"Test Browser",browserLanguage:"en-US",timeZone:"Asia/Shanghai",pageUrl:`${origin}/products`});
  assert.deepEqual(calls.find(call=>call.sql.startsWith("INSERT INTO contact_emails"))?.values,[contactId,"sam@example.com"]);
  assert.deepEqual(calls.find(call=>call.sql.startsWith("INSERT INTO contact_methods"))?.values,[contactId,"+12025550123"]);
  assert.ok(calls.some(call=>call.sql.includes("status='open',closed_at=NULL")));
  assert.ok(calls.some(call=>call.sql.startsWith("INSERT INTO agent_jobs")&&call.sql.includes("account_agent_settings")));
  assert.equal(calls.at(-1)?.sql,"COMMIT");
  existingVisitor=true;
  const followup=await app.inject({method:"POST",url:`/livechat/${channelId}/messages`,headers:{origin,authorization},payload:{clientMessageId:channelId,text:"继续咨询",name:"Do not overwrite",email:"different@example.com",whatsapp:"other",context:{pageUrl:"https://evil.test/path?secret=1"}}});
  assert.equal(followup.statusCode,201,followup.body);
  assert.equal(calls.filter(call=>call.sql.startsWith("INSERT INTO contacts")).length,1);
  assert.equal(calls.filter(call=>call.sql.startsWith("INSERT INTO contact_emails")).length,1);
  assert.equal(calls.filter(call=>call.sql.startsWith("INSERT INTO contact_methods")).length,1);
  assert.ok(!calls.some(call=>call.sql.startsWith("UPDATE contacts")));
  assert.equal(JSON.parse(String(calls.filter(call=>call.sql.startsWith("UPDATE livechat_visitors")).at(-1)!.values[2])).pageUrl,undefined);
});

test("LiveChat 多渠道创建分别保存账号与嵌入配置",async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];let count=0;
  const ids=[accountId,contactId],publicIds=[channelId,messageId];
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.startsWith("INSERT INTO channel_accounts"))return result([{id:ids[count]}]);
    if(sql.startsWith("INSERT INTO livechat_channels"))return result([{public_id:publicIds[count++]}]);
    return result();
  };
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const headers={authorization:`Bearer ${signToken({sub:contactId,role:"admin"},config.JWT_SECRET,60)}`};
  for(let i=0;i<2;i++){
    const response=await app.inject({method:"POST",url:"/api/v1/admin/livechat/channels",headers,payload:{displayName:`客服 ${i}`,welcomeMessage:`欢迎 ${i}`,themeColor:i?"#aa3344":"#146d73",position:i?"left":"right",...(i?{language:"zh-CN"}:{}),allowedOrigins:[i?"https://other.example.com":origin]}});
    assert.equal(response.statusCode,201,response.body);assert.equal(response.json().id,ids[i]);assert.equal(response.json().publicId,publicIds[i]);
  }
  const inserts=calls.filter(call=>call.sql.startsWith("INSERT INTO livechat_channels"));
  assert.equal(inserts[0].values[0],accountId);assert.equal(inserts[1].values[0],contactId);
  assert.deepEqual(inserts[0].values[4],[origin]);assert.deepEqual(inserts[1].values[4],["https://other.example.com"]);
  assert.equal(inserts[0].values[6],"en");assert.equal(inserts[1].values[6],"zh-CN");
  assert.equal(calls.filter(call=>call.sql.includes("livechat.create")).length,2);
});

test("LiveChat 编辑渠道保存语言并拒绝不支持的语言",async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return result(sql.startsWith("UPDATE livechat_channels")?[{account_id:accountId}]:[]);};
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const headers={authorization:`Bearer ${signToken({sub:contactId,role:"admin"},config.JWT_SECRET,60)}`};
  const url=`/api/v1/admin/livechat/channels/${accountId}`;
  const payload={displayName:"客服",allowedOrigins:[origin],language:"ja"};
  assert.equal((await app.inject({method:"PUT",url,headers,payload})).statusCode,200);
  const update=calls.find(call=>call.sql.startsWith("UPDATE livechat_channels"))!;
  assert.equal(update.values[6],"ja");assert.match(update.sql,/language=\$7/);
  assert.equal(update.values[7],null);
  const count=calls.length;
  assert.equal((await app.inject({method:"PUT",url,headers,payload:{...payload,language:"invalid"}})).statusCode,400);
  assert.equal(calls.length,count);
});

test("LiveChat 图标创建、更新、清除和 URL 校验",async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return result([{id:accountId,account_id:accountId,public_id:channelId}]);};
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);t.after(()=>app.close());
  const headers={authorization:`Bearer ${signToken({sub:contactId,role:"admin"},config.JWT_SECRET,60)}`};
  const base="/api/v1/admin/livechat/channels",payload={displayName:"BelaroPrecision",allowedOrigins:[origin]},iconUrl="https://cdn.example.com/brand.png";
  assert.equal((await app.inject({method:"POST",url:base,headers,payload:{...payload,iconUrl}})).statusCode,201);
  assert.equal(calls.find(c=>c.sql.startsWith("INSERT INTO livechat_channels"))!.values[7],iconUrl);
  for(const value of [iconUrl,""]){
    assert.equal((await app.inject({method:"PUT",url:`${base}/${accountId}`,headers,payload:{...payload,iconUrl:value}})).statusCode,200);
    assert.equal(calls.filter(c=>c.sql.startsWith("UPDATE livechat_channels")).at(-1)!.values[7],value);
  }
  for(const value of ["javascript:alert(1)","data:image/png;base64,AA==","http://example.com/a.png","https://user:password@example.com/a.png","/logo.png","not a url"]){
    const count=calls.length;
    for(const method of ["POST","PUT"] as const)assert.equal((await app.inject({method,url:method==="POST"?base:`${base}/${accountId}`,headers,payload:{...payload,iconUrl:value}})).statusCode,400);
    assert.equal(calls.length,count);
  }
});

test("LiveChat Worker 发布出站消息并记录发送回执",async t=>{
  const calls:string[]=[];
  const query=async(sql:string)=>{
    calls.push(sql);
    if(sql.includes("FROM outbound_commands"))return result([{id:channelId,message_id:messageId,account_id:accountId,enabled:true}]);
    if(sql.startsWith("UPDATE messages"))return result([{conversation_id:contactId,provider_message_id:messageId}]);
    if(sql.startsWith("INSERT INTO webhook_events"))return result([{id:messageId}]);
    return result();
  };
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  assert.equal(await processOneLivechatOutbound(),true);
  assert.ok(calls.some(sql=>sql.includes("SET state='completed'")));
  assert.ok(calls.some(sql=>sql.startsWith("INSERT INTO message_receipts")));
  assert.ok(calls.some(sql=>sql.startsWith("INSERT INTO webhook_events")));
  assert.equal(calls.at(-1),"COMMIT");
});
