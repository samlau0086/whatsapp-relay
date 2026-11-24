import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import test from "node:test";
import pg from "pg";
import Fastify from "fastify";
import ts from "typescript";
import {mergeConversationTimelines} from "../src/timeline-merge.js";
import {enqueueTimelineAgentReply,loadAgentDeliveryContext,resolveTimelineAgentControl,setTimelineAgentMode} from "../src/timeline-agent.js";
import {pauseAgentForHuman} from "../src/agent-engine.js";

// 显式提供 PostgreSQL bin 路径，只启动临时实例，不连接开发或生产数据库。
test("PostgreSQL：合并保留全部消息、稳定分页、连续合并、入站摘要和成员保护",{skip:!process.env.TIMELINE_PG_BIN},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-timeline-test-"));
  const bin=process.env.TIMELINE_PG_BIN!;
  const run=(name:string,args:string[])=>execFileSync(join(bin,process.platform==="win32"?`${name}.exe`:name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  let started=false;
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"});
  const app=Fastify();
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);
    started=true;await client.connect();
    await client.query(`CREATE TABLE users(id uuid PRIMARY KEY,role text DEFAULT 'admin');
      CREATE TABLE contacts(id uuid PRIMARY KEY,entity_type text,provider_user_id text);
      CREATE TABLE channel_accounts(id uuid PRIMARY KEY,agent_id uuid,transport text);
      CREATE TABLE account_agent_settings(account_id uuid PRIMARY KEY,enabled boolean);
      CREATE TABLE conversation_agent_state(conversation_id uuid PRIMARY KEY,mode text DEFAULT 'human_paused',proactive_reply_mode text DEFAULT 'cautious',pause_reason text,updated_at timestamptz DEFAULT now());
      CREATE TABLE agent_jobs(conversation_id uuid,source_message_id uuid,kind text,available_at timestamptz,state text DEFAULT 'pending',completed_at timestamptz,last_error text);
      CREATE TABLE ai_drafts(id uuid PRIMARY KEY,conversation_id uuid,status text DEFAULT 'pending',resolved_at timestamptz,resolved_by uuid);
      CREATE TABLE proactive_outreach_jobs(conversation_id uuid,state text,payload jsonb,completed_at timestamptz,last_error text,updated_at timestamptz);
      CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,origin_mode text DEFAULT 'livechat',unread_count int DEFAULT 0,status text DEFAULT 'open',closed_at timestamptz,
        last_message_id uuid,last_message_text text,last_message_kind text,last_message_direction text,last_message_status text,last_message_at timestamptz,
        last_message_sender_provider_user_id text,last_message_sender_name text,summary_updated_at timestamptz);
      CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,media_id uuid,text_content text,kind text DEFAULT 'text',direction text DEFAULT 'in',status text DEFAULT 'sent',occurred_at timestamptz,sender_provider_user_id text,sender_display_name text);
      CREATE TABLE orders(id uuid PRIMARY KEY,conversation_id uuid);
      CREATE TABLE order_payment_requests(order_id uuid,is_current boolean);
      CREATE TABLE outbound_commands(message_id uuid,state text);
      CREATE TABLE email_messages(conversation_id uuid,status text);
      ALTER TABLE messages ADD COLUMN livechat_end_request_id uuid;
      ALTER TABLE email_messages ADD COLUMN livechat_end_request_id uuid;
      CREATE TABLE livechat_end_requests(request_id uuid PRIMARY KEY,conversation_id uuid REFERENCES conversations(id) ON DELETE RESTRICT);
      CREATE TABLE media(id uuid PRIMARY KEY,object_key text);
      CREATE TABLE conversation_merge_links(source_conversation_id uuid,target_conversation_id uuid);
      CREATE TABLE audit_log(actor_type text,actor_id uuid,action text,target_type text,target_id uuid,metadata jsonb);
      CREATE FUNCTION relay_publish_conversation_change(uuid,uuid) RETURNS void LANGUAGE sql AS $$ SELECT pg_notify('timeline_test',$1::text) $$;`);
    const migration=await readFile(new URL("../../../infra/postgres/migrations/102_conversation_timeline_merges.sql",import.meta.url),"utf8");
    const deleteMigration=await readFile(new URL("../../../infra/postgres/migrations/104_allow_timeline_conversation_delete.sql",import.meta.url),"utf8");
    await client.query(migration);await client.query(deleteMigration);
    await client.query("CREATE TRIGGER conversations_change_notify AFTER INSERT OR UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION relay_notify_conversation_row()");
    const account=randomUUID(),actor=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()];
    await client.query("INSERT INTO users(id) VALUES($1)",[actor]);
    await client.query("INSERT INTO channel_accounts VALUES($1,NULL,'livechat')",[account]);
    await client.query("INSERT INTO account_agent_settings VALUES($1,true)",[account]);
    for(const id of ids){await client.query("INSERT INTO contacts VALUES($1::uuid,'person',$2)",[id,id]);await client.query("INSERT INTO conversations(id,account_id,contact_id) VALUES($1,$2,$1)",[id,account]);}
    const messageIds=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000003","00000000-0000-4000-8000-000000000004"];
    for(let index=0;index<4;index++)await client.query("INSERT INTO messages(id,conversation_id,text_content,occurred_at) VALUES($1,$2,$3,$4)",[messageIds[index],ids[index%2],`消息 ${index}`,index===0?"2026-11-15T00:00:00Z":"2026-11-15T01:00:00Z"]);
    const before=(await client.query("SELECT * FROM messages ORDER BY id")).rows;
    const merge=async(values:string[],target:string)=>{await client.query("BEGIN");try{await mergeConversationTimelines(client as unknown as pg.PoolClient,values,target,actor,()=>true);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}};
    await merge(ids.slice(0,2),ids[0]);
    assert.deepEqual((await client.query("SELECT * FROM messages ORDER BY id")).rows,before);
    const agentClient=client as unknown as pg.PoolClient;
    const setMode=async(id:string,mode:string)=>{
      await client.query("BEGIN");
      try{await setTimelineAgentMode(agentClient,id,{mode},actor);await client.query("COMMIT");}
      catch(error){await client.query("ROLLBACK");throw error;}
    };
    await client.query("INSERT INTO conversation_agent_state(conversation_id,mode) VALUES($1,'human_paused'),($2,'full')",[ids[1],ids[2]]);
    await setMode(ids[0],"full");
    assert.equal(await resolveTimelineAgentControl(agentClient,ids[1]),ids[0]);
    const delivery=(await loadAgentDeliveryContext(agentClient,ids[1])).rows[0];
    assert.equal(delivery.mode,"full");
    assert.equal(delivery.provider_user_id,ids[1]);
    assert.equal(delivery.id,account);
    assert.equal((await client.query("SELECT mode FROM conversation_agent_state WHERE conversation_id=$1",[ids[1]])).rows[0].mode,"human_paused");
    await enqueueTimelineAgentReply(agentClient,ids[1],messageIds[1]);
    assert.equal((await client.query("SELECT conversation_id FROM agent_jobs WHERE source_message_id=$1",[messageIds[1]])).rows[0].conversation_id,ids[1]);
    await enqueueTimelineAgentReply(agentClient,ids[2],messageIds[0]);
    await setMode(ids[1],"human_paused");
    assert.equal((await loadAgentDeliveryContext(agentClient,ids[1])).rows[0].mode,"human_paused");
    assert.equal((await client.query("SELECT state FROM agent_jobs WHERE conversation_id=$1",[ids[1]])).rows[0].state,"cancelled");
    assert.equal((await client.query("SELECT state FROM agent_jobs WHERE conversation_id=$1",[ids[2]])).rows[0].state,"pending");
    assert.equal((await enqueueTimelineAgentReply(agentClient,ids[1],messageIds[3])).rowCount,0);
    await setMode(ids[1],"cautious");
    assert.equal((await enqueueTimelineAgentReply(agentClient,ids[1],messageIds[3])).rowCount,1);
    await client.query("UPDATE account_agent_settings SET enabled=false WHERE account_id=$1",[account]);
    assert.equal((await loadAgentDeliveryContext(agentClient,ids[1])).rows[0].enabled,false);
    assert.equal((await enqueueTimelineAgentReply(agentClient,ids[1],messageIds[3])).rowCount,0);
    await client.query("UPDATE account_agent_settings SET enabled=true WHERE account_id=$1",[account]);
    const draft=randomUUID(),unrelatedDraft=randomUUID();
    await client.query("INSERT INTO ai_drafts(id,conversation_id) VALUES($1,$2),($3,$4)",[draft,ids[1],unrelatedDraft,ids[2]]);
    await setMode(ids[0],"full");
    assert.equal((await client.query("SELECT status FROM ai_drafts WHERE id=$1",[draft])).rows[0].status,"dismissed");
    assert.equal((await client.query("SELECT status FROM ai_drafts WHERE id=$1",[unrelatedDraft])).rows[0].status,"pending");
    await client.query("UPDATE ai_drafts SET status='pending' WHERE id=$1",[draft]);
    await client.query("INSERT INTO proactive_outreach_jobs(conversation_id,state,payload) VALUES($1,'awaiting_approval',$2)",[ids[1],JSON.stringify({draftId:draft})]);
    await client.query("BEGIN");
    try{await pauseAgentForHuman(agentClient,ids[1]);await client.query("COMMIT");}
    catch(error){await client.query("ROLLBACK");throw error;}
    assert.equal((await loadAgentDeliveryContext(agentClient,ids[0])).rows[0].mode,"human_paused");
    assert.equal((await client.query("SELECT state FROM proactive_outreach_jobs WHERE conversation_id=$1",[ids[1]])).rows[0].state,"skipped");
    assert.deepEqual((await client.query("SELECT * FROM messages ORDER BY id")).rows,before);
    const first=await client.query("SELECT id,occurred_at::text cursor_time FROM messages WHERE conversation_id IN (SELECT relay_conversation_members($1)) ORDER BY occurred_at DESC,id DESC LIMIT 2",[ids[0]]);
    const cursor=first.rows.at(-1)!;
    const second=await client.query("SELECT id FROM messages WHERE conversation_id IN (SELECT relay_conversation_members($1)) AND (occurred_at,id)<($2::timestamptz,$3::uuid) ORDER BY occurred_at DESC,id DESC LIMIT 2",[ids[0],cursor.cursor_time,cursor.id]);
    assert.deepEqual([...first.rows,...second.rows].map(row=>row.id),[...messageIds].reverse());
    await merge([ids[0],ids[2]],ids[2]);
    assert.equal(await resolveTimelineAgentControl(agentClient,ids[1]),ids[2]);
    assert.equal((await loadAgentDeliveryContext(agentClient,ids[1])).rows[0].mode,"full");
    assert.equal((await loadAgentDeliveryContext(agentClient,ids[1])).rows[0].provider_user_id,ids[1]);
    assert.equal((await client.query("SELECT relay_conversation_members($1)",[ids[2]])).rowCount,3);
    assert.deepEqual((await client.query("SELECT * FROM messages ORDER BY id")).rows,before);
    await client.query("UPDATE conversations SET status='closed',closed_at=now() WHERE id=$1",[ids[2]]);
    await client.query("UPDATE conversations SET unread_count=unread_count+1 WHERE id=$1",[ids[1]]);
    assert.equal((await client.query("SELECT status FROM conversations WHERE id=$1",[ids[2]])).rows[0].status,"open");
    const newest=randomUUID();
    await client.query("INSERT INTO messages(id,conversation_id,text_content,occurred_at) VALUES($1,$2,'后续消息','2026-11-16T00:00:00Z')",[newest,ids[1]]);
    await client.query("SELECT relay_refresh_conversation_summary($1)",[ids[1]]);
    assert.equal((await client.query("SELECT last_message_id FROM conversations WHERE id=$1",[ids[2]])).rows[0].last_message_id,newest);
    for(const id of ids){
      await assert.rejects(client.query("UPDATE conversations SET account_id=$2 WHERE id=$1",[id,randomUUID()]),/conversation_timeline_merge_member/);
      await client.query("UPDATE conversations SET account_id=account_id WHERE id=$1",[id]);
    }
    assert.equal((await client.query("SELECT COUNT(*)::int count FROM messages")).rows[0].count,5);
    // 上次仅放开触发器但不清理关联时，主、源会话均被外键拒绝。
    for(const id of [ids[2],ids[1]])await assert.rejects(client.query("DELETE FROM conversations WHERE id=$1",[id]),{code:"23503"});
    await client.query("INSERT INTO messages(id,conversation_id,text_content,occurred_at) VALUES($1,$2,'主会话消息','2026-11-14T00:00:00Z')",[randomUUID(),ids[2]]);

    // 运行 server.ts 中实际的删除路由，避免仅验证 SQL 文本而漏掉事务中的外键错误。
    const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
    const route=server.slice(server.indexOf('app.delete("/api/v1/conversations/:id"'),server.indexOf('app.patch("/api/v1/conversations/:id/contact"'));
    let role="admin",allowed=true,failCommit=false;
    const transaction=async(work:(db:pg.Client)=>Promise<unknown>)=>{
      await client.query("BEGIN");
      try{const result=await work(client);if(failCommit)throw new Error("测试事务回滚");await client.query("COMMIT");return result;}
      catch(error){await client.query("ROLLBACK");throw error;}
    };
    new Function("app","authenticate","transaction","canAccessAccount",ts.transpile(route,{target:ts.ScriptTarget.ES2022}))(
      app,async(request:{principal:unknown})=>{request.principal={kind:"user",id:actor,role};},transaction,()=>allowed,
    );
    const remove=(id:string)=>app.inject({method:"DELETE",url:`/api/v1/conversations/${id}`});
    const links=async()=>(await client.query("SELECT source_id,target_id FROM conversation_timeline_merges ORDER BY source_id")).rows;
    const originalLinks=await links();
    role="agent";assert.equal((await remove(ids[2])).statusCode,403);role="admin";
    allowed=false;assert.equal((await remove(ids[2])).statusCode,404);allowed=true;
    assert.equal((await remove(randomUUID())).statusCode,404);
    await client.query("INSERT INTO orders VALUES($1,$2);",[actor,ids[2]]);
    await client.query("INSERT INTO order_payment_requests VALUES($1,true)",[actor]);
    assert.equal((await remove(ids[2])).json().error,"payment_request_exists");
    await client.query("DELETE FROM order_payment_requests");
    await client.query("INSERT INTO outbound_commands VALUES($1,'pending')",[newest]);
    assert.equal((await remove(ids[1])).json().error,"outbound_pending");
    await client.query("DELETE FROM outbound_commands");
    await client.query("INSERT INTO email_messages VALUES($1,'queued')",[ids[2]]);
    assert.equal((await remove(ids[2])).json().error,"email_pending");
    await client.query("DELETE FROM email_messages");
    assert.deepEqual(await links(),originalLinks);
    failCommit=true;assert.equal((await remove(ids[2])).statusCode,500);failCommit=false;
    assert.deepEqual(await links(),originalLinks);
    assert.equal((await client.query("SELECT COUNT(*)::int count FROM messages")).rows[0].count,6);
    assert.equal((await client.query("SELECT COUNT(*)::int count FROM audit_log WHERE action='conversation.delete'")).rows[0].count,0);
    // 删除源成员，主会话仍保留其他成员，摘要不再指向源成员的消息。
    assert.equal((await remove(ids[1])).statusCode,204);
    assert.equal((await client.query("SELECT 1 FROM messages WHERE conversation_id=$1",[ids[1]])).rowCount,0);
    assert.equal((await client.query("SELECT relay_conversation_members($1)",[ids[2]])).rowCount,2);
    assert.notEqual((await client.query("SELECT last_message_id FROM conversations WHERE id=$1",[ids[2]])).rows[0].last_message_id,newest);
    // 删除主会话不会级联删除其他成员；独立成员随后也可正常删除。
    assert.equal((await remove(ids[2])).statusCode,204);
    assert.equal((await links()).length,0);
    assert.equal((await client.query("SELECT 1 FROM conversations WHERE id=$1",[ids[0]])).rowCount,1);
    assert.equal((await client.query("SELECT 1 FROM messages WHERE conversation_id=$1",[ids[0]])).rowCount,2);
    assert.equal((await client.query("SELECT last_message_id FROM conversations WHERE id=$1",[ids[0]])).rows[0].last_message_id,messageIds[2]);
    assert.equal((await remove(ids[0])).statusCode,204);
    assert.equal((await client.query("SELECT COUNT(*)::int count FROM audit_log WHERE action='conversation.delete'")).rows[0].count,3);
  }finally{
    await app.close();
    await client.end().catch(()=>{});
    if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    const target=resolve(directory);
    if(target.startsWith(resolve(tmpdir())+"\\relay-timeline-test-")||target.startsWith(resolve(tmpdir())+"/relay-timeline-test-"))await rm(target,{recursive:true,force:true});
  }
});
