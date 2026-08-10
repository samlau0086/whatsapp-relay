import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import QRCode from "qrcode";
import { AgentStore } from "./store.js";
import { CentralClient } from "./central-client.js";

const PROTOCOL_VERSION=2;
const VERSION=process.env.npm_package_version??"docker";
const dataDir=process.env.RELAY_DATA_DIR??"/data";
const baseUrl=required("RELAY_CENTRAL_URL");
const accountId=required("RELAY_ACCOUNT_ID");
const accountName=process.env.RELAY_ACCOUNT_NAME?.trim()||"Docker WhatsApp";
const agentName=process.env.RELAY_AGENT_NAME?.trim()||`Docker Agent (${accountName})`;
const proxyUrl=process.env.RELAY_PROXY_URL?.trim()||undefined;
const uiHost=process.env.RELAY_UI_BIND?.trim()||"127.0.0.1";
const uiPort=Number(process.env.RELAY_UI_PORT??8788);
let store:AgentStore;
let client:CentralClient|undefined;
let worker:ChildProcess|undefined;
let stopping=false;
let masterKey="";
let qrDataUrl="";
let repairRequested=false;

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
  const savedAccount=store.accounts()[0];
  if(savedAccount&&savedAccount.id!==accountId)throw new Error(`RELAY_ACCOUNT_ID differs from the persisted account (${savedAccount.id})`);
  if(!savedAccount)await createAccount();
  startCentral();
  await startWorker();
  await startDashboard();
  process.on("SIGTERM",shutdown);
  process.on("SIGINT",shutdown);
  console.log(`RelayDesk Docker Agent is running for account ${accountId}. Open http://${uiHost}:${uiPort} to scan the QR code.`);
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

async function createAccount():Promise<void>{
  const response=await fetch(new URL("/agent/accounts",baseUrl),{method:"POST",headers:authHeaders(),body:JSON.stringify({id:accountId,name:accountName})});
  if(!response.ok)throw new Error(`Account registration failed (HTTP ${response.status})`);
  store.upsertAccount(accountId,accountName,"pairing");
}

function startCentral():void{
  const agentId=store.get("agentId")!;const credential=store.get("credential")!;
  client=new CentralClient(store,baseUrl,agentId,credential,VERSION,`docker-${process.platform}-${process.arch}`,PROTOCOL_VERSION,["publish_status_v1","group_chat_v1","group_create_v1"],executeCommand,status=>{store.set("connection",status);console.log(`Central connection: ${status}`);},()=>undefined);
  client.start();
}

async function startWorker():Promise<void>{
  if(worker||stopping)return;
  const next=fork(join(import.meta.dirname,"account-worker.js"),[],{stdio:["ignore","inherit","inherit","ipc"]});
  worker=next;
  let lastHeartbeat=Date.now();
  const watchdog=setInterval(()=>{if(Date.now()-lastHeartbeat>30_000){console.error("Account worker heartbeat timed out; restarting.");next.kill();}},10_000);
  next.on("message",message=>{
    const value=message as Record<string,unknown>;
    if(value.type==="worker_heartbeat"){lastHeartbeat=Date.now();return;}
    if(value.type==="event"){const payload=value.payload as Record<string,unknown>;store.enqueueEvent(String(payload.eventId),String(value.kind),payload);client?.flush();return;}
    if(value.type==="status"){const status=String(value.status),reason=typeof value.reason==="string"?value.reason:undefined,eventId=`status:${accountId}:${Date.now()}`;if(status==="online"||status==="logged_out")qrDataUrl="";store.setAccountStatus(accountId,status,reason);store.enqueueEvent(eventId,"account_status",{eventId,accountId,status,reason,at:new Date().toISOString()});client?.flush();console.log(`WhatsApp account: ${status}${reason?` (${reason})`:""}`);return;}
    if(value.type==="qr")void updateQr(String(value.qr));
  });
  next.on("exit",()=>{clearInterval(watchdog);if(worker===next)worker=undefined;if(stopping)return;if(repairRequested){repairRequested=false;void resetAccount();return;}store.setAccountStatus(accountId,"offline","worker_exited");setTimeout(()=>void startWorker(),5_000);});
  next.send({type:"init",accountId,dataDir:join(dataDir,"accounts"),masterKey,baseUrl,credential:store.get("credential")!,proxyUrl});
}

async function updateQr(qr:string):Promise<void>{
  qrDataUrl=await QRCode.toDataURL(qr,{width:360,margin:1});
  console.log(`WhatsApp QR code is ready at http://${uiHost}:${uiPort}.`);
}

async function reconnect():Promise<void>{
  if(!worker)return void startWorker();
  worker.kill();
}

async function repair():Promise<void>{
  qrDataUrl="";repairRequested=true;
  if(worker){worker.send({type:"shutdown",logout:true});setTimeout(()=>worker?.kill(),3_000).unref();return;}
  repairRequested=false;await resetAccount();
}

async function resetAccount():Promise<void>{
  await rm(join(dataDir,"accounts",accountId),{recursive:true,force:true});
  store.setAccountStatus(accountId,"pairing");
  await startWorker();
}

async function startDashboard():Promise<void>{
  if(!Number.isInteger(uiPort)||uiPort<1||uiPort>65535)throw new Error("RELAY_UI_PORT must be a valid TCP port");
  const html=await readFile(join(import.meta.dirname,"docker-ui.html"),"utf8");
  const server=createServer((request,response)=>void handleDashboardRequest(request.method??"GET",request.url??"/",html,response));
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(uiPort,uiHost,()=>{server.off("error",reject);resolve();});});
}

async function handleDashboardRequest(method:string,url:string,html:string,response:ServerResponse):Promise<void>{
  const path=new URL(url,"http://localhost").pathname;
  if(method==="GET"&&path==="/"){response.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});response.end(html);return;}
  if(method==="GET"&&path==="/api/state"){respondJson(response,200,{agentName,baseUrl,version:VERSION,centralStatus:store.get("connection")??"offline",account:store.accounts()[0]??null,qrDataUrl});return;}
  if(method==="POST"&&path==="/api/reconnect"){await reconnect();respondJson(response,202,{ok:true});return;}
  if(method==="POST"&&path==="/api/repair"){await repair();respondJson(response,202,{ok:true});return;}
  respondJson(response,404,{error:"not_found"});
}

function respondJson(response:ServerResponse,status:number,body:unknown):void{response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});response.end(JSON.stringify(body));}

async function executeCommand(command:{sequence:number;commandId:string;accountId:string;command:string;payload:Record<string,unknown>}):Promise<Record<string,unknown>>{
  const activeWorker=worker;if(!activeWorker)return deferred(command,"account_worker_unavailable","Account worker is restarting; command remains queued");
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
function shutdown():void{if(stopping)return;stopping=true;console.log("Stopping RelayDesk Docker Agent.");client?.stop();worker?.send({type:"shutdown"});setTimeout(()=>process.exit(0),3_000).unref();}
