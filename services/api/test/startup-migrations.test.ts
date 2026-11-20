import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {pool} from "../src/db.js";
import {migrateAgentSchema} from "../src/migrate-agent.js";

const migration=(name:string)=>readFile(new URL("../../../infra/postgres/migrations/"+name,import.meta.url),"utf8");

test("新版渠道数据库重复启动不再访问 whatsapp_accounts，089 保留 transcript 类型",async t=>{
  const calls:string[]=[];
  let releases=0;
  t.mock.method(pool,"connect",async()=>({
    async query(sql:string){
      calls.push(sql);
      return {rows:sql.includes("channel_schema")?[{channel_schema:true}]:[]};
    },
    release(){releases++;},
  }));
  await migrateAgentSchema();
  const first=[...calls];calls.length=0;
  await migrateAgentSchema();
  assert.deepEqual(calls,first);
  assert.equal(releases,2);
  assert.equal(first[0],"SELECT pg_advisory_lock(774129703)");
  assert.equal(first.at(-1),"SELECT pg_advisory_unlock(774129703)");
  assert.ok(!first.includes(await migration("014_ai_agent.sql")));
  const email=await migration("089_conversation_email.sql"),transcript=await migration("114_livechat_transcript_content_type.sql");
  assert.ok(first.indexOf(email)>0);
  assert.ok(first.indexOf(transcript)>first.indexOf(email));
  for(const sql of [email,transcript])assert.match(sql,/CHECK\s*\(content_type IN \([^)]*'livechat_transcript'/);
});

test("迁移失败包含文件名与原始 SQLSTATE，释放会话锁且不执行后续迁移",async t=>{
  const failedSql=await migration("089_conversation_email.sql");
  const original=Object.assign(new Error("constraint violation"),{code:"23514"});
  const calls:string[]=[];let released=false;
  t.mock.method(pool,"connect",async()=>({
    async query(sql:string){
      calls.push(sql);
      if(sql===failedSql)throw original;
      return {rows:sql.includes("channel_schema")?[{channel_schema:true}]:[]};
    },
    release(){released=true;},
  }));
  await assert.rejects(migrateAgentSchema(),error=>{
    assert.equal((error as Error).message,"agent_schema_migration_failed:089_conversation_email.sql");
    assert.equal((error as {code:string}).code,"23514");
    assert.equal((error as Error).cause,original);
    return true;
  });
  assert.equal(calls.filter(sql=>sql===failedSql).length,1);
  assert.ok(!calls.includes(await migration("114_livechat_transcript_content_type.sql")));
  assert.equal(calls.at(-1),"SELECT pg_advisory_unlock(774129703)");
  assert.equal(released,true);
});
