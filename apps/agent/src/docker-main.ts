import { randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { AgentStore } from "./store.js";
import { CentralClient } from "./central-client.js";

const PROTOCOL_VERSION=2;
const VERSION=process.env.npm_package_version??"docker";
const dataDir=process.env.RELAY_DATA_DIR??"/data";
const baseUrl=required("RELAY_CENTRAL_URL");
const initialAccountId=process.env.RELAY_ACCOUNT_ID?.trim();
const initialAccountName=process.env.RELAY_ACCOUNT_NAME?.trim()||"WhatsApp";
const agentName=process.env.RELAY_AGENT_NAME?.trim()||"Docker Relay Agent";
const proxyUrl=process.env.RELAY_PROXY_URL?.trim()||undefined;
const uiHost=process.env.RELAY_UI_BIND?.trim()||"127.0.0.1";
const uiPort=Number(process.env.RELAY_UI_PORT??8788);
let store:AgentStore;
let client:CentralClient|undefined;
const workers=new Map<string,ChildProcess>();
const qrDataUrls=new Map<string,string>();
const repairRequested=new Set<string>();
const removedWorkers=new Set<string>();
const reconnectRequested=new Set<string>();
let stopping=false;
let masterKey="";

class CentralAccountRequestError extends Error {
  constructor(readonly status:number,readonly code?:string){
    super(status===404?"中心平台未找到此账号与当前 Agent 的绑定":`中心账号操作失败（HTTP ${status}${code?` · ${code}`:""}`);
    this.name="CentralAccountRequestError";
  }
}

void start().catch(error=>{
  console.error("RelayDesk Docker Agent failed to start:",error);
  process.exitCode=1;
});

async function start():Promise<void>{
  await mkdir(dataDir,{recursive:true});
  store=new AgentStore(join(dataDir,"relay-agent.db"));
  store.discardRemovedAccountStatusEvents();
  store.discardUnsupportedMessageEvents();
  masterKey=process.env.RELAY_MASTER_KEY?.trim()||store.get("masterKey")||randomBytes(32).toString("hex");
  if(!/^[a-f0-9]{64}$/i.test(masterKey))throw new Error("RELAY_MASTER_KEY must be a 64-character hexadecimal key");
  store.set("masterKey",masterKey);
  await enrollIfNeeded();
  const savedBaseUrl=store.get("baseUrl");
  if(savedBaseUrl!==baseUrl)throw new Error(`RELAY_CENTRAL_URL differs from the enrolled value (${savedBaseUrl??"none"})`);
  if(store.accounts().length===0&&initialAccountId)await registerAccount(initialAccountId,initialAccountName);
  startCentral();
  for(const account of store.accounts())await startAccount(account.id,account.name);
  await startDashboard();
  process.on("SIGTERM",shutdown);
  process.on("SIGINT",shutdown);
  console.log(`RelayDesk Docker Agent is running. Open http://${uiHost}:${uiPort} to manage WhatsApp accounts.`);
}

async function enrollIfNeeded():Promise<void>{
  if(store.get("agentId")&&store.get("credential"))return;
  const code=required("RELAY_ENROLLMENT_CODE");
  const response=await fetch(new URL("/api/v1/agents/enroll",baseUrl),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code,name:agentName,version:VERSION,platform:`docker-${process.platform}-${process.arch}`})});
  if(!response.ok)throw new Error(`Agent enrollment failed (HTTP ${response.status})`);
  const enrolled=await response.json() as {agentId:string;credential:string};
  store.set("baseUrl",baseUrl);store.set("agentId",enrolled.agentId);store.set("credential",enrolled.credential);
  console.log(`Agent enrolled as ${enrolled.agentId}.`);
}

async function registerAccount(accountId:string,name:string):Promise<void>{
  const response=await fetch(new URL("/agent/accounts",baseUrl),{method:"POST",headers:authHeaders(),body:JSON.stringify({id:accountId,name})});
  if(!response.ok){
    const body=await response.json().catch(()=>({})) as {error?:string};
    throw new Error(body.error==="account_conflict"?"账号 ID 已被其他 Agent 使用":`账号登记失败（HTTP ${response.status}）`);
  }
  store.upsertAccount(accountId,name,"pairing");
}

