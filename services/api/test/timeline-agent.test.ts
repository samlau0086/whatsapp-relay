import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {setTimelineAgentMode} from "../src/timeline-agent.js";
import {applyProactiveReplyTransition} from "../src/agent-engine.js";

test("成员设置只更新主会话控制状态，暂停覆盖全组待执行任务",async()=>{
  const queries:Array<{sql:string;params?:unknown[]}>=[];
  const client={query:async(sql:string,params?:unknown[])=>{
    queries.push({sql,params});
    return{rows:sql.startsWith("SELECT root.id")?[{id:"sean"}]:[],rowCount:1};
  }};
  await setTimelineAgentMode(client as never,"sam",{mode:"human_paused",proactiveReplyMode:"full"},"actor");
  assert.deepEqual(queries[0].params,["sam"]);
  assert.match(queries[0].sql,/FOR UPDATE OF root/);
  for(const query of queries.slice(1))assert.equal(query.params?.[0],"sean");
  assert.match(queries.find(query=>query.sql.startsWith("UPDATE agent_jobs"))!.sql,/relay_conversation_members\(\$1\).*state='pending'/);
  assert.ok(!queries.some(query=>/UPDATE messages|DELETE FROM|UPDATE contacts/.test(query.sql)));
});

test("不存在的会话不能写入接管状态",async()=>{
  let count=0;
  const client={query:async()=>{count++;return{rows:[],rowCount:0};}};
  await assert.rejects(setTimelineAgentMode(client as never,"missing",{mode:"full"},"actor"),/conversation_not_found/);
  assert.equal(count,1);
});

test("成员的主动回复切换使用主会话设置，入站匹配仍限定原成员",async()=>{
  const queries:Array<{sql:string;params?:unknown[]}>=[];
  const client={query:async(sql:string,params?:unknown[])=>{
    queries.push({sql,params});
    if(sql.startsWith("SELECT root.id"))return{rows:[{id:"sean"}],rowCount:1};
    if(sql.includes("JOIN messages sent ON sent.id=st.last_agent_message_id"))return{rows:[{proactive_reply_mode:"human_paused"}],rowCount:1};
    return{rows:[],rowCount:0};
  }};
  await applyProactiveReplyTransition(client as never,"sam","sam-message");
  const lookup=queries.find(query=>query.sql.includes("JOIN messages sent ON sent.id=st.last_agent_message_id"))!;
  assert.deepEqual(lookup.params,["sam","sam-message","sean"]);
  assert.match(lookup.sql,/incoming.conversation_id=st.conversation_id/);
  assert.deepEqual(queries.find(query=>query.sql.startsWith("UPDATE conversation_agent_state"))?.params,["sean","human_paused","proactive_customer_replied"]);
  for(const query of queries.filter(query=>/^UPDATE (agent_jobs|ai_drafts)/.test(query.sql))){
    assert.match(query.sql,/relay_conversation_members\(\$1\)/);
    assert.deepEqual(query.params,["sean"]);
  }
});

test("入站、执行、发送前校验共用主会话模式，但发送队列保留原会话与收件人",async()=>{
  const engine=await readFile(new URL("../src/agent-engine.ts",import.meta.url),"utf8");
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(engine,/await enqueueTimelineAgentReply\(client,conversationId,messageId\)/);
  assert.match(engine,/COALESCE\(control.mode,'human_paused'\) mode.*\$\{timelineAgentControlJoin\}/s);
  assert.match(engine,/const account = await loadAgentDeliveryContext\(client,String\(job.conversation_id\)\)/);
  assert.match(engine,/account.rows\[0\].mode !== cfg.mode/);
  assert.match(engine,/conversationId: String\(job.conversation_id\)/);
  assert.match(engine,/toJid: account.rows\[0\].provider_user_id/);
  assert.match(server,/FROM agent_runs WHERE conversation_id IN \(SELECT relay_conversation_members\(\$1\)\)/);
  assert.match(server,/WHERE d.conversation_id IN \(SELECT relay_conversation_members\(\$1\)\)/);
});
