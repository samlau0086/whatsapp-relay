import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate} from "./auth.js";
import {pool,transaction} from "./db.js";
import {createWebhookEvent} from "./agent-hub.js";
import {recordProactiveOutreachDelivery} from "./proactive-outreach.js";

export function normalizeLivechatOrigins(values:string[]):string[]{
  return [...new Set(values.map(value=>{
    const url=new URL(value.trim());
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password||url.pathname!=="/"||url.search||url.hash)throw new Error("invalid_origin");
    if(url.protocol==="http:"&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error("https_required");
    return url.origin;
  }))];
}

const channelSchema=z.object({
  displayName:z.string().trim().min(1).max(80),
  iconUrl:z.string().trim().max(2048).refine(value=>{
    if(!value)return true;
    try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password;}catch{return false;}
  },"图标必须为不含账号密码的 HTTPS 图片地址").default(""),
  welcomeMessage:z.string().trim().max(1000).default(""),
  themeColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb"),
  position:z.enum(["left","right"]).default("right"),
  language:z.enum(["zh-CN","zh-TW","en","ja","es","pt"]).default("en"),
  allowedOrigins:z.array(z.string().max(2048)).min(1).max(50),
  enabled:z.boolean().default(true),
});

export async function processOneLivechatOutbound():Promise<boolean>{
  return transaction(async client=>{
    const result=await client.query(`SELECT oc.id,oc.message_id,oc.account_id,oc.payload,c.enabled,c.archived_at
      FROM outbound_commands oc JOIN channel_accounts a ON a.id=oc.account_id
      JOIN livechat_channels c ON c.account_id=a.id
      WHERE a.platform='livechat' AND oc.state='pending' AND oc.available_at<=now()
      ORDER BY oc.sequence FOR UPDATE OF oc SKIP LOCKED LIMIT 1`);
    if(!result.rowCount)return false;
    const row=result.rows[0];
    if(!row.enabled||row.archived_at){
      await client.query("UPDATE outbound_commands SET state='failed',completed_at=now(),last_error='livechat_channel_disabled' WHERE id=$1",[row.id]);
      if(row.message_id)await client.query("UPDATE messages SET status='failed',failure_code='livechat_channel_disabled',failure_message='LiveChat channel is disabled' WHERE id=$1",[row.message_id]);
      return true;
    }
    await client.query("UPDATE outbound_commands SET state='completed',attempt=attempt+1,claimed_at=now(),completed_at=now(),last_error=NULL WHERE id=$1",[row.id]);
    if(row.message_id){
      const message=await client.query("UPDATE messages SET status='sent',provider_message_id=COALESCE(provider_message_id,id::text),failure_code=NULL,failure_message=NULL WHERE id=$1 RETURNING conversation_id,provider_message_id",[row.message_id]);
      if(message.rowCount){
        await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,'sent',now()) ON CONFLICT DO NOTHING",[row.message_id]);
        await recordProactiveOutreachDelivery(client,String(row.message_id));
        await createWebhookEvent(client,"message.status_changed",String(row.message_id),{platform:"livechat",accountId:String(row.account_id),conversationId:String(message.rows[0].conversation_id),providerMessageId:String(message.rows[0].provider_message_id),status:"sent"});
      }
    }
    return true;
  });
}

