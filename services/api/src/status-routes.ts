import type {FastifyInstance,FastifyReply,FastifyRequest} from "fastify";
import {z} from "zod";
import {authenticate,type Principal} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {rescheduleStatusCampaign} from "./status-engine.js";
import {generateStatusSlots,isValidIanaTimeZone,statusDateOnly,type StatusSchedule} from "./status-schedule.js";

const uuid=z.string().uuid();
const languageCode=z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const audienceSchema=z.object({
  mode:z.enum(["all","manual","tags"]).default("all"),
  contactIds:z.array(uuid).max(1000).default([]),
  tagIds:z.array(uuid).max(100).default([]),
}).superRefine((value,ctx)=>{
  if(value.mode==="manual"&&!value.contactIds.length)ctx.addIssue({code:"custom",path:["contactIds"],message:"manual audience requires contacts"});
  if(value.mode==="tags"&&!value.tagIds.length)ctx.addIssue({code:"custom",path:["tagIds"],message:"tag audience requires tags"});
});
const scheduleFields={
  timezone:z.string().trim().min(1).max(100),
  startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activeWeekdays:z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7),
  dailyStart:z.string().regex(/^\d{2}:\d{2}$/),
  dailyEnd:z.string().regex(/^\d{2}:\d{2}$/),
  intervalMinutes:z.coerce.number().int().min(1).max(10080),
};
const campaignCreateSchema=z.object({
  clientCampaignId:uuid,accountId:uuid,name:z.string().trim().min(1).max(120),...scheduleFields,audience:audienceSchema,
});
const campaignPatchSchema=z.object({
  name:z.string().trim().min(1).max(120).optional(),
  timezone:scheduleFields.timezone.optional(),startDate:scheduleFields.startDate.optional(),endDate:scheduleFields.endDate.optional(),
  activeWeekdays:scheduleFields.activeWeekdays.optional(),dailyStart:scheduleFields.dailyStart.optional(),dailyEnd:scheduleFields.dailyEnd.optional(),
  intervalMinutes:scheduleFields.intervalMinutes.optional(),audience:audienceSchema.optional(),
}).refine(value=>Object.keys(value).length>0);
const postItemObject=z.object({
  clientPostId:uuid,type:z.enum(["text","image","video"]),text:z.string().trim().max(65536).optional(),
  mediaId:uuid.optional(),backgroundColor:z.string().regex(/^#[0-9a-fA-F]{6,8}$/).optional(),font:z.coerce.number().int().min(0).max(5).optional(),
  translationSourceText:z.string().trim().min(1).max(65536).optional(),translationTargetLanguage:languageCode.optional(),
});
const postItemSchema=postItemObject.superRefine((value,ctx)=>{
  if(value.type==="text"&&!value.text)ctx.addIssue({code:"custom",path:["text"],message:"text status requires text"});
  if(value.type!=="text"&&!value.mediaId)ctx.addIssue({code:"custom",path:["mediaId"],message:"media status requires media"});
  if(Boolean(value.translationSourceText)!==Boolean(value.translationTargetLanguage))ctx.addIssue({code:"custom",path:["translationTargetLanguage"],message:"translation source and target must be provided together"});
  if(value.translationSourceText&&!value.text)ctx.addIssue({code:"custom",path:["text"],message:"translated status requires outgoing text"});
});
const postsCreateSchema=z.object({items:z.array(postItemSchema).min(1).max(500)});
const orderSchema=z.object({postIds:z.array(uuid).min(1).max(500)});

async function readableAccounts(principal:Principal|undefined):Promise<string[]|null>{
  if(!principal)return[];
  if(principal.kind==="api_key")return principal.accountIds??null;
  if(principal.role==="admin")return null;
  return(await pool.query("SELECT account_id FROM account_permissions WHERE user_id=$1 AND can_read",[principal.id])).rows.map(row=>String(row.account_id));
}
async function canRead(principal:Principal|undefined,accountId:string):Promise<boolean>{
  const ids=await readableAccounts(principal);return ids===null||ids.includes(accountId);
}
function canManage(principal:Principal|undefined):boolean{return principal?.kind==="user"&&["admin","supervisor"].includes(principal.role??"");}
function scheduleFrom(value:Record<string,unknown>):StatusSchedule{
  return{timezone:String(value.timezone),startDate:statusDateOnly(value.startDate??value.start_date),endDate:statusDateOnly(value.endDate??value.end_date),activeWeekdays:(value.activeWeekdays??value.active_weekdays) as number[],dailyStart:String(value.dailyStart??value.daily_start).slice(0,5),dailyEnd:String(value.dailyEnd??value.daily_end).slice(0,5),intervalMinutes:Number(value.intervalMinutes??value.interval_minutes)};
}
function validateSchedule(value:Record<string,unknown>):void{
  if(!isValidIanaTimeZone(String(value.timezone)))throw Object.assign(new Error("invalid_timezone"),{statusCode:400});
  try{generateStatusSlots(scheduleFrom(value));}catch(error){throw Object.assign(error instanceof Error?error:new Error(String(error)),{statusCode:400});}
}
async function campaignAccess(request:FastifyRequest,reply:FastifyReply,id:string,lock=false){
  const found=await pool.query(`SELECT c.*,a.display_name account_name,a.transport,a.status account_status,a.agent_id,g.status agent_status,g.capabilities
    FROM status_campaigns c JOIN channel_accounts a ON a.id=c.account_id LEFT JOIN agents g ON g.id=a.agent_id WHERE c.id=$1${lock?" FOR UPDATE OF c":""}`,[id]);
  if(!found.rowCount||!await canRead(request.principal,String(found.rows[0].account_id))){await reply.code(404).send({error:"not_found"});return null;}
  return found.rows[0] as Record<string,unknown>;
}
async function validateMedia(client:import("pg").PoolClient,accountId:string,item:z.infer<typeof postItemSchema>):Promise<void>{
  if(item.type==="text")return;
  const media=await client.query("SELECT mime_type FROM media WHERE id=$1 AND status='ready' AND (account_id=$2 OR account_id IS NULL)",[item.mediaId,accountId]);
  if(!media.rowCount)throw Object.assign(new Error("status_media_not_found"),{statusCode:404});
  const mime=String(media.rows[0].mime_type);
  const valid=item.type==="image"?["image/jpeg","image/png","image/webp"].includes(mime):mime==="video/mp4";
  if(!valid)throw Object.assign(new Error("unsupported_status_media_type"),{statusCode:415});
}
async function snapshotAudience(client:import("pg").PoolClient,campaign:Record<string,unknown>):Promise<number>{
  const audience=(campaign.audience_filter??{mode:"all"}) as {mode?:string;contactIds?:string[];tagIds?:string[]};
  let rows;
  if(audience.mode==="manual")rows=await client.query(`SELECT id,provider_user_id,COALESCE(NULLIF(alias,''),display_name,phone_e164) display_name FROM contacts WHERE account_id=$1 AND id=ANY($2::uuid[])`,[campaign.account_id,audience.contactIds??[]]);
  else if(audience.mode==="tags")rows=await client.query(`SELECT DISTINCT co.id,co.provider_user_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) display_name FROM contacts co JOIN conversations c ON c.contact_id=co.id JOIN conversation_tags ct ON ct.conversation_id=c.id WHERE co.account_id=$1 AND ct.tag_id=ANY($2::uuid[])`,[campaign.account_id,audience.tagIds??[]]);
  else rows=await client.query("SELECT id,provider_user_id,COALESCE(NULLIF(alias,''),display_name,phone_e164) display_name FROM contacts WHERE account_id=$1",[campaign.account_id]);
  const recipients=new Map<string,{contactId:string;name:string}>();
  for(const row of rows.rows){const jid=String(row.provider_user_id??"").toLowerCase();if(/^\d{7,15}@s\.whatsapp\.net$/.test(jid))recipients.set(jid,{contactId:String(row.id),name:String(row.display_name??"")});}
  if(!recipients.size)throw Object.assign(new Error("status_audience_empty"),{statusCode:409});
  if(recipients.size>config.STATUS_MAX_RECIPIENTS)throw Object.assign(new Error("status_audience_too_large"),{statusCode:409,count:recipients.size,max:config.STATUS_MAX_RECIPIENTS});
  await client.query("DELETE FROM status_campaign_recipients WHERE campaign_id=$1",[campaign.id]);
  for(const [jid,item] of recipients)await client.query("INSERT INTO status_campaign_recipients(campaign_id,contact_id,jid,display_name) VALUES($1,$2,$3,$4)",[campaign.id,item.contactId,jid,item.name]);
  return recipients.size;
}

export async function registerStatusRoutes(app:FastifyInstance):Promise<void>{
  app.post("/api/v1/status-campaigns/preview-schedule",{preHandler:authenticate},async(request,reply)=>{
    const parsed=z.object({...scheduleFields,postCount:z.coerce.number().int().min(0).max(5000).default(0)}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    try{const slots=generateStatusSlots(scheduleFrom(parsed.data));return{capacity:slots.length,overflow:Math.max(0,parsed.data.postCount-slots.length),slots:slots.slice(0,500).map(slot=>slot.toISOString())};}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:String(error)});}
  });
  app.get("/api/v1/status-campaigns",{preHandler:authenticate},async(request)=>{
    const query=request.query as {accountId?:string;status?:string;q?:string},accountIds=await readableAccounts(request.principal);
    const result=await pool.query(`SELECT c.*,a.display_name account_name,a.status account_status,a.transport,g.status agent_status,g.capabilities,
      (SELECT count(*)::int FROM status_campaign_recipients r WHERE r.campaign_id=c.id) recipient_count,
      (SELECT count(*)::int FROM status_posts p WHERE p.campaign_id=c.id) post_count,
      (SELECT count(*)::int FROM status_posts p WHERE p.campaign_id=c.id AND p.status='published') published_count
      FROM status_campaigns c JOIN channel_accounts a ON a.id=c.account_id LEFT JOIN agents g ON g.id=a.agent_id
      WHERE ($1::uuid[] IS NULL OR c.account_id=ANY($1)) AND ($2::uuid IS NULL OR c.account_id=$2) AND ($3::text IS NULL OR c.status=$3) AND ($4::text IS NULL OR c.name ILIKE '%'||$4||'%')
      ORDER BY c.created_at DESC`,[accountIds,query.accountId??null,query.status??null,query.q?.trim()||null]);
    return{data:result.rows};
  });
  app.post("/api/v1/status-campaigns",{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});
    const parsed=campaignCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    if(!await canRead(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
    try{validateSchedule(parsed.data);}catch(error){return reply.code(400).send({error:(error as Error).message});}
    const created=await transaction(async client=>{
      const account=await client.query("SELECT platform,transport FROM channel_accounts WHERE id=$1",[parsed.data.accountId]);if(!account.rowCount)throw Object.assign(new Error("account_not_found"),{statusCode:404});if(account.rows[0].platform!=="whatsapp"||account.rows[0].transport!=="web")throw Object.assign(new Error("status_web_account_required"),{statusCode:409});
      const existing=await client.query("SELECT * FROM status_campaigns WHERE client_campaign_id=$1",[parsed.data.clientCampaignId]);if(existing.rowCount)return existing.rows[0];
      const result=await client.query(`INSERT INTO status_campaigns(client_campaign_id,account_id,name,timezone,start_date,end_date,active_weekdays,daily_start,daily_end,interval_minutes,audience_filter,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[parsed.data.clientCampaignId,parsed.data.accountId,parsed.data.name,parsed.data.timezone,parsed.data.startDate,parsed.data.endDate,parsed.data.activeWeekdays,parsed.data.dailyStart,parsed.data.dailyEnd,parsed.data.intervalMinutes,JSON.stringify(parsed.data.audience),request.principal!.id]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'status.campaign.create','status_campaign',$2,'{}')",[request.principal!.id,result.rows[0].id]);
      return result.rows[0];
    });return reply.code(201).send(created);
  });
  app.get("/api/v1/status-campaigns/:id",{preHandler:authenticate},async(request,reply)=>{
    const {id}=request.params as {id:string},campaign=await campaignAccess(request,reply,id);if(!campaign)return;
    const [posts,recipients]=await Promise.all([pool.query("SELECT p.*,m.file_name,m.mime_type,m.byte_size FROM status_posts p LEFT JOIN media m ON m.id=p.media_id WHERE p.campaign_id=$1 ORDER BY p.position",[id]),pool.query("SELECT contact_id,jid,display_name FROM status_campaign_recipients WHERE campaign_id=$1 ORDER BY display_name,jid",[id])]);
    return{...campaign,posts:posts.rows,recipients:recipients.rows};
  });
  app.patch("/api/v1/status-campaigns/:id",{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});
    const patch=campaignPatchSchema.safeParse(request.body);if(!patch.success)return reply.code(400).send({error:"invalid_request",details:patch.error.flatten()});
    const {id}=request.params as {id:string},current=await campaignAccess(request,reply,id);if(!current)return;if(!["draft","paused"].includes(String(current.status)))return reply.code(409).send({error:"campaign_not_editable"});
    const merged={...current,...patch.data};try{validateSchedule(merged);}catch(error){return reply.code(400).send({error:(error as Error).message});}
    const data=patch.data,result=await pool.query(`UPDATE status_campaigns SET name=COALESCE($2,name),timezone=COALESCE($3,timezone),start_date=COALESCE($4,start_date),end_date=COALESCE($5,end_date),active_weekdays=COALESCE($6,active_weekdays),daily_start=COALESCE($7,daily_start),daily_end=COALESCE($8,daily_end),interval_minutes=COALESCE($9,interval_minutes),audience_filter=COALESCE($10,audience_filter),updated_at=now() WHERE id=$1 RETURNING *`,[id,data.name??null,data.timezone??null,data.startDate??null,data.endDate??null,data.activeWeekdays??null,data.dailyStart??null,data.dailyEnd??null,data.intervalMinutes??null,data.audience?JSON.stringify(data.audience):null]);
    return result.rows[0];
  });
  app.delete("/api/v1/status-campaigns/:id",{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},campaign=await campaignAccess(request,reply,id);if(!campaign)return;
    await transaction(async client=>{await client.query("DELETE FROM status_campaigns WHERE id=$1",[id]);});return reply.code(204).send();
  });
  app.post("/api/v1/status-campaigns/:id/posts",{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const parsed=postsCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {id}=request.params as {id:string},campaign=await campaignAccess(request,reply,id);if(!campaign)return;if(!["draft","paused","active"].includes(String(campaign.status)))return reply.code(409).send({error:"campaign_not_editable"});
    const created=await transaction(async client=>{let position=Number((await client.query("SELECT COALESCE(max(position),-1)+1 next FROM status_posts WHERE campaign_id=$1",[id])).rows[0].next);const rows=[];for(const item of parsed.data.items){await validateMedia(client,String(campaign.account_id),item);const found=await client.query("SELECT * FROM status_posts WHERE campaign_id=$1 AND client_post_id=$2",[id,item.clientPostId]);if(found.rowCount){rows.push(found.rows[0]);continue;}const saved=await client.query(`INSERT INTO status_posts(client_post_id,campaign_id,account_id,position,content_type,text_content,translation_source_text,translation_target_language,media_id,background_color,font) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[item.clientPostId,id,campaign.account_id,position++,item.type,item.text??null,item.translationSourceText??null,item.translationTargetLanguage??null,item.mediaId??null,item.backgroundColor??null,item.font??null]);rows.push(saved.rows[0]);}if(campaign.status==="active")await rescheduleStatusCampaign(client,id,new Date());return rows;});return reply.code(201).send({data:created});
  });
  app.patch("/api/v1/status-campaigns/:id/posts/order",{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const parsed=orderSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request"});const {id}=request.params as {id:string},campaign=await campaignAccess(request,reply,id);if(!campaign)return;
    await transaction(async client=>{const mutable=await client.query("SELECT id FROM status_posts WHERE campaign_id=$1 AND status IN ('queued','scheduled') ORDER BY position FOR UPDATE",[id]);if(mutable.rowCount!==parsed.data.postIds.length||new Set(parsed.data.postIds).size!==parsed.data.postIds.length||mutable.rows.some(row=>!parsed.data.postIds.includes(String(row.id))))throw Object.assign(new Error("invalid_post_order"),{statusCode:409});for(const [index,postId] of parsed.data.postIds.entries())await client.query("UPDATE status_posts SET position=$3+100000,updated_at=now() WHERE id=$1 AND campaign_id=$2",[postId,id,index]);await client.query("UPDATE status_posts SET position=position-100000 WHERE campaign_id=$1 AND position>=100000",[id]);if(campaign.status==="active")await rescheduleStatusCampaign(client,id,new Date());});return reply.code(204).send();
  });
  for(const action of ["activate","resume"] as const)app.post(`/api/v1/status-campaigns/:id/${action}`,{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},campaign=await campaignAccess(request,reply,id);if(!campaign)return;if(campaign.transport!=="web")return reply.code(409).send({error:"status_web_account_required"});if(!Array.isArray(campaign.capabilities)||!campaign.capabilities.includes("publish_status_v1"))return reply.code(409).send({error:"agent_upgrade_required"});
    try{const result=await transaction(async client=>{const locked=(await client.query("SELECT * FROM status_campaigns WHERE id=$1 FOR UPDATE",[id])).rows[0];if(action==="activate")await snapshotAudience(client,locked);const count=Number((await client.query("SELECT count(*) count FROM status_posts WHERE campaign_id=$1 AND status IN ('queued','scheduled')",[id])).rows[0].count);if(!count)throw Object.assign(new Error("status_campaign_empty"),{statusCode:409});const slots=generateStatusSlots(scheduleFrom(locked),new Date());if(count>slots.length)throw Object.assign(new Error("schedule_capacity_exceeded"),{statusCode:409,capacity:slots.length,overflow:count-slots.length});await client.query("UPDATE status_campaigns SET status='active',activated_at=COALESCE(activated_at,now()),completed_at=NULL,updated_at=now() WHERE id=$1",[id]);const scheduled=await rescheduleStatusCampaign(client,id,new Date());return{...scheduled,recipientCount:Number((await client.query("SELECT count(*) count FROM status_campaign_recipients WHERE campaign_id=$1",[id])).rows[0].count)};});return result;}catch(error){const value=error as Error&{statusCode?:number;capacity?:number;overflow?:number};return reply.code(value.statusCode??500).send({error:value.message,capacity:value.capacity,overflow:value.overflow});}
  });
  app.post("/api/v1/status-campaigns/:id/pause",{preHandler:authenticate},async(request,reply)=>{if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},campaign=await campaignAccess(request,reply,id);if(!campaign)return;await pool.query("UPDATE status_campaigns SET status='paused',updated_at=now() WHERE id=$1 AND status='active'",[id]);return reply.code(204).send();});
  app.get("/api/v1/status-posts",{preHandler:authenticate},async(request)=>{
    const query=request.query as {accountId?:string;campaignId?:string;status?:string;from?:string;to?:string;q?:string},ids=await readableAccounts(request.principal);
    const result=await pool.query(`SELECT p.*,c.name campaign_name,c.timezone,c.start_date,c.end_date,c.daily_start,c.daily_end,c.status campaign_status,a.display_name account_name,m.file_name,m.mime_type,m.byte_size,
      (SELECT count(*)::int FROM status_campaign_recipients r WHERE r.campaign_id=c.id) recipient_count
      FROM status_posts p JOIN status_campaigns c ON c.id=p.campaign_id JOIN channel_accounts a ON a.id=p.account_id LEFT JOIN media m ON m.id=p.media_id
      WHERE ($1::uuid[] IS NULL OR p.account_id=ANY($1)) AND ($2::uuid IS NULL OR p.account_id=$2) AND ($3::uuid IS NULL OR p.campaign_id=$3) AND ($4::text IS NULL OR p.status=$4)
      AND ($5::timestamptz IS NULL OR p.scheduled_at>=$5) AND ($6::timestamptz IS NULL OR p.scheduled_at<=$6) AND ($7::text IS NULL OR c.name ILIKE '%'||$7||'%' OR p.text_content ILIKE '%'||$7||'%')
      ORDER BY COALESCE(p.scheduled_at,p.created_at),p.position`,[ids,query.accountId??null,query.campaignId??null,query.status??null,query.from??null,query.to??null,query.q?.trim()||null]);
    return{data:result.rows};
  });
  app.patch("/api/v1/status-posts/:id",{preHandler:authenticate},async(request,reply)=>{
    if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const parsed=postItemObject.partial().refine(value=>Object.keys(value).length>0).safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request"});const {id}=request.params as {id:string},found=await pool.query("SELECT p.*,c.status campaign_status FROM status_posts p JOIN status_campaigns c ON c.id=p.campaign_id WHERE p.id=$1",[id]);if(!found.rowCount||!await canRead(request.principal,String(found.rows[0].account_id)))return reply.code(404).send({error:"not_found"});if(!["queued","scheduled","failed","expired"].includes(String(found.rows[0].status)))return reply.code(409).send({error:"status_post_immutable"});const merged={clientPostId:String(found.rows[0].client_post_id),type:parsed.data.type??found.rows[0].content_type,text:parsed.data.text??found.rows[0].text_content,translationSourceText:parsed.data.translationSourceText??found.rows[0].translation_source_text,translationTargetLanguage:parsed.data.translationTargetLanguage??found.rows[0].translation_target_language,mediaId:parsed.data.mediaId??found.rows[0].media_id,backgroundColor:parsed.data.backgroundColor??found.rows[0].background_color,font:parsed.data.font??found.rows[0].font},valid=postItemSchema.safeParse(merged);if(!valid.success)return reply.code(400).send({error:"invalid_request",details:valid.error.flatten()});await transaction(async client=>{await validateMedia(client,String(found.rows[0].account_id),valid.data);await client.query("UPDATE status_posts SET content_type=$2,text_content=$3,translation_source_text=$4,translation_target_language=$5,media_id=$6,background_color=$7,font=$8,updated_at=now() WHERE id=$1",[id,valid.data.type,valid.data.text??null,valid.data.translationSourceText??null,valid.data.translationTargetLanguage??null,valid.data.mediaId??null,valid.data.backgroundColor??null,valid.data.font??null]);});return reply.code(204).send();
  });
  app.delete("/api/v1/status-posts/:id",{preHandler:authenticate},async(request,reply)=>{if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},found=await pool.query("SELECT account_id,campaign_id,status FROM status_posts WHERE id=$1",[id]);if(!found.rowCount||!await canRead(request.principal,String(found.rows[0].account_id)))return reply.code(404).send({error:"not_found"});if(["published","dispatching","uncertain"].includes(String(found.rows[0].status)))return reply.code(409).send({error:"status_post_immutable"});await pool.query("UPDATE status_posts SET status='cancelled',updated_at=now() WHERE id=$1",[id]);return reply.code(204).send();});
  for(const action of ["publish-now","retry"] as const)app.post(`/api/v1/status-posts/:id/${action}`,{preHandler:authenticate},async(request,reply)=>{if(!canManage(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},found=await pool.query("SELECT p.*,c.status campaign_status FROM status_posts p JOIN status_campaigns c ON c.id=p.campaign_id WHERE p.id=$1",[id]);if(!found.rowCount||!await canRead(request.principal,String(found.rows[0].account_id)))return reply.code(404).send({error:"not_found"});if(action==="retry"&&!["failed","uncertain","expired"].includes(String(found.rows[0].status)))return reply.code(409).send({error:"status_post_not_retryable"});if(!["active","paused","completed"].includes(String(found.rows[0].campaign_status)))return reply.code(409).send({error:"campaign_not_activated"});await transaction(async client=>{await client.query("UPDATE status_campaigns SET status='active',completed_at=NULL,updated_at=now() WHERE id=$1",[found.rows[0].campaign_id]);await client.query("UPDATE status_posts SET status='scheduled',scheduled_at=now(),last_error=NULL,updated_at=now() WHERE id=$1",[id]);});return reply.code(202).send({status:"scheduled"});});
}
