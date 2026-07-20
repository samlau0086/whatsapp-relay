import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, initAuthCreds, jidNormalizedUser, normalizeMessageContent, proto, type AnyMessageContent, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pino } from "pino";
import { ProxyAgent as UndiciProxyAgent } from "undici";
import { describeSendError, isTransientSendConnectionError } from "./send-errors.js";

type Init = {type:"init";accountId:string;dataDir:string;masterKey:string;baseUrl:string;credential:string;proxyUrl?:string};
type Command = {type:"command";sequence:number;commandId:string;payload:Record<string,unknown>};
type Control = {type:"shutdown";logout?:boolean}|{type:"reconnect"};
let socket:ReturnType<typeof makeWASocket>|undefined;let init:Init|undefined;let sendChain=Promise.resolve();let reconnectAttempt=0;let reconnectTimer:NodeJS.Timeout|undefined;let connectionOpen=false;let connectionGeneration=0;let mediaProxyAgent:UndiciProxyAgent|undefined;let messageCache:Awaited<ReturnType<typeof encryptedAuthState>>|undefined;
const emit=(message:unknown):void=>{process.send?.(message);};
const emitIdentity=(accountId:string,lid:string,pn:string,displayName?:string):void=>{const lidJid=jidNormalizedUser(lid),phoneJid=jidNormalizedUser(pn);if(!lidJid.endsWith("@lid")||!phoneJid.endsWith("@s.whatsapp.net"))return;emit({type:"event",kind:"contact_identity",payload:{eventId:`identity:${accountId}:${lidJid}:${phoneJid}`,accountId,lidJid,phoneJid,displayName,at:new Date().toISOString()}});};

process.on("message",(message:Init|Command|Control)=>{
  if(message.type==="init"){init=message;void connect(message);}
  if(message.type==="command")sendChain=sendChain.then(()=>execute(message)).catch((error)=>emit({type:"command_result",sequence:message.sequence,commandId:message.commandId,outcome:"failed",errorCode:"send_failed",errorMessage:String(error),completedAt:new Date().toISOString()}));
  if(message.type==="reconnect"&&init){reconnectAttempt=0;void connect(init);}
  if(message.type==="shutdown")void shutdown(message.logout===true);
});

async function shutdown(logout:boolean):Promise<void>{
  connectionGeneration++;
  if(reconnectTimer)clearTimeout(reconnectTimer);
  try{if(logout&&socket)await socket.logout();else socket?.end(undefined);await mediaProxyAgent?.close();}catch{}finally{process.exit(0);}
}

