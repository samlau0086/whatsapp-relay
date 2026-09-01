import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { pool, transaction } from "./db.js";
import { hashSecret } from "./security.js";
import { enqueueInboundAgentWork } from "./agent-engine.js";
import {processStatusCommandResult} from "./status-engine.js";

const PROTOCOL_VERSION = 2;
const HEARTBEAT_TIMEOUT_SECONDS = 45;
const liveAgents = new Map<string, WebSocket>();
let watchdog:NodeJS.Timeout|undefined;
let dispatchWatchdog:NodeJS.Timeout|undefined;

type AgentFrame = { type: string; [key: string]: unknown };

export async function registerAgentHub(app: FastifyInstance): Promise<void> {
  app.get("/agent/ws", { websocket: true }, async (socket, request) => {
    const agent = await authenticateAgent(request);
    if (!agent) { socket.close(4001, "unauthorized"); return; }
    liveAgents.set(agent.id, socket);
    await pool.query("UPDATE agents SET status='online',last_seen_at=now() WHERE id=$1", [agent.id]);

    socket.on("message", (raw) => void handleFrame(agent.id, socket, raw.toString()).catch((error) => {
      app.log.error({ error, agentId: agent.id }, "agent frame failed");
      socket.send(JSON.stringify({ type:"error", code:"frame_failed" }));
    }));
    socket.on("close", () => {
      if (liveAgents.get(agent.id) !== socket) return;
      liveAgents.delete(agent.id);
      void markAgentOffline(agent.id,"agent_disconnected");
    });
  });
  watchdog??=setInterval(()=>void markStaleAgentsOffline().catch(error=>app.log.error({error},"agent heartbeat watchdog failed")),15_000);
  dispatchWatchdog??=setInterval(()=>{
    for(const [agentId,socket] of liveAgents)void dispatchPending(agentId,socket).catch(error=>app.log.error({error,agentId},"agent queue dispatch watchdog failed"));
  },3_000);
  app.addHook("onClose",async()=>{if(watchdog){clearInterval(watchdog);watchdog=undefined;}if(dispatchWatchdog){clearInterval(dispatchWatchdog);dispatchWatchdog=undefined;}});
}

export function disconnectAgent(agentId:string,reason="revoked"):void {
  const socket=liveAgents.get(agentId);
  if(!socket)return;
  liveAgents.delete(agentId);
  socket.close(4003,reason);
}

export function clearAgentAttention(agentId:string,accountId:string,chatJid:string):boolean{
  const socket=liveAgents.get(agentId);
  if(!socket||socket.readyState!==socket.OPEN)return false;
  socket.send(JSON.stringify({type:"attention_cleared",accountId,chatJid}));
  return true;
}

export function notifyAgentAccountReassignment(agentId:string,accountId:string,accountName:string,action:"add"|"remove"):boolean{
  const socket=liveAgents.get(agentId);
  if(!socket||socket.readyState!==socket.OPEN)return false;
  socket.send(JSON.stringify({type:"account_reassigned",accountId,accountName,action}));
  return true;
}

export async function markStaleAgentsOffline():Promise<number>{
  return transaction(async client=>{
    const stale=await client.query(`UPDATE agents SET status='offline' WHERE status='online' AND last_seen_at<now()-($1::text||' seconds')::interval RETURNING id`,[HEARTBEAT_TIMEOUT_SECONDS]);
    const offline=await client.query("SELECT id FROM agents WHERE status IN ('offline','revoked')");
    for(const row of offline.rows)await markAgentAccountsOffline(client,row.id,stale.rows.some(item=>item.id===row.id)?"agent_heartbeat_timeout":"agent_offline");
    return stale.rowCount??0;
  });
}

async function markAgentOffline(agentId:string,reason:string):Promise<void>{
  await transaction(async client=>{
    await client.query("UPDATE agents SET status=CASE WHEN status='revoked' THEN status ELSE 'offline' END WHERE id=$1",[agentId]);
    await markAgentAccountsOffline(client,agentId,reason);
  });
}

async function markAgentAccountsOffline(client:import("pg").PoolClient,agentId:string,reason:string):Promise<void>{
  const accounts=await client.query("UPDATE channel_accounts SET status='offline',status_reason=$2,last_event_at=now() WHERE agent_id=$1 AND status IN ('online','pairing') RETURNING id",[agentId,reason]);
  for(const account of accounts.rows)await createWebhookEvent(client,"account.status_changed",account.id,{accountId:account.id,status:"offline",reason,at:new Date().toISOString()});
}

async function authenticateAgent(request: FastifyRequest): Promise<{ id: string } | null> {
  const credential = request.headers.authorization?.replace(/^Bearer /, "");
  if (!credential) return null;
  const result = await pool.query("SELECT id FROM agents WHERE credential_hash=$1 AND status<>'revoked'", [hashSecret(credential)]);
  return result.rows[0] ?? null;
}

