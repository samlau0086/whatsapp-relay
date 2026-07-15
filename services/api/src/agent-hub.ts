import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { pool, transaction } from "./db.js";
import { hashSecret } from "./security.js";

const PROTOCOL_VERSION = 1;
const liveAgents = new Map<string, WebSocket>();

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
      if (liveAgents.get(agent.id) === socket) liveAgents.delete(agent.id);
      void pool.query("UPDATE agents SET status=CASE WHEN status='revoked' THEN status ELSE 'offline' END WHERE id=$1", [agent.id]);
    });
    await dispatchPending(agent.id, socket);
  });
}

export function disconnectAgent(agentId:string,reason="revoked"):void {
  const socket=liveAgents.get(agentId);
  if(!socket)return;
  liveAgents.delete(agentId);
  socket.close(4003,reason);
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
  const events = Array.isArray(frame.events) ? frame.events as Array<{kind:string;payload:Record<string,unknown>}> : [];
  const start = Number(frame.fromCursor);
  await transaction(async (client) => {
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const cursor = start + index;
      const eventId = String(event.payload.eventId ?? `${event.kind}:${cursor}`);
      const inserted = await client.query("INSERT INTO agent_inbox(agent_id,cursor,event_id,event_kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING cursor", [agentId,cursor,eventId,event.kind]);
      if (!inserted.rowCount) continue;
      if (event.kind === "message") await ingestMessage(client, event.payload);
      if (event.kind === "message_status") await updateMessageStatus(client, event.payload);
      if (event.kind === "account_status") {
        const updated=await client.query("UPDATE whatsapp_accounts SET status=$2,status_reason=$3,last_event_at=now(),last_connected_at=CASE WHEN $2='online' THEN now() ELSE last_connected_at END WHERE id=$1 AND agent_id=$4 RETURNING id", [event.payload.accountId,event.payload.status,event.payload.reason ?? null,agentId]);
        if(updated.rowCount)await createWebhookEvent(client,"account.status_changed",String(event.payload.accountId),event.payload);
      }
    }
    await client.query("UPDATE agents SET last_acked_cursor=GREATEST(last_acked_cursor,$2),last_seen_at=now() WHERE id=$1", [agentId,Number(frame.toCursor)]);
  });
}

async function ingestMessage(client: import("pg").PoolClient, payload: Record<string,unknown>): Promise<void> {
  const chatJid = String(payload.chatJid);
  if (chatJid.endsWith("@g.us")) return;
  const accountId = String(payload.accountId);
  const contact = await client.query("INSERT INTO contacts(account_id,wa_jid,display_name,last_seen_at) VALUES($1,$2,$3,now()) ON CONFLICT(account_id,wa_jid) DO UPDATE SET last_seen_at=now() RETURNING id", [accountId,chatJid,String(payload.senderName ?? chatJid.split("@")[0])]);
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
    const command = await client.query("UPDATE outbound_commands SET state=$3,completed_at=now(),last_error=$4 WHERE id=$1 AND agent_id=$2 RETURNING message_id", [frame.commandId,agentId,frame.outcome === "succeeded" ? "completed" : frame.outcome,frame.errorMessage ?? null]);
    if (!command.rowCount || !command.rows[0].message_id) return;
    const status = frame.outcome === "succeeded" ? "sent" : frame.outcome === "uncertain" ? "uncertain" : "failed";
    await client.query("UPDATE messages SET status=$2,whatsapp_message_id=COALESCE($3,whatsapp_message_id) WHERE id=$1", [command.rows[0].message_id,status,frame.whatsappMessageId ?? null]);
    const updated = await client.query("SELECT id,conversation_id,account_id,status,whatsapp_message_id FROM messages WHERE id=$1", [command.rows[0].message_id]);
    await createWebhookEvent(client,"message.status_changed",updated.rows[0].id,updated.rows[0]);
  });
}

export async function dispatchPending(agentId: string, socket = liveAgents.get(agentId)): Promise<void> {
  if (!socket || socket.readyState !== socket.OPEN) return;
  const result = await pool.query("SELECT sequence,id,account_id,command,payload,created_at FROM outbound_commands WHERE agent_id=$1 AND state='pending' AND available_at<=now() ORDER BY sequence LIMIT 50", [agentId]);
  for (const row of result.rows) {
    socket.send(JSON.stringify({ type:"command", sequence:Number(row.sequence), commandId:row.id, accountId:row.account_id, command:row.command, payload:row.payload, createdAt:row.created_at }));
    await pool.query("UPDATE outbound_commands SET state='dispatched',attempt=attempt+1,claimed_at=now() WHERE id=$1 AND state='pending'", [row.id]);
  }
}
