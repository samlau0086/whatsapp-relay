import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, initAuthCreds, proto, type AnyMessageContent, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pino } from "pino";

type Init = {type:"init";accountId:string;dataDir:string;masterKey:string;baseUrl:string;credential:string;proxyUrl?:string};
type Command = {type:"command";sequence:number;commandId:string;payload:Record<string,unknown>};
type Control = {type:"shutdown";logout?:boolean};
let socket:ReturnType<typeof makeWASocket>|undefined;let init:Init|undefined;let sendChain=Promise.resolve();let reconnectAttempt=0;let reconnectTimer:NodeJS.Timeout|undefined;
const emit=(message:unknown):void=>{process.send?.(message);};

process.on("message",(message:Init|Command|Control)=>{
  if(message.type==="init"){init=message;void connect(message);}
  if(message.type==="command")sendChain=sendChain.then(()=>execute(message)).catch((error)=>emit({type:"command_result",sequence:message.sequence,commandId:message.commandId,outcome:"failed",errorCode:"send_failed",errorMessage:String(error),completedAt:new Date().toISOString()}));
  if(message.type==="shutdown")void shutdown(message.logout===true);
});

async function shutdown(logout:boolean):Promise<void>{
  if(reconnectTimer)clearTimeout(reconnectTimer);
  try{if(logout&&socket)await socket.logout();else socket?.end(undefined);}catch{}finally{process.exit(0);}
}

async function connect(options:Init):Promise<void>{
  try{
  const auth=await encryptedAuthState(join(options.dataDir,options.accountId),Buffer.from(options.masterKey,"hex"));
  const proxyAgent=options.proxyUrl?new HttpsProxyAgent(options.proxyUrl):undefined;
  const axiosOptions=proxyAgent?{httpsAgent:proxyAgent,proxy:false as const}:{};
  const {version}=await fetchLatestBaileysVersion(axiosOptions);
  const logger=pino({level:"warn"});
  socket=makeWASocket({version,auth:auth.state,logger,browser:Browsers.windows("RelayDesk Agent"),syncFullHistory:false,markOnlineOnConnect:false,generateHighQualityLinkPreview:false,agent:proxyAgent,fetchAgent:proxyAgent,options:axiosOptions});
  socket.ev.on("creds.update",auth.saveCreds);
  socket.ev.on("connection.update",({connection,lastDisconnect,qr})=>{
    if(qr)emit({type:"qr",accountId:options.accountId,qr});
    if(connection==="open"){reconnectAttempt=0;emit({type:"status",accountId:options.accountId,status:"online"});}
    if(connection==="close"){
      const status=(lastDisconnect?.error as {output?:{statusCode?:number}}|undefined)?.output?.statusCode;
      if(status===DisconnectReason.loggedOut){emit({type:"status",accountId:options.accountId,status:"logged_out"});return;}
      emit({type:"status",accountId:options.accountId,status:"offline",reason:disconnectReason(lastDisconnect?.error)});scheduleReconnect(options);
    }
  });
  socket.ev.on("messages.upsert",({messages})=>{void (async()=>{
    for(const item of messages){
      const jid=item.key.remoteJid;if(!jid||jid.endsWith("@g.us")||!item.key.id||!item.message)continue;
      const content=item.message;const text=content.conversation??content.extendedTextMessage?.text??content.imageMessage?.caption??content.videoMessage?.caption??undefined;
      const kind=content.imageMessage?"image":content.videoMessage?"video":content.audioMessage?"audio":content.documentMessage?"document":content.locationMessage?"location":content.contactMessage?"contact":"text";
      let media:Record<string,unknown>|undefined;
      if(["image","video","audio","document"].includes(kind)){
        try{const bytes=await downloadMediaMessage(item,"buffer",{},{logger,reuploadRequest:async(message)=>socket!.updateMediaMessage(message)});const mime=content.imageMessage?.mimetype??content.videoMessage?.mimetype??content.audioMessage?.mimetype??content.documentMessage?.mimetype??"application/octet-stream";const fileName=content.documentMessage?.fileName??`${item.key.id}.${kind}`;const form=new FormData();form.append("file",new Blob([bytes],{type:mime}),fileName);const response=await fetch(new URL(`/agent/media?accountId=${encodeURIComponent(options.accountId)}`,options.baseUrl),{method:"POST",headers:{authorization:`Bearer ${options.credential}`,"x-content-sha256":createHash("sha256").update(bytes).digest("hex")},body:form});if(response.ok){const uploaded=await response.json() as {mediaId:string;size:number;sha256:string};media={uploadId:uploaded.mediaId,mimeType:mime,fileName,size:uploaded.size,sha256:uploaded.sha256};}}
        catch(error){emit({type:"diagnostic",level:"warn",accountId:options.accountId,message:"media_upload_failed",detail:String(error)});}
      }
      emit({type:"event",kind:"message",payload:{eventId:`message:${options.accountId}:${item.key.id}`,accountId:options.accountId,whatsappMessageId:item.key.id,chatJid:jid,senderJid:item.key.participant??jid,direction:item.key.fromMe?"out":"in",kind,text,occurredAt:new Date(Number(item.messageTimestamp)*1000).toISOString(),media}});
    }
  })();});
  socket.ev.on("messages.update",(updates)=>{for(const update of updates){if(!update.key.id||!update.update.status)continue;const mapped=update.update.status>=4?"read":update.update.status>=3?"delivered":"sent";emit({type:"event",kind:"message_status",payload:{eventId:`status:${options.accountId}:${update.key.id}:${mapped}`,accountId:options.accountId,whatsappMessageId:update.key.id,status:mapped,at:new Date().toISOString()}});}});
  }catch(error){emit({type:"status",accountId:options.accountId,status:"offline",reason:disconnectReason(error)});scheduleReconnect(options);}
}

