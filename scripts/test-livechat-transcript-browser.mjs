// 使用真实弹窗与认证请求函数，模拟 API，不向真实邮箱发信。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const require=createRequire(new URL("../services/api/package.json",import.meta.url));
const {build}=require("esbuild");
const root=fileURLToPath(new URL("..",import.meta.url));
const entry=`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LivechatTranscriptDialog} from './app/livechat-transcript-dialog';
const noop=()=>{},members=[{id:'sean',contactId:'contact-sean',name:'Sean'},{id:'sam',contactId:'contact-sam',name:'Sam'},{id:'empty',contactId:'contact-empty',name:'无邮箱访客'}];
function App(){const [open,setOpen]=useState(true),[toast,setToast]=useState('');return <main><button onClick={()=>setOpen(true)}>打开记录弹窗</button><output>{toast}</output>{open&&<LivechatTranscriptDialog conversationId="root" accountId="channel" members={members} initialRecipientId="sam" token="test" onToken={noop} onClose={()=>setOpen(false)} onSent={setToast}/>}</main>}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_RELAY_API_URL":'""'}});
const css=await readFile(resolve(root,"app/globals.css"),"utf8");
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const browser=await chromium.launch({headless:true});
try{
  const output=resolve(root,"outputs/livechat-transcript");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport}),errors=[],requests=[];
    let fail=true,held;
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/api/v1/contacts/**",route=>{
      const id=new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({json:{primaryEmail:id==='contact-empty'?'':id==='contact-sam'?'sam@example.com':'sean@example.com'}});
    });
    await page.route("**/api/v1/conversations/root/transcript",async route=>{
      requests.push(route.request().postDataJSON());
      if(fail){await route.fulfill({status:503,json:{message:"模拟暂时失败"}});return;}
      held=route;
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const picker=page.getByRole("combobox",{name:"记录接收访客"}),email=page.getByRole("textbox",{name:"收件邮箱"}),send=page.getByRole("button",{name:"发送记录",exact:true});
    await email.waitFor();await page.waitForFunction(()=>document.querySelector('input')?.value==='sam@example.com');
    assert.equal(await picker.inputValue(),"sam");
    await picker.selectOption("empty");await page.getByText("请先在客户资料中设置访客主邮箱").waitFor();assert.ok(await send.isDisabled());
    await picker.selectOption("sean");await page.waitForFunction(()=>document.querySelector('input')?.value==='sean@example.com');
    assert.ok(await email.getAttribute("readonly")!==null);
    await page.screenshot({path:resolve(output,`dialog-${viewport.width}.png`)});
    const bounds=await page.getByRole("dialog").boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await send.click();await page.getByRole("alert").waitFor();assert.equal(requests.length,1);assert.equal(requests[0].targetConversationId,"sean");
    await send.click();await page.getByRole("alert").waitFor();assert.equal(requests.length,2);assert.equal(requests[0].clientSendId,requests[1].clientSendId);
    await page.getByRole("button",{name:"关闭",exact:true}).click();await page.getByRole("button",{name:"打开记录弹窗"}).click();
    await picker.selectOption("sean");await page.waitForFunction(()=>document.querySelector('input')?.value==='sean@example.com');
    await send.click();await page.getByRole("alert").waitFor();assert.equal(requests[2].clientSendId,requests[0].clientSendId);
    await page.reload();await picker.selectOption("sean");await page.waitForFunction(()=>document.querySelector('input')?.value==='sean@example.com');
    fail=false;await send.click();await page.waitForFunction(()=>document.querySelector('select')?.disabled===true);
    assert.ok(await picker.isDisabled());assert.ok(await page.getByRole("button",{name:"正在提交…"}).isDisabled());
    await page.keyboard.press("Escape");assert.equal(await page.getByRole("dialog").count(),1);
    assert.equal(requests[3].clientSendId,requests[0].clientSendId);
    await held.fulfill({status:202,json:{ok:true,status:"queued"}});
    await page.getByRole("dialog").waitFor({state:"detached"});assert.match(await page.locator("output").textContent(),/已入队/);
    await page.getByRole("button",{name:"打开记录弹窗"}).click();await picker.selectOption("sean");await page.waitForFunction(()=>document.querySelector('input')?.value==='sean@example.com');
    await send.click();await page.waitForFunction(()=>document.querySelector('select')?.disabled===true);
    assert.notEqual(requests[4].clientSendId,requests[0].clientSendId);await held.fulfill({status:202,json:{ok:true,status:"accepted"}});
    await page.getByRole("dialog").waitFor({state:"detached"});assert.match(await page.locator("output").textContent(),/已提交邮件服务商/);
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log("桌面和手机：访客邮箱切换、缺邮箱阻止发送、失败重试/重开/刷新去重、发送中锁定、成功后新请求及布局检查通过（模拟 API）。");
}finally{await browser.close();await new Promise(done=>server.close(done));}
