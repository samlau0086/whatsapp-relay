import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import test from "node:test";
import pg from "pg";

test("PostgreSQL：邮件单份归档、同邮箱共享、权限隔离及删除保留",{skip:!process.env.EMAIL_ARCHIVE_PG_BIN},async t=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-email-archive-test-")),bin=process.env.EMAIL_ARCHIVE_PG_BIN!;
  const run=(name:string,args:string[])=>execFileSync(join(bin,process.platform==="win32"?`${name}.exe`:name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"});let started=false;
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);started=true;await client.connect();
    await client.query(`CREATE TYPE message_kind AS ENUM('text');
      CREATE TYPE message_direction AS ENUM('in','out');
      CREATE TYPE delivery_status AS ENUM('received','queued','sent','failed');
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE channel_accounts(id uuid PRIMARY KEY);
      CREATE TABLE contacts(id uuid PRIMARY KEY,account_id uuid REFERENCES channel_accounts ON DELETE CASCADE);
      CREATE TABLE contact_emails(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_id uuid REFERENCES contacts ON DELETE CASCADE,email text);
      CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid REFERENCES channel_accounts ON DELETE CASCADE,contact_id uuid REFERENCES contacts ON DELETE CASCADE,
        unread_count int DEFAULT 0,status text DEFAULT 'open',closed_at timestamptz,last_message_at timestamptz,
        last_message_sender_provider_user_id text,last_message_sender_name text);
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
        account_id uuid REFERENCES channel_accounts ON DELETE CASCADE,sender_contact_id uuid REFERENCES contacts ON DELETE SET NULL,
        direction message_direction,kind message_kind DEFAULT 'text',text_content text,status delivery_status,
        occurred_at timestamptz DEFAULT now(),sender_provider_user_id text,sender_display_name text);
      CREATE TABLE email_messages(id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
        contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,html_body text);
      CREATE TABLE message_email_details(message_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE,from_email text,to_emails jsonb,
        email_job_id uuid REFERENCES email_messages ON DELETE SET NULL);
      CREATE TABLE message_email_attachments(message_id uuid REFERENCES messages ON DELETE CASCADE,object_key text);`);
    const summaries=await readFile(new URL("../../../infra/postgres/migrations/040_conversation_summaries_events.sql",import.meta.url),"utf8");
    await client.query(summaries.split("CREATE OR REPLACE FUNCTION relay_publish_conversation_change")[0]);
    await client.query("CREATE FUNCTION relay_publish_conversation_change(uuid,uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$");
    const merges=await readFile(new URL("../../../infra/postgres/migrations/102_conversation_timeline_merges.sql",import.meta.url),"utf8");
    await client.query(merges);
    await client.query("CREATE TRIGGER conversations_change_notify AFTER INSERT OR UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION relay_notify_conversation_row()");
    const accounts=[randomUUID(),randomUUID()],contacts=Array.from({length:4},()=>randomUUID()),conversations=Array.from({length:4},()=>randomUUID());
    await client.query("INSERT INTO channel_accounts VALUES($1),($2)",accounts);
    for(let i=0;i<4;i++){
      await client.query("INSERT INTO contacts VALUES($1,$2)",[contacts[i],accounts[i===3?1:0]]);
      await client.query("INSERT INTO contact_emails(contact_id,email) VALUES($1,$2)",[contacts[i],i===2?"other@example.com":i===1?"  SAM@example.com  ":"sam@example.com"]);
      await client.query("INSERT INTO conversations(id,account_id,contact_id) VALUES($1,$2,$3)",[conversations[i],accounts[i===3?1:0],contacts[i]]);
    }
    const inbound=randomUUID(),outbound=randomUUID(),chat=randomUUID(),job=randomUUID();
    await client.query("INSERT INTO email_messages VALUES($1,$2,$3,'<p>original</p>')",[job,conversations[0],contacts[0]]);
    await client.query("INSERT INTO messages(id,conversation_id,account_id,direction,text_content,status,occurred_at) VALUES($1,$2,$3,'in','incoming','received','2026-01-01'),($4,$2,$3,'out','outgoing','queued','2026-01-02'),($5,$2,$3,'in','visitor','received','2025-01-01')",[inbound,conversations[0],accounts[0],outbound,chat]);
    await client.query("INSERT INTO message_email_details VALUES($1,'sam@example.com','[\"support@example.com\"]',NULL),($2,'support@example.com','[\"SAM@example.com\"]',$3)",[inbound,outbound,job]);
    await client.query("INSERT INTO message_email_attachments VALUES($1,'email/shared-file')",[inbound]);
    const migration=await readFile(new URL("../../../infra/postgres/migrations/110_shared_email_archive.sql",import.meta.url),"utf8");
    const visible=async(id:string)=>(await client.query("SELECT message_id FROM relay_conversation_messages($1) ORDER BY message_id",[id])).rows.map(row=>row.message_id);
    const latest=async(id:string)=>(await client.query("SELECT last_message_id,last_message_status FROM conversations WHERE id=$1",[id])).rows[0];
    await t.test("历史迁移幂等且正文、附件和消息 ID 不变",async()=>{
      await client.query(migration);await client.query(migration);
      assert.equal((await client.query("SELECT conversation_id FROM messages WHERE id=$1",[inbound])).rows[0].conversation_id,null);
      assert.equal((await client.query("SELECT count(*)::int total FROM messages")).rows[0].total,3);
      assert.equal((await client.query("SELECT count(*)::int total FROM email_archive_addresses")).rows[0].total,2);
      assert.equal((await client.query("SELECT object_key FROM message_email_attachments WHERE message_id=$1",[inbound])).rows[0].object_key,"email/shared-file");
    });
    await t.test("同邮箱共享收发，非邮件、不同邮箱与不同渠道隔离",async()=>{
      assert.deepEqual(await visible(conversations[0]),[inbound,outbound,chat].sort());
      assert.deepEqual(await visible(conversations[1]),[inbound,outbound].sort());
      assert.deepEqual(await visible(conversations[2]),[]);assert.deepEqual(await visible(conversations[3]),[]);
      assert.equal((await latest(conversations[1])).last_message_id,outbound);
    });
    await t.test("非主要邮箱动态关联，新增会话立即获得历史摘要",async()=>{
      await client.query("INSERT INTO contact_emails(contact_id,email) VALUES($1,'sam@example.com')",[contacts[2]]);
      assert.deepEqual(await visible(conversations[2]),[inbound,outbound].sort());
      await client.query("DELETE FROM contact_emails WHERE contact_id=$1 AND email='sam@example.com'",[contacts[2]]);
      assert.equal((await latest(conversations[2])).last_message_id,null);
      const contact=randomUUID(),conversation=randomUUID();
      await client.query("INSERT INTO contacts VALUES($1,$2)",[contact,accounts[0]]);
      await client.query("INSERT INTO contact_emails(contact_id,email) VALUES($1,'sam@example.com')",[contact]);
      await client.query("INSERT INTO conversations(id,account_id,contact_id) VALUES($1,$2,$3)",[conversation,accounts[0],contact]);
      assert.equal((await latest(conversation)).last_message_id,outbound);
      await client.query("DELETE FROM contacts WHERE id=$1",[contact]);
    });
    await t.test("合并时间线按消息 ID 去重并保留当前会话回复目标",async()=>{
      await client.query("INSERT INTO conversation_timeline_merges(source_id,target_id) VALUES($1,$2)",[conversations[1],conversations[0]]);
      assert.deepEqual(await visible(conversations[0]),[inbound,outbound,chat].sort());
      assert.equal((await client.query("SELECT conversation_id FROM relay_conversation_messages($1) WHERE message_id=$2",[conversations[0],inbound])).rows[0].conversation_id,conversations[0]);
      await client.query("DELETE FROM conversation_timeline_merges");
    });
    await t.test("修改资料邮箱后移除历史，恢复邮箱后重新可读",async()=>{
      await client.query("UPDATE contact_emails SET email='new@example.com' WHERE contact_id=$1",[contacts[1]]);
      assert.deepEqual(await visible(conversations[1]),[]);assert.equal((await latest(conversations[1])).last_message_id,null);
      await client.query("UPDATE contact_emails SET email='sam@example.com' WHERE contact_id=$1",[contacts[1]]);
      assert.equal((await latest(conversations[1])).last_message_id,outbound);
    });
    await t.test("发送状态与地址修改刷新所有相关摘要",async()=>{
      await client.query("UPDATE messages SET status='sent' WHERE id=$1",[outbound]);
      assert.equal((await latest(conversations[1])).last_message_status,"sent");
      await client.query("UPDATE message_email_details SET to_emails='[\"other@example.com\"]' WHERE message_id=$1",[outbound]);
      assert.equal((await latest(conversations[1])).last_message_id,inbound);
      assert.equal((await latest(conversations[2])).last_message_id,outbound);
      await client.query("UPDATE message_email_details SET to_emails='[\"sam@example.com\"]' WHERE message_id=$1",[outbound]);
    });
    await t.test("删除来源联系人和会话保留共享收发与附件及 HTML",async()=>{
      await client.query("DELETE FROM contacts WHERE id=$1",[contacts[0]]);
      assert.deepEqual(await visible(conversations[1]),[inbound,outbound].sort());
      const saved=(await client.query("SELECT * FROM email_messages WHERE id=$1",[job])).rows[0];
      assert.equal(saved.account_id,accounts[0]);assert.equal(saved.contact_id,null);assert.equal(saved.conversation_id,null);assert.equal(saved.html_body,"<p>original</p>");
      assert.equal((await client.query("SELECT object_key FROM message_email_attachments WHERE message_id=$1",[inbound])).rows[0].object_key,"email/shared-file");
      assert.equal((await client.query("SELECT count(*)::int total FROM messages WHERE id=$1",[chat])).rows[0].total,0);
    });
    await t.test("新发件自动记录渠道，删除共享邮件同步刷新读者摘要",async()=>{
      const nextJob=randomUUID();
      await client.query("INSERT INTO email_messages(id,conversation_id,contact_id,html_body) VALUES($1,$2,$3,'new')",[nextJob,conversations[1],contacts[1]]);
      assert.equal((await client.query("SELECT account_id FROM email_messages WHERE id=$1",[nextJob])).rows[0].account_id,accounts[0]);
      await client.query("DELETE FROM messages WHERE id=$1",[outbound]);assert.equal((await latest(conversations[1])).last_message_id,inbound);
      await client.query("DELETE FROM messages WHERE id=$1",[inbound]);assert.equal((await latest(conversations[1])).last_message_id,null);
    });
  }finally{
    await client.end().catch(()=>{});if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    if(resolve(directory).startsWith(resolve(tmpdir())+sep+"relay-email-archive-test-"))await rm(directory,{recursive:true,force:true});
  }
});
