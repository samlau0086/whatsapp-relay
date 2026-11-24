import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import test from "node:test";
import Fastify from "fastify";
import pg from "pg";
import ts from "typescript";

test("PostgreSQL：结束后的 LiveChat 可删除，保留邮件、其他会话及删除保护",{skip:!process.env.LIVECHAT_PG_BIN},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-livechat-delete-test-")),bin=process.env.LIVECHAT_PG_BIN!;
  const run=(name:string,args:string[])=>execFileSync(join(bin,process.platform==="win32"?`${name}.exe`:name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"}),app=Fastify();let started=false;
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);started=true;await client.connect();
    await client.query(`CREATE TABLE channel_accounts(id uuid PRIMARY KEY);
      CREATE TABLE contacts(id uuid PRIMARY KEY,provider_user_id text);
      CREATE TABLE livechat_visitors(id uuid PRIMARY KEY);
      CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,status text DEFAULT 'closed');
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
        account_id uuid,client_message_id text UNIQUE,direction text,kind text,text_content text,status text,
        occurred_at timestamptz,created_at timestamptz DEFAULT now(),media_id uuid);
      CREATE TABLE email_messages(id uuid PRIMARY KEY,conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,status text,text_body text);
      CREATE TABLE message_email_details(message_id uuid REFERENCES messages(id) ON DELETE CASCADE,email_message_id uuid REFERENCES email_messages(id));
      CREATE TABLE orders(id uuid PRIMARY KEY,conversation_id uuid);
      CREATE TABLE order_payment_requests(order_id uuid,is_current boolean);
      CREATE TABLE outbound_commands(message_id uuid,state text);
      CREATE TABLE media(id uuid PRIMARY KEY,object_key text);
      CREATE TABLE conversation_timeline_merges(source_id uuid,target_id uuid);
      CREATE TABLE conversation_merge_links(source_conversation_id uuid,target_conversation_id uuid);
      CREATE TABLE audit_log(actor_type text,actor_id uuid,action text,target_type text,target_id uuid,metadata jsonb);`);
    const migration=(name:string)=>readFile(new URL(`../../../infra/postgres/migrations/${name}`,import.meta.url),"utf8");
    await client.query(await migration("101_livechat_end_requests.sql"));
    await client.query(await migration("116_livechat_session_boundaries.sql"));
    const archive=await migration("110_shared_email_archive.sql");
    const preserveStart=archive.indexOf("CREATE OR REPLACE FUNCTION relay_preserve_email_archive()");
    const preserveEnd=archive.indexOf("INSERT INTO email_archive_addresses(message_id,account_id,email)",preserveStart);
    assert.ok(preserveStart>=0&&preserveEnd>preserveStart);
    await client.query(archive.slice(preserveStart,preserveEnd));
    const actor=randomUUID(),account=randomUUID(),ids=[randomUUID(),randomUUID()],ends=[randomUUID(),randomUUID(),randomUUID()],email=randomUUID();
    await client.query("INSERT INTO channel_accounts VALUES($1)",[account]);
    for(const id of ids){
      await client.query("INSERT INTO contacts VALUES($1,$2)",[id,id]);
      await client.query("INSERT INTO livechat_visitors VALUES($1)",[id]);
      await client.query("INSERT INTO conversations(id,account_id,contact_id) VALUES($1,$2,$1)",[id,account]);
    }
    await client.query("INSERT INTO email_messages VALUES($1,$2,'sent','保留的 transcript 正文',NULL)",[email,ids[0]]);
    for(const [index,end] of ends.entries()){
      const id=ids[index===2?1:0];
      await client.query(`INSERT INTO livechat_end_requests(request_id,visitor_id,conversation_id,account_id,contact_id,send_transcript,email_id)
        VALUES($1,$2,$2,$3,$2,$4,$5)`,[end,id,account,index===1,index===1?email:null]);
    }
    // 使用真实迁移补齐分隔符及保留触发器，验证邮件气泡随删除解除归属而不丢失。
    await client.query(await migration("116_livechat_session_boundaries.sql"));
    const archived=randomUUID();
    await client.query("INSERT INTO messages(id,conversation_id,text_content) VALUES($1,$2,'保留的邮件气泡')",[archived,ids[0]]);
    await client.query("INSERT INTO message_email_details VALUES($1,$2)",[archived,email]);
    await client.query("UPDATE email_messages SET livechat_end_request_id=$1 WHERE id=$2",[ends[1],email]);
    await assert.rejects(client.query("DELETE FROM conversations WHERE id=$1",[ids[0]]),{code:"23503"});
    let failCommit=false,role="admin",allowed=true;
    const transaction=async(work:(db:pg.Client)=>Promise<unknown>)=>{
      await client.query("BEGIN");
      try{const result=await work(client);if(failCommit)throw new Error("测试回滚");await client.query("COMMIT");return result;}
      catch(error){await client.query("ROLLBACK");throw error;}
    };
    const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
    const route=server.slice(server.indexOf('app.delete("/api/v1/conversations/:id"'),server.indexOf('app.patch("/api/v1/conversations/:id/contact"'));
    new Function("app","authenticate","transaction","canAccessAccount",ts.transpile(route,{target:ts.ScriptTarget.ES2022}))(
      app,async(request:{principal:unknown})=>{request.principal={kind:"user",id:actor,role};},transaction,()=>allowed,
    );
    const remove=()=>app.inject({method:"DELETE",url:`/api/v1/conversations/${ids[0]}`});
    const snapshot=async()=>{
      const tables=["conversations","messages","email_messages","livechat_end_requests","audit_log"];
      const rows=[];for(const table of tables)rows.push((await client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows);return rows;
    };
    const before=await snapshot();
    role="agent";assert.equal((await remove()).statusCode,403);role="admin";
    allowed=false;assert.equal((await remove()).statusCode,404);allowed=true;
    for(const status of ["queued","sending","retrying"]){
      await client.query("UPDATE email_messages SET status=$1 WHERE id=$2",[status,email]);
      const protectedState=await snapshot();
      const response=await remove();assert.equal(response.statusCode,409);assert.equal(response.json().error,"email_pending");
      assert.deepEqual(await snapshot(),protectedState);
    }
    await client.query("UPDATE email_messages SET status='sent' WHERE id=$1",[email]);
    await client.query("INSERT INTO orders VALUES($1,$2)",[actor,ids[0]]);
    await client.query("INSERT INTO order_payment_requests VALUES($1,true)",[actor]);
    assert.equal((await remove()).json().error,"payment_request_exists");
    await client.query("DELETE FROM order_payment_requests");
    const boundary=(await client.query("SELECT id FROM messages WHERE conversation_id=$1 LIMIT 1",[ids[0]])).rows[0].id;
    await client.query("INSERT INTO outbound_commands VALUES($1,'pending')",[boundary]);
    assert.equal((await remove()).json().error,"outbound_pending");
    await client.query("DELETE FROM outbound_commands");
    assert.deepEqual(await snapshot(),before);
    failCommit=true;assert.equal((await remove()).statusCode,500);failCommit=false;
    assert.deepEqual(await snapshot(),before);
    const otherMessages=(await client.query("SELECT * FROM messages WHERE conversation_id=$1",[ids[1]])).rows;
    role="supervisor";assert.equal((await remove()).statusCode,204);
    assert.equal((await client.query("SELECT 1 FROM conversations WHERE id=$1",[ids[0]])).rowCount,0);
    assert.equal((await client.query("SELECT 1 FROM messages WHERE conversation_id=$1",[ids[0]])).rowCount,0);
    assert.equal((await client.query("SELECT 1 FROM livechat_end_requests WHERE conversation_id=$1",[ids[0]])).rowCount,0);
    assert.deepEqual((await client.query("SELECT text_body,conversation_id,livechat_end_request_id FROM email_messages WHERE id=$1",[email])).rows,
      [{text_body:"保留的 transcript 正文",conversation_id:null,livechat_end_request_id:null}]);
    assert.deepEqual((await client.query("SELECT text_content,conversation_id,livechat_end_request_id FROM messages WHERE id=$1",[archived])).rows,
      [{text_content:"保留的邮件气泡",conversation_id:null,livechat_end_request_id:null}]);
    assert.equal((await client.query("SELECT 1 FROM message_email_details WHERE message_id=$1",[archived])).rowCount,1);
    assert.deepEqual((await client.query("SELECT * FROM messages WHERE conversation_id=$1",[ids[1]])).rows,otherMessages);
    assert.equal((await client.query("SELECT request_id FROM livechat_end_requests")).rows[0].request_id,ends[2]);
    assert.equal((await client.query("SELECT 1 FROM contacts WHERE id=$1",[ids[0]])).rowCount,1);
    assert.equal((await client.query("SELECT 1 FROM livechat_visitors WHERE id=$1",[ids[0]])).rowCount,1);
    assert.equal((await client.query("SELECT 1 FROM audit_log WHERE action='conversation.delete'")).rowCount,1);
    assert.equal((await remove()).statusCode,404);
  }finally{
    await app.close();await client.end().catch(()=>{});if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    if(resolve(directory).startsWith(resolve(tmpdir())+sep+"relay-livechat-delete-test-"))await rm(directory,{recursive:true,force:true});
  }
});
