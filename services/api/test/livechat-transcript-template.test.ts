import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerLivechatRoutes} from "../src/livechat.js";
import {registerLivechatPublicRoutes} from "../src/livechat-public.js";
import {queueLivechatTranscript} from "../src/livechat-transcript.js";
import {defaultTranscriptTemplate,renderTranscript,transcriptTemplateError,type TranscriptContext} from "../src/livechat-transcript-template.js";

const fixture=():TranscriptContext=>({visitor:{name:'John <Smith>',email:'john@example.com'},conversation:{id:'chat-1',startedAt:'2026-11-20T10:32:00.000Z',endedAt:'2026-11-20T10:36:00.000Z',duration:'00:04:00'},agent:{name:'Alex'},department:{name:'Sales'},channel:{name:'Belaro Precision',logo:'https://example.com/logo.png'},messages:[
  {direction:'in',sender:'John <Smith>',time:'10:32 AM',body:'<script>alert(1)</script>\n{{channel.name}}',attachments:['quote<&>.pdf','model.step']},
  {direction:'out',sender:'Alex',time:'10:33 AM',body:'Hello John',attachments:[]},
]});
test('模板渲染全部变量、消息顺序、附件数组及左右布局',()=>{
  const context=fixture();
  const rendered=renderTranscript({...defaultTranscriptTemplate,subject:'{{channel.name}} · {{visitor.name}}',body:'{{channel.logo}}\n{{visitor.name}} {{visitor.email}} {{conversation.id}} {{conversation.startedAt}} {{conversation.endedAt}} {{conversation.duration}} {{agent.name}} {{department.name}} {{channel.name}}\n{{messages}}',message:'{{message.time}} {{message.body}} {{message.attachments}}'},context);
  for(const text of ['john@example.com','chat-1','00:04:00','Sales','Alex','quote<&>.pdf','model.step','10:32 AM'])assert.ok(rendered.text.includes(text));
  assert.equal(rendered.subject,'Belaro Precision · John <Smith>');
  assert.match(rendered.html,/align="left"/);assert.match(rendered.html,/align="right"/);assert.match(rendered.html,/background:#e9f1f8/);
  assert.ok(rendered.html.indexOf('alert(1)')<rendered.html.indexOf('Hello John'));
  assert.match(rendered.html,/&lt;script&gt;/);assert.doesNotMatch(rendered.html,/<script>/);
  assert.match(rendered.html,/quote&lt;&amp;&gt;.pdf/);assert.match(rendered.html,/\{\{channel.name\}\}/,'不递归解释客户消息里的变量');
  assert.match(rendered.html,/<img src="https:\/\/example.com\/logo.png"/);
});
test('模板拒绝未知、错位、不完整变量、缺失历史与主题换行',()=>{
  assert.equal(transcriptTemplateError(defaultTranscriptTemplate),null);
  for(const change of [{subject:'{{unknown}}'},{subject:'{{messages}}'},{body:'{{message.body}} {{messages}}'},{body:'{{visitor.name'},{body:'没有历史'},{message:'{{message.time}}'},{subject:'subject\nBcc: other@example.com'},{body:'   '}])assert.ok(transcriptTemplateError({...defaultTranscriptTemplate,...change}));
  assert.equal(transcriptTemplateError({...defaultTranscriptTemplate,body:'{{ messages }}',message:'{{ message.body }}'}),null);
});
test('危险 Logo、HTML、邮件头注入、空数组与空字段安全降级',()=>{
  const context=fixture();context.visitor.name='John\r\nBcc: other@example.com';
  for(const logo of ['javascript:alert(1)','data:image/svg+xml,test','http://example.com/logo.png','https://user:pass@example.com/image','https://example.com/" onerror="alert(1)']){
    context.channel.logo=logo;
    const rendered=renderTranscript({...defaultTranscriptTemplate,subject:'{{visitor.name}}'},context);
    assert.doesNotMatch(rendered.subject,/[\r\n]/);assert.doesNotMatch(rendered.html,/<script| onerror="alert/);
    if(!logo.startsWith('https://example.com/'))assert.doesNotMatch(rendered.html,/<img/);
  }
  context.messages=[];context.channel.logo='';context.agent.name='';context.department.name='';
  assert.doesNotThrow(()=>renderTranscript(defaultTranscriptTemplate,context));
  assert.equal(renderTranscript({...defaultTranscriptTemplate,subject:'{{agent.name}}'},context).subject,defaultTranscriptTemplate.subject);
});

const accountId='11111111-1111-4111-8111-111111111111',conversationId='22222222-2222-4222-8222-222222222222';
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
test('渠道模板创建、读取、兼容旧更新、清除、权限及公开配置隔离',async t=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const template={...defaultTranscriptTemplate,departmentName:'销售部'};
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    if(sql.includes('INSERT INTO livechat_rate_limits'))return result([{hits:1}]);
    if(sql.includes('JOIN channel_accounts'))return result([{account_id:accountId,enabled:true,allowed_origins:['https://example.com'],transcript_template:template}]);
    return result([{id:accountId,account_id:accountId,public_id:conversationId}]);
  };
  t.mock.method(pool,'query',query);t.mock.method(pool,'connect',async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const headers={authorization:'Bearer '+signToken({sub:accountId,role:'admin'},config.JWT_SECRET,3600)},url='/api/v1/admin/livechat/channels';
  const payload={displayName:'渠道',allowedOrigins:['https://example.com']};
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,transcriptTemplate:template}})).statusCode,201);
  assert.equal(calls.find(c=>c.sql.startsWith('INSERT INTO livechat_channels'))?.values[11],JSON.stringify(template));
  assert.deepEqual((await app.inject({url,headers})).json().data[0].transcript_template,template);
  for(const value of [template,undefined,null]){
    assert.equal((await app.inject({method:'PUT',url:url+'/'+accountId,headers,payload:{...payload,...(value===undefined?{}:{transcriptTemplate:value})}})).statusCode,200);
    const update=calls.filter(c=>c.sql.startsWith('UPDATE livechat_channels')).at(-1)!;
    assert.equal(update.values[12],value!==undefined);assert.equal(update.values[13],value?JSON.stringify(value):null);
    assert.match(update.sql,/transcript_template=CASE WHEN \$13 THEN \$14::jsonb ELSE transcript_template END/);
  }
  for(const change of [{subject:'{{bad}}'},{body:'no history'},{message:'no content'},{subject:'x'.repeat(201)},{body:'x'.repeat(20001)},{message:'x'.repeat(5001)},{departmentName:'x'.repeat(101)}]){
    const count=calls.length;
    for(const method of ['POST','PUT'] as const)assert.equal((await app.inject({method,url:method==='POST'?url:url+'/'+accountId,headers,payload:{...payload,transcriptTemplate:{...template,...change}}})).statusCode,400);
    assert.equal(calls.length,count);
  }
  const before=calls.length;
  assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer '+signToken({sub:accountId,role:'agent'},config.JWT_SECRET,60)},payload:{...payload,transcriptTemplate:template}})).statusCode,403);
  assert.equal(calls.length,before);
  const publicConfig=await app.inject({url:'/livechat/'+conversationId+'/config',headers:{origin:'https://example.com'}});
  assert.equal(publicConfig.statusCode,200);assert.equal(publicConfig.json().transcript_template,undefined);assert.equal(publicConfig.json().transcriptTemplate,undefined);
  const migration=await readFile(new URL('../../../infra/postgres/migrations/115_livechat_transcript_template.sql',import.meta.url),'utf8');
  const migrator=await readFile(new URL('../src/migrate-agent.ts',import.meta.url),'utf8');
  assert.match(migration,/ADD COLUMN IF NOT EXISTS transcript_template jsonb/);assert.match(migrator,/115_livechat_transcript_template.sql/);
});
test('入队使用原渠道模板和认领客服，结束时间区分导出与结束动作',async()=>{
  const jobs:unknown[][]=[];
  let status='open';
  let startedAt:string|Date='2026-11-20T10:32:00Z';
  const query=async(sql:string,values:unknown[]=[])=>{
    if(sql.includes('JOIN email_provider_instances'))return result([{provider:'smtp',config:{fromEmail:'support@example.com'},secret_encrypted:'secret'}]);
    if(sql.includes('SELECT cv.created_at'))return result([{created_at:startedAt,closed_at:'2026-11-20T10:35:00Z',status,visitor_name:'John',agent_name:'Assigned Alex',channel_name:'Original channel',icon_url:'',snapshot_at:'2026-11-20T10:36:00Z',transcript_template:{...defaultTranscriptTemplate,subject:'{{channel.name}} {{agent.name}}',body:'{{department.name}} {{conversation.startedAt}} | {{conversation.endedAt}} | {{conversation.duration}}\n{{messages}}',departmentName:'Sales'}}]);
    if(sql.includes('FROM livechat_end_requests'))return result();
    if(sql.includes('FROM messages m'))return result([{direction:'out',sender_name:'Actual Sam',text_content:'Reply',occurred_at:'2026-11-20T10:33:00Z'}]);
    if(sql.startsWith('INSERT INTO email_messages')){jobs.push(values);return result([{id:accountId,status:'queued'}]);}
    return result([{id:accountId}]);
  };
  const client={query} as unknown as Parameters<typeof queueLivechatTranscript>[0];
  const row={account_id:accountId,conversation_id:conversationId,contact_id:conversationId,recipient_email:'john@example.com'};
  await queueLivechatTranscript(client,row,accountId,conversationId);
  assert.equal(jobs[0][7],'Original channel Assigned Alex');assert.match(String(jobs[0][8]),/Sales.*10:32:00.000Z \|  \| 00:04:00/);assert.match(String(jobs[0][8]),/Actual Sam/);
  await queueLivechatTranscript(client,row,accountId,null,true);
  assert.match(String(jobs[1][8]),/10:36:00.000Z \| 00:04:00/);
  status='closed';await queueLivechatTranscript(client,row,accountId);
  assert.match(String(jobs[2][8]),/10:35:00.000Z \| 00:03:00/);
  startedAt=new Date('2026-11-20T10:32:00.123Z');
  await queueLivechatTranscript(client,row,accountId);
  assert.match(String(jobs[3][8]),/10:32:00.123Z/);
});
