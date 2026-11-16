import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import pg from "pg";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {credentialHash,registerLivechatPublicRoutes} from "../src/livechat-public.js";
import {registerLivechatRoutes} from "../src/livechat.js";

// 只在显式提供路径时创建临时数据库，不连接业务数据库。
test("PostgreSQL：多标签状态、乱序关闭、超时离线及当前页面选择",{skip:!process.env.LIVECHAT_PG_BIN},async t=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-presence-test-"));
  const run=(name:string,args:string[])=>execFileSync(join(process.env.LIVECHAT_PG_BIN!,process.platform==="win32"?`${name}.exe`:name),args,{windowsHide:true,stdio:"ignore",timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const client=new pg.Client({host:"127.0.0.1",port,user:"postgres",database:"postgres"});
  const app=Fastify();let started=false;
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);started=true;
    await client.connect();
    await client.query(`CREATE TABLE channel_accounts(id uuid PRIMARY KEY,display_name text);
      CREATE TABLE livechat_channels(account_id uuid PRIMARY KEY,public_id uuid,enabled boolean,archived_at timestamptz,allowed_origins text[]);
      CREATE TABLE livechat_visitors(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,credential_hash text,embed_origin text,expires_at timestamptz);
      CREATE TABLE livechat_rate_limits(bucket text,window_start timestamptz,hits int,PRIMARY KEY(bucket,window_start));`);
    const migration=await readFile(new URL("../../../infra/postgres/migrations/105_livechat_presence.sql",import.meta.url),"utf8");
    await client.query(migration);await client.query(migration);
    t.mock.method(pool,"query",(sql:string,values:unknown[]=[])=>client.query(sql,values));
    await registerLivechatRoutes(app);await registerLivechatPublicRoutes(app);
    const accountId=randomUUID(),publicId=randomUUID(),visitorId=randomUUID(),contactId=randomUUID(),first=randomUUID(),second=randomUUID();
    const origin="https://shop.example.com",secret="a".repeat(64);
    await client.query("INSERT INTO channel_accounts VALUES($1,'测试网站')",[accountId]);
    await client.query("INSERT INTO livechat_channels VALUES($1,$2,true,NULL,$3)",[accountId,publicId,[origin]]);
    await client.query("INSERT INTO livechat_visitors VALUES($1,$2,$3,$4,$5,now()+interval '1 day')",[visitorId,accountId,contactId,credentialHash(secret),origin]);
    const send=async(sessionId:string,sequence:number,visible:boolean,connected=true,path="/current")=>{
      const response=await app.inject({method:"POST",url:`/livechat/${publicId}/presence`,headers:{origin,authorization:`Bearer ${secret}`},payload:{sessionId,sequence,visible,connected,pageUrl:origin+path}});
      assert.equal(response.statusCode,200,response.body);
    };
    const read=async()=>{
      const response=await app.inject({method:"POST",url:"/api/v1/livechat/presence/query",headers:{authorization:`Bearer ${signToken({sub:randomUUID(),role:"admin"},config.JWT_SECRET,60)}`},payload:{contactIds:[contactId]}});
      assert.equal(response.statusCode,200,response.body);return response.json().data[0];
    };
    assert.deepEqual(await read(),{contactId,status:"offline",pageUrl:null});
    await send(first,1,true,true,"/first?private=1#secret");
    assert.deepEqual(await read(),{contactId,status:"online",pageUrl:origin+"/first"});
    await send(second,1,false,true,"/hidden");
    assert.equal((await read()).pageUrl,origin+"/first","后台标签页的新心跳不覆盖可见页面");
    await send(second,2,true,true,"/second");assert.equal((await read()).pageUrl,origin+"/second");
    await send(second,4,true,false);await send(second,3,true,true,"/late");
    assert.equal((await read()).pageUrl,origin+"/first","迟到心跳不能复活已关闭标签页，另一页仍在线");
    await send(first,2,false);
    assert.deepEqual(await read(),{contactId,status:"away",pageUrl:null});
    await send(first,3,true);assert.equal((await read()).status,"online");
    await client.query("UPDATE livechat_presence SET updated_at=now()-interval '46 seconds'");
    assert.deepEqual(await read(),{contactId,status:"offline",pageUrl:null});
    await send(first,4,true);assert.equal((await read()).status,"online");
    await client.query("UPDATE livechat_channels SET enabled=false");assert.equal((await read()).status,"offline");
    await client.query("UPDATE livechat_channels SET enabled=true");
    await client.query("UPDATE livechat_visitors SET expires_at=now()-interval '1 second'");assert.equal((await read()).status,"offline");
    await client.query("DELETE FROM livechat_visitors");assert.equal((await client.query("SELECT * FROM livechat_presence")).rowCount,0);
  }finally{
    await app.close();await client.end().catch(()=>{});
    if(started)run("pg_ctl",["-D",directory,"-m","immediate","-w","stop"]);
    await rm(directory,{recursive:true,force:true});
  }
});
