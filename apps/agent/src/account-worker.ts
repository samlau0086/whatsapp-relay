import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, initAuthCreds, jidNormalizedUser, normalizeMessageContent, proto, type AnyMessageContent, type AuthenticationState, type GroupMetadata, type GroupParticipant, type SignalDataTypeMap, type WAMessage } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import { pino } from "pino";
import { ProxyAgent as UndiciProxyAgent } from "undici";
import { centralMediaAuthorizationError, describeSendError, isCentralMediaAuthorizationError, isSendConfirmationTimeout, isTransientSendConnectionError, waitForSendConfirmation } from "./send-errors.js";

type Init = {type:"init";accountId:string;dataDir:string;masterKey:string;baseUrl:string;credential:string;proxyUrl?:string};
type Command = {type:"command";sequence:number;commandId:string;command:string;payload:Record<string,unknown>};
type Control = {type:"shutdown";logout?:boolean}|{type:"reconnect"};
let socket:ReturnType<typeof makeWASocket>|undefined;let init:Init|undefined;let sendChain=Promise.resolve();let reconnectAttempt=0;let reconnectTimer:NodeJS.Timeout|undefined;let connectionOpen=false;let connectionGeneration=0;let mediaProxyAgent:UndiciProxyAgent|undefined;let messageCache:Awaited<ReturnType<typeof encryptedAuthState>>|undefined;const groupRefreshTimers=new Map<string,NodeJS.Timeout>();
const emit=(message:unknown):void=>{process.send?.(message);};
const emitIdentity=(accountId:string,lid:string,pn:string,displayName?:string):void=>{const lidJid=jidNormalizedUser(lid),phoneJid=jidNormalizedUser(pn);if(!lidJid.endsWith("@lid")||!phoneJid.endsWith("@s.whatsapp.net"))return;emit({type:"event",kind:"contact_identity",payload:{eventId:`identity:${accountId}:${lidJid}:${phoneJid}`,accountId,lidJid,phoneJid,displayName,at:new Date().toISOString()}});};
setInterval(()=>emit({type:"worker_heartbeat",at:new Date().toISOString()}),10_000).unref();

