import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { pool, transaction } from "./db.js";
import { hashSecret } from "./security.js";
import { enqueueInboundAgentWork } from "./agent-engine.js";

const PROTOCOL_VERSION = 1;
const HEARTBEAT_TIMEOUT_SECONDS = 45;
const liveAgents = new Map<string, WebSocket>();
let watchdog:NodeJS.Timeout|undefined;

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
    await dispatchPending(agent.id, socket);
  });
  watchdog??=setInterval(()=>void markStaleAgentsOffline().catch(error=>app.log.error({error},"agent heartbeat watchdog failed")),15_000);
  app.addHook("onClose",async()=>{if(watchdog){clearInterval(watchdog);watchdog=undefined;}});
}

export function disconnectAgent(agentId:string,reason="revoked"):void {
  const socket=liveAgents.get(agentId);
  if(!socket)return;
  liveAgents.delete(agentId);
  socket.close(4003,reason);
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
  const accounts=await client.query("UPDATE whatsapp_accounts SET status='offline',status_reason=$2,last_event_at=now() WHERE agent_id=$1 AND status IN ('online','pairing') RETURNING id",[agentId,reason]);
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
    if (frame.protocolVersion !== PROTOCOL_VERSION) { socket.send(JSON.stringify({ type:"incompatible", supportedVersion:PROTOCOL_VERSION })); return; }
    await pool.query("UPDATE agents SET version=$2,protocol_version=$3,platform=$4,last_seen_at=now() WHERE id=$1", [agentId, frame.agentVersion, frame.protocolVersion, frame.platform]);
    await dispatchPending(agentId, socket);
    return;
  }
  if (frame.type === "heartbeat") {
    await pool.query("UPDATE agents SET last_seen_at=now(),status='online' WHERE id=$1", [agentId]);
    const accounts = Array.isArray(frame.accounts) ? frame.accounts as Array<{accountId:string;status:string}> : [];
    for (const account of accounts) await pool.query("UPDATE whatsapp_accounts SET status=$2::wa_account_status,status_reason=CASE WHEN $2::wa_account_status='online'::wa_account_status THEN NULL ELSE status_reason END,last_event_at=now(),last_connected_at=CASE WHEN $2::wa_account_status='online'::wa_account_status THEN now() ELSE last_connected_at END WHERE id=$1 AND agent_id=$3", [account.accountId, account.status, agentId]);
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
          if(event.kind==="message")await ingestMessage(client,agentId,event.payload);
          else if(event.kind==="message_status")await updateMessageStatus(client,event.payload);
          else if(event.kind==="contact_identity")await mergeContactIdentity(client,agentId,event.payload);
          else if(event.kind==="account_status"){
            const updated=await client.query("UPDATE whatsapp_accounts SET status=$2::wa_account_status,status_reason=$3,last_event_at=now(),last_connected_at=CASE WHEN $2::wa_account_status='online'::wa_account_status THEN now() ELSE last_connected_at END WHERE id=$1 AND agent_id=$4 RETURNING id",[event.payload.accountId,event.payload.status,event.payload.reason??null,agentId]);
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
  const owned=await client.query("SELECT id FROM whatsapp_accounts WHERE id=$1 AND agent_id=$2",[accountId,agentId]);if(!owned.rowCount)throw new Error("contact_identity_account_not_owned_by_agent");
  const phone=`+${phoneJid.split("@")[0]}`;
  const found=await client.query("SELECT id,wa_jid,phone_e164,display_name FROM contacts WHERE account_id=$1 AND (wa_jid=ANY($2::text[]) OR phone_e164=$3) ORDER BY CASE WHEN wa_jid=$4 THEN 0 WHEN phone_e164=$3 THEN 1 ELSE 2 END,id FOR UPDATE",[accountId,[phoneJid,lidJid],phone,phoneJid]);
  if(!found.rowCount)return null;
  const target=found.rows[0];
  const suppliedName=typeof payload.displayName==="string"&&!/^\+?\d+$/.test(payload.displayName)?payload.displayName:null;
  const bestName=suppliedName??found.rows.map(row=>String(row.display_name??"")).find(name=>name&&!/^\+?\d+$/.test(name))??target.display_name??phone;
  for(const source of found.rows.slice(1)){
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
      await client.query("UPDATE conversations t SET unread_count=t.unread_count+s.unread_count,favorite=t.favorite OR s.favorite,last_message_at=GREATEST(t.last_message_at,s.last_message_at),assigned_user_id=COALESCE(t.assigned_user_id,s.assigned_user_id),customer_stage=CASE WHEN array_position(ARRAY['new','considering','qualified','lost','won'],s.customer_stage)>array_position(ARRAY['new','considering','qualified','lost','won'],t.customer_stage) THEN s.customer_stage ELSE t.customer_stage END,status=CASE WHEN t.status='open' OR s.status='open' THEN 'open'::conversation_status WHEN t.status='closed' OR s.status='closed' THEN 'closed'::conversation_status ELSE 'archived'::conversation_status END,closed_at=CASE WHEN t.status='open' OR s.status='open' THEN NULL ELSE GREATEST(t.closed_at,s.closed_at) END FROM conversations s WHERE t.id=$1 AND s.id=$2",[targetId,sourceId]);
      await client.query("DELETE FROM conversations WHERE id=$1",[sourceId]);
    }else if(sourceConversation.rowCount)await client.query("UPDATE conversations SET contact_id=$1 WHERE id=$2",[target.id,sourceConversation.rows[0].id]);
    await client.query("UPDATE messages SET sender_contact_id=$1 WHERE sender_contact_id=$2",[target.id,source.id]);
    await client.query("DELETE FROM contacts WHERE id=$1",[source.id]);
  }
  await client.query("UPDATE contacts SET wa_jid=$2,phone_e164=$3,display_name=$4,last_seen_at=COALESCE(last_seen_at,now()) WHERE id=$1",[target.id,phoneJid,phone,bestName]);
  return String(target.id);
}