async function accountRequest(accountId:string,method:"PATCH"|"DELETE",body?:Record<string,unknown>):Promise<void>{
  const response=await fetch(new URL(`/agent/accounts/${encodeURIComponent(accountId)}`,baseUrl),{method,headers:body?authHeaders():{authorization:authHeaders().authorization},body:body?JSON.stringify(body):undefined});
  if(!response.ok){
    const payload=await response.json().catch(()=>({})) as {error?:string};
    throw new CentralAccountRequestError(response.status,payload.error);
  }
}

function startCentral():void{
  const agentId=store.get("agentId")!;const credential=store.get("credential")!;
  client=new CentralClient(store,{baseUrl,agentId,credential,agentVersion:VERSION,platform:`docker-${process.platform}-${process.arch}`,protocolVersion:PROTOCOL_VERSION,capabilities:["publish_status_v1","group_chat_v1","group_create_v1","contact_block_v1","contact_avatar_sync_v1"],proxyUrl,onCommand:executeCommand,onStatus:status=>{store.set("connection",status);console.log(`Central connection: ${status}`);},onAttentionCleared:()=>undefined,onAccountRemoved:accountId=>void removeLocalAccount(accountId)});
  client.start();
}

async function startAccount(accountId:string,name:string):Promise<void>{
  if(workers.has(accountId)||stopping||!store.accounts().some(account=>account.id===accountId))return;
  const next=fork(join(import.meta.dirname,"account-worker.js"),[],{stdio:["ignore","inherit","inherit","ipc"]});
  workers.set(accountId,next);
  let lastHeartbeat=Date.now();
  const watchdog=setInterval(()=>{if(Date.now()-lastHeartbeat>30_000){console.error(`Account worker ${accountId} heartbeat timed out; restarting.`);next.kill();}},10_000);
  next.on("message",message=>{
    const value=message as Record<string,unknown>;
    if(value.type==="worker_heartbeat"){lastHeartbeat=Date.now();return;}
    if(removedWorkers.has(accountId))return;
    if(value.type==="event"){const payload=value.payload as Record<string,unknown>;store.enqueueEvent(String(payload.eventId),String(value.kind),payload);client?.flush();return;}
    if(value.type==="status"){
      const status=String(value.status),reason=typeof value.reason==="string"?value.reason:undefined,eventId=`status:${accountId}:${Date.now()}`;
      if(status==="online"||status==="logged_out")qrDataUrls.delete(accountId);
      store.setAccountStatus(accountId,status,reason);store.enqueueEvent(eventId,"account_status",{eventId,accountId,status,reason,at:new Date().toISOString()});client?.flush();console.log(`WhatsApp account ${accountId}: ${status}${reason?` (${reason})`:""}`);return;
    }
    if(value.type==="qr")void updateQr(accountId,String(value.qr));
  });
  next.on("exit",()=>{
    clearInterval(watchdog);
    if(workers.get(accountId)===next)workers.delete(accountId);
    if(stopping)return;
    if(removedWorkers.delete(accountId)){void rm(join(dataDir,"accounts",accountId),{recursive:true,force:true});return;}
    if(repairRequested.delete(accountId)){void resetAccount(accountId,name);return;}
    if(reconnectRequested.delete(accountId)){setTimeout(()=>void startAccount(accountId,name),500);return;}
    if(!store.accounts().some(account=>account.id===accountId))return;
    store.setAccountStatus(accountId,"offline","worker_exited");
    setTimeout(()=>void startAccount(accountId,name),5_000);
  });
  next.send({type:"init",accountId,dataDir:join(dataDir,"accounts"),masterKey,baseUrl,credential:store.get("credential")!,proxyUrl});
}

