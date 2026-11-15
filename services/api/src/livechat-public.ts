import {createHash,randomUUID} from "node:crypto";
import type {FastifyInstance,FastifyRequest} from "fastify";
import type {PoolClient} from "pg";
import {GetObjectCommand,PutObjectCommand,S3Client} from "@aws-sdk/client-s3";
import {z} from "zod";
import {pool,transaction} from "./db.js";
import {config} from "./config.js";
import {enqueueInboundAgentWork} from "./agent-engine.js";
import {createWebhookEvent} from "./agent-hub.js";
import {livechatLoader,livechatWidget} from "./livechat-widget.js";
import {isValidTimeZone} from "./order-number.js";
import {emailShell,escapeHtml} from "./email.js";

const s3=new S3Client({region:config.S3_REGION,endpoint:config.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});
const uuid=z.string().uuid();
const messageSchema=z.object({
  clientMessageId:uuid,text:z.string().trim().max(10000).default(""),mediaId:uuid.optional(),
  name:z.string().trim().max(80).optional(),email:z.string().trim().email().max(254).optional(),
  company:z.string().trim().max(160).optional(),whatsapp:z.string().trim().max(80).optional(),
  context:z.object({browserLanguage:z.string().trim().max(80).optional(),timeZone:z.string().max(100).refine(isValidTimeZone).optional(),pageUrl:z.string().url().max(2048).optional()}).optional(),
}).refine(v=>Boolean(v.text||v.mediaId));
const endChatSchema=z.object({clientRequestId:uuid});
const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
export const credentialHash=(value:string)=>createHash("sha256").update(value).digest("hex");
export function livechatCredential(header:unknown):string{
  if(typeof header!=="string"||!/^Bearer [a-f0-9]{64}$/.test(header))throw fail(401,"invalid_visitor_credential");
  return credentialHash(header.slice(7));
}
export function livechatOrigin(origin:unknown,allowed:string[]):string{
  if(typeof origin!=="string"||!allowed.includes(origin))throw fail(403,"livechat_origin_denied");
  return origin;
}
function embedOrigin(request:FastifyRequest):string|undefined{
  if(request.headers.origin)return request.headers.origin;
  // 同源 GET 不发送 Origin，仅接受浏览器同源请求的 Referer。
  if(request.headers["sec-fetch-site"]==="same-origin"&&request.headers.referer){
    try{return new URL(request.headers.referer).origin;}catch{}
  }
  return undefined;
}
export function allowedLivechatFile(mime:string,buffer:Buffer):boolean{
  if(mime==="image/png")return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==="image/jpeg")return buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
  if(mime==="image/webp")return buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WEBP";
  if(mime==="application/pdf")return buffer.toString("ascii",0,5)==="%PDF-";
  return mime==="text/plain"&&!buffer.includes(0);
}
async function rate(bucket:string,limit:number,seconds=60){
    const result=await pool.query(`INSERT INTO livechat_rate_limits(bucket,window_start,hits) VALUES($1,to_timestamp(floor(extract(epoch from now())/$2)*$2),1)
    ON CONFLICT(bucket,window_start) DO UPDATE SET hits=livechat_rate_limits.hits+1 RETURNING hits`,[bucket,seconds]);
  if(Number(result.rows[0].hits)>limit)throw fail(429,"livechat_rate_limited");
}
async function channel(request:FastifyRequest){
  const {publicId}=request.params as {publicId:string};
  if(!uuid.safeParse(publicId).success)throw fail(404,"livechat_unavailable");
  await rate(`ip:${credentialHash(request.ip)}:${publicId}`,600);
  const found=await pool.query(`SELECT c.*,a.display_name FROM livechat_channels c JOIN channel_accounts a ON a.id=c.account_id WHERE public_id=$1 AND enabled AND archived_at IS NULL`,[publicId]);
  if(!found.rowCount)throw fail(404,"livechat_unavailable");
  const row=found.rows[0];
  livechatOrigin(embedOrigin(request),row.allowed_origins);
  return row;
}
async function visitor(request:FastifyRequest,c:{account_id:string},client:PoolClient|typeof pool=pool){
  const hash=livechatCredential(request.headers.authorization);
  const found=await client.query(`SELECT * FROM livechat_visitors WHERE account_id=$1 AND credential_hash=$2 AND embed_origin=$3 AND expires_at>now()`,[c.account_id,hash,embedOrigin(request)]);
  if(!found.rowCount)throw fail(401,"visitor_not_found_or_expired");
  await rate(`visitor:${hash}`,120);
  return found.rows[0];
}
export async function livechatCorsOrigin(url:string,origin:string|undefined):Promise<boolean>{
  if(!origin)return false;
  const match=/^\/livechat\/([a-f0-9-]{36})\//i.exec(url);
  if(!match||!uuid.safeParse(match[1]).success)return false;
  const result=await pool.query("SELECT 1 FROM livechat_channels WHERE public_id=$1 AND enabled AND archived_at IS NULL AND $2=ANY(allowed_origins)",[match[1],origin]);
  return Boolean(result.rowCount);
}
export async function registerLivechatPublicRoutes(app:FastifyInstance){
  app.get("/livechat/embed.js",async(_request,reply)=>reply.header("cache-control","public,max-age=300").type("application/javascript; charset=utf-8").send(livechatLoader));
  app.get("/livechat/:publicId/widget",async(request,reply)=>{
    const {publicId}=request.params as {publicId:string};
    if(!uuid.safeParse(publicId).success)return reply.code(404).send();
    const found=await pool.query("SELECT allowed_origins FROM livechat_channels WHERE public_id=$1 AND enabled AND archived_at IS NULL",[publicId]);
    if(!found.rowCount)return reply.code(404).send();
    // 白名单只允许规范化的 origin，不能注入 CSP 指令。
    return reply.header("content-security-policy",`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: https:; frame-ancestors ${found.rows[0].allowed_origins.join(" ")}; base-uri 'none'; form-action 'none'`).header("cache-control","no-store").header("referrer-policy","no-referrer").type("text/html; charset=utf-8").send(livechatWidget);
  });
  app.get("/livechat/:publicId/config",async(request,reply)=>{
    const c=await channel(request);reply.header("cache-control","no-store");
    return {name:c.display_name,iconUrl:c.icon_url??"",welcome:c.welcome_message,color:c.theme_color,position:c.position,language:c.language??"en"};
  });
  app.post("/livechat/:publicId/messages",async(request,reply)=>{
    const c=await channel(request),hash=livechatCredential(request.headers.authorization),parsed=messageSchema.safeParse(request.body);
    if(!parsed.success)throw fail(400,"invalid_message");
    await rate(`send:${c.account_id}:${hash}`,30);
    await rate(`new:${credentialHash(request.ip)}:${c.account_id}`,120);
    const data=parsed.data;
    const result=await transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[hash]);
      // 锁住渠道，防止归档或停用与首条入站消息并发。
      const active=await client.query("SELECT 1 FROM livechat_channels WHERE account_id=$1 AND enabled AND archived_at IS NULL FOR SHARE",[c.account_id]);
      if(!active.rowCount)throw fail(404,"livechat_unavailable");
      let v=(await client.query("SELECT * FROM livechat_visitors WHERE credential_hash=$1",[hash])).rows[0];
      if(v&&(v.account_id!==c.account_id||v.embed_origin!==embedOrigin(request)||new Date(v.expires_at).getTime()<=Date.now()))throw fail(401,"invalid_visitor_credential");
      if(!v){
        if(data.mediaId)throw fail(400,"first_message_must_be_text");
        if(!data.name||!data.email||!data.text)throw fail(400,"prechat_details_required");
        const contact=await client.query("INSERT INTO contacts(account_id,provider_user_id,display_name,company_name,last_seen_at) VALUES($1,$2,$3,$4,now()) RETURNING id",[c.account_id,`livechat:${randomUUID()}`,data.name,data.company||null]);
        v=(await client.query("INSERT INTO livechat_visitors(account_id,contact_id,credential_hash,embed_origin,first_ip,last_ip) VALUES($1,$2,$3,$4,$5,$5) RETURNING *",[c.account_id,contact.rows[0].id,hash,embedOrigin(request),request.ip])).rows[0];
        await client.query("INSERT INTO contact_emails(contact_id,email,label,is_primary) VALUES($1,$2,'LiveChat',true)",[v.contact_id,data.email]);
        if(data.whatsapp)await client.query("INSERT INTO contact_methods(contact_id,type,label,value) VALUES($1,'phone','WhatsApp',$2)",[v.contact_id,data.whatsapp]);
      }
      const duplicate=await client.query("SELECT id,sender_contact_id,text_content,media_id,direction FROM messages WHERE account_id=$1 AND client_message_id=$2",[c.account_id,data.clientMessageId]);
      if(duplicate.rowCount){
        const old=duplicate.rows[0];
        if(old.direction!=="in"||old.sender_contact_id!==v.contact_id||(old.text_content??"")!==data.text||(old.media_id??null)!==(data.mediaId??null))throw fail(409,"client_message_id_conflict");
        return {id:old.id};
      }
      let kind="text";
      if(data.mediaId){
        const media=await client.query("SELECT mime_type FROM media WHERE id=$1 AND account_id=$2 AND object_key LIKE $3 AND status='ready' FOR SHARE",[data.mediaId,c.account_id,`livechat/${v.id}/%`]);
        if(!media.rowCount)throw fail(403,"invalid_attachment");
        kind=String(media.rows[0].mime_type).startsWith("image/")?"image":"document";
      }
      const conv=await client.query(`INSERT INTO conversations(account_id,contact_id,unread_count) VALUES($1,$2,1) ON CONFLICT(account_id,contact_id) DO UPDATE SET unread_count=conversations.unread_count+1,status='open',closed_at=NULL RETURNING id`,[c.account_id,v.contact_id]);
      const msg=await client.query(`INSERT INTO messages(conversation_id,account_id,sender_contact_id,provider_message_id,client_message_id,direction,kind,text_content,media_id,status,occurred_at)
        VALUES($1,$2,$3,$4,$4,'in',$5,$6,$7,'received',now()) RETURNING id`,[conv.rows[0].id,c.account_id,v.contact_id,data.clientMessageId,kind,data.text||null,data.mediaId??null]);
      if(data.mediaId)await client.query("UPDATE media SET delete_after=NULL WHERE id=$1",[data.mediaId]);
      // 页面地址只保留同源路径，避免查询参数、片段或 URL 账号泄露。
      const context:Record<string,string>={userAgent:(request.headers["user-agent"]||"").slice(0,512)};
      if(data.context?.browserLanguage)context.browserLanguage=data.context.browserLanguage;
      if(data.context?.timeZone)context.timeZone=data.context.timeZone;
      if(data.context?.pageUrl){const url=new URL(data.context.pageUrl);if(url.origin===embedOrigin(request))context.pageUrl=url.origin+url.pathname;}
      await client.query("UPDATE livechat_visitors SET last_seen_at=now(),first_ip=COALESCE(first_ip,$2),last_ip=$2,visitor_context=visitor_context||$3::jsonb WHERE id=$1",[v.id,request.ip,JSON.stringify(context)]);
      await createWebhookEvent(client,"message.received",msg.rows[0].id,{platform:"livechat",accountId:c.account_id,conversationId:conv.rows[0].id,direction:"in",kind,text:data.text});
      await enqueueInboundAgentWork(client,conv.rows[0].id,msg.rows[0].id,Boolean(data.text));
      return {id:msg.rows[0].id};
    });
    return reply.code(201).send(result);
  });
  app.post("/livechat/:publicId/end-chat",async(request,reply)=>{
    const c=await channel(request),v=await visitor(request,c),parsed=endChatSchema.safeParse(request.body);
    if(!parsed.success)throw fail(400,"invalid_request");
    await rate(`end:${v.id}`,10);
    const result=await transaction(async client=>{
      // 与消息发送共用访客锁，保证记录快照与结束操作按顺序执行。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`transcript:${parsed.data.clientRequestId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[livechatCredential(request.headers.authorization)]);
      const active=await client.query("SELECT 1 FROM livechat_channels WHERE account_id=$1 AND enabled AND archived_at IS NULL FOR SHARE",[c.account_id]);
      if(!active.rowCount)throw fail(404,"livechat_unavailable");
      const existing=await client.query("SELECT e.id,e.status,e.contact_id,cv.account_id,e.content_type FROM email_messages e JOIN conversations cv ON cv.id=e.conversation_id WHERE e.client_send_id=$1",[parsed.data.clientRequestId]);
      if(existing.rowCount){
        const old=existing.rows[0];
        if(old.account_id!==c.account_id||old.contact_id!==v.contact_id||old.content_type!=="livechat_transcript")throw fail(409,"client_request_id_conflict");
        return {emailId:old.id,status:old.status,deduplicated:true};
      }
      const context=await client.query(`SELECT cv.id conversation_id,cv.status,cv.account_id,cv.contact_id,
        (SELECT email FROM contact_emails WHERE contact_id=cv.contact_id AND is_primary LIMIT 1) recipient_email
        FROM conversations cv WHERE cv.account_id=$1 AND cv.contact_id=$2 FOR UPDATE`,[c.account_id,v.contact_id]);
      if(!context.rowCount)throw fail(404,"conversation_not_found");
      const row=context.rows[0],recipient=String(row.recipient_email??"").trim();
      if(!recipient)throw fail(409,"visitor_email_required");
      const provider=await client.query("SELECT provider,config,secret_encrypted FROM email_provider_settings WHERE enabled AND secret_encrypted IS NOT NULL LIMIT 1");
      if(!provider.rowCount)throw fail(409,"email_provider_not_configured");
      const messages=await client.query(`SELECT m.direction,m.kind,m.text_content,m.occurred_at,media.file_name
        FROM messages m LEFT JOIN media ON media.id=m.media_id WHERE m.conversation_id=$1
        AND NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id)
        AND (m.direction='in' OR m.status IN ('sent','delivered','read')) ORDER BY m.occurred_at,m.id`,[row.conversation_id]);
      const lines=messages.rows.map(item=>`[${new Date(item.occurred_at).toISOString()}] ${item.direction==='in'?'Visitor':'Support'}: ${[item.text_content,item.file_name?`[Attachment: ${item.file_name}]`:null].filter(Boolean).join("\n")||'[Message]'}`).join("\n\n");
      const text=`LiveChat transcript\n\n${lines}`;
      const job=await client.query(`INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type)
        VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,'',$9,$10,'livechat_transcript') RETURNING id,status`,[parsed.data.clientRequestId,row.conversation_id,row.contact_id,provider.rows[0].provider,JSON.stringify(provider.rows[0].config),provider.rows[0].secret_encrypted,JSON.stringify([{email:recipient,label:"LiveChat visitor"}]),"Your LiveChat transcript",text,emailShell("",`<h2>LiveChat transcript</h2><p>${escapeHtml(lines)}</p>`)]);
      const bubble=await client.query(`INSERT INTO messages(conversation_id,account_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,'out','text',$4,'queued',now()) RETURNING id`,[row.conversation_id,row.account_id,`email:${job.rows[0].id}`,text]);
      await client.query("INSERT INTO message_email_details(message_id,subject,from_email,to_emails,rfc_message_id,email_job_id) VALUES($1,$2,$3,$4,$5,$6)",[bubble.rows[0].id,"Your LiveChat transcript",provider.rows[0].config.fromEmail,JSON.stringify([recipient]),`<email-${job.rows[0].id}@relaydesk.local>`,job.rows[0].id]);
      await client.query("UPDATE conversations SET status='closed',closed_at=now() WHERE id=$1",[row.conversation_id]);
      await client.query("INSERT INTO audit_log(actor_type,action,target_type,target_id,metadata) VALUES('visitor','livechat.end_chat','conversation',$1,$2)",[row.conversation_id,JSON.stringify({emailId:job.rows[0].id,recipient})]);
      return {emailId:job.rows[0].id,status:job.rows[0].status};
    });
    return reply.code(202).send({ok:true,queued:true,closed:true,...result});
  });
  app.get("/livechat/:publicId/messages",async(request,reply)=>{
    const c=await channel(request),v=await visitor(request,c);
    const query=z.object({before:uuid.optional(),after:uuid.optional()}).refine(v=>!(v.before&&v.after)).safeParse(request.query);
    if(!query.success)throw fail(400,"invalid_cursor");
    // 出站消息按实际送入访客队列的时间排序，避免长时间排队的旧消息被增量游标漏掉。
    const after=Boolean(query.data.after);
    const result=await pool.query(`WITH visible AS (
      SELECT m.id,m.client_message_id,m.direction,m.kind,m.text_content,m.media_id,m.status,m.created_at,media.file_name,media.mime_type,
        COALESCE(receipt.occurred_at,m.created_at) visible_at
      FROM messages m LEFT JOIN media ON media.id=m.media_id JOIN conversations cv ON cv.id=m.conversation_id
      LEFT JOIN message_receipts receipt ON receipt.message_id=m.id AND receipt.status='sent'
      WHERE cv.account_id=$1 AND cv.contact_id=$2 AND NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id) AND (m.direction='in' OR m.status IN ('sent','delivered','read'))
    ) SELECT *,to_char(visible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') sort_at
      FROM visible WHERE ($3::uuid IS NULL OR (visible_at,id) ${after?">":"<"} (SELECT visible_at,id FROM visible WHERE id=$3))
      ORDER BY visible_at ${after?"ASC":"DESC"},id ${after?"ASC":"DESC"} LIMIT 101`,[c.account_id,v.contact_id,query.data.after??query.data.before??null]);
    const data=result.rows.slice(0,100);
    reply.header("cache-control","no-store");return {data:after?data:data.reverse(),hasMore:result.rows.length>100};
  });
  app.post("/livechat/:publicId/media",async(request,reply)=>{
    const c=await channel(request),v=await visitor(request,c);
    await rate(`upload:${v.id}`,10);await rate(`upload-day:${v.id}`,100,86400);
    const file=await request.file({limits:{fileSize:10*1024*1024,files:1}});
    if(!file)throw fail(400,"file_required");
    const buffer=await file.toBuffer();if(file.file.truncated)throw fail(413,"file_too_large");
    if(!buffer.length||!allowedLivechatFile(file.mimetype,buffer))throw fail(415,"unsupported_attachment_type");
    const id=randomUUID(),key=`livechat/${v.id}/${id}`;
    await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:key,Body:buffer,ContentType:file.mimetype}));
    await pool.query(`INSERT INTO media(id,account_id,object_key,file_name,mime_type,byte_size,sha256,delete_after) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 day')`,[id,c.account_id,key,file.filename.replace(/[\x00-\x1f/\\]/g,"_").slice(0,200),file.mimetype,buffer.length,createHash("sha256").update(buffer).digest("hex")]);
    return reply.code(201).send({id});
  });
  app.get("/livechat/:publicId/media/:mediaId",async(request,reply)=>{
    const c=await channel(request),v=await visitor(request,c),{mediaId}=request.params as {mediaId:string};
    if(!uuid.safeParse(mediaId).success)throw fail(404,"attachment_not_found");
    const result=await pool.query(`SELECT md.* FROM media md WHERE md.id=$1 AND EXISTS(SELECT 1 FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE m.media_id=md.id AND cv.account_id=$2 AND cv.contact_id=$3 AND (m.direction='in' OR m.status IN ('sent','delivered','read')))`,[mediaId,c.account_id,v.contact_id]);
    if(!result.rowCount)throw fail(404,"attachment_not_found");
    const md=result.rows[0],object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:md.object_key}));
    return reply.header("cache-control","private,no-store").header("x-content-type-options","nosniff").header("content-disposition",`attachment; filename*=UTF-8''${encodeURIComponent(md.file_name||"attachment")}`).type(md.mime_type).send(object.Body);
  });
}
