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
import {encryptAtRest,signToken} from "../src/security.js";
import {analyticsSchema,conversionSchema,processOneLivechatConversion,registerLivechatAnalyticsRoutes,saveVisitorAnalytics} from "../src/livechat-analytics.js";

test("禁止手工 generate_lead，购买只能从订单读取金额",()=>{
  const clientEventId=randomUUID();
  assert.ok(!conversionSchema.safeParse({clientEventId,eventName:"generate_lead"}).success);
  assert.ok(!conversionSchema.safeParse({clientEventId,eventName:"purchase",orderId:randomUUID(),value:100,currency:"USD"}).success);
  assert.ok(!conversionSchema.safeParse({clientEventId,eventName:"lead_example@example.com"}).success);
  assert.ok(conversionSchema.safeParse({clientEventId,eventName:"qualify_lead"}).success);
});

test("未设置分析状态时按默认启用策略接受 Measurement ID 和 Client ID，但明确拒绝不能携带标识",()=>{
  const context={consent:"unset" as const,updatedAt:Date.now(),measurementId:"G-TEST123",clientId:"123.456"};
  assert.ok(analyticsSchema.safeParse(context).success);
  assert.ok(analyticsSchema.safeParse({consent:"unset",updatedAt:Date.now()}).success);
  assert.ok(!analyticsSchema.safeParse({...context,consent:"denied"}).success);
});

