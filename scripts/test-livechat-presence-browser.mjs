// 使用真实状态 Hook 和访客面板，模拟 API，不操作业务数据。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const root=fileURLToPath(new URL("..",import.meta.url));
const require=createRequire(new URL("../services/api/package.json",import.meta.url));
const {build}=require("esbuild");
const entry=`import React,{useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {useLivechatPresence,visitorStatusLabel} from './app/livechat-presence';
import {LivechatVisitorDetails} from './app/livechat-visitor-details';
import {ConversationListRow} from './app/conversation-list-row';
function App(){
  const request=useCallback(async(contactIds,signal)=>{
    const response=await fetch('/api/v1/livechat/presence/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contactIds}),signal});
    if(!response.ok)throw Error('读取失败');return (await response.json()).data;
  },[]);
  const data=useLivechatPresence(['visitor'],true,request);
  const item={id:'conversation',contactId:'visitor',platform:'livechat',account:'测试网站',accountStatus:'online',name:'测试访客',initials:'访',tags:[],unread:0,color:'#467c65',visitorPresence:data.visitor};
  const visitor={embedOrigin:'https://shop.example.com',context:{pageUrl:'https://shop.example.com/message-snapshot'},firstIp:'203.0.113.1',lastIp:'203.0.113.1'};
  return <main><aside><ConversationListRow item={item} onSelect={()=>{}}/></aside><section><p aria-label="访客状态">{visitorStatusLabel(item)}</p><LivechatVisitorDetails visitor={visitor} presence={data.visitor}/></section></main>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"'}});
const css=await readFile(resolve(root,"app/globals.css"),"utf8");
let status="online",pageUrl="https://shop.example.com/current",fail=false,queries=0;
const server=createServer(async(request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);return;}
  if(request.url==="/api/v1/livechat/presence/query"){
    const parts=[];for await(const chunk of request)parts.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(parts).toString()).contactIds,["visitor"]);queries++;
    response.statusCode=fail?503:200;response.setHeader("content-type","application/json");
    response.end(JSON.stringify(fail?{error:"unavailable"}:{data:[{contactId:"visitor",status,pageUrl:status==="online"?pageUrl:null}]}));return;
  }
  response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nmain{width:min(800px,100%);margin:24px auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}aside,main>section{min-width:0}main>section{padding:12px}@media(max-width:600px){main{grid-template-columns:minmax(0,1fr);gap:0}}</style><div id="root"></div><script src="/bundle.js"></script>`);
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const browser=await chromium.launch({headless:true});
try{
  const output=resolve(root,"outputs/livechat/presence");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    status="online";fail=false;pageUrl="https://shop.example.com/current";
    const page=await browser.newPage({viewport}),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const label=page.getByLabel("访客状态"),current=page.locator('dt').filter({hasText:'当前浏览页面'}).locator('+ dd');
    await label.getByText("在线",{exact:true}).waitFor();await current.getByText(pageUrl,{exact:true}).waitFor();
    assert.equal(await page.locator('.presence.online').count(),1);
    pageUrl="https://shop.example.com/products/updated-without-sending-a-message";
    await current.getByText(pageUrl,{exact:true}).waitFor({timeout:10000});
    await page.screenshot({path:resolve(output,`online-${viewport.width}.png`)});
    status="away";await label.getByText("离开",{exact:true}).waitFor({timeout:10000});
    assert.equal(await current.textContent(),"访客已离开当前标签页");assert.equal(await page.locator('.presence.online').count(),0);
    status="offline";await label.getByText("离线",{exact:true}).waitFor({timeout:10000});
    assert.equal(await current.textContent(),"访客已离线");
    fail=true;await label.getByText("状态未知",{exact:true}).waitFor({timeout:10000});
    assert.equal(await current.textContent(),"状态未知");
    status="online";fail=false;await label.getByText("在线",{exact:true}).waitFor({timeout:10000});
    assert.equal(await current.textContent(),pageUrl);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);await page.close();
  }
  assert.ok(queries>=12);
  console.log("已通过：桌面与手机的实时轮询、当前页变化、在线/离开/离线、读取失败显示未知、恢复在线及布局检查（模拟 API）。");
}finally{await browser.close();await new Promise(done=>server.close(done));}