async function handleFrame(agentId: string, socket: WebSocket, raw: string): Promise<void> {
  if (Buffer.byteLength(raw) > 2_000_000) { socket.close(4009, "frame_too_large"); return; }
  const frame = JSON.parse(raw) as AgentFrame;
  if (frame.type === "hello") {
    if (frame.protocolVersion !== PROTOCOL_VERSION) { socket.send(JSON.stringify({ type:"incompatible", supportedVersion:PROTOCOL_VERSION })); socket.close(4002,"protocol_upgrade_required"); return; }
    const capabilities=Array.isArray(frame.capabilities)?frame.capabilities.map(String).filter(value=>value.length<=80).slice(0,20):[];
    await pool.query("UPDATE agents SET version=$2,protocol_version=$3,platform=$4,capabilities=$5,last_seen_at=now() WHERE id=$1", [agentId, frame.agentVersion, frame.protocolVersion, frame.platform,capabilities]);
    await dispatchPending(agentId, socket);
    return;
  }
  if (frame.type === "heartbeat") {
    await pool.query("UPDATE agents SET last_seen_at=now(),status='online' WHERE id=$1", [agentId]);
    const accounts = Array.isArray(frame.accounts) ? frame.accounts as Array<{accountId:string;status:string}> : [];
    for (const account of accounts) await pool.query("UPDATE channel_accounts SET status=$2::wa_account_status,status_reason=CASE WHEN $2::wa_account_status='online'::wa_account_status THEN NULL ELSE status_reason END,last_event_at=now(),last_connected_at=CASE WHEN $2::wa_account_status='online'::wa_account_status THEN now() ELSE last_connected_at END WHERE id=$1 AND agent_id=$3", [account.accountId, account.status, agentId]);
    socket.send(JSON.stringify({ type:"pong", at:new Date().toISOString() }));
    await dispatchPending(agentId, socket);
    return;
  }
  if (frame.type === "event_batch") {
    const result=await processBatch(agentId, frame);
    if(result.ackedCursor>=Number(frame.fromCursor))socket.send(JSON.stringify({ type:"ack", cursor:result.ackedCursor }));
    if(result.failedCursor!==undefined){socket.send(JSON.stringify({type:"error",code:"event_rejected",cursor:result.failedCursor,detail:result.error}));return;}
    await dispatchPending(agentId, socket);
    return;
  }
  if (frame.type === "command_result") {
    await processCommandResult(agentId, frame);
    await dispatchPending(agentId, socket);
  }
}

async function processBatch(agentId: string, frame: AgentFrame): Promise<{ackedCursor:number;failedCursor?:number;error?:string}> {
  const events = Array.isArray(frame.events) ? frame.events as Array<{cursor?:number;kind:string;payload:Record<string,unknown>}> : [];
  const start = Number(frame.fromCursor);
  let ackedCursor=start-1;
  for(let index=0;index<events.length;index++){
    const event=events[index];const cursor=Number(event.cursor??start+index);
    try{
      if(!Number.isSafeInteger(cursor)||cursor<start||cursor>Number(frame.toCursor)||cursor<=ackedCursor)throw new Error("invalid_event_cursor");
      await transaction(async client=>{
        const eventId=String(event.payload.eventId??`${event.kind}:${cursor}`);
        const inserted=await client.query("INSERT INTO agent_inbox(agent_id,cursor,event_id,event_kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING cursor",[agentId,cursor,eventId,event.kind]);
        if(inserted.rowCount){
          if(event.kind==="message")await ingestNormalizedMessage(client,event.payload,{agentId});
          else if(event.kind==="message_status")await updateNormalizedMessageStatus(client,event.payload);
          else if(event.kind==="contact_identity")await mergeContactIdentity(client,agentId,event.payload);
          else if(event.kind==="group_snapshot")await ingestGroupSnapshot(client,agentId,event.payload);
          else if(event.kind==="group_sync_complete")await completeGroupSync(client,agentId,event.payload);
          else if(event.kind==="account_status"){
            const updated=await client.query("UPDATE channel_accounts SET status=$2::wa_account_status,status_reason=$3,last_event_at=now(),last_connected_at=CASE WHEN $2::wa_account_status='online'::wa_account_status THEN now() ELSE last_connected_at END WHERE id=$1 AND agent_id=$4 RETURNING id",[event.payload.accountId,event.payload.status,event.payload.reason??null,agentId]);
            if(updated.rowCount)await createWebhookEvent(client,"account.status_changed",String(event.payload.accountId),event.payload);
          }else throw new Error("unsupported_event_kind");
        }
        await client.query("UPDATE agents SET last_acked_cursor=GREATEST(last_acked_cursor,$2),last_seen_at=now() WHERE id=$1",[agentId,cursor]);
      });
      ackedCursor=cursor;
    }catch(error){return{ackedCursor,failedCursor:cursor,error:(error instanceof Error?error.message:String(error)).slice(0,240)};}
  }
  return{ackedCursor};
}