async function updateQr(accountId:string,qr:string):Promise<void>{
  if(!store.accounts().some(account=>account.id===accountId))return;
  qrDataUrls.set(accountId,await QRCode.toDataURL(qr,{width:360,margin:1}));
  console.log(`WhatsApp QR code for ${accountId} is ready at http://${uiHost}:${uiPort}.`);
}

async function reconnectAccount(accountId:string):Promise<void>{
  const account=requireAccount(accountId);store.setAccountStatus(accountId,"offline","正在重新连接");
  const worker=workers.get(accountId);
  if(worker){reconnectRequested.add(accountId);worker.kill();}else await startAccount(account.id,account.name);
}

async function repairAccount(accountId:string):Promise<void>{
  const account=requireAccount(accountId);await accountRequest(accountId,"PATCH",{status:"pairing"});
  qrDataUrls.delete(accountId);repairRequested.add(accountId);store.setAccountStatus(accountId,"pairing");
  const worker=workers.get(accountId);
  if(worker){worker.send({type:"shutdown",logout:true});setTimeout(()=>{if(workers.get(accountId)===worker)worker.kill();},3_000).unref();return;}
  repairRequested.delete(accountId);await resetAccount(accountId,account.name);
}

async function resetAccount(accountId:string,name:string):Promise<void>{
  await rm(join(dataDir,"accounts",accountId),{recursive:true,force:true});
  if(!store.accounts().some(account=>account.id===accountId))return;
  store.setAccountStatus(accountId,"pairing");
  await startAccount(accountId,name);
}

async function removeLocalAccount(accountId:string):Promise<void>{
  if(!store.accounts().some(account=>account.id===accountId))return;
  qrDataUrls.delete(accountId);store.deleteAccount(accountId);store.discardRemovedAccountStatusEvents();
  const worker=workers.get(accountId);
  if(worker){removedWorkers.add(accountId);worker.send({type:"shutdown",logout:true});setTimeout(()=>{if(workers.get(accountId)===worker)worker.kill();},3_000).unref();return;}
  await rm(join(dataDir,"accounts",accountId),{recursive:true,force:true});
}

async function removeAccount(accountId:string):Promise<{warning?:string}>{
  requireAccount(accountId);
  try{await accountRequest(accountId,"DELETE");}
  catch(error){
    if(!(error instanceof CentralAccountRequestError)||error.status!==404)throw error;
    await removeLocalAccount(accountId);
    return {warning:"已移除 Docker 中的本地 WhatsApp 会话；中心平台未找到此账号与当前 Agent 的绑定，因此未修改中心端账号数据。"};
  }
  await removeLocalAccount(accountId);
  return {};
}

function requireAccount(accountId:string):{id:string;name:string}{
  const account=store.accounts().find(item=>item.id===accountId);if(!account)throw new Error("账号不存在");return account;
}

async function startDashboard():Promise<void>{
  if(!Number.isInteger(uiPort)||uiPort<1||uiPort>65535)throw new Error("RELAY_UI_PORT must be a valid TCP port");
  const html=(await readFile(join(import.meta.dirname,"docker-ui.html"),"utf8")).replace("__AGENT_VERSION__",VERSION);
  const server=createServer((request,response)=>void handleDashboardRequest(request,html,response).catch(error=>respondJson(response,400,{error:error instanceof Error?error.message:String(error)})));
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(uiPort,uiHost,()=>{server.off("error",reject);resolve();});});
}