function scheduleReconnect(options:Init):void{
  if(reconnectTimer)clearTimeout(reconnectTimer);
  const delay=Math.min(60_000,3_000*(2**Math.min(reconnectAttempt++,5)))+Math.floor(Math.random()*1_000);
  reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;void connect(options);},delay);
}

function disconnectReason(error:unknown):string{
  const value=error as {message?:string;code?:string;data?:{code?:string;address?:string;port?:number};cause?:{code?:string};output?:{statusCode?:number}}|undefined;
  const code=value?.data?.code??value?.code??value?.cause?.code;
  const status=value?.output?.statusCode;
  const target=value?.data?.address&&value.data.port?` ${value.data.address}:${value.data.port}`:"";
  const message=value?.message??String(error??"connection_closed");
  return `${status?`[${status}] `:""}${code?`${code}: `:""}${message}${target}`.replace(/\s+/g," ").slice(0,300);
}

async function execute(command:Command):Promise<void>{
  if(!socket||!init)throw new Error("WhatsApp account is not connected");const toJid=String(command.payload.toJid??"");if(!toJid)throw new Error("Missing destination JID");
  const type=String(command.payload.type??"text");let content:AnyMessageContent;
  if(type==="text")content={text:String(command.payload.text??"")};else{const mediaId=String(command.payload.mediaId??"");const response=await fetch(new URL(`/agent/media/${mediaId}`,init.baseUrl),{headers:{authorization:`Bearer ${init.credential}`}});if(!response.ok)throw new Error(`Media download failed: ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());const mime=response.headers.get("content-type")??"application/octet-stream";const name=response.headers.get("x-file-name")??"attachment";const caption=command.payload.text?String(command.payload.text):undefined;if(type==="image")content={image:bytes,mimetype:mime,caption};else if(type==="video")content={video:bytes,mimetype:mime,caption};else if(type==="audio")content={audio:bytes,mimetype:mime,ptt:true};else content={document:bytes,mimetype:mime,fileName:name,caption};}
  try{const sent=await socket.sendMessage(toJid,content);emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",whatsappMessageId:sent?.key.id,completedAt:new Date().toISOString()});}catch(error){emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"failed",errorCode:"whatsapp_rejected",errorMessage:error instanceof Error?error.message:String(error),completedAt:new Date().toISOString()});}
}

async function encryptedAuthState(directory:string,key:Buffer):Promise<{state:AuthenticationState;saveCreds:()=>Promise<void>}>{
  await mkdir(directory,{recursive:true});const file=(name:string)=>join(directory,encodeURIComponent(name));
  const read=async(name:string)=>{try{const packed=await readFile(file(name));const iv=packed.subarray(0,12);const tag=packed.subarray(12,28);const decipher=createDecipheriv("aes-256-gcm",key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString(),BufferJSON.reviver);}catch{return null;}};
  const write=async(name:string,value:unknown)=>{const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value,BufferJSON.replacer)),cipher.final()]);await writeFile(file(name),Buffer.concat([iv,cipher.getAuthTag(),encrypted]));};
  const remove=async(name:string)=>{await rm(file(name),{force:true});};const creds=await read("creds")??initAuthCreds();
  return {state:{creds,keys:{get:async(type,ids)=>{const data:Record<string,unknown>={};for(const id of ids){let value=await read(`${type}-${id}`);if(type==="app-state-sync-key"&&value)value=proto.Message.AppStateSyncKeyData.fromObject(value);data[id]=value;}return data as {[id:string]:SignalDataTypeMap[typeof type]};},set:async(data)=>{for(const category of Object.keys(data) as Array<keyof SignalDataTypeMap>){for(const id of Object.keys(data[category]??{})){const value=data[category]?.[id];if(value)await write(`${category}-${id}`,value);else await remove(`${category}-${id}`);}}}}},saveCreds:()=>write("creds",creds)};
}
