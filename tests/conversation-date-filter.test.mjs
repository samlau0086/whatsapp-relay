import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source=await readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
const tree=ts.createSourceFile("inbox.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const callbacks=new Map();
function visit(node){
  if(ts.isVariableDeclaration(node)&&["applyConversationEvents","loadConversationCounts","loadConversations"].includes(node.name.getText(tree))){
    callbacks.set(node.name.getText(tree),node.initializer.arguments[0].getText(tree));
  }
  ts.forEachChild(node,visit);
}
visit(tree);

function callback(name,context){
  assert.ok(callbacks.has(name));
  const code=ts.transpileModule(`const callback=${callbacks.get(name)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return vm.runInNewContext(`${code}\ncallback`,{...context});
}

test("LiveChat 实时摘要和计数旧请求在切换日期后不能回写",async()=>{
  let release,writes=0;
  const dateFilterRef={current:"all"};
  const context={view:"inbox",dateFilter:"all",dateFilterRef,apiToken:"test",selectedAccount:"",debouncedQuery:"",selectedTags:[],selectedCustomerStage:"",selectedLatestOrderStatus:"",followupFilter:"",selectedAgentMode:"",filter:"全部会话",effectiveActiveId:"other",Date,
    conversationFilterKey:()=>"all",conversationSummaryPath:()=>"/summary",conversationCountsPath:()=>"/counts",
    authorizedFetch:async()=>{await new Promise(done=>{release=done;});return{token:"test",response:{status:200,ok:true,json:async()=>({matches:true,data:{platform:"livechat"}})}};},
    setConversations:()=>{writes++;},setConversationCounts:()=>{writes++;},notificationBaseline:{current:new Map()},mapConversation:()=>{writes++;return{};},refreshRealtimeCounts:async()=>{},
  };
  for(const name of ["applyConversationEvents","loadConversationCounts"]){
    dateFilterRef.current="all";
    const pending=callback(name,context)(name==="applyConversationEvents"?["visitor"]:"test");
    dateFilterRef.current="today";release();await pending;
    assert.equal(writes,0,name);
  }
});

test("会话列表旧请求即使仍为最新序号，也不能跨日期回写",async()=>{
  let release,writes=0;
  const context={dateFilter:"all",dateFilterRef:{current:"all"},workspaceLoadSequence:{current:0},conversationCursorRef:{current:null},conversationAbortRef:{current:null},AbortController,Date,
    filter:"全部会话",selectedAccount:"",debouncedQuery:"",selectedTags:[],selectedCustomerStage:"",selectedLatestOrderStatus:"",followupFilter:"",selectedAgentMode:"",selectedCountry:"",
    conversationFilterKey:()=>"all",conversationListPath:()=>"/list",setLoadError:()=>{},setLoading:()=>{},
    authorizedFetch:async()=>{await new Promise(done=>{release=done;});return{token:"test",response:{status:200,ok:true,json:async()=>({data:[{platform:"livechat"}],nextCursor:null})}};},
    mapConversation:()=>{writes++;},setConversations:()=>{writes++;},
  };
  const pending=callback("loadConversations",context)("test");
  context.dateFilterRef.current="today";release();await pending;
  assert.equal(writes,0);
});
