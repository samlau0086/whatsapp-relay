import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import Fastify from "fastify";
import {pool} from "../src/db.js";
import {config} from "../src/config.js";
import {signToken} from "../src/security.js";
import {registerLivechatRoutes} from "../src/livechat.js";
import {registerLivechatPublicRoutes} from "../src/livechat-public.js";
import {defaultWorkingHours,isLivechatWorkingTime} from "../src/livechat-working-hours.js";

test("工作时间按渠道时区判断，包含开始、不包含结束，支持跨午夜",()=>{
  const hours={...defaultWorkingHours,enabled:true};
  for(const [time,expected] of [["00:59",false],["01:00",true],["09:59",true],["10:00",false]] as const){
    assert.equal(isLivechatWorkingTime(hours,new Date(`2026-11-20T${time}:00Z`)),expected,time);
  }
  const overnight={...hours,start:"22:00",end:"06:00",timeZone:"UTC"};
  for(const [time,expected] of [["21:59",false],["22:00",true],["00:00",true],["05:59",true],["06:00",false]] as const){
    assert.equal(isLivechatWorkingTime(overnight,new Date(`2026-11-20T${time}:00Z`)),expected,time);
  }
  assert.equal(isLivechatWorkingTime(null),true);
  assert.equal(isLivechatWorkingTime(defaultWorkingHours),true);
});

test("工作时区自动应用夏令时",()=>{
  const hours={enabled:true,timeZone:"America/New_York",start:"09:00",end:"18:00"};
  assert.equal(isLivechatWorkingTime(hours,new Date("2026-07-01T13:00:00Z")),true);
  assert.equal(isLivechatWorkingTime(hours,new Date("2026-01-01T13:00:00Z")),false);
  const repeated={...hours,start:"01:00",end:"02:00"};
  assert.equal(isLivechatWorkingTime(repeated,new Date("2026-11-01T05:30:00Z")),true);
  assert.equal(isLivechatWorkingTime(repeated,new Date("2026-11-01T06:30:00Z")),true);
});

test("工作时段迁移已接入启动序列并支持重复执行",async()=>{
  const migration=await readFile(new URL('../../../infra/postgres/migrations/117_livechat_working_hours.sql',import.meta.url),'utf8');
  const migrator=await readFile(new URL('../src/migrate-agent.ts',import.meta.url),'utf8');
  assert.match(migration,/ADD COLUMN IF NOT EXISTS working_hours jsonb/);
  assert.match(migration,/DROP CONSTRAINT IF EXISTS livechat_working_hours_object/);
  assert.match(migrator,/117_livechat_working_hours.sql/);
});

test("渠道工作时段保存、公开读取、旧请求保留及非法参数校验",async t=>{
  const id="11111111-1111-4111-8111-111111111111",origin="https://example.com";
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const hours={...defaultWorkingHours,enabled:true,start:"22:00",end:"06:00"};
  const query=async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values});
    const rows=sql.includes("INSERT INTO livechat_rate_limits")?[{hits:1}]:[{id,account_id:id,public_id:id,display_name:"测试客服",allowed_origins:[origin],working_hours:hours}];
    return {rows,rowCount:rows.length};
  };
  t.mock.method(pool,"query",query);t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const app=Fastify();await registerLivechatRoutes(app);await registerLivechatPublicRoutes(app);t.after(()=>app.close());
  const headers={authorization:`Bearer ${signToken({sub:id,role:"admin"},config.JWT_SECRET,60)}`};
  const base="/api/v1/admin/livechat/channels",payload={displayName:"测试客服",allowedOrigins:[origin]};
  assert.equal((await app.inject({method:"POST",url:base,headers,payload:{...payload,workingHours:hours}})).statusCode,201);
  assert.deepEqual(JSON.parse(String(calls.find(c=>c.sql.startsWith("UPDATE livechat_channels SET working_hours"))!.values[1])),hours);
  const update=async(workingHours?:unknown)=>app.inject({method:"PUT",url:`${base}/${id}`,headers,payload:{...payload,...(workingHours===undefined?{}:{workingHours})}});
  assert.equal((await update(hours)).statusCode,200);
  assert.deepEqual(JSON.parse(String(calls.filter(c=>c.sql.startsWith("UPDATE livechat_channels SET welcome_message")).at(-1)!.values[14])),hours);
  assert.equal((await update()).statusCode,200);
  const last=calls.filter(c=>c.sql.startsWith("UPDATE livechat_channels SET welcome_message")).at(-1)!;
  assert.equal(last.values[14],null);assert.match(last.sql,/working_hours=COALESCE\(\$15::jsonb,working_hours\)/);
  const response=await app.inject({url:`/livechat/${id}/config`,headers:{origin}});
  assert.equal(response.statusCode,200);assert.deepEqual(response.json().workingHours,hours);assert.ok(Number.isFinite(response.json().serverTime));
  for(const invalid of [{...hours,timeZone:"Invalid/Zone"},{...hours,start:"24:00"},{...hours,end:"9:00"},{...hours,end:"22:00"},null]){
    const count=calls.length;assert.equal((await update(invalid)).statusCode,400);assert.equal(calls.length,count);
    assert.equal((await app.inject({method:"POST",url:base,headers,payload:{...payload,workingHours:invalid}})).statusCode,400);
  }
  assert.equal((await update({...hours,enabled:false,end:hours.start})).statusCode,200);
});
