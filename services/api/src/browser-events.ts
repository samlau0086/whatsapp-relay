import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { WebSocket } from "ws";
import { authenticate } from "./auth.js";
import { config } from "./config.js";
import { signToken, verifyToken } from "./security.js";

const CHANNEL = "relay_conversation_changes";
const TICKET_AUDIENCE = "relay-browser-events";
const TICKET_TTL_SECONDS = 30;
const HEARTBEAT_MS = 25_000;

type LiveClient = { socket: WebSocket; accountIds?: Set<string>; alive: boolean };
type ChangeEvent = { conversationId: string; accountId: string };

export async function registerBrowserEvents(app: FastifyInstance): Promise<void> {
  const clients = new Set<LiveClient>();
  let listener: Client | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectAttempt = 0;
  let closing = false;

  app.post("/api/v1/events/ticket", { preHandler:authenticate }, async (request,reply) => {
    const principal=request.principal;
    if(principal?.kind!=="user")return reply.code(403).send({error:"user_session_required"});
    const expiresAt=new Date(Date.now()+TICKET_TTL_SECONDS*1000);
    const ticket=signToken({
      aud:TICKET_AUDIENCE,
      purpose:"websocket-events",
      sub:principal.id,
      jti:randomUUID(),
      accountIds:principal.accountIds,
    },config.JWT_SECRET,TICKET_TTL_SECONDS);
    return reply.send({ticket,expiresAt:expiresAt.toISOString(),websocketPath:"/api/v1/events/ws"});
  });

  app.get("/api/v1/events/ws", { websocket:true }, (socket,request) => {
    const ticket=String((request.query as {ticket?:string}).ticket??"");
    const payload=verifyToken(ticket,config.JWT_SECRET);
    if(!payload||payload.aud!==TICKET_AUDIENCE||payload.purpose!=="websocket-events"||!payload.sub){
      socket.close(4001,"invalid_or_expired_ticket");
      return;
    }
    const accountIds=Array.isArray(payload.accountIds)
      ? new Set(payload.accountIds.filter((value):value is string=>typeof value==="string"))
      : undefined;
    const client:LiveClient={socket,accountIds,alive:true};
    clients.add(client);
    socket.on("pong",()=>{client.alive=true;});
    socket.on("close",()=>clients.delete(client));
    socket.on("error",()=>clients.delete(client));
    socket.send(JSON.stringify({type:"events.ready"}));
  });

  const broadcast=(event:ChangeEvent)=>{
    const frame=JSON.stringify({type:"conversation.changed",...event});
    for(const client of clients){
      if(client.socket.readyState!==client.socket.OPEN)continue;
      if(client.accountIds&&!client.accountIds.has(event.accountId))continue;
      client.socket.send(frame);
    }
  };

  const connect=async()=>{
    if(closing)return;
    const next=new Client({connectionString:config.DATABASE_URL,application_name:"relay-browser-events"});
    try{
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
      listener=next;
      reconnectAttempt=0;
      next.on("notification",message=>{
        if(message.channel!==CHANNEL||!message.payload)return;
        try{
          const event=JSON.parse(message.payload) as Partial<ChangeEvent>;
          if(typeof event.conversationId==="string"&&typeof event.accountId==="string")broadcast(event as ChangeEvent);
        }catch(error){app.log.warn({error},"ignored malformed conversation notification");}
      });
      const disconnected=(error?:Error)=>{
        if(listener===next)listener=undefined;
        if(error)app.log.warn({error},"conversation event listener disconnected");
        void next.end().catch(()=>undefined);
        scheduleReconnect();
      };
      next.once("error",disconnected);
      next.once("end",()=>disconnected());
      app.log.info("conversation event listener ready");
    }catch(error){
      app.log.warn({error},"conversation event listener connect failed");
      void next.end().catch(()=>undefined);
      scheduleReconnect();
    }
  };
  const scheduleReconnect=()=>{
    if(closing||reconnectTimer)return;
    const delay=Math.min(30_000,500*2**Math.min(reconnectAttempt++,6));
    reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;void connect();},delay);
  };

  const heartbeat=setInterval(()=>{
    for(const client of clients){
      if(!client.alive){client.socket.terminate();clients.delete(client);continue;}
      client.alive=false;
      client.socket.ping();
    }
  },HEARTBEAT_MS);
  heartbeat.unref();
  void connect();

  app.addHook("onClose",async()=>{
    closing=true;
    clearInterval(heartbeat);
    if(reconnectTimer)clearTimeout(reconnectTimer);
    for(const client of clients)client.socket.close(1001,"server_shutdown");
    clients.clear();
    const current=listener;
    listener=undefined;
    if(current)await current.end().catch(()=>undefined);
  });
}