export async function registerLivechatRoutes(app:FastifyInstance):Promise<void>{
  app.post("/api/v1/livechat/presence/query",{preHandler:authenticate},async(request,reply)=>{
    const parsed=z.object({contactIds:z.array(z.string().uuid()).max(500)}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const result=await pool.query(`SELECT v.contact_id "contactId",
      CASE WHEN p.session_id IS NULL THEN 'offline' WHEN p.visible THEN 'online' ELSE 'away' END status,
      CASE WHEN p.visible THEN p.page_url ELSE NULL END "pageUrl"
      FROM livechat_visitors v JOIN livechat_channels channel ON channel.account_id=v.account_id
      LEFT JOIN LATERAL (SELECT session_id,visible,page_url FROM livechat_presence
        WHERE visitor_id=v.id AND connected AND updated_at>now()-interval '45 seconds'
          AND v.expires_at>now() AND channel.enabled AND channel.archived_at IS NULL
        ORDER BY visible DESC,updated_at DESC,session_id LIMIT 1) p ON true
      WHERE v.contact_id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR v.account_id=ANY($2::uuid[]))`,[parsed.data.contactIds,request.principal?.accountIds??null]);
    return reply.header("cache-control","no-store").send({data:result.rows});
  });
  app.get("/api/v1/admin/livechat/channels",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const result=await pool.query(`SELECT a.id,a.display_name,c.public_id,c.welcome_message,c.theme_color,c.position,c.language,c.icon_url,c.allowed_origins,c.enabled,c.created_at,c.updated_at
      FROM livechat_channels c JOIN channel_accounts a ON a.id=c.account_id WHERE c.archived_at IS NULL ORDER BY a.display_name,a.id`);
    return {data:result.rows};
  });
  app.post("/api/v1/admin/livechat/channels",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=channelSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    let origins:string[];try{origins=normalizeLivechatOrigins(parsed.data.allowedOrigins);}catch{return reply.code(400).send({error:"invalid_origin"});}
    const data=parsed.data;
    const result=await transaction(async client=>{
      const account=await client.query("INSERT INTO channel_accounts(display_name,status,transport,platform) VALUES($1,$2,'cloud','livechat') RETURNING id",[data.displayName,data.enabled?"online":"offline"]);
      const channel=await client.query("INSERT INTO livechat_channels(account_id,welcome_message,theme_color,position,allowed_origins,enabled,language,icon_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING public_id",[account.rows[0].id,data.welcomeMessage,data.themeColor,data.position,origins,data.enabled,data.language,data.iconUrl]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'livechat.create','channel_account',$2,$3)",[request.principal!.id,account.rows[0].id,JSON.stringify({allowedOrigins:origins})]);
      return {id:account.rows[0].id,publicId:channel.rows[0].public_id};
    });
    return reply.code(201).send(result);
  });
  app.put("/api/v1/admin/livechat/channels/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=channelSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    let origins:string[];try{origins=normalizeLivechatOrigins(parsed.data.allowedOrigins);}catch{return reply.code(400).send({error:"invalid_origin"});}
    const {id}=request.params as {id:string},data=parsed.data;
    if(!z.string().uuid().safeParse(id).success)return reply.code(400).send({error:"invalid_channel_id"});
    const updated=await transaction(async client=>{
      const channel=await client.query("UPDATE livechat_channels SET welcome_message=$2,theme_color=$3,position=$4,allowed_origins=$5,enabled=$6,language=$7,icon_url=COALESCE($8,icon_url),updated_at=now() WHERE account_id=$1 AND archived_at IS NULL RETURNING account_id",[id,data.welcomeMessage,data.themeColor,data.position,origins,data.enabled,data.language,Object.hasOwn(request.body as object,"iconUrl")?data.iconUrl:null]);
      if(!channel.rowCount)return false;
      await client.query("UPDATE channel_accounts SET display_name=$2,status=$3,status_reason=$4 WHERE id=$1",[id,data.displayName,data.enabled?"online":"offline",data.enabled?null:"livechat_disabled"]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'livechat.update','channel_account',$2,$3)",[request.principal!.id,id,JSON.stringify({enabled:data.enabled,allowedOrigins:origins})]);
      return true;
    });
    return updated?{ok:true}:reply.code(404).send({error:"not_found"});
  });
  app.delete("/api/v1/admin/livechat/channels/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};
    if(!z.string().uuid().safeParse(id).success)return reply.code(400).send({error:"invalid_channel_id"});
    const archived=await transaction(async client=>{
      const channel=await client.query("UPDATE livechat_channels SET enabled=false,archived_at=now(),updated_at=now() WHERE account_id=$1 AND archived_at IS NULL RETURNING account_id",[id]);
      if(!channel.rowCount)return false;
      await client.query("UPDATE channel_accounts SET status='offline',status_reason='livechat_archived' WHERE id=$1",[id]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'livechat.archive','channel_account',$2,'{}')",[request.principal!.id,id]);
      return true;
    });
    return archived?{ok:true,historyPreserved:true}:reply.code(404).send({error:"not_found"});
  });
}
