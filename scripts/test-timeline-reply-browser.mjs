// 使用真实发送函数与接收人控件，模拟两个隔离的访客消息流，不操作业务数据。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";
import {chromium} from "playwright";

const require=createRequire(new URL("../services/api/package.json",import.meta.url));
const {build}=require("esbuild");
const root=fileURLToPath(new URL("..",import.meta.url));
const source=await readFile(resolve(root,"app/whatsapp-inbox.tsx"),"utf8");
const tree=ts.createSourceFile("inbox.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let send,effect;
function visit(node){
  if(ts.isFunctionDeclaration(node)&&node.name?.text==="queueTextMessage")send=node.getText(tree);
  if(ts.isCallExpression(node)&&node.expression.getText(tree)==="useEffect"&&node.arguments[0]?.getText(tree).includes("manualReplyRecipients.current.has"))effect=node.getText(tree);
  ts.forEachChild(node,visit);
}
visit(tree);assert.ok(send&&effect);
const entry=`import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {TimelineRecipientPicker,defaultTimelineRecipient} from './app/timeline-recipient';
function App(){
 const [members,setMembers]=useState([{id:'sean',name:'Sean',latestIncomingAt:'2026-11-15T22:00:00Z',latestIncomingId:'a'},{id:'sam',name:'Sam',latestIncomingAt:'2026-11-15T23:00:00Z',latestIncomingId:'b'}]);
 const [draft,setDraft]=useState(''),[replyRecipients,setReplyRecipients]=useState({}),[messages,setMessages]=useState({sean:[]}),[streams,setStreams]=useState({sean:[],sam:[]});
 const manualReplyRecipients=useRef(new Set()),effectiveActiveId='sean',active={id:'sean',accountId:'channel',platform:'livechat',accountStatus:'online'},apiToken='test';
 const recommendedRecipient=defaultTimelineRecipient(members,effectiveActiveId),replyConversationId=replyRecipients.sean??recommendedRecipient;
 const conversationMode='livechat',sendingConversation=active;
 const pendingComposerImages=[],selectedReply=null,translationPreview=null,translatingDraft=false,composerImageBusy=false,quickReplyResolving=false,mediaOpen=false,materialLibraryOpen=false,productCardsOpen=false;
 const noop=()=>{},setReplyTo=noop,setTranslationPreview=noop,setTranslationError=noop,setApiToken=noop,setToast=noop,loadMessages=async()=>{},formatTime=()=>'',messageQuote=message=>message;
 const authorizedFetch=async(path,token,init)=>{const body=JSON.parse(init.body);window.lastDelivery=body;setStreams(all=>({...all,[body.conversationId]:[...all[body.conversationId],body.text]}));return{token,response:{ok:true}}};
 ${effect};
 ${send}
 return <main><h1>Sean · 合并时间线</h1><div className="composer-tools"><div className="composer-tool-actions">LiveChat</div><TimelineRecipientPicker members={members} value={replyConversationId} disabled={false} onChange={id=>{manualReplyRecipients.current.add(effectiveActiveId);setReplyRecipients(all=>({...all,sean:id}));}}/></div><textarea aria-label="回复内容" value={draft} onChange={e=>setDraft(e.target.value)}/><button onClick={()=>void queueTextMessage(draft)}>发送</button><button onClick={()=>setMembers(all=>all.map(item=>item.id==='sean'?{...item,latestIncomingAt:'2026-11-15T23:59:00Z'}:item))}>模拟 Sean 新来信</button><section aria-label="Sean 访客">{streams.sean.map((text,i)=><p key={i}>{text}</p>)}</section><section aria-label="Sam 访客">{streams.sam.map((text,i)=><p key={i}>{text}</p>)}</section><output aria-label="时间线数量">{messages.sean.length}</output></main>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"'}});
const css=await readFile(resolve(root,"app/globals.css"),"utf8");
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nmain{width:min(660px,100%);margin:auto;padding:16px;box-sizing:border-box}h1{font-size:20px}textarea{display:block;width:100%;box-sizing:border-box;margin-top:12px}section{border-top:1px solid #ddd;min-height:40px;margin-top:16px}button{margin:8px 8px 8px 0}</style><div id="root"></div><script src="/bundle.js"></script>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const browser=await chromium.launch({headless:true});
try{
  const output=resolve(root,"outputs/timeline-merge");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport}),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const picker=page.getByRole("combobox",{name:"回复接收人"});await picker.waitFor();assert.equal(await picker.inputValue(),"sam");
    await page.getByLabel("回复内容").fill("给 Sam 的回复");
    await page.getByRole("button",{name:"模拟 Sean 新来信"}).click();assert.equal(await picker.inputValue(),"sam");
    await page.getByRole("button",{name:"发送",exact:true}).click();
    await page.getByLabel("Sam 访客").getByText("给 Sam 的回复").waitFor();assert.equal(await page.getByLabel("Sean 访客").textContent(),"");
    const request=await page.evaluate(()=>window.lastDelivery);assert.equal(request.conversationId,"sam");assert.equal(await page.getByLabel("时间线数量").textContent(),"1");
    await picker.selectOption("sam");await page.getByLabel("回复内容").fill("手动指定 Sam");await page.getByRole("button",{name:"发送",exact:true}).click();
    await page.getByLabel("Sam 访客").getByText("手动指定 Sam").waitFor();assert.equal(await picker.inputValue(),"sam");
    await picker.selectOption("sean");await page.getByLabel("回复内容").fill("给 Sean 的回复");await page.getByRole("button",{name:"发送",exact:true}).click();
    await page.getByLabel("Sean 访客").getByText("给 Sean 的回复").waitFor();assert.equal(await picker.inputValue(),"sean");
    assert.equal(await page.getByLabel("Sam 访客").textContent(),"给 Sam 的回复手动指定 Sam");
    const bounds=await picker.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=viewport.width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:resolve(output,`reply-${viewport.width}.png`)});assert.deepEqual(errors,[]);await page.close();
  }
  console.log("桌面和手机：默认 Sam、编辑期间目标冻结、手动选择 Sean、独立访客收信、主时间线更新及布局检查通过（模拟 API）。");
}finally{await browser.close();await new Promise(done=>server.close(done));}
