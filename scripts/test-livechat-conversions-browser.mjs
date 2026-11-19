// 使用实际转化组件及样式，API 用测试数据模拟，不连接真实客户或 GA4。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import {chromium} from "playwright";

const require=createRequire(new URL("../services/api/package.json",import.meta.url));
const {build}=require("esbuild");
const root=fileURLToPath(new URL("..",import.meta.url));
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {LivechatConversionsPanel} from './app/livechat-conversions';
import {GoogleAdsSettings} from './app/google-ads-settings';
const noop=()=>{};
const members=[{id:'root',contactId:'contact-root',name:'Alex',latestIncomingAt:null,latestIncomingId:null},{id:'visitor-b',contactId:'contact-b',name:'Blair',latestIncomingAt:null,latestIncomingId:null},{id:'email',contactId:'contact-email',name:'Email 客户',conversionMode:'email',latestIncomingAt:null,latestIncomingId:null}];
createRoot(document.getElementById('root')).render(<><LivechatConversionsPanel conversationId="root" members={members} initialRecipientId="root" token="fixture" onToken={noop} onRecorded={()=>{}}/><GoogleAdsSettings token="fixture" onToken={noop}/></>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_RELAY_API_URL":'""'}});
const css=(await postcss([tailwindcss()]).process(await readFile(resolve(root,"app/globals.css"),"utf8"),{from:resolve(root,"app/globals.css")})).css+await readFile(resolve(root,"app/ui/ui.css"),"utf8")+'html,body{height:auto;overflow:auto}body{padding:16px;font-size:14px}';
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],writes=[];
  let firstWriteFails=true,history=[],purchaseRecorded=false;
  let linked=false,linkFails=true,saveFails=true,adsHistory=[];
  const settings={id:'channel',display_name:'测试渠道',enabled:false,customerId:'1234567890',loginCustomerId:'',qualifyLeadAction:'123',closeConvertLeadAction:'124',purchaseAction:'125',revision:0};
  await page.route('**/api/v1/admin/google-ads',route=>route.fulfill({json:{connected:true,oauthConfigured:true,data:[settings]}}));
  await page.route('**/api/v1/admin/google-ads/channels/channel',async route=>{
    if(saveFails){saveFails=false;return route.fulfill({status:503,json:{message:'模拟保存失败'}});}
    Object.assign(settings,route.request().postDataJSON(),{revision:settings.revision+1});return route.fulfill({json:{saved:true}});
  });
  await page.route(/\/api\/v1\/conversations\/root\/ads-conversions(?:\?|$)/,async route=>{
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();writes.push(body);adsHistory=[{id:'ads-event',event_name:body.eventName,delivery_state:'accepted',created_at:new Date().toISOString()}];
      return route.fulfill({status:201,json:{id:'ads-event',deliveryState:'accepted'}});
    }
    const email=new URL(route.request().url()).searchParams.get('targetConversationId')==='email';
    return route.fulfill({json:{mode:email?'email':'livechat',canRecord:true,orders:[],data:email?adsHistory:[],attribution:!email||linked?{sourceConversationId:'root',consent:'unset',available:true,lockedAt:new Date().toISOString()}:null,candidates:email?[{id:'root',name:'Alex',lockedAt:new Date().toISOString()}]:[]}});
  });
  await page.route('**/api/v1/conversations/root/ads-attribution',route=>{
    if(linkFails){linkFails=false;return route.fulfill({status:503,json:{message:'模拟关联失败'}});}
    linked=true;return route.fulfill({json:{saved:true}});
  });
  page.on("pageerror",error=>errors.push(error.message));
  await page.route(/\/api\/v1\/conversations\/root\/livechat-conversions\?/,async route=>{
    const target=new URL(route.request().url()).searchParams.get("targetConversationId")||"root";
    return route.fulfill({json:{data:history.filter(item=>item.conversation_id===target),canRecord:true,analytics:{consent:"granted",clientIdAvailable:true,configured:true},orders:[...(target==="root"?[{id:"order-1",display_order_number:"ORD-101",amount:"45.00",currency:"USD",recorded:purchaseRecorded}]:[])]}});
  });
  await page.route("**/api/v1/conversations/root/livechat-conversions",async route=>{
    const body=route.request().postDataJSON();writes.push(body);
    if(firstWriteFails&&body.eventName==="qualify_lead"){firstWriteFails=false;return route.fulfill({status:503,json:{message:"测试网络失败"}});}
    if(body.eventName==="purchase")purchaseRecorded=true;
    history.unshift({id:"event-"+writes.length,conversation_id:body.targetConversationId,event_name:body.eventName,delivery_state:body.eventName==="purchase"?"queued":"skipped_client_id",created_at:new Date().toISOString(),order_id:body.orderId||null});
    return route.fulfill({status:201,json:{id:"event-"+writes.length,deliveryState:body.eventName==="purchase"?"queued":"skipped_client_id"}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const toggle=page.getByRole("button",{name:"转化事件"});await toggle.click();
  await page.getByLabel("记录给访客").selectOption("visitor-b");
  await page.getByLabel("事件类型").selectOption("qualify_lead");
  const record=page.getByRole("button",{name:"记录事件"});
  await record.click();await page.getByRole("alert").waitFor();
  assert.equal(await page.getByLabel("事件类型").inputValue(),"qualify_lead");
  await record.click();await page.getByText(/已记录：未取得有效 GA4 Client ID/).waitFor();
  assert.equal(writes[0].clientEventId,writes[1].clientEventId,"失败重试沿用同一幂等 ID");
  assert.equal(writes[1].targetConversationId,"visitor-b");
  await page.getByLabel("记录给访客").selectOption("root");
  await page.getByLabel("事件类型").selectOption("purchase");
  await page.getByLabel("已付款订单").selectOption("order-1");
  await page.getByRole("button",{name:"记录事件"}).click();
  await page.getByText("已记录：等待回传",{exact:false}).waitFor();
  assert.equal(writes.at(-1).eventName,"purchase");assert.equal(writes.at(-1).orderId,"order-1");
  await page.waitForFunction(()=>document.body.textContent.includes("订单：ORD-101"));
  assert.equal(await page.getByLabel("已付款订单").locator('option[value="order-1"]').count(),0,"已记录订单从候选中移除");
  await page.getByLabel('记录给访客').selectOption('email');
  const source=page.getByLabel('原 LiveChat 会话 ID');await source.fill('root');
  await page.getByRole('button',{name:'确认关联',exact:true}).click();await page.getByText('模拟关联失败').waitFor();assert.equal(await source.inputValue(),'root');
  await page.getByRole('button',{name:'确认关联',exact:true}).click();await source.waitFor({state:'detached'});
  assert.equal(await page.getByLabel('事件类型').locator('option').count(),3);
  await page.getByRole('button',{name:'记录事件',exact:true}).click();await page.getByText('已记录：Google 已接收，待处理').waitFor();
  assert.equal(writes.at(-1).targetConversationId,'email');await page.getByText(/Ads：API 已接收，待处理/).waitFor();
  const customer=page.getByLabel('Google Ads 客户 ID',{exact:true});await customer.fill('9876543210');
  await page.getByLabel('启用 Ads 回传').check();await page.getByRole('button',{name:'保存 Ads 配置',exact:true}).click();
  await page.getByText('模拟保存失败').waitFor();assert.equal(await customer.inputValue(),'9876543210');assert.equal(await page.getByLabel('启用 Ads 回传').isChecked(),true);
  await page.getByRole('button',{name:'保存 Ads 配置',exact:true}).click();await page.waitForFunction(()=>!document.body.textContent.includes('模拟保存失败'));
  assert.equal(settings.customerId,'9876543210');assert.equal(settings.enabled,true);
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:resolve(root,"outputs/livechat-conversions-browser.png"),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log("转化浏览器验收通过：访客隔离选择、失败保留、幂等重试、purchase 去重显示和窄屏布局（模拟 API）。");
}finally{await browser.close();await new Promise(done=>server.close(done));}
