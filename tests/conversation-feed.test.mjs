import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("收件箱实时连接断开后五秒兜底，重连立即补齐且不重叠请求",async()=>{
  const source=await readFile(new URL("../app/use-conversation-feed.ts",import.meta.url),"utf8");
  const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const effects=[],intervals=new Map(),timers=new Map(),sockets=[],windowEvents=new Map(),documentEvents=new Map();
  let reconciles=0,release;
  class Socket{
    events=new Map();
    constructor(){sockets.push(this);}
    addEventListener(name,callback){this.events.set(name,callback);}
    emit(name,data){this.events.get(name)?.(data);}
    close(){this.emit("close");}
  }
  const context={exports:{},require:()=>({useRef:value=>({current:value}),useEffect:effect=>effects.push(effect)}),WebSocket:Socket,Date,Promise,
    document:{visibilityState:"visible",addEventListener:(n,cb)=>documentEvents.set(n,cb),removeEventListener:n=>documentEvents.delete(n)},
    window:{setInterval:(cb,ms)=>{intervals.set(1,{cb,ms});return 1;},clearInterval:id=>intervals.delete(id),setTimeout:(cb,ms)=>{timers.set(2,{cb,ms});return 2;},clearTimeout:id=>timers.delete(id),addEventListener:(n,cb)=>windowEvents.set(n,cb),removeEventListener:n=>windowEvents.delete(n)}};
  vm.runInNewContext(javascript,context);
  context.exports.useConversationFeed({enabled:true,getWebSocketUrl:async()=>"ws://localhost",onConversationIds:async()=>{},onReconcile:async()=>{reconciles++;if(release===null)await new Promise(resolve=>{release=resolve;});}});
  effects[0]();const cleanup=effects[1]();await Promise.resolve();
  assert.equal(intervals.get(1).ms,5000);
  await intervals.get(1).cb();await Promise.resolve();assert.equal(reconciles,1);
  sockets[0].emit("message",{data:JSON.stringify({type:"events.ready"})});await Promise.resolve();assert.equal(reconciles,2);
  await intervals.get(1).cb();assert.equal(reconciles,2);
  sockets[0].close();release=null;
  await intervals.get(1).cb();assert.equal(reconciles,3);
  await intervals.get(1).cb();assert.equal(reconciles,3);
  release();await Promise.resolve();await Promise.resolve();
  await timers.get(2).cb();await Promise.resolve();
  sockets[1].emit("message",{data:JSON.stringify({type:"events.ready"})});await Promise.resolve();assert.equal(reconciles,4);
  documentEvents.get("visibilitychange")();await Promise.resolve();assert.equal(reconciles,5);
  cleanup();assert.equal(intervals.size,0);assert.equal(documentEvents.size,0);assert.equal(windowEvents.size,0);
});