// 临时 PostgreSQL 实例及模拟 Google 请求，不连接业务库或真实 GA4。
test("PostgreSQL：转化权限、订单归属和并发去重、撤回同意及独立队列",{skip:!process.env.LIVECHAT_PG_BIN},async t=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-conversion-test-"));
  const run=(name:string,args:string[])=>execFileSync(join(process.env.LIVECHAT_PG_BIN!,process.platform==="win32"?name+".exe":name),args,{stdio:"ignore",windowsHide:true,timeout:60000});
  const listener=createServer();await new Promise<void>(done=>listener.listen(0,"127.0.0.1",done));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(done=>listener.close(()=>done()));
  const database=new pg.Pool({host:"127.0.0.1",port,user:"postgres",database:"postgres"});
  const app=Fastify();
  let started=false;
  try{
    run("initdb",["-D",directory,"-A","trust","-U","postgres","--encoding=UTF8","--no-locale"]);
    run("pg_ctl",["-D",directory,"-l",join(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p ${port}`,"-w","start"]);started=true;
    await database.query(`CREATE TABLE channel_accounts(id uuid PRIMARY KEY);
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE account_permissions(account_id uuid,user_id uuid,can_read boolean,can_send boolean);
      CREATE TABLE contacts(id uuid PRIMARY KEY);
      CREATE TABLE conversations(id uuid PRIMARY KEY,account_id uuid,contact_id uuid,origin_mode text,customer_stage text DEFAULT 'new');
      CREATE TABLE messages(id uuid PRIMARY KEY);
      CREATE TABLE orders(id uuid PRIMARY KEY,conversation_id uuid,display_order_number text,amount numeric,currency text,shipping_amount numeric,
        business_status text,deleted_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE order_payment_requests(order_id uuid,environment text,status text,amount numeric,currency text);
      CREATE TABLE order_items(id uuid PRIMARY KEY,order_id uuid,position int,product_id uuid,quantity int,unit_amount numeric);
      CREATE TABLE audit_log(actor_type text,actor_id text,action text,target_type text,target_id text,metadata jsonb);
      CREATE FUNCTION relay_publish_conversation_change(uuid,uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
      CREATE TYPE channel_platform AS ENUM ('whatsapp');
    `);
    const migration=(file:string)=>readFile(new URL("../../../infra/postgres/migrations/"+file,import.meta.url),"utf8");
    await database.query(await migration("097_livechat_schema.sql"));
    await database.query(await migration("102_conversation_timeline_merges.sql"));
    const conversionMigration=await migration("111_livechat_ga4_conversions.sql");
    await database.query(conversionMigration);await database.query(conversionMigration);
    const account=randomUUID(),anotherAccount=randomUUID(),contact=randomUUID(),anotherContact=randomUUID(),visitor=randomUUID(),anotherVisitor=randomUUID(),root=randomUUID(),member=randomUUID(),actor=randomUUID();
    const order=randomUUID(),sandbox=randomUUID(),partial=randomUUID(),foreign=randomUUID(),manual=randomUUID();
    const measurementId="G-TEST123",secret="test-secret_not-real",encrypted=encryptAtRest(secret,config.DATA_ENCRYPTION_KEY);
    await database.query("INSERT INTO channel_accounts VALUES($1),($2)",[account,anotherAccount]);
    await database.query("INSERT INTO users VALUES($1)",[actor]);
    await database.query("INSERT INTO contacts VALUES($1),($2)",[contact,anotherContact]);
    await database.query("INSERT INTO livechat_channels(account_id,ga4_measurement_id,ga4_api_secret_encrypted) VALUES($1,$3,$4),($2,$3,$4)",[account,anotherAccount,measurementId,encrypted]);
    await database.query("INSERT INTO conversations(id,account_id,contact_id,origin_mode) VALUES($1,$2,$3,'livechat'),($4,$5,$6,'livechat')",[root,account,contact,member,anotherAccount,anotherContact]);
    await database.query("INSERT INTO conversation_timeline_merges(source_id,target_id) VALUES($1,$2)",[member,root]);
    await database.query("INSERT INTO livechat_visitors(id,account_id,contact_id,credential_hash,embed_origin) VALUES($1,$2,$3,'first','https://one.example'),($4,$5,$6,'second','https://two.example')",[visitor,account,contact,anotherVisitor,anotherAccount,anotherContact]);
    await database.query("INSERT INTO account_permissions VALUES($1,$3,true,false),($2,$3,true,false)",[account,anotherAccount,actor]);
    for(const [id,target,label,status,environment,providerStatus] of [
      [order,member,"ORD-123","pending_payment","live","PAID"],
      [sandbox,member,"sandbox","paid","sandbox","PAID"],
      [partial,member,"partial","paid","live","PARTIALLY_PAID"],
      [foreign,root,"different visitor","paid",null,null],
      [manual,member,"manual payment","shipped",null,null],
    ]){
      await database.query("INSERT INTO orders(id,conversation_id,display_order_number,amount,currency,shipping_amount,business_status) VALUES($1,$2,$3,45,'USD',5,$4)",[id,target,label,status]);
      await database.query("INSERT INTO order_items VALUES(gen_random_uuid(),$1,0,NULL,2,20)",[id]);
      if(environment)await database.query("INSERT INTO order_payment_requests VALUES($1,$2,$3,45,'USD')",[id,environment,providerStatus]);
    }
    const updatedAt=Date.now();
    const unsetEnabled={consent:"unset" as const,clientId:"123.456",measurementId,updatedAt};
    assert.equal(await saveVisitorAnalytics(database,anotherVisitor,measurementId,{...unsetEnabled,measurementId:"G-WRONG"}),false);
    assert.equal(await saveVisitorAnalytics(database,anotherVisitor,measurementId,unsetEnabled),true);
    assert.equal((await database.query("SELECT analytics_consent FROM livechat_visitors WHERE id=$1",[anotherVisitor])).rows[0].analytics_consent,"unset","unset 保留 CMP 来源状态");
    t.mock.method(pool,"query",(sql:string,values:unknown[]=[])=>database.query(sql,values));
    t.mock.method(pool,"connect",()=>database.connect());
    await registerLivechatAnalyticsRoutes(app);
    const path=`/api/v1/conversations/${root}/livechat-conversions`;
    const headers=(role:string)=>({authorization:`Bearer ${signToken({sub:actor,role},config.JWT_SECRET,60)}`});
    const get=(role="agent")=>app.inject({method:"GET",url:path+"?targetConversationId="+member,headers:headers(role)});
    const post=(eventName:string,orderId?:string,role="agent",clientEventId=randomUUID())=>app.inject({method:"POST",url:path,headers:headers(role),payload:{eventName,clientEventId,targetConversationId:member,...(orderId?{orderId}:{})}});
    const before=await get();
    assert.equal(before.statusCode,200,before.body);assert.equal(before.json().canRecord,false);
    assert.deepEqual(before.json().orders.map((row:{id:string})=>row.id),[order]);
    assert.doesNotMatch(before.body,/123\.456|test-secret|ga4_api_secret/);
    assert.equal((await post("qualify_lead")).statusCode,403);
    await database.query("UPDATE account_permissions SET can_send=true WHERE account_id=$1",[anotherAccount]);
    for(const invalidOrder of [foreign,partial,sandbox,manual])assert.equal((await post("purchase",invalidOrder)).json().error,"purchase_paid_order_required");
    const purchaseId=randomUUID();
    const concurrent=await Promise.all([post("purchase",order,"agent",purchaseId),post("purchase",order)]);
    assert.deepEqual(concurrent.map(result=>result.statusCode).sort(),[201,409],concurrent.map(result=>result.body).join("\n"));
    const winning=concurrent.find(result=>result.statusCode===201)!;
    assert.equal(winning.json().deliveryState,"queued","CMP 状态 unset 时按默认启用策略进入 GA4 队列");
    if(concurrent[0]===winning)assert.equal((await post("purchase",order,"agent",purchaseId)).json().deduplicated,true);
    assert.equal((await database.query("SELECT customer_stage FROM conversations WHERE id=$1",[member])).rows[0].customer_stage,"won");
    assert.equal((await database.query("SELECT customer_stage FROM conversations WHERE id=$1",[root])).rows[0].customer_stage,"new");
    const measurementRequests:Array<{url:URL;body:Record<string,unknown>}>=[];
    let interrupt=false;
    t.mock.method(globalThis,"fetch",async(url:URL,options:RequestInit)=>{
      measurementRequests.push({url,body:JSON.parse(String(options.body))});
      if(interrupt)throw new Error("测试响应丢失");
      return new Response(null,{status:204});
    });
    assert.equal(await processOneLivechatConversion(),true);
    assert.equal(measurementRequests.length,1);assert.equal(measurementRequests[0].url.searchParams.get("api_secret"),secret);
    assert.deepEqual(measurementRequests[0].body.events,[{name:"purchase",params:{
      lead_source:"livechat",transaction_id:order,currency:"USD",value:40,shipping:5,event_id:winning.json().id,
      items:[{item_id:(await database.query("SELECT id FROM order_items WHERE order_id=$1",[order])).rows[0].id,item_name:"Custom item",quantity:2,price:20}],
    }}]);
    const leadId=randomUUID();
    const lead=await post("qualify_lead",undefined,"agent",leadId);assert.equal(lead.statusCode,201,lead.body);
    await saveVisitorAnalytics(database,anotherVisitor,measurementId,{consent:"denied",updatedAt:updatedAt+1});
    await saveVisitorAnalytics(database,anotherVisitor,measurementId,unsetEnabled);
    assert.equal((await post("qualify_lead",undefined,"agent",leadId)).json().deliveryState,"skipped_consent");
    assert.equal(await processOneLivechatConversion(),false);
    await saveVisitorAnalytics(database,anotherVisitor,measurementId,{...unsetEnabled,updatedAt:updatedAt+2});
    const changed=await post("working_lead");assert.equal(changed.json().deliveryState,"queued");
    await database.query("UPDATE livechat_channels SET ga4_api_secret_encrypted=$2 WHERE account_id=$1",[anotherAccount,encryptAtRest("rotated",config.DATA_ENCRYPTION_KEY)]);
    assert.equal(await processOneLivechatConversion(),true);assert.equal(measurementRequests.length,1);
    const last=await post("close_convert_lead");assert.equal(last.json().deliveryState,"queued");
    interrupt=true;assert.equal(await processOneLivechatConversion(),true);assert.equal(await processOneLivechatConversion(),false);
    const events=(await get()).json().data as Array<{id:string;delivery_state:string}>;
    assert.equal(events.find(event=>event.id===last.json().id)?.delivery_state,"uncertain");
    assert.equal(events.find(event=>event.id===changed.json().id)?.delivery_state,"skipped_config");
    await database.query("UPDATE account_permissions SET can_read=false WHERE account_id=$1",[account]);
    assert.equal((await get()).statusCode,404);
    assert.equal(measurementRequests.length,2);
  }finally{
    await app.close();await database.end();
    if(started)run("pg_ctl",["-D",directory,"-m","immediate","-w","stop"]);
    await rm(directory,{recursive:true,force:true});
  }
});
