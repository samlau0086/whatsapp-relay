import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, initAuthCreds, jidNormalizedUser, normalizeMessageContent, proto, type AnyMessageContent, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pino } from "pino";

type Init = {type:"init";accountId:string;dataDir:string;masterKey:string;baseUrl:string;credential:string;proxyUrl?:string};
type Command = {type:"command";sequence:number;commandId:string;payload:Record<string,unknown>};
type Control = {type:"shutdown";logout?:boolean};
let socket:ReturnType<typeof makeWASocket>|undefined;let init:Init|undefined;let sendChain=Promise.resolve();let reconnectAttempt=0;let reconnectTimer:NodeJS.Timeout|undefined;let connectionOpen=false;let connectionGeneration=0;let messageCache:Awaited<ReturnType<typeof encryptedAuthState>>|undefined;
const emit=(message:unknown):void=>{process.send?.(message);};
const emitIdentity=(accountId:string,lid:string,pn:string,displayName?:string):void=>{const lidJid=jidNormalizedUser(lid),phoneJid=jidNormalizedUser(pn);if(!lidJid.endsWith("@lid")||!phoneJid.endsWith("@s.whatsapp.net"))return;emit({type:"event",kind:"contact_identity",payload:{eventId:`identity:${accountId}:${lidJid}:${phoneJid}`,accountId,lidJid,phoneJid,displayName,at:new Date().toISOString()}});};

process.on("message",(message:Init|Command|Control)=>{
  if(message.type==="init"){init=message;void connect(message);}
  if(message.type==="command")sendChain=sendChain.then(()=>execute(message)).catch((error)=>emit({type:"command_result",sequence:message.sequence,commandId:message.commandId,outcome:"failed",errorCode:"send_failed",errorMessage:String(error),completedAt:new Date().toISOString()}));
  if(message.type==="shutdown")void shutdown(message.logout===true);
});

async function shutdown(logout:boolean):Promise<void>{
  connectionGeneration++;
  if(reconnectTimer)clearTimeout(reconnectTimer);
  try{if(logout&&socket)await socket.logout();else socket?.end(undefined);}catch{}finally{process.exit(0);}
}