async function mergeContactIdentity(client:import("pg").PoolClient,agentId:string,payload:Record<string,unknown>):Promise<string|null>{
  const accountId=String(payload.accountId??""),lidJid=normalizedIdentityJid(payload.lidJid,"lid"),phoneJid=normalizedIdentityJid(payload.phoneJid,"s.whatsapp.net");
  if(!accountId||!lidJid||!phoneJid)throw new Error("invalid_contact_identity");
  const owned=await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND agent_id=$2",[accountId,agentId]);if(!owned.rowCount)throw new Error("contact_identity_account_not_owned_by_agent");
  const phone=`+${phoneJid.split("@")[0]}`;
  const found=await client.query("SELECT id,provider_user_id,phone_e164,display_name,alias,note,first_name,middle_name,last_name FROM contacts WHERE account_id=$1 AND (provider_user_id=ANY($2::text[]) OR phone_e164=$3) ORDER BY CASE WHEN provider_user_id=$4 THEN 0 WHEN phone_e164=$3 THEN 1 ELSE 2 END,id FOR UPDATE",[accountId,[phoneJid,lidJid],phone,phoneJid]);
  if(!found.rowCount)return null;
  const target=found.rows[0];
  const usableName=(value:unknown)=>{const name=String(value??"").trim();return name&&!/^\+?\d+$/.test(name)?name:null;};
  const suppliedName=usableName(payload.displayName);
  const bestName=suppliedName??found.rows.map(row=>usableName(row.display_name)).find((name):name is string=>Boolean(name))??phone;
  const bestAlias=found.rows.map(row=>String(row.alias??"").trim()).find(Boolean)??null;
  for(const source of found.rows.slice(1)){
    await client.query("UPDATE contacts SET note=CASE WHEN NULLIF(btrim(note),'') IS NULL THEN $2 WHEN NULLIF(btrim($2),'') IS NULL OR note=$2 THEN note ELSE note||E'\\n\\n'||$2 END,first_name=COALESCE(NULLIF(first_name,''),$3),middle_name=COALESCE(NULLIF(middle_name,''),$4),last_name=COALESCE(NULLIF(last_name,''),$5),updated_at=now() WHERE id=$1",[target.id,source.note??null,source.first_name??null,source.middle_name??null,source.last_name??null]);
    const targetPrimary=await client.query("SELECT 1 FROM contact_emails WHERE contact_id=$1 AND is_primary LIMIT 1",[target.id]);
    await client.query("INSERT INTO contact_emails(contact_id,label,email,is_primary,position,created_at,updated_at) SELECT $1,label,email,false,position+1000,created_at,updated_at FROM contact_emails WHERE contact_id=$2 ON CONFLICT(contact_id,lower(email)) DO NOTHING",[target.id,source.id]);
    if(!targetPrimary.rowCount)await client.query("UPDATE contact_emails SET is_primary=true,updated_at=now() WHERE id=(SELECT email.id FROM contact_emails email WHERE email.contact_id=$1 ORDER BY email.email=(SELECT source_email.email FROM contact_emails source_email WHERE source_email.contact_id=$2 AND source_email.is_primary LIMIT 1) DESC,email.position,email.id LIMIT 1)",[target.id,source.id]);
    await client.query("INSERT INTO contact_methods(contact_id,type,label,value,position,created_at,updated_at) SELECT $1,source.type,source.label,source.value,source.position+1000,source.created_at,source.updated_at FROM contact_methods source WHERE source.contact_id=$2 AND NOT EXISTS(SELECT 1 FROM contact_methods target_method WHERE target_method.contact_id=$1 AND target_method.type=source.type AND lower(target_method.label)=lower(source.label) AND target_method.value=source.value)",[target.id,source.id]);
    const targetDefaultAddress=await client.query("SELECT 1 FROM contact_addresses WHERE contact_id=$1 AND is_default LIMIT 1",[target.id]);
    if(targetDefaultAddress.rowCount)await client.query("UPDATE contact_addresses SET is_default=false WHERE contact_id=$1 AND is_default",[source.id]);
    await client.query("UPDATE contact_addresses SET contact_id=$1,updated_at=now() WHERE contact_id=$2",[target.id,source.id]);
    const targetConversation=await client.query("SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2",[accountId,target.id]);
    const sourceConversation=await client.query("SELECT id FROM conversations WHERE account_id=$1 AND contact_id=$2",[accountId,source.id]);
    if(sourceConversation.rowCount&&targetConversation.rowCount){
      const targetId=targetConversation.rows[0].id,sourceId=sourceConversation.rows[0].id;
      await client.query("UPDATE messages SET conversation_id=$1 WHERE conversation_id=$2",[targetId,sourceId]);
      await client.query("UPDATE notes SET conversation_id=$1 WHERE conversation_id=$2",[targetId,sourceId]);
      await client.query("INSERT INTO conversation_tags(conversation_id,tag_id) SELECT $1,tag_id FROM conversation_tags WHERE conversation_id=$2 ON CONFLICT DO NOTHING",[targetId,sourceId]);
      await client.query("UPDATE orders SET conversation_id=$1 WHERE conversation_id=$2",[targetId,sourceId]);
      await client.query("INSERT INTO reminders(conversation_id,user_id,remind_at,dismissed_at,created_at,updated_at) SELECT $1,user_id,remind_at,dismissed_at,created_at,updated_at FROM reminders WHERE conversation_id=$2 ON CONFLICT(conversation_id,user_id) DO UPDATE SET remind_at=LEAST(reminders.remind_at,EXCLUDED.remind_at),dismissed_at=CASE WHEN reminders.dismissed_at IS NULL OR EXCLUDED.dismissed_at IS NULL THEN NULL ELSE GREATEST(reminders.dismissed_at,EXCLUDED.dismissed_at) END,updated_at=now()",[targetId,sourceId]);
      await client.query("DELETE FROM reminders WHERE conversation_id=$1",[sourceId]);
      await client.query("UPDATE conversations t SET unread_count=t.unread_count+s.unread_count,favorite=t.favorite OR s.favorite,assigned_user_id=COALESCE(t.assigned_user_id,s.assigned_user_id),customer_stage=CASE WHEN array_position(ARRAY['new','considering','qualified','lost','won'],s.customer_stage)>array_position(ARRAY['new','considering','qualified','lost','won'],t.customer_stage) THEN s.customer_stage ELSE t.customer_stage END,status=CASE WHEN t.status='open' OR s.status='open' THEN 'open'::conversation_status WHEN t.status='closed' OR s.status='closed' THEN 'closed'::conversation_status ELSE 'archived'::conversation_status END,closed_at=CASE WHEN t.status='open' OR s.status='open' THEN NULL ELSE GREATEST(t.closed_at,s.closed_at) END FROM conversations s WHERE t.id=$1 AND s.id=$2",[targetId,sourceId]);
      await client.query("DELETE FROM conversations WHERE id=$1",[sourceId]);
    }else if(sourceConversation.rowCount)await client.query("UPDATE conversations SET contact_id=$1 WHERE id=$2",[target.id,sourceConversation.rows[0].id]);
    await client.query("UPDATE messages SET sender_contact_id=$1 WHERE sender_contact_id=$2",[target.id,source.id]);
    await client.query("DELETE FROM contacts WHERE id=$1",[source.id]);
  }
  await client.query("UPDATE contacts SET provider_user_id=$2,phone_e164=$3,display_name=$4,alias=$5,last_seen_at=COALESCE(last_seen_at,now()),updated_at=now() WHERE id=$1",[target.id,phoneJid,phone,bestName,bestAlias]);
  return String(target.id);
}

