import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import test from "node:test";
import pg from "pg";

test("PostgreSQL：已有 text 和 transcript 邮件时重复迁移保留记录且约束有效",{skip:!process.env.TRANSCRIPT_PG_BIN},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-transcript-migration-test-")),bin=process.env.TRANSCRIPT_PG_BIN!;
  const run=(name:string,args:string[])=>execFileSync(join(bin,process.platform==="win32"?name+".exe":name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"});let started=false;
  const migration=(name:string)=>readFile(new URL("../../../infra/postgres/migrations/"+name,import.meta.url),"utf8");
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o","-h 127.0.0.1 -p "+port,"-w","start"]);started=true;await client.connect();
    await client.query(`CREATE TYPE delivery_status AS ENUM('queued','sent','failed');
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE channel_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE orders(id uuid PRIMARY KEY);
      CREATE TABLE media(id uuid PRIMARY KEY);
      CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid REFERENCES channel_accounts);
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid REFERENCES conversations,
        account_id uuid REFERENCES channel_accounts,sender_user_id uuid REFERENCES users,client_message_id text,
        direction text,kind text,text_content text,status delivery_status,occurred_at timestamptz,
        UNIQUE(account_id,client_message_id));`);
    await client.query(await migration("032_email_delivery.sql"));
    const email=await migration("089_conversation_email.sql"),transcript=await migration("114_livechat_transcript_content_type.sql");
    await client.query(email);await client.query(transcript);
    await client.query(`WITH account AS (INSERT INTO channel_accounts DEFAULT VALUES RETURNING id)
      INSERT INTO conversations(account_id) SELECT id FROM account;
      INSERT INTO contacts DEFAULT VALUES;
      INSERT INTO email_messages(client_send_id,conversation_id,contact_id,provider,provider_config,provider_secret_encrypted,
        recipients,subject,message_body,text_body,html_body,content_type)
      SELECT gen_random_uuid(),cv.id,co.id,'smtp','{"fromEmail":"support@example.com"}','fixture',
        '[{"email":"visitor@example.com"}]','Original subject','','Original text','<p>Original HTML</p>',kind
      FROM conversations cv CROSS JOIN contacts co CROSS JOIN (VALUES('text'),('livechat_transcript')) kinds(kind);`);
    const before=(await client.query("SELECT * FROM email_messages ORDER BY id")).rows;
    // 先验证旧版约束确实复现生产故障；事务回滚后再运行修复后的真实迁移。
    await client.query("BEGIN");
    await client.query("ALTER TABLE email_messages DROP CONSTRAINT email_messages_content_type_check");
    await assert.rejects(client.query("ALTER TABLE email_messages ADD CONSTRAINT email_messages_content_type_check CHECK(content_type IN ('text','order_text','order_image','order_pdf','product_cards'))"),{code:"23514"});
    await client.query("ROLLBACK");
    for(let startup=0;startup<2;startup++){
      await client.query(email);await client.query(transcript);
      assert.deepEqual((await client.query("SELECT * FROM email_messages ORDER BY id")).rows,before);
      assert.equal((await client.query("SELECT count(*)::int total FROM message_email_details")).rows[0].total,2);
      assert.equal((await client.query("SELECT count(*)::int total FROM messages")).rows[0].total,2);
      await assert.rejects(client.query("UPDATE email_messages SET content_type='invalid'"),{code:"23514"});
    }
    assert.deepEqual((await client.query("SELECT * FROM email_messages ORDER BY id")).rows,before);
    assert.equal((await client.query("SELECT to_regclass('public.whatsapp_accounts') missing")).rows[0].missing,null);
  }finally{
    await client.end().catch(()=>{});if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    if(resolve(directory).startsWith(resolve(tmpdir())+sep+"relay-transcript-migration-test-"))await rm(directory,{recursive:true,force:true});
  }
});