async function connect(options:Init):Promise<void>{
  const generation=++connectionGeneration;
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=undefined;}
  const previousSocket=socket;socket=undefined;connectionOpen=false;
  try{previousSocket?.end(undefined);}catch{}
  try{
  const auth=await encryptedAuthState(join(options.dataDir,options.accountId),Buffer.from(options.masterKey,"hex"));
  if(generation!==connectionGeneration)return;
  messageCache=auth;
  for(const mapping of await auth.listLidMappings())emitIdentity(options.accountId,mapping.lid,mapping.pn);
  const proxyAgent=options.proxyUrl?new HttpsProxyAgent(options.proxyUrl):undefined;
  const {version}=await fetchLatestBaileysVersion();
  const logger=pino({level:"warn"});
  if(generation!==connectionGeneration)return;
  const activeSocket=makeWASocket({version,auth:auth.state,logger,browser:Browsers.windows("RelayDesk Agent"),syncFullHistory:false,markOnlineOnConnect:false,generateHighQualityLinkPreview:false,agent:proxyAgent,fetchAgent:proxyAgent,getMessage:async key=>key.id?auth.getMessage(key.id):undefined});
  socket=activeSocket;
  activeSocket.ev.on("creds.update",auth.saveCreds);
  activeSocket.ev.on("lid-mapping.update",({lid,pn})=>{if(generation!==connectionGeneration)return;void auth.saveLidMapping(lid,pn);emitIdentity(options.accountId,lid,pn);});
  activeSocket.ev.on("messaging-history.set",({lidPnMappings})=>{if(generation!==connectionGeneration)return;for(const mapping of lidPnMappings??[])emitIdentity(options.accountId,mapping.lid,mapping.pn);});
  activeSocket.ev.on("connection.update",({connection,lastDisconnect,qr})=>{
    if(generation!==connectionGeneration)return;
    if(qr)emit({type:"qr",accountId:options.accountId,qr});
    if(connection==="open"){connectionOpen=true;reconnectAttempt=0;if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=undefined;}emit({type:"status",accountId:options.accountId,status:"online"});}
    if(connection==="close"){
      connectionOpen=false;
      const status=(lastDisconnect?.error as {output?:{statusCode?:number}}|undefined)?.output?.statusCode;
      if(status===DisconnectReason.loggedOut){emit({type:"status",accountId:options.accountId,status:"logged_out"});return;}
      emit({type:"status",accountId:options.accountId,status:"offline",reason:disconnectReason(lastDisconnect?.error)});scheduleReconnect(options,generation);
    }
  });
  activeSocket.ev.on("messages.upsert",({messages})=>{if(generation!==connectionGeneration)return;void (async()=>{
    for(const item of messages){
      const rawJid=jidNormalizedUser(item.key.remoteJid??undefined);if(!rawJid||rawJid.endsWith("@g.us")||!item.key.id||!item.message)continue;
      const repositoryJid=rawJid.endsWith("@lid")?await activeSocket.signalRepository.lidMapping.getPNForLID(rawJid):null;
      const jid=jidNormalizedUser(repositoryJid??await auth.resolveJid(rawJid));
      if(rawJid.endsWith("@lid")&&jid.endsWith("@s.whatsapp.net"))emitIdentity(options.accountId,rawJid,jid,item.pushName??undefined);
      const content=normalizeMessageContent(item.message);if(!content)continue;
      const text=content.conversation??content.extendedTextMessage?.text??content.imageMessage?.caption??content.videoMessage?.caption??content.buttonsResponseMessage?.selectedDisplayText??content.listResponseMessage?.title??undefined;
      const kind=content.imageMessage?"image":content.videoMessage?"video":content.audioMessage?"audio":content.documentMessage?"document":content.locationMessage?"location":content.contactMessage?"contact":"text";
      if(kind==="text"&&!text)continue;
      if(item.key.fromMe)await auth.saveMessage(item.key.id,item.message);
      let media:Record<string,unknown>|undefined;
      if(["image","video","audio","document"].includes(kind)){
        try{const bytes=await downloadMediaMessage(item,"buffer",{},{logger,reuploadRequest:async(message)=>activeSocket.updateMediaMessage(message)});const mime=content.imageMessage?.mimetype??content.videoMessage?.mimetype??content.audioMessage?.mimetype??content.documentMessage?.mimetype??"application/octet-stream";const fileName=content.documentMessage?.fileName??`${item.key.id}.${kind}`;const form=new FormData();form.append("file",new Blob([bytes],{type:mime}),fileName);const response=await fetch(new URL(`/agent/media?accountId=${encodeURIComponent(options.accountId)}`,options.baseUrl),{method:"POST",headers:{authorization:`Bearer ${options.credential}`,"x-content-sha256":createHash("sha256").update(bytes).digest("hex")},body:form});if(response.ok){const uploaded=await response.json() as {mediaId:string;size:number;sha256:string};media={uploadId:uploaded.mediaId,mimeType:mime,fileName,size:uploaded.size,sha256:uploaded.sha256};}}
        catch(error){emit({type:"diagnostic",level:"warn",accountId:options.accountId,message:"media_upload_failed",detail:String(error)});}
      }
      emit({type:"event",kind:"message",payload:{eventId:`message:${options.accountId}:${item.key.id}`,accountId:options.accountId,whatsappMessageId:item.key.id,chatJid:jid,rawChatJid:rawJid,senderJid:jidNormalizedUser(item.key.participant??jid),senderName:item.pushName??undefined,direction:item.key.fromMe?"out":"in",kind,text,occurredAt:messageTime(item.messageTimestamp),media}});
    }
  })().catch(error=>emit({type:"diagnostic",level:"error",accountId:options.accountId,message:"message_normalize_failed",detail:String(error)}));});
  activeSocket.ev.on("messages.update",(updates)=>{if(generation!==connectionGeneration)return;for(const update of updates){if(!update.key.id||!update.update.status)continue;const mapped=update.update.status>=4?"read":update.update.status>=3?"delivered":"sent";emit({type:"event",kind:"message_status",payload:{eventId:`status:${options.accountId}:${update.key.id}:${mapped}`,accountId:options.accountId,whatsappMessageId:update.key.id,status:mapped,at:new Date().toISOString()}});}});
  }catch(error){if(generation!==connectionGeneration)return;connectionOpen=false;emit({type:"status",accountId:options.accountId,status:"offline",reason:disconnectReason(error)});scheduleReconnect(options,generation);}
}