function normalizedIdentityJid(value:unknown,server:"lid"|"s.whatsapp.net"):string|null{
  const raw=String(value??"").trim().toLowerCase(),parts=raw.split("@");if(parts.length!==2||parts[1]!==server)return null;
  const user=parts[0].split(":")[0];return /^\d{7,15}$/.test(user)?`${user}@${server}`:null;
}

export async function ingestNormalizedMessage(client: import("pg").PoolClient, payload: Record<string,unknown>, source:{agentId?:string;transport?:'cloud'}): Promise<void> {
  const chatJid = String(payload.chatJid);
  if (chatJid.endsWith("@broadcast")) return;
  if(String(payload.kind??"text")==="text"&&!payload.text&&!payload.media&&!payload.adReferral)return;
  const accountId = String(payload.accountId);
  const account=source.transport==="cloud"
    ?await client.query("SELECT id,agent_id,'{}'::text[] capabilities FROM channel_accounts WHERE id=$1 AND platform='whatsapp' AND transport='cloud'",[accountId])
    :await client.query("SELECT a.id,a.agent_id,COALESCE(g.capabilities,'{}'::text[]) capabilities FROM channel_accounts a JOIN agents g ON g.id=a.agent_id WHERE a.id=$1 AND a.platform='whatsapp' AND a.agent_id=$2 AND a.transport='web'",[accountId,source.agentId]);
  if(!account.rowCount)throw new Error("message_account_not_owned_by_agent");
  if(chatJid.endsWith("@g.us")){
    if(source.transport==="cloud")return;
    const peer=await upsertGroupPeer(client,accountId,chatJid,chatJid.split("@")[0]);
    const senderJid=normalizedParticipantJid(payload.senderJid),senderName=String(payload.senderName??"").trim()||null;
    if(senderJid){
      await client.query("INSERT INTO whatsapp_group_participants(group_id,participant_jid,phone_jid,lid_jid,display_name) VALUES($1,$2,CASE WHEN $2 LIKE '%@s.whatsapp.net' THEN $2 END,CASE WHEN $2 LIKE '%@lid' THEN $2 END,$3) ON CONFLICT(group_id,participant_jid) DO UPDATE SET display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),whatsapp_group_participants.display_name),updated_at=now()",[peer.groupId,senderJid,senderName]);
      await client.query("UPDATE whatsapp_groups SET participant_count=(SELECT count(*) FROM whatsapp_group_participants WHERE group_id=$1),updated_at=now() WHERE id=$1",[peer.groupId]);
    }
    const media=payload.media as {uploadId?:string}|undefined;
    const providerMetadata={...(payload.quotedWhatsappMessageId?{quotedWhatsappMessageId:payload.quotedWhatsappMessageId,quotedParticipantJid:payload.quotedParticipantJid??null}:{}),...(payload.adReferral&&typeof payload.adReferral==="object"?{adReferral:payload.adReferral}:{})};
    const quoteMetadata=Object.keys(providerMetadata).length?JSON.stringify(providerMetadata):null;
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_provider_user_id,sender_display_name,provider_message_id,direction,kind,text_content,media_id,quoted_message_id,status,occurred_at,provider_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT id FROM messages WHERE account_id=$2 AND conversation_id=$1 AND provider_message_id=$10),$11,$12,$13) ON CONFLICT(account_id,provider_message_id) DO NOTHING RETURNING id",[peer.conversationId,accountId,payload.direction==="in"?senderJid:null,payload.direction==="in"?senderName:null,payload.whatsappMessageId,payload.direction,payload.kind,payload.text??null,media?.uploadId??null,payload.quotedWhatsappMessageId??null,payload.direction==="in"?"received":"sent",payload.occurredAt,quoteMetadata]);
    if(message.rowCount){
      await client.query("UPDATE conversations SET unread_count=unread_count+CASE WHEN $2='in' THEN 1 ELSE 0 END,status='open' WHERE id=$1",[peer.conversationId,payload.direction]);
      await client.query("UPDATE messages SET quoted_message_id=$1 WHERE account_id=$2 AND conversation_id=$3 AND quoted_message_id IS NULL AND provider_payload->>'quotedWhatsappMessageId'=$4",[message.rows[0].id,accountId,peer.conversationId,payload.whatsappMessageId]);
      await createWebhookEvent(client,"message.received",message.rows[0].id,{...payload,platform:"whatsapp",providerMessageId:payload.whatsappMessageId,platformMessageId:message.rows[0].id,conversationId:peer.conversationId});
    }
    return;
  }
  const phonePart=chatJid.endsWith("@s.whatsapp.net")?chatJid.split("@")[0].split(":")[0]:null;
  const phone=phonePart&&/^\d{7,15}$/.test(phonePart)?`+${phonePart}`:null;
  const rawChatJid=String(payload.rawChatJid??"");
  const remoteDisplayName=payload.direction==="in"?String(payload.senderName??"").trim():"";
  const mergedContactId=source.agentId&&phone&&rawChatJid.endsWith("@lid")?await mergeContactIdentity(client,source.agentId,{accountId,lidJid:rawChatJid,phoneJid:chatJid,displayName:remoteDisplayName}):null;
  const contact = mergedContactId?await client.query("UPDATE contacts SET display_name=COALESCE(NULLIF($2,''),display_name),last_seen_at=now() WHERE id=$1 RETURNING id,avatar_url",[mergedContactId,remoteDisplayName]):await client.query("INSERT INTO contacts(account_id,provider_user_id,phone_e164,display_name,last_seen_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(account_id,provider_user_id) DO UPDATE SET phone_e164=COALESCE(contacts.phone_e164,EXCLUDED.phone_e164),display_name=COALESCE(NULLIF($5,''),contacts.display_name),last_seen_at=now() RETURNING id,avatar_url", [accountId,chatJid,phone,remoteDisplayName||phone||chatJid.split("@")[0],remoteDisplayName]);
  const conversation = await client.query("INSERT INTO conversations(account_id,contact_id,unread_count,service_window_expires_at) VALUES($1,$2,CASE WHEN $3='in' THEN 1 ELSE 0 END,CASE WHEN $3='in' AND $4='cloud' THEN $5::timestamptz+interval '24 hours' END) ON CONFLICT(account_id,contact_id) DO UPDATE SET unread_count=conversations.unread_count+CASE WHEN $3='in' THEN 1 ELSE 0 END,status='open',service_window_expires_at=CASE WHEN $3='in' AND $4='cloud' THEN GREATEST(conversations.service_window_expires_at,EXCLUDED.service_window_expires_at) ELSE conversations.service_window_expires_at END RETURNING id", [accountId,contact.rows[0].id,payload.direction,source.transport??"web",payload.occurredAt]);
  const media=payload.media as {uploadId?:string}|undefined;
  const providerMetadata={...(payload.quotedWhatsappMessageId?{quotedWhatsappMessageId:payload.quotedWhatsappMessageId}:{}),...(payload.adReferral&&typeof payload.adReferral==="object"?{adReferral:payload.adReferral}:{})};
  const quoteMetadata=Object.keys(providerMetadata).length?JSON.stringify(providerMetadata):null;
  const message = await client.query("INSERT INTO messages(conversation_id,account_id,sender_contact_id,provider_message_id,direction,kind,text_content,media_id,quoted_message_id,status,occurred_at,provider_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT id FROM messages WHERE account_id=$2 AND conversation_id=$1 AND provider_message_id=$9),$10,$11,$12) ON CONFLICT(account_id,provider_message_id) DO NOTHING RETURNING id", [conversation.rows[0].id,accountId,payload.direction === "in" ? contact.rows[0].id : null,payload.whatsappMessageId,payload.direction,payload.kind,payload.text ?? null,media?.uploadId??null,payload.quotedWhatsappMessageId??null,payload.direction === "in" ? "received" : "sent",payload.occurredAt,quoteMetadata]);
  if (message.rowCount){
    await client.query("UPDATE messages SET quoted_message_id=$1 WHERE account_id=$2 AND conversation_id=$3 AND quoted_message_id IS NULL AND provider_payload->>'quotedWhatsappMessageId'=$4",[message.rows[0].id,accountId,conversation.rows[0].id,payload.whatsappMessageId]);
    await createWebhookEvent(client,"message.received",message.rows[0].id,{ ...payload,platform:"whatsapp",providerMessageId:payload.whatsappMessageId,platformMessageId:message.rows[0].id,conversationId:conversation.rows[0].id });
    const capabilities=Array.isArray(account.rows[0].capabilities)?account.rows[0].capabilities.map(String):[];
    if(payload.direction==="in"&&!contact.rows[0].avatar_url&&source.agentId&&capabilities.includes("contact_avatar_sync_v1"))await client.query("INSERT INTO outbound_commands(agent_id,account_id,command,payload) SELECT $1,$2,'sync_contact_avatar',$3::jsonb WHERE NOT EXISTS(SELECT 1 FROM outbound_commands WHERE account_id=$2 AND command='sync_contact_avatar' AND payload->>'contactId'=$4 AND state IN ('pending','dispatched'))",[source.agentId,accountId,JSON.stringify({contactId:String(contact.rows[0].id),toJid:chatJid}),String(contact.rows[0].id)]);
    if(payload.direction==="in"&&(payload.kind==="text"||payload.kind==="audio"))await enqueueInboundAgentWork(client,conversation.rows[0].id,message.rows[0].id);
  }
}

