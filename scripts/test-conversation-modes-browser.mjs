// 提取真实模式栏、切换函数及发送函数，使用模拟 API 验证，不发送业务消息。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";
import {chromium} from "playwright";

const require=createRequire(new URL("../services/api/package.json",import.meta.url)),{build}=require("esbuild");
const root=fileURLToPath(new URL("..",import.meta.url)),source=await readFile(resolve(root,"app/whatsapp-inbox.tsx"),"utf8");
const tree=ts.createSourceFile("inbox.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),functions={};let bar,agentBar;
function visit(node){
  if(ts.isFunctionDeclaration(node)&&node.name?.text==="AgentConversationBar")agentBar=node.getText(tree);
  if(ts.isFunctionDeclaration(node)&&["switchConversationMode","queueTextMessage","sendEmailMessage"].includes(node.name?.text))functions[node.name.text]=node.getText(tree);
  if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attr=>attr.name?.getText(tree)==="className"&&attr.initializer?.text==="conversation-mode-bar"))bar=node.getText(tree);
  ts.forEachChild(node,visit);
}
visit(tree);assert.ok(bar&&agentBar&&Object.keys(functions).length===3);
const entry=`import React,{useState,useRef,useCallback,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Mail,MessageCircle,Bot,ShieldCheck,Users,Sparkles} from 'lucide-react';
import {modeMembers,matchesMessageMode} from './app/conversation-modes';
const authorizedFetch=async(path,token,init)=>{
 if(init){const body=JSON.parse(init.body);window.agentWrites.push(body);Object.assign(window.agentState,body.mode?{mode:body.mode}:{proactive_reply_mode:body.proactiveReplyMode});}
 return{token,response:{ok:true,status:200,json:async()=>({...window.agentState})}};
};
${agentBar}
function App(){
 const active={id:'root',platform:'livechat'},effectiveActiveId='root',apiToken='test';
 const [conversationMode,setConversationMode]=useState('livechat'),[modeBusy,setModeBusy]=useState(false),[draft,setDraft]=useState('');
 const [emailEnabled,setEmailEnabled]=useState(true),[emailConfigured,setEmailConfigured]=useState(true),[replyRecipients,setReplyRecipients]=useState({});
 const [messages,setMessages]=useState({root:[{id:'lc',platform:'livechat',text:'网站消息'},{id:'wa',platform:'whatsapp',text:'WhatsApp 消息'},{id:'em',platform:'livechat',email:{subject:'邮件'},text:'邮件消息'}]});
 const [emailBodyHtml,setEmailBodyHtml]=useState(''),[emailSubject,setEmailSubject]=useState(''),[emailAttachments,setEmailAttachments]=useState([]),emailDocumentBusyRef=useRef(false);
 const modeDrafts=useRef({}),modeRequestRef=useRef({id:'root'}),noop=()=>{},setReplyTo=noop,setToast=noop,setApiToken=noop,setTranslationPreview=noop,setTranslationError=noop;
 const members=[{id:'root',name:'网站客户',mode:'livechat',platform:'livechat',accountId:'live-account'},{id:'email',name:'邮件客户',mode:'email',platform:'whatsapp',accountId:'email-account',primaryEmail:emailEnabled?'customer@example.com':'',hasEmailProvider:emailConfigured},{id:'wa',name:'WhatsApp 客户',mode:'whatsapp',platform:'whatsapp',accountId:'wa-account'}];
 const accounts=[],whatsappAccountId='',setWhatsappAccountId=noop,availableModeMembers=modeMembers(members,conversationMode),sender=availableModeMembers.find(m=>m.id===replyRecipients['root:'+conversationMode])??availableModeMembers[0];
 const emailAvailable=modeMembers(members,'email').length>0,whatsappAvailable=true,livechatAvailable=true,replyConversationId=sender?.id,sendingConversation=sender,activePrimaryEmail=sender?.primaryEmail??'';
 const selectedReply=null,translatingDraft=false,quickReplyResolving=false,composerImageBusy=false,emailDocumentBusy=false,translationPreview=null,pendingComposerImages=[],mediaOpen=false,materialLibraryOpen=false,productCardsOpen=false,ttsOpen=false;
 const emailMailboxes=[],emailMailboxId='',formatTime=()=>'',formatBytes=()=>'',messageQuote=m=>m,htmlToPlainText=t=>t,replyEmailSubject=t=>t,loadMessages=async()=>{},loadConversations=async()=>{};
 const authorizedFetch=async(path,token,init)=>{window.deliveries.push({path,body:JSON.parse(init.body)});return{token,response:{ok:true}}};
 ${Object.values(functions).join('\n')}
 return <main>${bar}<AgentConversationBar conversationId="root" conversationMode={conversationMode} token="test" translationTargetLanguage="zh" refreshKey="" onToken={noop} onToast={noop} onUseDraft={noop} onSent={noop}/><section aria-label="消息记录">{messages.root.filter(m=>matchesMessageMode(m,conversationMode)).map(m=><p key={m.id}>{m.text}</p>)}</section>{conversationMode==='email'?<section aria-label="Email 发送区"><input aria-label="邮件主题" value={emailSubject} onChange={e=>setEmailSubject(e.target.value)}/><textarea aria-label="邮件正文" value={emailBodyHtml} onChange={e=>setEmailBodyHtml(e.target.value)}/><button onClick={()=>sendEmailMessage()}>发送邮件</button></section>:<section aria-label={conversationMode==='whatsapp'?'WhatsApp 发送区':'Live Chat 发送区'}><textarea aria-label="消息正文" value={draft} onChange={e=>setDraft(e.target.value)}/><button onClick={()=>queueTextMessage(draft)}>发送消息</button></section>}<label><input type="checkbox" checked={emailEnabled} onChange={e=>setEmailEnabled(e.target.checked)}/>客户有邮箱</label><label><input type="checkbox" checked={emailConfigured} onChange={e=>setEmailConfigured(e.target.checked)}/>渠道邮件已配置</label></main>;
}
window.deliveries=[];window.agentWrites=[];window.agentState={mode:'full',proactive_reply_mode:'human_paused',account_enabled:true,draft:null};createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"'}});
const css=await readFile(resolve(root,"app/globals.css"),"utf8");
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nmain{width:min(720px,100%);margin:auto;padding:16px;box-sizing:border-box}section{padding:12px 0;border-bottom:1px solid #ddd}textarea,input:not([type=checkbox]){display:block;box-sizing:border-box;width:100%;margin:8px 0}label{display:block;margin-top:12px}</style><div id="root"></div><script src="/bundle.js"></script>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));const browser=await chromium.launch({headless:true});
try{
  const output=resolve(root,"outputs/conversation-modes");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport}),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);const history=page.getByLabel("消息记录");
    await page.getByRole("tab",{name:"Live Chat",exact:true}).waitFor();assert.equal(await history.textContent(),"网站消息");
    const choice=page.getByLabel("主动触达回复时切换为");
    await page.getByRole("button",{name:"完全接管",exact:true}).waitFor();
    assert.equal(await choice.count(),0);
    await page.getByRole("button",{name:"谨慎接管",exact:true}).click();
    await page.waitForFunction(()=>window.agentState.mode==='cautious');
    await page.getByRole("button",{name:"完全接管",exact:true}).click();
    await page.waitForFunction(()=>window.agentState.mode==='full');
    await page.getByLabel("消息正文").fill("网站草稿");await page.getByRole("tab",{name:"WhatsApp",exact:true}).click();
    assert.equal(await choice.inputValue(),"human_paused");await choice.selectOption("cautious");
    await page.waitForFunction(()=>window.agentState.proactive_reply_mode==='cautious');
    assert.equal(await history.textContent(),"WhatsApp 消息");assert.equal(await page.getByLabel("消息正文").inputValue(),"");
    await page.getByLabel("消息正文").fill("WhatsApp 回复");await page.getByRole("button",{name:"发送消息"}).click();
    await page.getByRole("tab",{name:"Email",exact:true}).click();assert.equal((await history.textContent()).includes("WhatsApp"),false);assert.ok((await history.textContent()).includes("邮件消息"));
    assert.equal(await choice.inputValue(),"cautious");
    await page.getByLabel("邮件主题").fill("主题");await page.getByLabel("邮件正文").fill("邮件回复");await page.getByRole("button",{name:"发送邮件"}).click();
    await page.getByRole("tab",{name:"Live Chat",exact:true}).click();assert.equal(await page.getByLabel("消息正文").inputValue(),"网站草稿");
    assert.equal(await choice.count(),0);
    assert.equal(await page.evaluate(()=>window.agentWrites.filter(body=>'proactiveReplyMode' in body).length),1);
    await page.getByRole("button",{name:"发送消息"}).click();
    const deliveries=await page.evaluate(()=>window.deliveries);assert.equal(deliveries.length,3);
    assert.equal(deliveries[0].body.conversationId,"wa");assert.equal(deliveries[0].body.accountId,"wa-account");
    assert.equal(deliveries[1].path,"/api/v1/conversations/email/email-sends/text");assert.equal(deliveries[1].body.mailboxId,undefined);
    assert.equal(deliveries[2].body.conversationId,"root");assert.equal(deliveries[2].body.accountId,"live-account");
    await page.getByLabel("客户有邮箱").uncheck();assert.equal(await page.getByRole("tab",{name:"Email",exact:true}).isDisabled(),true);
    await page.getByLabel("客户有邮箱").check();await page.getByLabel("渠道邮件已配置").uncheck();assert.equal(await page.getByRole("tab",{name:"Email",exact:true}).isDisabled(),true);
    await page.getByLabel("渠道邮件已配置").check();assert.equal(await page.getByRole("tab",{name:"Email",exact:true}).isEnabled(),true);
    for(const mode of ["Email","WhatsApp","Live Chat"]){await page.getByRole("tab",{name:mode,exact:true}).click();await page.screenshot({path:resolve(output,`${mode.replaceAll(' ','-')}-${viewport.width}.png`)});}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.close();
  }
  console.log("桌面和手机：三模式消息隔离、对应发送区、跨账号发送目标、Provider-only 邮件、草稿恢复、切换条件与布局检查通过（模拟 API）。");
}finally{await browser.close();await new Promise(done=>server.close(done));}