process.on("message",(message:Init|Command|Control)=>{
  if(message.type==="init"){init=message;void connect(message);}
  if(message.type==="command"){
    emit({type:"command_accepted",commandId:message.commandId});
    sendChain=sendChain.then(()=>{emit({type:"command_started",commandId:message.commandId});return execute(message);}).catch((error)=>emit({type:"command_result",sequence:message.sequence,commandId:message.commandId,outcome:"failed",errorCode:"send_failed",errorMessage:String(error),completedAt:new Date().toISOString()}));
  }
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
  for(const timer of groupRefreshTimers.values())clearTimeout(timer);groupRefreshTimers.clear();
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
  // The version lookup is hosted on GitHub, which may be unreachable directly
  // on networks where WhatsApp itself also requires the configured proxy. If it
  // silently falls back to the version bundled with Baileys, WhatsApp can reject
  // every account with a 405 once that bundled protocol version becomes stale.
  const {version}=await fetchLatestBaileysVersion(
    mediaProxyAgent ? ({dispatcher:mediaProxyAgent} as unknown as RequestInit) : undefined,
  );
  const logger=pino({level:"warn"});
  if(generation!==connectionGeneration)return;
  const activeSocket=makeWASocket({version,auth:auth.state,logger,browser:Browsers.windows("RelayDesk Agent"),connectTimeoutMs:60_000,syncFullHistory:false,markOnlineOnConnect:false,generateHighQualityLinkPreview:false,agent:proxyAgent,fetchAgent:proxyAgent,getMessage:async key=>key.id?auth.getMessage(key.id):undefined});
  socket=activeSocket;
  activeSocket.ev.on("creds.update",auth.saveCreds);
  activeSocket.ev.on("lid-mapping.update",({lid,pn})=>{if(generation!==connectionGeneration)return;void auth.saveLidMapping(lid,pn);emitIdentity(options.accountId,lid,pn);});
  activeSocket.ev.on("messaging-history.set",({lidPnMappings})=>{if(generation!==connectionGeneration)return;for(const mapping of lidPnMappings??[])emitIdentity(options.accountId,mapping.lid,mapping.pn);});
  activeSocket.ev.on("connection.update",({connection,lastDisconnect,qr})=>{
    if(generation!==connectionGeneration)return;
    if(qr)emit({type:"qr",accountId:options.accountId,qr});
    if(connection==="open"){connectionOpen=true;reconnectAttempt=0;if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=undefined;}emit({type:"status",accountId:options.accountId,status:"online"});void syncParticipatingGroups(activeSocket,options,generation);}
    if(connection==="close"){
      connectionOpen=false;
      const status=(lastDisconnect?.error as {output?:{statusCode?:number}}|undefined)?.output?.statusCode;
      if(status===DisconnectReason.loggedOut){emit({type:"status",accountId:options.accountId,status:"logged_out"});return;}
      emit({type:"status",accountId:options.accountId,status:"offline",reason:disconnectReason(lastDisconnect?.error)});scheduleReconnect(options,generation);
    }
  });
  const refreshGroup=(groupJid:string)=>{
    const jid=jidNormalizedUser(groupJid);if(!jid.endsWith("@g.us")||generation!==connectionGeneration)return;
    const previous=groupRefreshTimers.get(jid);if(previous)clearTimeout(previous);
    groupRefreshTimers.set(jid,setTimeout(()=>{groupRefreshTimers.delete(jid);void activeSocket.groupMetadata(jid).then(metadata=>emitGroupSnapshot(options,metadata)).catch(error=>emit({type:"diagnostic",level:"warn",accountId:options.accountId,message:"group_metadata_refresh_failed",detail:`${jid}: ${String(error)}`}));},750));
  };
  activeSocket.ev.on("groups.upsert",groups=>{if(generation!==connectionGeneration)return;for(const group of groups)emitGroupSnapshot(options,group);});
  activeSocket.ev.on("groups.update",groups=>{if(generation!==connectionGeneration)return;for(const group of groups)if(group.id)refreshGroup(group.id);});
  activeSocket.ev.on("group-participants.update",update=>{if(generation===connectionGeneration)refreshGroup(update.id);});
  activeSocket.ev.on("messages.upsert",({messages,type})=>{if(generation!==connectionGeneration)return;void (async()=>{
    for(const item of messages){
      const rawJid=jidNormalizedUser(item.key.remoteJid??undefined);if(!rawJid||rawJid.endsWith("@broadcast")||!item.key.id||!item.message)continue;
      const isGroup=rawJid.endsWith("@g.us");
      const repositoryJid=!isGroup&&rawJid.endsWith("@lid")?await activeSocket.signalRepository.lidMapping.getPNForLID(rawJid):null;
      const jid=isGroup?rawJid:jidNormalizedUser(repositoryJid??await auth.resolveJid(rawJid));
      const remotePushName=item.key.fromMe?undefined:item.pushName??undefined;
      if(rawJid.endsWith("@lid")&&jid.endsWith("@s.whatsapp.net"))emitIdentity(options.accountId,rawJid,jid,remotePushName);
      const rawSender=jidNormalizedUser(item.key.participant??(isGroup?undefined:jid));
      const senderJid=rawSender?await resolveUserJid(activeSocket,auth,rawSender):jid;
      if(rawSender.endsWith("@lid")&&senderJid.endsWith("@s.whatsapp.net"))emitIdentity(options.accountId,rawSender,senderJid,remotePushName);
      const content=normalizeMessageContent(item.message);if(!content)continue;
      const text=content.conversation??content.extendedTextMessage?.text??content.imageMessage?.caption??content.videoMessage?.caption??content.documentMessage?.caption??content.buttonsResponseMessage?.selectedDisplayText??content.listResponseMessage?.title??undefined;
      const adReferral=externalAdReferral(content);
      const quotedWhatsappMessageId=quotedMessageId(content);
      const quotedParticipantJid=quotedParticipant(content);
      const sticker=Boolean(content.stickerMessage);
      const kind=content.imageMessage||sticker?"image":content.videoMessage?"video":content.audioMessage?"audio":content.documentMessage?"document":content.locationMessage?"location":content.contactMessage?"contact":"text";
      if(kind==="text"&&!text&&!adReferral)continue;
      await auth.saveMessage(item.key.id,item.message);
      let media:Record<string,unknown>|undefined;
      if(["image","video","audio","document"].includes(kind)){
        try{const mediaRequestOptions=mediaProxyAgent?({dispatcher:mediaProxyAgent} as unknown as RequestInit):undefined;const bytes=await downloadInboundMessageMedia(item,mediaRequestOptions,logger,activeSocket);const mime=content.stickerMessage?.mimetype??content.imageMessage?.mimetype??content.videoMessage?.mimetype??content.audioMessage?.mimetype??content.documentMessage?.mimetype??(sticker?"image/webp":"application/octet-stream");const fileName=sticker?`sticker-${item.key.id}.webp`:content.documentMessage?.fileName??`${item.key.id}.${kind}`;const uploaded=await uploadInboundMedia(options,bytes,mime,fileName);media={uploadId:uploaded.mediaId,mimeType:mime,fileName,size:uploaded.size,sha256:uploaded.sha256,isSticker:sticker};}
        catch(error){emit({type:"diagnostic",level:"warn",accountId:options.accountId,message:"inbound_media_capture_failed",detail:`${kind}:${String(error)}`.slice(0,500)});}
      }
      emit({type:"event",kind:"message",live:type==="notify",payload:{eventId:`message:${options.accountId}:${item.key.id}`,accountId:options.accountId,whatsappMessageId:item.key.id,chatJid:jid,rawChatJid:rawJid,chatType:isGroup?"group":"direct",senderJid,senderName:remotePushName,direction:item.key.fromMe?"out":"in",kind,text,adReferral,quotedWhatsappMessageId,quotedParticipantJid,occurredAt:messageTime(item.messageTimestamp),media}});
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

async function downloadInboundMessageMedia(item:WAMessage,options:RequestInit|undefined,logger:NonNullable<Parameters<typeof downloadMediaMessage>[3]>["logger"],activeSocket:ReturnType<typeof makeWASocket>):Promise<Buffer>{
  let lastError:unknown;
  for(let attempt=0;attempt<3;attempt++){
    try{return await downloadMediaMessage(item,"buffer",{options},{logger,reuploadRequest:async(message)=>activeSocket.updateMediaMessage(message)});}
    catch(error){lastError=error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,2_000*(attempt+1)));}
  }
  throw lastError;
}

async function uploadInboundMedia(options:Init,bytes:Buffer,mime:string,fileName:string):Promise<{mediaId:string;size:number;sha256:string}>{
  const sha256=createHash("sha256").update(bytes).digest("hex");let lastError:unknown;
  for(let attempt=0;attempt<5;attempt++){
    try{const form=new FormData();form.append("file",new Blob([bytes],{type:mime}),fileName);const response=await fetch(new URL(`/agent/media?accountId=${encodeURIComponent(options.accountId)}`,options.baseUrl),{method:"POST",headers:{authorization:`Bearer ${options.credential}`,"x-content-sha256":sha256},body:form,signal:AbortSignal.timeout(120_000)});if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,160)}`);return await response.json() as {mediaId:string;size:number;sha256:string};}catch(error){lastError=error;if(attempt<4)await new Promise(resolve=>setTimeout(resolve,Math.min(30_000,2_000*(2**attempt))));}
  }
  throw lastError;
}

async function uploadContactAvatar(options:Init,contactId:string,bytes:Buffer,mime:string):Promise<void>{
  const form=new FormData();form.append("file",new Blob([bytes],{type:mime}),"avatar");const response=await fetch(new URL(`/agent/contacts/${contactId}/avatar?accountId=${encodeURIComponent(options.accountId)}`,options.baseUrl),{method:"POST",headers:{authorization:`Bearer ${options.credential}`},body:form,signal:AbortSignal.timeout(120_000)});if(!response.ok)throw new Error(`Avatar upload failed (HTTP ${response.status}: ${(await response.text()).slice(0,160)})`);
}

async function execute(command:Command):Promise<void>{
  if(!socket||!init||!connectionOpen){emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode:"account_offline",errorMessage:"WhatsApp account is offline; command remains queued",completedAt:new Date().toISOString()});return;}
  try{
    if(command.command==="sync_contact_avatar"){
      const contactId=String(command.payload.contactId??""),toJid=String(command.payload.toJid??"");
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contactId)||!/^\d{7,15}@s\.whatsapp\.net$/.test(toJid))throw new Error("Invalid contact avatar request");
      const url=await socket.profilePictureUrl(toJid,"image").catch(()=>undefined);if(!url){emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",completedAt:new Date().toISOString()});return;}
      const avatarRequestOptions=mediaProxyAgent?({dispatcher:mediaProxyAgent} as unknown as RequestInit):undefined;const response=await fetch(url,{...avatarRequestOptions,signal:AbortSignal.timeout(30_000)});if(!response.ok)throw new Error(`Avatar download failed (HTTP ${response.status})`);const mime=(response.headers.get("content-type")??"").split(";",1)[0].toLowerCase();if(!["image/jpeg","image/png","image/webp"].includes(mime))throw new Error("Unsupported avatar image type");const length=Number(response.headers.get("content-length")??0);if(length>5*1024*1024)throw new Error("Avatar image is too large");const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>5*1024*1024)throw new Error("Avatar image is too large");
      await uploadContactAvatar(init,contactId,bytes,mime);emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",completedAt:new Date().toISOString()});return;
    }
    if(command.command==="create_group"){
      const subject=String(command.payload.subject??"").trim().slice(0,100);
      const participants=Array.isArray(command.payload.participantJids)?[...new Set(command.payload.participantJids.map(String).filter(jid=>/^\d{7,15}@s\.whatsapp\.net$/.test(jid)))]:[];
      if(!subject)throw new Error("Missing group subject");
      if(participants.length<1)throw new Error("At least one participant is required");
      const group=await socket.groupCreate(subject,participants);
      // groupCreate already returns the authoritative group identity. Do not turn a
      // successful WhatsApp create into a failed command because a follow-up metadata
      // request is temporarily unavailable.
      emitGroupSnapshot(init,group);
      emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",whatsappMessageId:group.id,completedAt:new Date().toISOString()});
      void socket.groupMetadata(group.id).then(metadata=>emitGroupSnapshot(init!,metadata)).catch(error=>emit({type:"diagnostic",level:"warn",accountId:init!.accountId,message:"group_metadata_refresh_failed",detail:describeSendError(error)}));
      return;
    }
    if(command.command==="block_contact"||command.command==="unblock_contact"){
      const toJid=String(command.payload.toJid??"");
      if(!/^\d{7,15}@s\.whatsapp\.net$/.test(toJid))throw new Error("Invalid WhatsApp contact JID");
      await socket.updateBlockStatus(toJid,command.command==="block_contact"?"block":"unblock");
      emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",completedAt:new Date().toISOString()});
      return;
    }
    const type=String(command.payload.type??"text");let content:AnyMessageContent;
    if(type==="text")content={text:String(command.payload.text??"")};else{const media=await downloadOutboundMedia(init,String(command.payload.mediaId??""));const caption=command.payload.text?String(command.payload.text):undefined;if(type==="image")content={image:media.bytes,mimetype:media.mime,caption};else if(type==="video")content={video:media.bytes,mimetype:media.mime,caption};else if(type==="audio")content={audio:media.bytes,mimetype:media.mime,ptt:true};else content={document:media.bytes,mimetype:media.mime,fileName:media.name,caption};}
    if(command.command==="publish_status"){
      const statusJidList=Array.isArray(command.payload.audienceJids)?[...new Set(command.payload.audienceJids.map(String).filter(jid=>/^\d{7,15}@s\.whatsapp\.net$/.test(jid)))]:[];
      if(!statusJidList.length)throw new Error("Missing status audience");
      const sent=await waitForSendConfirmation(socket.sendMessage("status@broadcast",content,{broadcast:true,statusJidList,backgroundColor:command.payload.backgroundColor?String(command.payload.backgroundColor):undefined,font:command.payload.font===undefined?undefined:Number(command.payload.font)}),60_000);
      if(sent?.key.id&&sent.message)await messageCache?.saveMessage(sent.key.id,sent.message);
      emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",whatsappMessageId:sent?.key.id,completedAt:new Date().toISOString()});
      return;
    }
    const toJid=String(command.payload.toJid??"");if(!toJid)throw new Error("Missing destination JID");
    const quotedId=String(command.payload.quotedWhatsappMessageId??"");
    const quotedMessage=quotedId?(await messageCache?.getMessage(quotedId))??{conversation:String(command.payload.quotedText??"[message]")}:undefined;
    const quotedParticipantJid=String(command.payload.quotedParticipantJid??"");
    const quoted=quotedMessage?{key:{remoteJid:toJid,id:quotedId,fromMe:command.payload.quotedDirection==="out",participant:quotedParticipantJid||undefined},message:quotedMessage}:undefined;
    const sent=await waitForSendConfirmation(socket.sendMessage(toJid,content,quoted?{quoted}:undefined),30_000);if(sent?.key.id&&sent.message)await messageCache?.saveMessage(sent.key.id,sent.message);emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"succeeded",whatsappMessageId:sent?.key.id,completedAt:new Date().toISOString()});
  }catch(error){const errorMessage=describeSendError(error);if(isSendConfirmationTimeout(error)){const options=init;connectionOpen=false;emit({type:"diagnostic",level:"error",accountId:options.accountId,message:"send_confirmation_timeout_reconnecting",detail:errorMessage});emit({type:"status",accountId:options.accountId,status:"offline",reason:errorMessage});emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"uncertain",errorCode:"send_confirmation_timeout",errorMessage:`${errorMessage}; connection is being rebuilt`,completedAt:new Date().toISOString()});void connect(options);return;}if(isCentralMediaAuthorizationError(error)){emit({type:"diagnostic",level:"warn",accountId:init.accountId,message:"central_media_authorization_pending",detail:errorMessage});emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode:"central_media_authorization_pending",errorMessage:"Center media authorization is temporarily unavailable; command remains queued",completedAt:new Date().toISOString()});return;}if(isTransientSendConnectionError(error)){const options=init;connectionOpen=false;emit({type:"diagnostic",level:"warn",accountId:options.accountId,message:"send_deferred_after_transient_error",detail:errorMessage});emit({type:"status",accountId:options.accountId,status:"offline",reason:errorMessage});emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode:"transient_send_error",errorMessage:`Temporary send failure (${errorMessage}); command remains queued while the connection is rebuilt`,completedAt:new Date().toISOString()});void connect(options);return;}emit({type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"failed",errorCode:"whatsapp_rejected",errorMessage,completedAt:new Date().toISOString()});}
}

async function syncParticipatingGroups(activeSocket:ReturnType<typeof makeWASocket>,options:Init,generation:number):Promise<void>{
  const syncId=randomUUID();
  try{
    const groups=await activeSocket.groupFetchAllParticipating();
    if(generation!==connectionGeneration)return;
    for(const group of Object.values(groups))emitGroupSnapshot(options,group,syncId);
    emit({type:"event",kind:"group_sync_complete",payload:{eventId:`group-sync:${options.accountId}:${syncId}`,accountId:options.accountId,syncId,at:new Date().toISOString()}});
  }catch(error){emit({type:"diagnostic",level:"warn",accountId:options.accountId,message:"group_sync_failed",detail:String(error)});}
}

function emitGroupSnapshot(options:Init,metadata:GroupMetadata,syncId?:string):void{
  const groupJid=jidNormalizedUser(metadata.id);if(!groupJid.endsWith("@g.us"))return;
  const participants=(metadata.participants??[]).map(normalizeGroupParticipant).filter((item):item is NonNullable<typeof item>=>Boolean(item));
  const version=syncId??`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  emit({type:"event",kind:"group_snapshot",payload:{eventId:`group:${options.accountId}:${groupJid}:${version}`,accountId:options.accountId,syncId,groupJid,subject:metadata.subject||groupJid.split("@")[0],description:metadata.desc??undefined,ownerJid:metadata.ownerPn??metadata.owner??undefined,isAnnouncement:Boolean(metadata.announce),isCommunity:Boolean(metadata.isCommunity),participants,at:new Date().toISOString()}});
}

function normalizeGroupParticipant(participant:GroupParticipant):{jid:string;phoneJid?:string;lidJid?:string;displayName?:string;role:"member"|"admin"|"superadmin"}|null{
  const id=jidNormalizedUser(participant.id),phoneJid=jidNormalizedUser(participant.phoneNumber),lidJid=jidNormalizedUser(participant.lid);
  const jid=phoneJid.endsWith("@s.whatsapp.net")?phoneJid:id||lidJid;if(!jid)return null;
  return{jid,phoneJid:phoneJid.endsWith("@s.whatsapp.net")?phoneJid:undefined,lidJid:lidJid.endsWith("@lid")?lidJid:id.endsWith("@lid")?id:undefined,displayName:participant.name??participant.notify??participant.verifiedName??undefined,role:participant.admin==="superadmin"||participant.isSuperAdmin?"superadmin":participant.admin==="admin"||participant.isAdmin?"admin":"member"};
}

async function resolveUserJid(activeSocket:ReturnType<typeof makeWASocket>,auth:Awaited<ReturnType<typeof encryptedAuthState>>,rawJid:string):Promise<string>{
  if(!rawJid.endsWith("@lid"))return jidNormalizedUser(rawJid);
  const mapped=await activeSocket.signalRepository.lidMapping.getPNForLID(rawJid);
  return jidNormalizedUser(mapped??await auth.resolveJid(rawJid));
}

function quotedMessageId(content:proto.IMessage):string|undefined{
  const candidates=[
    content.extendedTextMessage?.contextInfo,
    content.imageMessage?.contextInfo,
    content.videoMessage?.contextInfo,
    content.audioMessage?.contextInfo,
    content.documentMessage?.contextInfo,
    content.stickerMessage?.contextInfo,
    content.locationMessage?.contextInfo,
    content.contactMessage?.contextInfo,
  ];
  return candidates.find(context=>context?.stanzaId)?.stanzaId??undefined;
}

function quotedParticipant(content:proto.IMessage):string|undefined{
  const candidates=[content.extendedTextMessage?.contextInfo,content.imageMessage?.contextInfo,content.videoMessage?.contextInfo,content.audioMessage?.contextInfo,content.documentMessage?.contextInfo,content.stickerMessage?.contextInfo,content.locationMessage?.contextInfo,content.contactMessage?.contextInfo];
  const participant=candidates.find(context=>context?.participant)?.participant;
  return participant?jidNormalizedUser(participant):undefined;
}

function externalAdReferral(content:proto.IMessage):Record<string,string>|undefined{
  const context=[content.extendedTextMessage?.contextInfo,content.imageMessage?.contextInfo,content.videoMessage?.contextInfo,content.documentMessage?.contextInfo].find(item=>item?.externalAdReply);
  const ad=context?.externalAdReply;if(!ad)return undefined;
  const referral:Record<string,string>={};
  const add=(key:string,value:unknown,max=4000)=>{if(value===null||value===undefined||value==="")return;referral[key]=String(value).slice(0,max);};
  add("source",ad.sourceApp??ad.sourceType,120);add("sourceId",ad.sourceId??ad.ref,500);add("headline",ad.title,1000);add("body",ad.body,4000);add("mediaType",ad.mediaType,80);add("ctwaClid",ad.ctwaClid,500);
  addSafeUrl(referral,"sourceUrl",ad.sourceUrl??ad.adPreviewUrl??ad.wtwaWebsiteUrl);
  addSafeUrl(referral,"thumbnailUrl",ad.thumbnailUrl??ad.originalImageUrl);
  addSafeUrl(referral,"mediaUrl",ad.mediaUrl);
  return Object.keys(referral).length?referral:undefined;
}

function addSafeUrl(target:Record<string,string>,key:string,value:unknown):void{
  if(typeof value!=="string"||value.length>8000)return;
  try{const url=new URL(value);if(url.protocol==="http:"||url.protocol==="https:")target[key]=url.toString();}catch{}
}

async function downloadOutboundMedia(options:Init,mediaId:string):Promise<{bytes:Buffer;mime:string;name:string}>{
  if(!mediaId)throw new Error("Missing media ID");let lastError:unknown;
  for(let attempt=0;attempt<5;attempt++){
    try{
      const response=await fetch(new URL(`/agent/media/${encodeURIComponent(mediaId)}`,options.baseUrl),{headers:{authorization:`Bearer ${options.credential}`},signal:AbortSignal.timeout(60_000)});
      if(!response.ok){if(response.status===401||response.status===403)throw centralMediaAuthorizationError(response.status);const error=Object.assign(new Error(`Media download failed: HTTP ${response.status}`),{statusCode:response.status});if(![408,425,429,502,503,504].includes(response.status))throw error;lastError=error;}else return{bytes:Buffer.from(await response.arrayBuffer()),mime:response.headers.get("content-type")??"application/octet-stream",name:decodeURIComponent(response.headers.get("x-file-name")??"attachment")};
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