async function ingestGroupSnapshot(client:import("pg").PoolClient,agentId:string,payload:Record<string,unknown>):Promise<void>{
  const accountId=String(payload.accountId??""),groupJid=normalizedGroupJid(payload.groupJid),subject=String(payload.subject??"").trim().slice(0,500);
  if(!accountId||!groupJid||!subject)throw new Error("invalid_group_snapshot");
  const owned=await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND agent_id=$2 AND platform='whatsapp' AND transport='web'",[accountId,agentId]);
  if(!owned.rowCount)throw new Error("group_account_not_owned_by_agent");
  const peer=await upsertGroupPeer(client,accountId,groupJid,subject);
  const syncId=typeof payload.syncId==="string"&&UUID_PATTERN.test(payload.syncId)?payload.syncId:null;
  await client.query("UPDATE whatsapp_groups SET subject=$2,description=$3,owner_jid=$4,is_announcement=$5,is_community=$6,active=true,sync_id=COALESCE($7::uuid,sync_id),last_synced_at=now(),updated_at=now() WHERE id=$1",[peer.groupId,subject,String(payload.description??"").trim()||null,normalizedParticipantJid(payload.ownerJid),Boolean(payload.isAnnouncement),Boolean(payload.isCommunity),syncId]);
  const participants=Array.isArray(payload.participants)?payload.participants as Array<Record<string,unknown>>:[];
  const normalized=participants.map(item=>({jid:normalizedParticipantJid(item.jid),phoneJid:normalizedPhoneJid(item.phoneJid),lidJid:normalizedLidJid(item.lidJid),displayName:String(item.displayName??"").trim().slice(0,240)||null,role:["member","admin","superadmin"].includes(String(item.role))?String(item.role):"member"})).filter((item):item is typeof item&{jid:string}=>Boolean(item.jid));
  await client.query("DELETE FROM whatsapp_group_participants WHERE group_id=$1",[peer.groupId]);
  if(normalized.length)await client.query("INSERT INTO whatsapp_group_participants(group_id,participant_jid,phone_jid,lid_jid,display_name,role) SELECT $1,item.jid,item.phone_jid,item.lid_jid,item.display_name,item.role FROM jsonb_to_recordset($2::jsonb) AS item(jid text,phone_jid text,lid_jid text,display_name text,role text) ON CONFLICT(group_id,participant_jid) DO UPDATE SET phone_jid=EXCLUDED.phone_jid,lid_jid=EXCLUDED.lid_jid,display_name=EXCLUDED.display_name,role=EXCLUDED.role,updated_at=now()",[peer.groupId,JSON.stringify(normalized.map(item=>({jid:item.jid,phone_jid:item.phoneJid,lid_jid:item.lidJid,display_name:item.displayName,role:item.role})))]);
  await client.query("UPDATE whatsapp_groups SET participant_count=$2 WHERE id=$1",[peer.groupId,normalized.length]);
}