function normalizedIdentityJid(value:unknown,server:"lid"|"s.whatsapp.net"):string|null{
  const raw=String(value??"").trim().toLowerCase(),parts=raw.split("@");if(parts.length!==2||parts[1]!==server)return null;
  const user=parts[0].split(":")[0];return /^\d{7,15}$/.test(user)?`${user}@${server}`:null;
}

async function ingestMessage(client: import("pg").PoolClient, agentId:string, payload: Record<string,unknown>): Promise<void> {
  const chatJid = String(payload.chatJid);
  if (chatJid.endsWith("@g.us")) return;
  if(String(payload.kind??"text")==="text"&&!payload.text&&!payload.media)return;
  const accountId = String(payload.accountId);
  const account=await client.query("SELECT id FROM whatsapp_accounts WHERE id=$1 AND agent_id=$2",[accountId,agentId]);
  if(!account.rowCount)throw new Error("message_account_not_owned_by_agent");
  const phonePart=chatJid.endsWith("@s.whatsapp.net")?chatJid.split("@")[0].split(":")[0]:null;
  const phone=phonePart&&/^\d{7,15}$/.test(phonePart)?`+${phonePart}`:null;
  const rawChatJid=String(payload.rawChatJid??"");
  const mergedContactId=phone&&rawChatJid.endsWith("@lid")?await mergeContactIdentity(client,agentId,{accountId,lidJid:rawChatJid,phoneJid:chatJid,displayName:payload.senderName}):null;
  const contact = mergedContactId?await client.query("UPDATE contacts SET display_name=COALESCE(NULLIF($2,''),display_name),last_seen_at=now() WHERE id=$1 RETURNING id",[mergedContactId,String(payload.senderName??"")]):await client.query("INSERT INTO contacts(account_id,wa_jid,phone_e164,display_name,last_seen_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(account_id,wa_jid) DO UPDATE SET phone_e164=COALESCE(contacts.phone_e164,EXCLUDED.phone_e164),display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),contacts.display_name),last_seen_at=now() RETURNING id", [accountId,chatJid,phone,String(payload.senderName ?? phone ?? chatJid.split("@")[0])]);
  const conversation = await client.query("INSERT INTO conversations(account_id,contact_id,last_message_at,unread_count) VALUES($1,$2,$3,CASE WHEN $4='in' THEN 1 ELSE 0 END) ON CONFLICT(account_id,contact_id) DO UPDATE SET last_message_at=EXCLUDED.last_message_at,unread_count=conversations.unread_count+CASE WHEN $4='in' THEN 1 ELSE 0 END,status='open' RETURNING id", [accountId,contact.rows[0].id,payload.occurredAt,payload.direction]);
  const media=payload.media as {uploadId?:string}|undefined;
  const message = await client.query("INSERT INTO messages(conversation_id,account_id,sender_contact_id,whatsapp_message_id,direction,kind,text_content,media_id,status,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,whatsapp_message_id) DO NOTHING RETURNING id", [conversation.rows[0].id,accountId,payload.direction === "in" ? contact.rows[0].id : null,payload.whatsappMessageId,payload.direction,payload.kind,payload.text ?? null,media?.uploadId??null,payload.direction === "in" ? "received" : "sent",payload.occurredAt]);
  if (message.rowCount){
    await createWebhookEvent(client,"message.received",message.rows[0].id,{ ...payload, platformMessageId:message.rows[0].id, conversationId:conversation.rows[0].id });
    if(payload.direction==="in"&&(payload.kind==="text"||payload.kind==="audio"))await enqueueInboundAgentWork(client,conversation.rows[0].id,message.rows[0].id);
  }
}

