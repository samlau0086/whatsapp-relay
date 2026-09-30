import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {applyProactiveReplyTransition} from "../src/agent-engine.js";

function inbound(options:{outreach?:boolean;agentMessage?:boolean;mode?:string;choice?:string;live?:boolean}={}){
  const queries:Array<{sql:string;params:unknown[]|undefined}>=[];
  const client={query:async(sql:string,params?:unknown[])=>{
    queries.push({sql,params});
    if(sql.includes("SELECT j.id FROM proactive_outreach_jobs"))return{rows:options.outreach?[{id:"outreach-1"}]:[],rowCount:options.outreach?1:0};
    if(sql.includes("JOIN messages sent ON sent.id=st.last_agent_message_id"))return{rows:options.agentMessage?[{proactive_reply_mode:options.choice??"cautious"}]:[],rowCount:options.agentMessage?1:0};
    if(sql.includes("SELECT mode,proactive_reply_mode"))return{rows:[{mode:options.mode??"full",proactive_reply_mode:options.choice??"cautious"}],rowCount:1};
    return{rows:[],rowCount:0};
  }};
  return{queries,run:()=>applyProactiveReplyTransition(client as never,"conversation-1","message-1",options.live??true)};
}

test("first reply to full outreach switches to cautious within the conversation lock",async()=>{
  const scenario=inbound({outreach:true});await scenario.run();
  const statements=scenario.queries.map(query=>query.sql);
  assert.match(statements[0],/FOR UPDATE/);
  assert.match(statements[1],/sent_agent_mode='full'.*reply_processed_at IS NULL/s);
  assert.match(statements[1],/sent\.status IN \('sent','delivered','read'\)/);
  assert.match(statements[1],/j\.sent_at<incoming\.occurred_at/);
  assert.match(statements[1],/NOT EXISTS \(SELECT 1 FROM messages newer/);
  assert.match(statements[1],/NOT EXISTS \(SELECT 1 FROM messages earlier/);
  assert.ok(statements.findIndex(sql=>sql.includes("reply_processed_at=now()"))<statements.findIndex(sql=>sql.includes("SET mode=$2")));
  assert.deepEqual(scenario.queries.find(query=>query.sql.includes("SET mode=$2"))?.params,["conversation-1","cautious",null]);
});

test("keep-full choice consumes the outreach without changing mode",async()=>{
  const scenario=inbound({outreach:true,choice:"full"});await scenario.run();
  assert.ok(scenario.queries.some(query=>query.sql.includes("reply_processed_at=now()")));
  assert.ok(!scenario.queries.some(query=>query.sql.includes("SET mode=$2")));
});

test("human choice cancels pending jobs and drafts",async()=>{
  const scenario=inbound({outreach:true,choice:"human_paused"});await scenario.run();
  assert.deepEqual(scenario.queries.find(query=>query.sql.includes("SET mode=$2"))?.params,["conversation-1","human_paused","proactive_customer_replied"]);
  assert.ok(scenario.queries.some(query=>query.sql.includes("UPDATE agent_jobs SET state='cancelled'")));
  assert.ok(scenario.queries.some(query=>query.sql.includes("UPDATE ai_drafts SET status='dismissed'")));
});

test("manual takeover remains authoritative and the outreach is consumed",async()=>{
  const scenario=inbound({outreach:true,mode:"human_paused"});await scenario.run();
  assert.ok(scenario.queries.some(query=>query.sql.includes("reply_processed_at=now()")));
  assert.ok(!scenario.queries.some(query=>query.sql.includes("SET mode=$2")));
  const cautious=inbound({outreach:true,mode:"cautious"});await cautious.run();
  assert.ok(cautious.queries.some(query=>query.sql.includes("reply_processed_at=now()")));
  assert.ok(!cautious.queries.some(query=>query.sql.includes("SET mode=$2")));
});

test("ordinary and historical replies do not transition",async()=>{
  const ordinary=inbound();await ordinary.run();
  assert.ok(!ordinary.queries.some(query=>query.sql.includes("reply_processed_at=now()")));
  const historical=inbound({outreach:true,live:false});await historical.run();
  assert.ok(!historical.queries.some(query=>query.sql.includes("SELECT j.id FROM proactive_outreach_jobs")));
});

test("customer replies after a full takeover agent message switch to the configured mode",async()=>{
  const scenario=inbound({agentMessage:true,choice:"cautious"});await scenario.run();
  assert.deepEqual(scenario.queries.find(query=>query.sql.includes("SET mode=$2"))?.params,["conversation-1","cautious",null]);
});

test("migration, API, and inbox expose a per-conversation default without changing old mode requests",async()=>{
  const [migration,migrator,server,inbox,engine,hub,messenger,cloud,outreach]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/091_proactive_reply_mode.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../src/agent-engine.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/messenger.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/whatsapp-cloud.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS proactive_reply_mode text NOT NULL DEFAULT 'cautious'/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS sent_agent_mode text/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS sent_at timestamptz/);
  assert.match(migrator,/091_proactive_reply_mode\.sql/);
  assert.match(server,/COALESCE\(st\.proactive_reply_mode,'cautious'\) proactive_reply_mode/);
  assert.match(server,/if\(body\.mode!==undefined\)/);
  assert.match(server,/if\(body\.proactiveReplyMode!==undefined\)await client\.query/);
  assert.match(inbox,/回复时切换为<select/);
  assert.match(engine,/await applyProactiveReplyTransition\(client,conversationId,messageId,live\)/);
  assert.match(engine,/await applyProactiveReplyTransition\(client,conversationId,messageId,live\);\s*if\(!eligibleForReply\)return;/);
  assert.match(hub,/if\(payload\.direction==="in"\)await enqueueInboundAgentWork/);
  assert.match(messenger,/if\(input\.direction==="in"\)await enqueueInboundAgentWork/);
  for(const channel of [hub,messenger,cloud])assert.match(channel,/recordProactiveOutreachDelivery\(client/);
  assert.match(outreach,/sent_agent_mode=COALESCE\(st\.mode,'human_paused'\),sent_at=now\(\)/);
});