async function completeGroupSync(client:import("pg").PoolClient,agentId:string,payload:Record<string,unknown>):Promise<void>{
  const accountId=String(payload.accountId??""),syncId=String(payload.syncId??"");
  if(!UUID_PATTERN.test(syncId))throw new Error("invalid_group_sync");
  const owned=await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND agent_id=$2 AND platform='whatsapp' AND transport='web'",[accountId,agentId]);
  if(!owned.rowCount)throw new Error("group_account_not_owned_by_agent");
  const inactive=await client.query("UPDATE whatsapp_groups SET active=false,updated_at=now() WHERE account_id=$1 AND active AND sync_id IS DISTINCT FROM $2::uuid RETURNING contact_id",[accountId,syncId]);
  if(inactive.rowCount)await client.query("UPDATE conversations SET status='archived' WHERE account_id=$1 AND contact_id=ANY($2::uuid[])",[accountId,inactive.rows.map(row=>row.contact_id)]);
}

async function upsertGroupPeer(client:import("pg").PoolClient,accountId:string,groupJid:string,subject:string):Promise<{groupId:string;contactId:string;conversationId:string}>{
  const contact=await client.query("INSERT INTO contacts(account_id,provider_user_id,display_name,entity_type,last_seen_at) VALUES($1,$2,$3,'group',now()) ON CONFLICT(account_id,provider_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,entity_type='group',last_seen_at=now(),updated_at=now() RETURNING id",[accountId,groupJid,subject]);
  const conversation=await client.query("INSERT INTO conversations(account_id,contact_id,unread_count) VALUES($1,$2,0) ON CONFLICT(account_id,contact_id) DO UPDATE SET status=CASE WHEN conversations.status='archived' THEN 'open'::conversation_status ELSE conversations.status END RETURNING id",[accountId,contact.rows[0].id]);
  const group=await client.query("INSERT INTO whatsapp_groups(account_id,contact_id,group_jid,subject) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,group_jid) DO UPDATE SET contact_id=EXCLUDED.contact_id,subject=EXCLUDED.subject,active=true,updated_at=now() RETURNING id",[accountId,contact.rows[0].id,groupJid,subject]);
  return{groupId:String(group.rows[0].id),contactId:String(contact.rows[0].id),conversationId:String(conversation.rows[0].id)};
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function normalizedGroupJid(value:unknown):string|null{const jid=String(value??"").trim().toLowerCase();return /^[0-9-]+@g\.us$/.test(jid)?jid:null;}
function normalizedParticipantJid(value:unknown):string|null{const jid=String(value??"").trim().toLowerCase();return /^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid)?jid.replace(/:\d+@/,"@"):null;}
function normalizedPhoneJid(value:unknown):string|null{const jid=normalizedParticipantJid(value);return jid?.endsWith("@s.whatsapp.net")?jid:null;}
function normalizedLidJid(value:unknown):string|null{const jid=normalizedParticipantJid(value);return jid?.endsWith("@lid")?jid:null;}