async function connect(options:Init):Promise<void>{
  const generation=++connectionGeneration;
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=undefined;}
  const previousSocket=socket;socket=undefined;connectionOpen=false;
  try{previousSocket?.end(undefined);}catch{}
  try{await mediaProxyAgent?.close();}catch{}mediaProxyAgent=options.proxyUrl?new UndiciProxyAgent(options.proxyUrl):undefined;
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
      const sticker=Boolean(content.stickerMessage);
      const kind=content.imageMessage||sticker?"image":content.videoMessage?"video":content.audioMessage?"audio":content.documentMessage?"document":content.locationMessage?"location":content.contactMessage?"contact":"text";
      if(kind==="text"&&!text)continue;
      if(item.key.fromMe)await auth.saveMessage(item.key.id,item.message);
      let media:Record<string,unknown>|undefined;
      if(["image","video","audio","document"].includes(kind)){
        try{const mediaRequestOptions=mediaProxyAgent?({dispatcher:mediaProxyAgent} as unknown as RequestInit):undefined;const bytes=await downloadMediaMessage(item,"buffer",{options:mediaRequestOptions},{logger,reuploadRequest:async(message)=>activeSocket.updateMediaMessage(message)});const mime=content.stickerMessage?.mimetype??content.imageMessage?.mimetype??content.videoMessage?.mimetype??content.audioMessage?.mimetype??content.documentMessage?.mimetype??(sticker?"image/webp":"application/octet-stream");const fileName=sticker?`sticker-${item.key.id}.webp`:content.documentMessage?.fileName??`${item.key.id}.${kind}`;const uploaded=await uploadInboundMedia(options,bytes,mime,fileName);media={uploadId:uploaded.mediaId,mimeType:mime,fileName,size:uploaded.size,sha256:uploaded.sha256,isSticker:sticker};}
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
  // A socket can report the same close more than once. Keep the first retry
  // scheduled so repeated close notifications cannot postpone it forever.
  if(reconnectTimer)return;
  const delay=Math.min(60_000,3_000*(2**Math.min(reconnectAttempt++,5)))+Math.floor(Math.random()*1_000);
  emit({type:"reconnect_scheduled",accountId:options.accountId,delayMs:delay,attempt:reconnectAttempt});
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

async function uploadInboundMedia(options:Init,bytes:Buffer,mime:string,fileName:string):Promise<{mediaId:string;size:number;sha256:string}>{
  const sha256=createHash("sha256").update(bytes).digest("hex");let lastError:unknown;
  for(let attempt=0;attempt<5;attempt++){
    try{const form=new FormData();form.append("file",new Blob([bytes],{type:mime}),fileName);const response=await fetch(new URL(`/agent/media?accountId=${encodeURIComponent(options.accountId)}`,options.baseUrl),{method:"POST",headers:{authorization:`Bearer ${options.credential}`,"x-content-sha256":sha256},body:form,signal:AbortSignal.timeout(120_000)});if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,160)}`);return await response.json() as {mediaId:string;size:number;sha256:string};}catch(error){lastError=error;if(attempt<4)await new Promise(resolve=>setTimeout(resolve,Math.min(30_000,2_000*(2**attempt))));}
  }
  throw lastError;
}

async function execute(command:Command):Promise<void>{
  if(!socket||!init||!connectionOpen){emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode:"account_offline",errorMessage:"WhatsApp account is offline; command remains queued",completedAt:new Date().toISOString()});return;}const toJid=String(command.payload.toJid??"");if(!toJid)throw new Error("Missing destination JID");
  try{
    const type=String(command.payload.type??"text");let content:AnyMessageContent;
    if(type==="text")content={text:String(command.payload.text??"")};else{const media=await downloadOutboundMedia(init,String(command.payload.mediaId??""));const caption=command.payload.text?String(command.payload.text):undefined;if(type==="image")content={image:media.bytes,mimetype:media.mime,caption};else if(type==="video")content={video:media.bytes,mimetype:media.mime,caption};else if(type==="audio")content={audio:media.bytes,mimetype:media.mime,ptt:true};else content={document:media.bytes,mimetype:media.mime,fileName:media.name,caption};}
    const sent=await socket.sendMessage(toJid,content);if(sent?.key.id&&sent.message)await messageCache?.saveMessage(sent.key.id,sent.message);emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",whatsappMessageId:sent?.key.id,completedAt:new Date().toISOString()});
  }catch(error){const errorMessage=describeSendError(error);if(isTransientSendConnectionError(error)){emit({type:"diagnostic",level:"warn",accountId:init.accountId,message:"send_deferred_after_transient_error",detail:errorMessage});emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode:"transient_send_error",errorMessage:`Temporary send failure (${errorMessage}); command remains queued`,completedAt:new Date().toISOString()});return;}emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"failed",errorCode:"whatsapp_rejected",errorMessage,completedAt:new Date().toISOString()});}
}

async function downloadOutboundMedia(options:Init,mediaId:string):Promise<{bytes:Buffer;mime:string;name:string}>{
  if(!mediaId)throw new Error("Missing media ID");let lastError:unknown;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const requestOptions=mediaProxyAgent?({dispatcher:mediaProxyAgent} as unknown as RequestInit):undefined;
      const response=await fetch(new URL(`/agent/media/${encodeURIComponent(mediaId)}`,options.baseUrl),{...requestOptions,headers:{authorization:`Bearer ${options.credential}`},signal:AbortSignal.timeout(12_000)});
      if(!response.ok){const error=Object.assign(new Error(`Media download failed: HTTP ${response.status}`),{statusCode:response.status});if(![408,425,429,502,503,504].includes(response.status))throw error;lastError=error;}else return{bytes:Buffer.from(await response.arrayBuffer()),mime:response.headers.get("content-type")??"application/octet-stream",name:decodeURIComponent(response.headers.get("x-file-name")??"attachment")};
    }catch(error){lastError=error;if(!isTransientSendConnectionError(error))throw error;}
    if(attempt<4)await new Promise(resolve=>setTimeout(resolve,Math.min(15_000,1_000*(2**attempt))+Math.floor(Math.random()*500)));
  }
  throw lastError;
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
