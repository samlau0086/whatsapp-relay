import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import test from "node:test";
import pg from "pg";
import {mergeConversationTimelines} from "../src/timeline-merge.js";

// 显式提供 PostgreSQL bin 路径，只启动临时实例，不连接开发或生产数据库。
test("PostgreSQL：合并保留全部消息、稳定分页、连续合并、入站摘要和成员保护",{skip:!process.env.TIMELINE_PG_BIN},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-timeline-test-"));
  const bin=process.env.TIMELINE_PG_BIN!;
  const run=(name:string,args:string[])=>execFileSync(join(bin,process.platform==="win32"?`${name}.exe`:name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  let started=false;
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"});
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);
    started=true;await client.connect();
    await client.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE contacts(id uuid PRIMARY KEY,entity_type text);
      CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,unread_count int DEFAULT 0,status text DEFAULT 'open',closed_at timestamptz,
        last_message_id uuid,last_message_text text,last_message_kind text,last_message_direction text,last_message_status text,last_message_at timestamptz,
        last_message_sender_provider_user_id text,last_message_sender_name text,summary_updated_at timestamptz);
      CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid REFERENCES conversations(id),text_content text,kind text DEFAULT 'text',direction text DEFAULT 'in',status text DEFAULT 'sent',occurred_at timestamptz,sender_provider_user_id text,sender_display_name text);
      CREATE TABLE conversation_merge_links(source_conversation_id uuid,target_conversation_id uuid);
      CREATE TABLE audit_log(actor_type text,actor_id uuid,action text,target_type text,target_id uuid,metadata jsonb);
      CREATE FUNCTION relay_publish_conversation_change(uuid,uuid) RETURNS void LANGUAGE sql AS $$ SELECT pg_notify('timeline_test',$1::text) $$;`);
    const migration=await readFile(new URL("../../../infra/postgres/migrations/102_conversation_timeline_merges.sql",import.meta.url),"utf8");
    await client.query(migration);await client.query(migration);
    await client.query("CREATE TRIGGER conversations_change_notify AFTER INSERT OR UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION relay_notify_conversation_row()");
    const account=randomUUID(),actor=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()];
    await client.query("INSERT INTO users VALUES($1)",[actor]);
    for(const id of ids){await client.query("INSERT INTO contacts VALUES($1,'person')",[id]);await client.query("INSERT INTO conversations(id,account_id,contact_id) VALUES($1,$2,$1)",[id,account]);}
    const messageIds=["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000003","00000000-0000-4000-8000-000000000004"];
    for(let index=0;index<4;index++)await client.query("INSERT INTO messages(id,conversation_id,text_content,occurred_at) VALUES($1,$2,$3,$4)",[messageIds[index],ids[index%2],`消息 ${index}`,index===0?"2026-11-15T00:00:00Z":"2026-11-15T01:00:00Z"]);
    const before=(await client.query("SELECT * FROM messages ORDER BY id")).rows;
    const merge=async(values:string[],target:string)=>{await client.query("BEGIN");try{await mergeConversationTimelines(client as unknown as pg.PoolClient,values,target,actor,()=>true);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}};
    await merge(ids.slice(0,2),ids[0]);
    assert.deepEqual((await client.query("SELECT * FROM messages ORDER BY id")).rows,before);
    const first=await client.query("SELECT id,occurred_at::text cursor_time FROM messages WHERE conversation_id IN (SELECT relay_conversation_members($1)) ORDER BY occurred_at DESC,id DESC LIMIT 2",[ids[0]]);
    const cursor=first.rows.at(-1)!;
    const second=await client.query("SELECT id FROM messages WHERE conversation_id IN (SELECT relay_conversation_members($1)) AND (occurred_at,id)<($2::timestamptz,$3::uuid) ORDER BY occurred_at DESC,id DESC LIMIT 2",[ids[0],cursor.cursor_time,cursor.id]);
    assert.deepEqual([...first.rows,...second.rows].map(row=>row.id),[...messageIds].reverse());
    await merge([ids[0],ids[2]],ids[2]);
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
      await assert.rejects(client.query("DELETE FROM conversations WHERE id=$1",[id]),/conversation_timeline_merge_member/);
      await assert.rejects(client.query("UPDATE conversations SET account_id=$2 WHERE id=$1",[id,randomUUID()]),/conversation_timeline_merge_member/);
      await client.query("UPDATE conversations SET account_id=account_id WHERE id=$1",[id]);
    }
    assert.equal((await client.query("SELECT COUNT(*)::int count FROM messages")).rows[0].count,5);
  }finally{
    await client.end().catch(()=>{});
    if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    const target=resolve(directory);
    if(target.startsWith(resolve(tmpdir())+"\\relay-timeline-test-")||target.startsWith(resolve(tmpdir())+"/relay-timeline-test-"))await rm(target,{recursive:true,force:true});
  }
});
