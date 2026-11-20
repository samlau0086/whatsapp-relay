import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate,canAccessAccount} from "./auth.js";
import {pool,transaction} from "./db.js";
import {createWebhookEvent} from "./agent-hub.js";
import {recordProactiveOutreachDelivery} from "./proactive-outreach.js";
import {queueLivechatTranscript} from "./livechat-transcript.js";
import {encryptAtRest} from "./security.js";
import {config} from "./config.js";
import {transcriptTemplateError} from "./livechat-transcript-template.js";

export function normalizeLivechatOrigins(values:string[]):string[]{
  return [...new Set(values.map(value=>{
    const url=new URL(value.trim());
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password||url.pathname!=="/"||url.search||url.hash)throw new Error("invalid_origin");
    if(url.protocol==="http:"&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error("https_required");
    return url.origin;
  }))];
}

const transcriptTemplateSchema=z.object({
  subject:z.string().trim().min(1).max(200),body:z.string().min(1).max(20000),
  message:z.string().min(1).max(5000),departmentName:z.string().trim().max(100).default(""),
}).superRefine((value,ctx)=>{const error=transcriptTemplateError(value);if(error)ctx.addIssue({code:z.ZodIssueCode.custom,message:error});});
const channelSchema=z.object({
  transcriptTemplate:transcriptTemplateSchema.nullable().optional(),
  displayName:z.string().trim().min(1).max(80),
  iconUrl:z.string().trim().max(2048).refine(value=>{
    if(!value)return true;
    try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password;}catch{return false;}
  },"图标必须为不含账号密码的 HTTPS 图片地址").default(""),
  ga4MeasurementId:z.string().trim().max(40).regex(/^G-[A-Z0-9]+$/).or(z.literal("")).optional(),
  ga4ApiSecret:z.string().trim().max(256).regex(/^[A-Za-z0-9_-]*$/).optional(),
  welcomeMessage:z.string().trim().max(1000).default(""),
  starterMessages:z.array(z.string().trim().min(1).max(500)).max(50).optional(),
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
  app.post("/api/v1/conversations/:id/transcript",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const params=z.object({id:z.string().uuid()}).safeParse(request.params);
    const parsed=z.object({clientSendId:z.string().uuid(),targetConversationId:z.string().uuid().optional(),endRequestId:z.string().uuid().optional()}).safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const principal=request.principal,rootId=params.data.id,targetId=parsed.data.targetConversationId??rootId;
    const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
    try{
      const result=await transaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`livechat-end:${parsed.data.clientSendId}`]);
        const context=await client.query(`SELECT cv.id conversation_id,cv.account_id,cv.contact_id,
          (SELECT email FROM contact_emails WHERE contact_id=cv.contact_id AND is_primary LIMIT 1) recipient_email
          FROM conversations root JOIN conversations cv ON cv.id=$2
          JOIN livechat_channels channel ON channel.account_id=cv.account_id
          WHERE root.id=$1 AND cv.id=$2 AND cv.id IN (SELECT relay_conversation_members(root.id))
          AND cv.origin_mode='livechat'
          AND EXISTS(SELECT 1 FROM livechat_visitors v WHERE v.account_id=cv.account_id AND v.contact_id=cv.contact_id)
          AND channel.enabled AND channel.archived_at IS NULL FOR UPDATE OF cv`,[rootId,targetId]);
        const row=context.rows[0];
        if(!row||!canAccessAccount(principal,row.account_id))throw fail(404,"conversation_not_found");
        if(principal.role!=="admin"){
          const permission=await client.query("SELECT 1 FROM account_permissions WHERE account_id=$1 AND user_id=$2 AND can_read AND can_send LIMIT 1",[row.account_id,principal.id]);
          if(!permission.rowCount)throw fail(403,"account_send_forbidden");
        }
        const existing=await client.query("SELECT id,status,conversation_id,sender_user_id,content_type,livechat_end_request_id FROM email_messages WHERE client_send_id=$1",[parsed.data.clientSendId]);
        if(existing.rowCount){
          const old=existing.rows[0];
          if(old.conversation_id!==targetId||old.sender_user_id!==principal.id||old.content_type!=="livechat_transcript"||(old.livechat_end_request_id??null)!==(parsed.data.endRequestId??null))throw fail(409,"client_send_id_conflict");
          return {emailId:old.id,status:old.status,deduplicated:true};
        }
        const job=await queueLivechatTranscript(client,row,parsed.data.clientSendId,principal.id,false,parsed.data.endRequestId);
        await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'livechat.send_transcript','conversation',$2,$3)",[principal.id,targetId,JSON.stringify({rootConversationId:rootId,endRequestId:parsed.data.endRequestId,emailId:job.emailId,recipient:job.recipient})]);
        return {emailId:job.emailId,status:job.status,deduplicated:false};
      });
      return reply.code(202).send({ok:true,queued:true,...result});
    }catch(error){
      const code=error instanceof Error?error.message:"";
      const messages:Record<string,string>={transcript_boundary_not_found:"结束分隔记录不存在或不属于该访客",account_send_forbidden:"没有该渠道的邮件发送权限",conversation_not_found:"会话不存在、无权访问或 LiveChat 渠道已停用",visitor_email_required:"请先在客户资料中设置访客主邮箱",email_provider_not_configured:"请先配置渠道邮件 Provider 或工作区默认 Provider",channel_email_provider_unavailable:"渠道绑定的邮件 Provider 不可用，请联系管理员",client_send_id_conflict:"发送请求冲突，请重新打开后重试"};
      if(messages[code])return reply.code((error as {statusCode?:number}).statusCode??409).send({error:code,message:messages[code]});
      throw error;
    }
  });
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
    const result=await pool.query(`SELECT a.id,a.display_name,c.public_id,c.welcome_message,c.starter_messages,c.transcript_template,c.theme_color,c.position,c.language,c.icon_url,c.allowed_origins,c.enabled,c.created_at,c.updated_at,c.ga4_measurement_id,(c.ga4_api_secret_encrypted IS NOT NULL) "ga4ApiSecretConfigured"
      FROM livechat_channels c JOIN channel_accounts a ON a.id=c.account_id WHERE c.archived_at IS NULL ORDER BY a.display_name,a.id`);
    return reply.header("cache-control","no-store").send({data:result.rows});
  });
  app.post("/api/v1/admin/livechat/channels",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=channelSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    let origins:string[];try{origins=normalizeLivechatOrigins(parsed.data.allowedOrigins);}catch{return reply.code(400).send({error:"invalid_origin"});}
    const data=parsed.data;
    if(data.ga4ApiSecret&&!data.ga4MeasurementId)return reply.code(400).send({error:"ga4_measurement_id_required",message:"填写 API secret 时必须提供 Measurement ID"});
    const result=await transaction(async client=>{
      const account=await client.query("INSERT INTO channel_accounts(display_name,status,transport,platform) VALUES($1,$2,'cloud','livechat') RETURNING id",[data.displayName,data.enabled?"online":"offline"]);
      const channel=await client.query("INSERT INTO livechat_channels(account_id,welcome_message,theme_color,position,allowed_origins,enabled,language,icon_url,ga4_measurement_id,ga4_api_secret_encrypted,starter_messages,transcript_template) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb) RETURNING public_id",[account.rows[0].id,data.welcomeMessage,data.themeColor,data.position,origins,data.enabled,data.language,data.iconUrl,data.ga4MeasurementId||null,data.ga4ApiSecret?encryptAtRest(data.ga4ApiSecret,config.DATA_ENCRYPTION_KEY):null,JSON.stringify(data.starterMessages??[]),data.transcriptTemplate?JSON.stringify(data.transcriptTemplate):null]);
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
    if(data.ga4ApiSecret&&!data.ga4MeasurementId)return reply.code(400).send({error:"ga4_measurement_id_required",message:"填写 API secret 时必须提供 Measurement ID"});
    const updated=await transaction(async client=>{
      const secret=data.ga4ApiSecret?encryptAtRest(data.ga4ApiSecret,config.DATA_ENCRYPTION_KEY):null;
      const channel=await client.query(`UPDATE livechat_channels SET welcome_message=$2,theme_color=$3,position=$4,allowed_origins=$5,enabled=$6,language=$7,icon_url=COALESCE($8,icon_url),
        ga4_measurement_id=CASE WHEN $9 THEN NULLIF($10,'') ELSE ga4_measurement_id END,
        ga4_api_secret_encrypted=CASE WHEN $11::text IS NOT NULL THEN $11 WHEN $9 AND (NULLIF($10,'') IS DISTINCT FROM ga4_measurement_id OR $10='') THEN NULL ELSE ga4_api_secret_encrypted END,
        starter_messages=COALESCE($12::jsonb,starter_messages),
        transcript_template=CASE WHEN $13 THEN $14::jsonb ELSE transcript_template END,
        updated_at=now() WHERE account_id=$1 AND archived_at IS NULL RETURNING account_id`,[id,data.welcomeMessage,data.themeColor,data.position,origins,data.enabled,data.language,Object.hasOwn(request.body as object,"iconUrl")?data.iconUrl:null,data.ga4MeasurementId!==undefined,data.ga4MeasurementId??null,secret,data.starterMessages===undefined?null:JSON.stringify(data.starterMessages),data.transcriptTemplate!==undefined,data.transcriptTemplate?JSON.stringify(data.transcriptTemplate):null]);
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
