import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import test from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";

const source=await readFile(new URL("../app/livechat-visitor-details.tsx",import.meta.url),"utf8");
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const output={};runInNewContext(javascript,{exports:output,require:createRequire(import.meta.url)});
const {LivechatVisitorDetails}=output;

test("网站访客信息展示环境字段并转义访客自报文本",()=>{
  const html=renderToStaticMarkup(LivechatVisitorDetails({companyName:"Example Ltd",visitor:{
    firstIp:"203.0.113.1",lastIp:"203.0.113.2",embedOrigin:"https://shop.example.com",
    context:{browserLanguage:"en-US",timeZone:"Asia/Shanghai",pageUrl:"https://shop.example.com/products",userAgent:'<script>alert("xss")</script>'},
    createdAt:"2026-11-14T01:00:00Z",lastSeenAt:"2026-11-14T02:00:00Z",
  }}));
  for(const text of ["网站访客信息","Example Ltd","203.0.113.1","203.0.113.2","en-US","Asia/Shanghai","https://shop.example.com/products"])assert.ok(html.includes(text));
  assert.ok(html.includes("&lt;script&gt;"));assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("credential"));
});

test("旧客户无访客资料时不显示空白环境面板",()=>{
  assert.equal(renderToStaticMarkup(LivechatVisitorDetails({})),"");
});

test("访客环境迁移幂等且只由现有私有客户详情返回",async()=>{
  const migration=await readFile(new URL("../infra/postgres/migrations/099_livechat_visitor_profile.sql",import.meta.url),"utf8");
  assert.equal((migration.match(/ADD COLUMN IF NOT EXISTS/g)||[]).length,3);
  const startup=await readFile(new URL("../services/api/src/migrate-agent.ts",import.meta.url),"utf8");
  assert.match(startup,/099_livechat_visitor_profile.sql/);
  const server=await readFile(new URL("../services/api/src/server.ts",import.meta.url),"utf8");
  assert.match(server,/if\(profile.platform!=="livechat"\)return profile/);
  assert.match(server,/FROM livechat_visitors WHERE contact_id=\$1 AND account_id=\$2/);
});