export async function updateNormalizedMessageStatus(client: import("pg").PoolClient, payload: Record<string,unknown>): Promise<void> {
  const result = await client.query("UPDATE messages SET status=$3,failure_code=COALESCE($4,failure_code),failure_message=COALESCE($5,failure_message) WHERE account_id=$1 AND provider_message_id=$2 RETURNING id,conversation_id", [payload.accountId,payload.whatsappMessageId,payload.status,payload.failureCode??null,payload.failureMessage??null]);
  if (!result.rowCount) return;
  await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [result.rows[0].id,payload.status,payload.at]);
  await createWebhookEvent(client,"message.status_changed",result.rows[0].id,{ ...payload,platform:"whatsapp",providerMessageId:payload.whatsappMessageId,platformMessageId:result.rows[0].id });
}

export async function createWebhookEvent(client: import("pg").PoolClient, eventType: string, aggregateId: string, payload: Record<string,unknown>): Promise<void> {
  const event = await client.query("INSERT INTO webhook_events(event_type,aggregate_id,payload) VALUES($1,$2,$3) RETURNING id", [eventType,aggregateId,JSON.stringify(payload)]);
  await client.query("INSERT INTO webhook_deliveries(event_id,endpoint_id) SELECT $1,id FROM webhook_endpoints WHERE enabled AND $2=ANY(event_types) ON CONFLICT DO NOTHING", [event.rows[0].id,eventType]);
}

