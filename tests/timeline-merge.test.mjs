import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";

const require=createRequire(import.meta.url);
const source=await readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
const tree=ts.createSourceFile("inbox.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let callback;
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==="selectConversation")callback=node.initializer.arguments[0].getText(tree);
  ts.forEachChild(node,visit);
}
visit(tree);
const javascript=ts.transpileModule(`const select=${callback};exports.select=select;`,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;

test("Shift 点击进入多选，普通点击继续选择，再次点击取消；不同 channel 和群会话不可选",()=>{
  const visible=[{id:"a",accountId:"one"},{id:"b",accountId:"one"},{id:"c",accountId:"two"},{id:"g",accountId:"one",conversationType:"group"}];
  let selected=new Map(),active="",toast="";
  const select=(id,shift=false)=>{
    const context={exports:{},visible,selectedConversations:selected,Map,selectedConversationRef:{current:null},setSelectedConversations:fn=>{selected=fn(selected)},setActiveId:id=>{active=id},setMobileConversationOpen:()=>{},setToast:value=>{toast=value}};
    runInNewContext(javascript,context);context.exports.select(id,shift);
  };
  select("a");assert.equal(active,"a");assert.equal(selected.size,0);
  select("a",true);assert.deepEqual([...selected.keys()],["a"]);
  select("b");assert.deepEqual([...selected.keys()],["a","b"]);
  select("c");assert.equal(selected.size,2);assert.match(toast,/同一个 channel/);
  select("g");assert.equal(selected.size,2);assert.match(toast,/群会话/);
  select("a");select("b");assert.equal(selected.size,0);
  select("c");assert.equal(active,"c");
});

test("列表行传递鼠标和键盘的 Shift 状态并展示选择状态",async()=>{
  const row=await readFile(new URL("../app/conversation-list-row.tsx",import.meta.url),"utf8");
  const output={};
  runInNewContext(ts.transpileModule(row,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:output,require:name=>name==="./message-time"?{formatMessageTime:()=>"",formatMessageTimeTitle:()=>""}:require(name)});
  const events=[];
  const element=output.ConversationListRow({item:{name:"客户",tags:[],conversationType:"direct",platform:"livechat",unread:0},multiSelect:true,selected:true,selectionDisabled:false,onSelect:shift=>events.push(shift)});
  element.props.onClick({shiftKey:true});element.props.onClick({shiftKey:false});
  let prevented=false;element.props.onKeyDown({key:" ",shiftKey:true,preventDefault:()=>{prevented=true}});
  assert.deepEqual(events,[true,false,true]);assert.equal(prevented,true);assert.equal(element.props["aria-pressed"],true);
});

test("时间线查询按原始时间及 id 分页，公开访客接口不扩大读取范围",async()=>{
  const server=await readFile(new URL("../services/api/src/server.ts",import.meta.url),"utf8");
  assert.match(server,/msg\.conversation_id IN \(SELECT relay_conversation_members\(\$1\)\).*ORDER BY msg\.occurred_at DESC,msg\.id DESC/);
  assert.match(server,/102_|relay_conversation_members/);
  const publicApi=await readFile(new URL("../services/api/src/livechat.ts",import.meta.url),"utf8");
  assert.equal(publicApi.includes("relay_conversation_members"),false);
});

test("旧身份合并入口在调用资料搬移前拒绝时间线成员",async()=>{
  const server=await readFile(new URL("../services/api/src/server.ts",import.meta.url),"utf8");
  const start=server.indexOf('app.post("/api/v1/conversations/:id/merge-same-account"');
  const end=server.indexOf('app.post("/api/v1/conversations/:id/merge"',start);
  const route=server.slice(start,end);
  assert.ok(route.indexOf("FROM conversation_timeline_merges")>0);
  assert.ok(route.indexOf("FROM conversation_timeline_merges")<route.indexOf("await mergeSameAccountConversations"));
  assert.match(route,/if\(timeline\.rowCount\)return\{status:"conflict"/);
});
