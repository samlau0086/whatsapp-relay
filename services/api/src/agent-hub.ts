import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { pool, transaction } from "./db.js";
import { hashSecret } from "./security.js";

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
    for (const account of accounts) await pool.query("UPDATE whatsapp_accounts SET status=$2,last_event_at=now() WHERE id=$1 AND agent_id=$3", [account.accountId, account.status, agentId]);
    socket.send(JSON.stringify({ type:"pong", at:new Date().toISOString() }));
    await dispatchPending(agentId, socket);
    return;
  }
  if (frame.type === "event_batch") {
    await processBatch(agentId, frame);
    const cursor = Number(frame.toCursor);
    socket.send(JSON.stringify({ type:"ack", cursor }));
    await dispatchPending(agentId, socket);
    return;
  }
  if (frame.type === "command_result") {
    await processCommandResult(agentId, frame);
    await dispatchPending(agentId, socket);
  }
}

async function processBatch(agentId: string, frame: AgentFrame): Promise<void> {
  const events = Array.isArray(frame.events) ? frame.events as Array<{cursor?:number;kind:string;payload:Record<string,unknown>}> : [];
  const start = Number(frame.fromCursor);
  await transaction(async (client) => {
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const cursor = Number(event.cursor ?? start + index);
      if(!Number.isSafeInteger(cursor)||cursor<start||cursor>Number(frame.toCursor))throw new Error("invalid_event_cursor");
      const eventId = String(event.payload.eventId ?? `${event.kind}:${cursor}`);
      const inserted = await client.query("INSERT INTO agent_inbox(agent_id,cursor,event_id,event_kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING cursor", [agentId,cursor,eventId,event.kind]);
      if (!inserted.rowCount) continue;
      if (event.kind === "message") await ingestMessage(client, agentId, event.payload);
      if (event.kind === "message_status") await updateMessageStatus(client, event.payload);
      if (event.kind === "account_status") {
        const updated=await client.query("UPDATE whatsapp_accounts SET status=$2,status_reason=$3,last_event_at=now(),last_connected_at=CASE WHEN $2='online' THEN now() ELSE last_connected_at END WHERE id=$1 AND agent_id=$4 RETURNING id", [event.payload.accountId,event.payload.status,event.payload.reason ?? null,agentId]);
        if(updated.rowCount)await createWebhookEvent(client,"account.status_changed",String(event.payload.accountId),event.payload);
      }
    }
    await client.query("UPDATE agents SET last_acked_cursor=GREATEST(last_acked_cursor,$2),last_seen_at=now() WHERE id=$1", [agentId,Number(frame.toCursor)]);
  });
}

async function ingestMessage(client: import("pg").PoolClient, agentId:string, payload: Record<string,unknown>): Promise<void> {
  const chatJid = String(payload.chatJid);
  if (chatJid.endsWith("@g.us")) return;
  const accountId = String(payload.accountId);
  const account=await client.query("SELECT id FROM whatsapp_accounts WHERE id=$1 AND agent_id=$2",[accountId,agentId]);
  if(!account.rowCount)throw new Error("message_account_not_owned_by_agent");
  const phonePart=chatJid.endsWith("@s.whatsapp.net")?chatJid.split("@")[0].split(":")[0]:null;
  const phone=phonePart&&/^\d{7,15}$/.test(phonePart)?`+${phonePart}`:null;
  const contact = await client.query("INSERT INTO contacts(account_id,wa_jid,phone_e164,display_name,last_seen_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(account_id,wa_jid) DO UPDATE SET phone_e164=COALESCE(contacts.phone_e164,EXCLUDED.phone_e164),display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),contacts.display_name),last_seen_at=now() RETURNING id", [accountId,chatJid,phone,String(payload.senderName ?? phone ?? chatJid.split("@")[0])]);
  const conversation = await client.query("INSERT INTO conversations(account_id,contact_id,last_message_at,unread_count) VALUES($1,$2,$3,CASE WHEN $4='in' THEN 1 ELSE 0 END) ON CONFLICT(account_id,contact_id) DO UPDATE SET last_message_at=EXCLUDED.last_message_at,unread_count=conversations.unread_count+CASE WHEN $4='in' THEN 1 ELSE 0 END,status='open' RETURNING id", [accountId,contact.rows[0].id,payload.occurredAt,payload.direction]);
  const media=payload.media as {uploadId?:string}|undefined;
  const message = await client.query("INSERT INTO messages(conversation_id,account_id,sender_contact_id,whatsapp_message_id,direction,kind,text_content,media_id,status,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,whatsapp_message_id) DO NOTHING RETURNING id", [conversation.rows[0].id,accountId,payload.direction === "in" ? contact.rows[0].id : null,payload.whatsappMessageId,payload.direction,payload.kind,payload.text ?? null,media?.uploadId??null,payload.direction === "in" ? "received" : "sent",payload.occurredAt]);
  if (message.rowCount) await createWebhookEvent(client,"message.received",message.rows[0].id,{ ...payload, platformMessageId:message.rows[0].id, conversationId:conversation.rows[0].id });
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
