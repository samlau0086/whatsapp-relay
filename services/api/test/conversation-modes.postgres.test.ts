import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import test from "node:test";
import pg from "pg";

test("PostgreSQL：原始类型迁移幂等、资料变更不改类型、模式过滤兼容渠道枚举",{skip:!process.env.TIMELINE_PG_BIN},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-modes-test-")),bin=process.env.TIMELINE_PG_BIN!;
  const run=(name:string,args:string[])=>execFileSync(join(bin,process.platform==="win32"?`${name}.exe`:name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"});let started=false;
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);started=true;await client.connect();
    await client.query(`CREATE TYPE channel_platform AS ENUM('whatsapp','livechat','messenger');
      CREATE TABLE channel_accounts(id uuid PRIMARY KEY,platform channel_platform);
      CREATE TABLE contacts(id uuid PRIMARY KEY,provider_user_id text,phone_e164 text,whatsapp_username text);
      CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid);
      CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid,account_id uuid);
      CREATE TABLE message_email_details(message_id uuid PRIMARY KEY);
      CREATE FUNCTION relay_conversation_members(uuid) RETURNS SETOF uuid LANGUAGE sql AS $$ SELECT id FROM conversations $$;`);
    const wa=randomUUID(),lc=randomUUID(),contact=randomUUID(),email=randomUUID(),chat=randomUUID();
    await client.query("INSERT INTO channel_accounts VALUES($1,'whatsapp'),($2,'livechat')",[wa,lc]);
    await client.query("INSERT INTO contacts(id) VALUES($1)",[contact]);
    await client.query("INSERT INTO conversations VALUES($1,$2,$3),($4,$5,$3)",[email,wa,contact,chat,lc]);
    const migration=await readFile(new URL("../../../infra/postgres/migrations/106_conversation_origin_mode.sql",import.meta.url),"utf8");
    await client.query(migration);await client.query(migration);
    assert.equal((await client.query("SELECT origin_mode FROM conversations WHERE id=$1",[email])).rows[0].origin_mode,"email");
    assert.equal((await client.query("SELECT origin_mode FROM conversations WHERE id=$1",[chat])).rows[0].origin_mode,"livechat");
    await client.query("UPDATE contacts SET phone_e164='+8613800138000' WHERE id=$1",[contact]);await client.query(migration);
    assert.equal((await client.query("SELECT origin_mode FROM conversations WHERE id=$1",[email])).rows[0].origin_mode,"email");
    const whatsapp=randomUUID();
    await client.query("INSERT INTO conversations VALUES($1,$2,$3,NULL)",[whatsapp,wa,contact]);
    assert.equal((await client.query("SELECT origin_mode FROM conversations WHERE id=$1",[whatsapp])).rows[0].origin_mode,"whatsapp");
    const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
    await client.query("INSERT INTO messages VALUES($1,$2,$3),($4,$5,$6),($7,$2,$3),($8,$5,$6)",[ids[0],whatsapp,wa,ids[1],chat,lc,ids[2],ids[3]]);
    await client.query("INSERT INTO message_email_details VALUES($1),($2)",[ids[2],ids[3]]);
    const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
    const filter=server.match(/\(\$9::text IS NULL OR \(\$9='email'.*?account\.platform::text=\$9\)\)/)?.[0];assert.ok(filter);
    const query=`SELECT msg.id FROM messages msg JOIN channel_accounts account ON account.id=msg.account_id LEFT JOIN message_email_details email_detail ON email_detail.message_id=msg.id WHERE ${filter!.replaceAll("$9","$1")} ORDER BY msg.id`;
    const selected=async(mode:string|null)=>(await client.query(query,[mode])).rows.map(row=>row.id).sort();
    assert.deepEqual(await selected("email"),ids.slice(2).sort());assert.deepEqual(await selected("whatsapp"),[ids[0]]);assert.deepEqual(await selected("livechat"),[ids[1]]);assert.equal((await selected(null)).length,4);
  }finally{
    await client.end().catch(()=>{});if(started)run("pg_ctl",["-D",directory,"-m","fast","-w","stop"]);
    const target=resolve(directory),prefix=resolve(tmpdir())+(process.platform==="win32"?"\\":"/")+"relay-modes-test-";
    if(target.startsWith(prefix))await rm(target,{recursive:true,force:true});
  }
});