async function handleDashboardRequest(request:IncomingMessage,html:string,response:ServerResponse):Promise<void>{
  const method=request.method??"GET";const path=new URL(request.url??"/","http://localhost").pathname;
  if(method==="GET"&&path==="/"){response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});response.end(html);return;}
  if(method==="GET"&&path==="/api/state"){respondJson(response,200,{agentName,baseUrl,version:VERSION,centralStatus:store.get("connection")??"offline",accounts:store.accounts(),qrDataUrls:Object.fromEntries(qrDataUrls)});return;}
  if(method==="POST"&&path==="/api/accounts"){
    const input=await readJson(request) as {name?:unknown};const name=String(input.name??"").trim();
    if(name.length<2||name.length>80)throw new Error("账号名称需要 2–80 个字符");
    const accountId=randomUUID();await registerAccount(accountId,name);await startAccount(accountId,name);respondJson(response,201,{ok:true,accountId});return;
  }
  const match=path.match(/^\/api\/accounts\/([^/]+)(?:\/(reconnect|repair))?$/);
  if(match){
    const accountId=decodeURIComponent(match[1]);const action=match[2];
    if(method==="PATCH"&&!action){const input=await readJson(request) as {name?:unknown};const name=String(input.name??"").trim();if(name.length<2||name.length>80)throw new Error("账号名称需要 2–80 个字符");requireAccount(accountId);await accountRequest(accountId,"PATCH",{name});store.renameAccount(accountId,name);respondJson(response,200,{ok:true});return;}
    if(method==="POST"&&action==="reconnect"){await reconnectAccount(accountId);respondJson(response,202,{ok:true});return;}
    if(method==="POST"&&action==="repair"){await repairAccount(accountId);respondJson(response,202,{ok:true});return;}
    if(method==="DELETE"&&!action){const result=await removeAccount(accountId);respondJson(response,202,{ok:true,...result});return;}
  }
  respondJson(response,404,{error:"not_found"});
}

async function readJson(request:IncomingMessage):Promise<unknown>{
  let body="";
  for await(const chunk of request){body+=String(chunk);if(body.length>16_384)throw new Error("请求内容过大");}
  if(!body)return {};
  try{return JSON.parse(body) as unknown;}catch{throw new Error("请求内容不是有效 JSON");}
}

function respondJson(response:ServerResponse,status:number,body:unknown):void{response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});response.end(JSON.stringify(body));}

async function executeCommand(command:{sequence:number;commandId:string;accountId:string;command:string;payload:Record<string,unknown>}):Promise<Record<string,unknown>>{
  const activeWorker=workers.get(command.accountId);if(!activeWorker)return deferred(command,"account_worker_unavailable","Account worker is restarting; command remains queued");
  return await new Promise(resolve=>{
    let complete=false;let started=false;
    const finish=(result:Record<string,unknown>)=>{if(complete)return;complete=true;clearTimeout(timer);activeWorker.off("message",onMessage);activeWorker.off("exit",onExit);resolve(result);};
    const onMessage=(message:Record<string,unknown>)=>{if(message.commandId!==command.commandId)return;if(message.type==="command_started")started=true;if(message.type==="command_result")finish(message);};
    const onExit=()=>finish(started?uncertain(command,"account_worker_restarted","Account worker restarted while sending; delivery could not be confirmed"):deferred(command,"account_worker_restarted","Account worker restarted before sending; command remains queued"));
    const timer:NodeJS.Timeout=setTimeout(()=>finish(started?uncertain(command,"account_worker_stalled","Account worker stopped responding during send"):deferred(command,"account_worker_unresponsive","Account worker did not accept the command")),70_000);
    activeWorker.on("message",onMessage);activeWorker.once("exit",onExit);activeWorker.send({type:"command",...command},error=>{if(error)finish(deferred(command,"account_worker_ipc_failed",error.message));});
  });
}

function authHeaders():Record<string,string>{return {authorization:`Bearer ${store.get("credential")!}`,"content-type":"application/json"};}
function deferred(command:{sequence:number;commandId:string},errorCode:string,errorMessage:string):Record<string,unknown>{return {type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode,errorMessage,completedAt:new Date().toISOString()};}
function uncertain(command:{sequence:number;commandId:string},errorCode:string,errorMessage:string):Record<string,unknown>{return {type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"uncertain",errorCode,errorMessage,completedAt:new Date().toISOString()};}
function required(name:string):string{const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;}
function shutdown():void{if(stopping)return;stopping=true;console.log("Stopping RelayDesk Docker Agent.");client?.stop();for(const worker of workers.values())worker.send({type:"shutdown"});setTimeout(()=>process.exit(0),3_000).unref();}