async function processCommandResult(agentId: string, frame: AgentFrame): Promise<void> {
  const statusCommand=await pool.query("SELECT id,status_post_id,state FROM outbound_commands WHERE id=$1 AND agent_id=$2 AND status_post_id IS NOT NULL",[frame.commandId,agentId]);
  if(statusCommand.rowCount){await processStatusCommandResult(agentId,frame as unknown as Record<string,unknown>,statusCommand.rows[0]);return;}
  await transaction(async (client) => {
    const outcome=String(frame.outcome);
    if(outcome==="deferred"){
      const deferred=await client.query("UPDATE outbound_commands SET state='pending',available_at=now()+interval '5 seconds',claimed_at=NULL,completed_at=NULL,last_error=$3,attempt=GREATEST(attempt-1,0) WHERE id=$1 AND agent_id=$2 AND state='dispatched' RETURNING message_id",[frame.commandId,agentId,frame.errorMessage??"WhatsApp account offline"]);
      if(deferred.rowCount&&deferred.rows[0].message_id)await client.query("UPDATE messages SET status='queued' WHERE id=$1 AND status IN ('queued','dispatching')",[deferred.rows[0].message_id]);
      return;
    }
    if(!["succeeded","failed","uncertain"].includes(outcome))throw new Error("invalid_command_outcome");
    const command = await client.query("UPDATE outbound_commands SET state=$3,completed_at=now(),last_error=$4 WHERE id=$1 AND agent_id=$2 AND state='dispatched' RETURNING message_id,account_id,command,payload", [frame.commandId,agentId,outcome === "succeeded" ? "completed" : outcome,frame.errorMessage ?? null]);
    if (!command.rowCount) return;
    const commandRow=command.rows[0];
    if(outcome==="succeeded"&&["block_contact","unblock_contact"].includes(String(commandRow.command))){
      const payload=(commandRow.payload??{}) as {toJid?:unknown;actorId?:unknown},toJid=String(payload.toJid??""),actorId=String(payload.actorId??"");
      if(/^\d{7,15}@s\.whatsapp\.net$/.test(toJid))await client.query("UPDATE contacts SET whatsapp_blocked_at=CASE WHEN $3 THEN now() ELSE NULL END,whatsapp_blocked_by=CASE WHEN $3 THEN NULLIF($4,'')::uuid ELSE NULL END,updated_at=now() WHERE account_id=$1 AND provider_user_id=$2",[commandRow.account_id,toJid,commandRow.command==="block_contact",actorId]);
    }
    if (!commandRow.message_id) return;
    const status = frame.outcome === "succeeded" ? "sent" : frame.outcome === "uncertain" ? "uncertain" : "failed";
    await client.query("UPDATE messages SET status=$2::delivery_status,provider_message_id=COALESCE($3::text,provider_message_id),failure_code=CASE WHEN $2::delivery_status IN ('failed'::delivery_status,'uncertain'::delivery_status) THEN $4::text ELSE NULL END,failure_message=CASE WHEN $2::delivery_status IN ('failed'::delivery_status,'uncertain'::delivery_status) THEN $5::text ELSE NULL END WHERE id=$1", [commandRow.message_id,status,frame.whatsappMessageId ?? null,frame.errorCode ?? null,frame.errorMessage ?? null]);
    const updated = await client.query("SELECT id,conversation_id,account_id,status,provider_message_id FROM messages WHERE id=$1", [commandRow.message_id]);
    await createWebhookEvent(client,"message.status_changed",updated.rows[0].id,updated.rows[0]);
  });
}

export async function dispatchPending(agentId: string, socket = liveAgents.get(agentId)): Promise<void> {
  if (!socket || socket.readyState !== socket.OPEN) return;
  const result = await pool.query(`WITH ready AS (
    SELECT oc.id FROM outbound_commands oc
    JOIN channel_accounts wa ON wa.id=oc.account_id
    WHERE oc.agent_id=$1 AND oc.state='pending' AND oc.available_at<=now() AND wa.status='online'
    ORDER BY oc.sequence LIMIT 50 FOR UPDATE OF oc SKIP LOCKED
  )
  UPDATE outbound_commands oc SET state='dispatched',attempt=attempt+1,claimed_at=now(),last_error=NULL
  FROM ready WHERE oc.id=ready.id
  RETURNING oc.sequence,oc.id,oc.account_id,oc.command,oc.payload,oc.created_at,oc.message_id`, [agentId]);
  for (const row of result.rows) {
    if(socket.readyState!==socket.OPEN){await requeueUnsent(row.id,row.message_id);continue;}
    try{
      socket.send(JSON.stringify({ type:"command", sequence:Number(row.sequence), commandId:row.id, accountId:row.account_id, command:row.command, payload:row.payload, createdAt:row.created_at }));
      if(row.message_id)await pool.query("UPDATE messages SET status='dispatching' WHERE id=$1 AND status='queued'",[row.message_id]);
    }catch{await requeueUnsent(row.id,row.message_id);}
  }
}

async function requeueUnsent(commandId:string,messageId:string|null):Promise<void>{
  await pool.query("UPDATE outbound_commands SET state='pending',available_at=now()+interval '5 seconds',claimed_at=NULL,last_error='Agent socket closed before dispatch',attempt=GREATEST(attempt-1,0) WHERE id=$1 AND state='dispatched'",[commandId]);
  if(messageId)await pool.query("UPDATE messages SET status='queued' WHERE id=$1 AND status='dispatching'",[messageId]);
}