async function updateMessageStatus(client: import("pg").PoolClient, payload: Record<string,unknown>): Promise<void> {
  const result = await client.query("UPDATE messages SET status=$3 WHERE account_id=$1 AND whatsapp_message_id=$2 RETURNING id,conversation_id", [payload.accountId,payload.whatsappMessageId,payload.status]);
  if (!result.rowCount) return;
  await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [result.rows[0].id,payload.status,payload.at]);
  await createWebhookEvent(client,"message.status_changed",result.rows[0].id,{ ...payload, platformMessageId:result.rows[0].id });
}

async function createWebhookEvent(client: import("pg").PoolClient, eventType: string, aggregateId: string, payload: Record<string,unknown>): Promise<void> {
  const event = await client.query("INSERT INTO webhook_events(event_type,aggregate_id,payload) VALUES($1,$2,$3) RETURNING id", [eventType,aggregateId,JSON.stringify(payload)]);
  await client.query("INSERT INTO webhook_deliveries(event_id,endpoint_id) SELECT $1,id FROM webhook_endpoints WHERE enabled AND $2=ANY(event_types) ON CONFLICT DO NOTHING", [event.rows[0].id,eventType]);
}

async function processCommandResult(agentId: string, frame: AgentFrame): Promise<void> {
  await transaction(async (client) => {
    const outcome=String(frame.outcome);
    if(outcome==="deferred"){
      const deferred=await client.query("UPDATE outbound_commands SET state='pending',available_at=now()+interval '5 seconds',claimed_at=NULL,completed_at=NULL,last_error=$3,attempt=GREATEST(attempt-1,0) WHERE id=$1 AND agent_id=$2 AND state='dispatched' RETURNING message_id",[frame.commandId,agentId,frame.errorMessage??"WhatsApp account offline"]);
      if(deferred.rowCount&&deferred.rows[0].message_id)await client.query("UPDATE messages SET status='queued' WHERE id=$1 AND status IN ('queued','dispatching')",[deferred.rows[0].message_id]);
      return;
    }
    if(!["succeeded","failed","uncertain"].includes(outcome))throw new Error("invalid_command_outcome");
    const command = await client.query("UPDATE outbound_commands SET state=$3,completed_at=now(),last_error=$4 WHERE id=$1 AND agent_id=$2 RETURNING message_id", [frame.commandId,agentId,outcome === "succeeded" ? "completed" : outcome,frame.errorMessage ?? null]);
    if (!command.rowCount || !command.rows[0].message_id) return;
    const status = frame.outcome === "succeeded" ? "sent" : frame.outcome === "uncertain" ? "uncertain" : "failed";
    await client.query("UPDATE messages SET status=$2,whatsapp_message_id=COALESCE($3,whatsapp_message_id) WHERE id=$1", [command.rows[0].message_id,status,frame.whatsappMessageId ?? null]);
    const updated = await client.query("SELECT id,conversation_id,account_id,status,whatsapp_message_id FROM messages WHERE id=$1", [command.rows[0].message_id]);
    await createWebhookEvent(client,"message.status_changed",updated.rows[0].id,updated.rows[0]);
  });
}

export async function dispatchPending(agentId: string, socket = liveAgents.get(agentId)): Promise<void> {
  if (!socket || socket.readyState !== socket.OPEN) return;
  const result = await pool.query(`WITH ready AS (
    SELECT oc.id FROM outbound_commands oc
    JOIN whatsapp_accounts wa ON wa.id=oc.account_id
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
