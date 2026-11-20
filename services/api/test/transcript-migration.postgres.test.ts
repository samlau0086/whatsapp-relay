import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import test from "node:test";
import pg from "pg";
import {randomUUID} from "node:crypto";
import {queueLivechatTranscript} from "../src/livechat-transcript.js";

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
    await client.query(`CREATE TYPE delivery_status AS ENUM('queued','sent','delivered','read','failed');
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

    // 在独立数据库中验证真实边界查询、历史补齐和多段导出，Provider 使用固定测试配置。
    await client.query(`ALTER TABLE messages ADD COLUMN created_at timestamptz DEFAULT now();
      ALTER TABLE messages ADD COLUMN media_id uuid;
      ALTER TABLE users ADD COLUMN display_name text;
      ALTER TABLE media ADD COLUMN file_name text;
      CREATE TABLE livechat_visitors(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      INSERT INTO livechat_visitors DEFAULT VALUES;`);
    await client.query(await migration("101_livechat_end_requests.sql"));
    const scope=(await client.query(`SELECT cv.id conversation_id,cv.account_id,co.id contact_id,v.id visitor_id
      FROM conversations cv CROSS JOIN contacts co CROSS JOIN livechat_visitors v LIMIT 1`)).rows[0];
    const ends=[randomUUID(),randomUUID()];
    for(const [index,id] of ends.entries())await client.query(`INSERT INTO livechat_end_requests(request_id,visitor_id,conversation_id,account_id,contact_id,send_transcript,created_at)
      VALUES($1,$2,$3,$4,$5,false,$6)`,[id,scope.visitor_id,scope.conversation_id,scope.account_id,scope.contact_id,`2026-11-20T10:${index===0?'10':'20'}:00Z`]);
    for(const [text,time] of [['first','05'],['edge','10'],['second','15'],['current','25']])await client.query(`INSERT INTO messages(conversation_id,account_id,direction,kind,text_content,status,occurred_at)
      VALUES($1,$2,'in','text',$3,'sent',$4)`,[scope.conversation_id,scope.account_id,text,`2026-11-20T10:${time}:00Z`]);
    const boundariesMigration=await migration("116_livechat_session_boundaries.sql");
    await client.query(boundariesMigration);await client.query(boundariesMigration);
    assert.equal((await client.query("SELECT count(*)::int n FROM messages WHERE livechat_end_request_id IS NOT NULL")).rows[0].n,2);
    let state='open';
    const adapter={query:async(sql:string,values:unknown[]=[])=>{
      if(sql.includes('JOIN email_provider_instances'))return {rows:[{provider:'smtp',config:{fromEmail:'test@example.com'},secret_encrypted:'fixture'}],rowCount:1};
      if(sql.includes('SELECT cv.created_at'))return {rows:[{created_at:'2026-11-20T10:00:00Z',status:state,visitor_name:'Test',snapshot_at:'2026-11-20T10:30:00Z'}],rowCount:1};
      return client.query(sql,values);
    }} as unknown as Parameters<typeof queueLivechatTranscript>[0];
    const exportSegment=async(ending=false,endRequestId?:string)=>{
      const job=await queueLivechatTranscript(adapter,{...scope,recipient_email:'test@example.com'},randomUUID(),null,ending,endRequestId);
      return (await client.query('SELECT text_body,livechat_end_request_id FROM email_messages WHERE id=$1',[job.emailId])).rows[0];
    };
    const current=await exportSegment();assert.match(current.text_body,/current/);assert.doesNotMatch(current.text_body,/first|second|Chat Ended|Original text/);
    const ending=await exportSegment(true);assert.match(ending.text_body,/current/);assert.doesNotMatch(ending.text_body,/first|second/);
    const first=await exportSegment(false,ends[0]);assert.match(first.text_body,/first/);assert.match(first.text_body,/edge/);assert.doesNotMatch(first.text_body,/second|current|Chat Ended/);assert.equal(first.livechat_end_request_id,ends[0]);
    const second=await exportSegment(false,ends[1]);assert.match(second.text_body,/second/);assert.doesNotMatch(second.text_body,/first|edge|current|Chat Ended/);
    state='closed';const latest=await exportSegment();assert.match(latest.text_body,/second/);assert.doesNotMatch(latest.text_body,/first|current/);
    await assert.rejects(exportSegment(false,randomUUID()),/transcript_boundary_not_found/);
  }finally{
    await client.end().catch(()=>{});if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    if(resolve(directory).startsWith(resolve(tmpdir())+sep+"relay-transcript-migration-test-"))await rm(directory,{recursive:true,force:true});
  }
});
