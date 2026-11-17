// 使用真实列表组件和确认弹窗，模拟 API；不连接业务账号或修改真实会话。
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
let select,dialog;
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==="selectConversation")select=node.initializer.arguments[0].getText(tree);
  if(ts.isFunctionDeclaration(node)&&node.name?.text==="TimelineMergeDialog")dialog=node.getText(tree);
  ts.forEachChild(node,visit);
}
visit(tree);
assert.ok(select&&dialog);
const entry=`import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Merge,X} from 'lucide-react';
import {ConversationPanel} from './app/conversation-panel';
async function authorizedFetch(path,token,init){window.mergeRequest={path,body:JSON.parse(init.body)};return{token,response:{ok:true,json:async()=>({})}}}
${dialog}
function App(){
 const visible=['客户甲','客户乙','其他渠道客户'].map((name,index)=>({id:String(index),name,accountId:index===2?'other':'channel',account:index===2?'其他渠道':'网站客服',initials:'客',color:'#267669',platform:'livechat',conversationType:'direct',customerStage:'new',tags:[],preview:'保留全部原始消息',lastDirection:'in',unread:0}));
 const [selectedConversations,setSelectedConversations]=useState(new Map()),[activeId,setActiveId]=useState('0'),[toast,setToast]=useState(''),[merging,setMerging]=useState(null);
 const selectedConversationRef=useRef(null),listRef=useRef(null),sentinelRef=useRef(null),noop=()=>{};
 const setMobileConversationOpen=noop;
 const selectConversation=${select};
 return <><div className="fixture-panel"><ConversationPanel filter="全部会话" subtitle="3 个会话" query="" onQuery={noop} tags={[]} tagIds={[]} onTagIds={noop} onTagOpen={noop} customerStage="" onCustomerStage={noop} latestOrderStatus="" onLatestOrderStatus={noop} followup="" onFollowup={noop} agentMode="" onAgentMode={noop} country="" onCountry={noop} onOpenSidebar={noop} collapsed={false} onToggleCollapsed={noop} onRefresh={noop} dateFilter="all" onDateFilter={noop} onDateKeyDown={noop} mobileOpen={true} onCloseMobile={noop} listRef={listRef} sentinelRef={sentinelRef} items={visible} rows={visible.map((_,index)=>({index,start:index*112}))} totalSize={336} measure={noop} effectiveActiveId={activeId} selectedIds={new Set(selectedConversations.keys())} selectionAccountId={selectedConversations.values().next().value?.accountId??''} clock={Date.now()} markingUnreadId="" onSelect={selectConversation} onMenu={noop} onMarkUnread={noop} onMergeSelection={()=>setMerging([...selectedConversations.values()])} onCancelSelection={()=>setSelectedConversations(new Map())} loading={false} loadError="" hasAccounts={true} loadingMore={false} loadMoreError="" hasMore={false} onLoadMore={noop}/></div><output aria-label="操作结果">{toast}</output>{merging&&<TimelineMergeDialog conversations={merging} token="test" onToken={noop} onClose={()=>setMerging(null)} onMerged={async id=>{setActiveId(id);setSelectedConversations(new Map());setMerging(null);setToast('合并成功')}}/>}</>;
}
createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"'}});
const css=await readFile(resolve(root,"app/globals.css"),"utf8");
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n.fixture-panel{width:min(430px,100%);height:100dvh}.fixture-panel .conversation-panel{position:static;transform:none;width:100%;height:100%;border-right:1px solid #ddd}output{position:fixed;bottom:4px;right:4px;background:white;color:#27654d;font-size:12px}</style><div id="root"></div><script src="/bundle.js"></script>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const browser=await chromium.launch({headless:true});
try{
  const output=resolve(root,"outputs/timeline-merge");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const page=await browser.newPage({viewport});const errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const first=page.locator('.conversation').nth(0),second=page.locator('.conversation').nth(1),other=page.locator('.conversation').nth(2);
    await first.click({modifiers:["Shift"]});assert.equal(await first.getAttribute("aria-pressed"),"true");
    const merge=page.getByRole("button",{name:"合并",exact:true});assert.equal(await merge.isDisabled(),true);
    assert.notEqual(await other.getAttribute("aria-disabled"),"true");await other.click();assert.equal(await merge.isEnabled(),true);await other.click();assert.equal(await merge.isDisabled(),true);
    await second.click();assert.equal(await merge.isEnabled(),true);
    await page.screenshot({path:resolve(output,`selection-${viewport.width}.png`)});
    await page.getByRole("button",{name:"取消",exact:true}).click();assert.equal(await merge.count(),0);
    await first.click({modifiers:["Shift"]});await second.click();await merge.click();
    const modal=page.getByRole("dialog");await modal.waitFor();
    await page.getByRole("radio").nth(1).check();
    const bounds=await modal.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1);assert.ok(bounds.y>=0&&bounds.y+bounds.height<=viewport.height+1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:resolve(output,`dialog-${viewport.width}.png`)});
    await page.getByRole("button",{name:"确认合并",exact:true}).click();await modal.waitFor({state:"detached"});
    const request=await page.evaluate(()=>window.mergeRequest);assert.equal(request.path,"/api/v1/conversations/merge-timelines");assert.deepEqual(request.body,{conversationIds:["0","1"],targetConversationId:"1"});
    assert.equal(await page.getByLabel("操作结果").textContent(),"合并成功");assert.deepEqual(errors,[]);await page.close();
  }
  console.log("桌面和移动端：Shift 多选、跨 channel 选择、取消、主会话选择、合并请求和布局检查全部通过。");
}finally{await browser.close();await new Promise(done=>server.close(done));}
