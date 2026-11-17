import assert from "node:assert/strict";
import test from "node:test";
import type {PoolClient} from "pg";
import {mergeConversationTimelines,timelineMergeSchema,validateTimelineMerge,type TimelineIdentity} from "../src/timeline-merge.js";

const ids=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"];
const rows:TimelineIdentity[]=ids.map(id=>({id,account_id:"channel",entity_type:"person",mode:"livechat"}));
function fakeClient(options:{rows?:TimelineIdentity[];members?:TimelineIdentity[];nested?:boolean;legacy?:boolean;role?:string}={}){
  const statements:Array<{sql:string;params:unknown[]}>=[];
  const client={query:async(sql:string,params:unknown[]=[])=>{
    statements.push({sql,params});
    if(sql.includes("FOR UPDATE OF c")){const found=sql.includes("SELECT source_id")?options.members??[]:options.rows??rows;return{rows:found,rowCount:found.length};}
    if(sql.startsWith("SELECT role FROM users"))return{rows:[{role:options.role??"admin"}],rowCount:1};
    if(sql.startsWith("SELECT 1 FROM conversation_timeline_merges"))return{rowCount:options.nested?1:0};
    if(sql.startsWith("SELECT 1 FROM conversation_merge_links"))return{rowCount:options.legacy?1:0};
    return{rows:[],rowCount:0};
  }} as unknown as PoolClient;
  return{client,statements};
}

test("合并请求必须选择 2 至 50 个不同会话，并从中指定主会话",()=>{
  const parse=(values:string[],target=ids[0])=>timelineMergeSchema.safeParse({conversationIds:values,targetConversationId:target}).success;
  assert.equal(parse(ids),true);
  assert.equal(parse([ids[0]]),false);
  assert.equal(parse([ids[0],ids[0]]),false);
  assert.equal(parse(ids,"33333333-3333-4333-8333-333333333333"),false);
  assert.equal(parse(Array.from({length:51},()=>ids[0])),false);
  assert.equal(parse(["invalid",ids[1]]),false);
});

test("允许跨渠道不同类型和 Live Chat 同类型，拒绝其他重复类型和群会话",()=>{
  assert.equal(validateTimelineMerge(rows,ids),null);
  assert.equal(validateTimelineMerge([rows[0],{...rows[1],account_id:"another"}],ids),null);
  assert.equal(validateTimelineMerge([{...rows[0],mode:"email"},{...rows[1],mode:"whatsapp"}],ids),null);
  for(const mode of ["email","whatsapp"])assert.match(validateTimelineMerge(rows.map(row=>({...row,mode})),ids)??"",/同类型/);
  assert.match(validateTimelineMerge([{...rows[0],mode:"messenger"},rows[1]],ids)??"",/仅支持/);
  assert.match(validateTimelineMerge([rows[0],{...rows[1],entity_type:"group"}],ids)??"",/群会话/);
});

test("合并只写关联和审计，展开已有成员但不改写或删除消息",async()=>{
  const {client,statements}=fakeClient();
  assert.deepEqual(await mergeConversationTimelines(client,ids,ids[0],"actor",()=>true),{targetConversationId:ids[0]});
  assert.match(statements[0].sql,/pg_advisory_xact_lock/);
  assert.ok(statements.some(item=>item.sql.includes("ORDER BY c.id FOR UPDATE")));
  assert.ok(statements.some(item=>item.sql.startsWith("UPDATE conversation_timeline_merges SET target_id=")));
  assert.deepEqual(statements.find(item=>item.sql.startsWith("INSERT INTO conversation_timeline_merges"))?.params,[[ids[1]],ids[0],"actor"]);
  assert.ok(statements.some(item=>item.sql.includes("relay_refresh_conversation_summary")));
  assert.ok(statements.some(item=>item.sql.includes("conversation.merge_timelines")));
  assert.equal(statements.some(item=>/DELETE\s+FROM|UPDATE\s+messages|INSERT\s+INTO\s+messages/i.test(item.sql)),false);
});

test("无权限、缺失、重复类型、群会话、隐藏源会话和旧关联均在写入前拒绝",async()=>{
  const scenarios=[
    {options:{},access:false,status:404},
    {options:{rows:[rows[0]]},access:true,status:404},
    {options:{rows:rows.map(row=>({...row,mode:"email"}))},access:true,status:409},
    {options:{rows:[{...rows[0],mode:"email"},rows[1]],members:[{...rows[0],id:"third",mode:"email"}]},access:true,status:409},
    {options:{role:"agent"},access:true,status:404},
    {options:{rows:[rows[0],{...rows[1],entity_type:"group"}]},access:true,status:409},
    {options:{nested:true},access:true,status:409},
    {options:{legacy:true},access:true,status:409},
  ];
  for(const scenario of scenarios){
    const {client,statements}=fakeClient(scenario.options);
    await assert.rejects(mergeConversationTimelines(client,ids,ids[0],"actor",()=>scenario.access),{statusCode:scenario.status});
    assert.equal(statements.some(item=>/^(UPDATE|INSERT|DELETE)/.test(item.sql)),false);
  }
});