function scheduleReconnect(options:Init,generation:number):void{
  if(generation!==connectionGeneration)return;
  if(reconnectTimer)clearTimeout(reconnectTimer);
  const delay=Math.min(60_000,3_000*(2**Math.min(reconnectAttempt++,5)))+Math.floor(Math.random()*1_000);
  reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;if(generation===connectionGeneration)void connect(options);},delay);
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
  if(!socket||!init||!connectionOpen){emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode:"account_offline",errorMessage:"WhatsApp account is offline; command remains queued",completedAt:new Date().toISOString()});return;}const toJid=String(command.payload.toJid??"");if(!toJid)throw new Error("Missing destination JID");
  const type=String(command.payload.type??"text");let content:AnyMessageContent;
  if(type==="text")content={text:String(command.payload.text??"")};else{const mediaId=String(command.payload.mediaId??"");const response=await fetch(new URL(`/agent/media/${mediaId}`,init.baseUrl),{headers:{authorization:`Bearer ${init.credential}`}});if(!response.ok)throw new Error(`Media download failed: ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());const mime=response.headers.get("content-type")??"application/octet-stream";const name=response.headers.get("x-file-name")??"attachment";const caption=command.payload.text?String(command.payload.text):undefined;if(type==="image")content={image:bytes,mimetype:mime,caption};else if(type==="video")content={video:bytes,mimetype:mime,caption};else if(type==="audio")content={audio:bytes,mimetype:mime,ptt:true};else content={document:bytes,mimetype:mime,fileName:name,caption};}
  try{const sent=await socket.sendMessage(toJid,content);if(sent?.key.id&&sent.message)await messageCache?.saveMessage(sent.key.id,sent.message);emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",whatsappMessageId:sent?.key.id,completedAt:new Date().toISOString()});}catch(error){emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"failed",errorCode:"whatsapp_rejected",errorMessage:error instanceof Error?error.message:String(error),completedAt:new Date().toISOString()});}
}

function messageTime(value:unknown):string{
  const seconds=Number(value);const date=new Date(Number.isFinite(seconds)&&seconds>0?seconds*1000:Date.now());return date.toISOString();
}

async function encryptedAuthState(directory:string,key:Buffer):Promise<{state:AuthenticationState;saveCreds:()=>Promise<void>;getMessage:(id:string)=>Promise<proto.IMessage|undefined>;saveMessage:(id:string,message:proto.IMessage)=>Promise<void>;resolveJid:(jid:string)=>Promise<string>;saveLidMapping:(lid:string,jid:string)=>Promise<void>;listLidMappings:()=>Promise<Array<{lid:string;pn:string}>>}>{
  await mkdir(directory,{recursive:true});const file=(name:string)=>join(directory,encodeURIComponent(name));
  const read=async(name:string)=>{try{const packed=await readFile(file(name));const iv=packed.subarray(0,12);const tag=packed.subarray(12,28);const decipher=createDecipheriv("aes-256-gcm",key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString(),BufferJSON.reviver);}catch{return null;}};
  const write=async(name:string,value:unknown)=>{const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value,BufferJSON.replacer)),cipher.final()]);await writeFile(file(name),Buffer.concat([iv,cipher.getAuthTag(),encrypted]));};
  const remove=async(name:string)=>{await rm(file(name),{force:true});};const creds=await read("creds")??initAuthCreds();
  return {state:{creds,keys:{get:async(type,ids)=>{const data:Record<string,unknown>={};for(const id of ids){let value=await read(`${type}-${id}`);if(type==="app-state-sync-key"&&value)value=proto.Message.AppStateSyncKeyData.fromObject(value);data[id]=value;}return data as {[id:string]:SignalDataTypeMap[typeof type]};},set:async(data)=>{for(const category of Object.keys(data) as Array<keyof SignalDataTypeMap>){for(const id of Object.keys(data[category]??{})){const value=data[category]?.[id];if(value)await write(`${category}-${id}`,value);else await remove(`${category}-${id}`);}}}}},saveCreds:()=>write("creds",creds),getMessage:async id=>(await read(`message-${id}`))??undefined,saveMessage:(id,message)=>write(`message-${id}`,message),resolveJid:async jid=>jid.endsWith("@lid")?(await read(`lid-${jid}`) as string|null)??jid:jid,saveLidMapping:async(lid,jid)=>{await write(`lid-${jidNormalizedUser(lid)}`,jidNormalizedUser(jid));},listLidMappings:async()=>{const mappings:Array<{lid:string;pn:string}>=[];for(const encoded of await readdir(directory)){const name=decodeURIComponent(encoded),match=/^lid-mapping-(\d+)$/.exec(name);if(!match)continue;const lidUser=await read(name);if(typeof lidUser==="string"&&/^\d+$/.test(lidUser))mappings.push({lid:`${lidUser}@lid`,pn:`${match[1]}@s.whatsapp.net`});}return mappings;}};
}
