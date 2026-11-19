import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LIVECHAT_TEST_PLAYWRIGHT||"playwright");
const root=fileURLToPath(new URL("..",import.meta.url));
const bundle=await build({stdin:{contents:`
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {useConversationFeed} from "./app/use-conversation-feed";
import {useLivechatTabAlert} from "./app/livechat-tab-alert";
window.calls=0;
window.WebSocket=class extends EventTarget {
  constructor(){super();window.socket=this;}
  close(){this.dispatchEvent(new Event("close"));}
};
const playSound=()=>{window.calls++;};
function App(){
  const [enabled,setEnabled]=useState(true);
  const onLivechatIncoming=useLivechatTabAlert(enabled,playSound);
  useConversationFeed({enabled,onLivechatIncoming,getWebSocketUrl:async()=>"ws://test",onConversationIds:()=>{},onReconcile:()=>{}});
  return <button onClick={()=>setEnabled(false)}>退出工作台</button>;
}
createRoot(document.getElementById("root")).render(<App/>);`,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser"});
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){
    response.setHeader("content-type","text/javascript");
    response.end(bundle.outputFiles[0].text);
  }else{
    response.setHeader("content-type","text/html; charset=utf-8");
    response.end('<!doctype html><title>RelayDesk</title><div id="root"></div><script src="/bundle.js"></script>');
  }
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>window.socket);
  const emit=frame=>page.evaluate(data=>window.socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(data)})),frame);
  const incoming=(messageId,channelName)=>emit({type:"livechat.incoming",messageId,channelName});
  await emit({type:"events.ready"});
  await emit({type:"conversation.changed",conversationId:"old"});
  await incoming("invalid",null);
  assert.equal(await page.title(),"RelayDesk");
  assert.equal(await page.evaluate(()=>window.calls),0);
  await incoming("first","售前咨询");
  assert.equal(await page.title(),"New message from 售前咨询");
  await page.waitForFunction(()=>document.title==="RelayDesk");
  await page.waitForFunction(()=>document.title==="New message from 售前咨询");
  await incoming("first","售前咨询");
  assert.equal(await page.evaluate(()=>window.calls),1);
  await incoming("second","海外官网");
  assert.equal(await page.title(),"New message from 海外官网");
  assert.equal(await page.evaluate(()=>window.calls),2);
  await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
  assert.equal(await page.title(),"RelayDesk");
  await incoming("third","海外官网");
  await page.getByRole("button",{name:"退出工作台"}).click();
  await page.waitForFunction(()=>document.title==="RelayDesk");
  await incoming("late","海外官网");
  assert.equal(await page.evaluate(()=>window.calls),3);
  assert.deepEqual(errors,[]);
  console.log("LiveChat 浏览器回归通过：有效事件、标题交替、原渠道名称、重复去重、焦点恢复、退出清理。");
}finally{
  await browser?.close();
  await new Promise(done=>server.close(done));
}
