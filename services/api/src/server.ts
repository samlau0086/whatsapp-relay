import { randomBytes, createHash } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { authenticate, canAccessAccount } from "./auth.js";
import { enrollmentSchema, loginSchema, messageSchema } from "./schemas.js";
import { encryptAtRest, hashPassword, hashSecret, signToken, verifyPassword } from "./security.js";
import { registerAgentHub, dispatchPending } from "./agent-hub.js";

const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact:["req.headers.authorization","password"] }, bodyLimit: 2_000_000 });
const s3 = new S3Client({ region:config.S3_REGION, endpoint:config.S3_ENDPOINT, forcePathStyle:true, credentials:{ accessKeyId:config.S3_ACCESS_KEY, secretAccessKey:config.S3_SECRET_KEY } });

await app.register(cors, { origin:config.CORS_ORIGIN, credentials:true });
await app.register(multipart, { limits:{ fileSize:64 * 1024 * 1024, files:1 } });
await app.register(websocket, { options:{ maxPayload:2_000_000 } });

app.get("/health", async () => { await pool.query("SELECT 1"); return { status:"ok", version:"0.1.0", time:new Date().toISOString() }; });
app.get("/api/v1/openapi.json", async () => ({ openapi:"3.1.0", info:{title:"RelayDesk API",version:"0.1.0"}, paths:{ "/api/v1/messages":{post:{summary:"发送单条消息",responses:{"202":{description:"已进入持久队列"}}}}, "/api/v1/conversations":{get:{summary:"分页查询会话"}}, "/api/v1/media":{post:{summary:"上传媒体"}} } }));

app.post("/api/v1/auth/login", async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error:"invalid_request", details:parsed.error.flatten() });
  const user = await pool.query("SELECT id,email,display_name,password_hash,role FROM users WHERE lower(email)=lower($1) AND disabled_at IS NULL", [parsed.data.email]);
  if (!user.rowCount || !verifyPassword(parsed.data.password,user.rows[0].password_hash)) return reply.code(401).send({ error:"invalid_credentials" });
  const token = signToken({ sub:user.rows[0].id, role:user.rows[0].role, email:user.rows[0].email }, config.JWT_SECRET);
  const refreshToken=`rdr_${randomBytes(48).toString("base64url")}`;await pool.query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')",[user.rows[0].id,hashSecret(refreshToken)]);
  reply.header("set-cookie",`relay_refresh=${refreshToken}; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000${config.NODE_ENV==="production"?"; Secure":""}`);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,ip) VALUES('user',$1,'auth.login','user',$1,$2)", [user.rows[0].id,request.ip]);
  return { accessToken:token, expiresIn:900, user:{ id:user.rows[0].id, email:user.rows[0].email, displayName:user.rows[0].display_name, role:user.rows[0].role } };
});

app.post("/api/v1/auth/refresh",async(request,reply)=>{const raw=request.headers.cookie?.split(";").map(value=>value.trim()).find(value=>value.startsWith("relay_refresh="))?.slice(14);if(!raw)return reply.code(401).send({error:"refresh_required"});const found=await pool.query("SELECT r.id,r.user_id,u.email,u.role FROM refresh_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=$1 AND r.revoked_at IS NULL AND r.expires_at>now() AND u.disabled_at IS NULL",[hashSecret(raw)]);if(!found.rowCount)return reply.code(401).send({error:"invalid_refresh"});const replacement=`rdr_${randomBytes(48).toString("base64url")}`;await transaction(async(client)=>{const next=await client.query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days') RETURNING id",[found.rows[0].user_id,hashSecret(replacement)]);await client.query("UPDATE refresh_tokens SET revoked_at=now(),replaced_by=$2 WHERE id=$1",[found.rows[0].id,next.rows[0].id]);});reply.header("set-cookie",`relay_refresh=${replacement}; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=2592000${config.NODE_ENV==="production"?"; Secure":""}`);return {accessToken:signToken({sub:found.rows[0].user_id,role:found.rows[0].role,email:found.rows[0].email},config.JWT_SECRET),expiresIn:900};});

app.post("/api/v1/auth/logout",async(request,reply)=>{const raw=request.headers.cookie?.split(";").map(value=>value.trim()).find(value=>value.startsWith("relay_refresh="))?.slice(14);if(raw)await pool.query("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1",[hashSecret(raw)]);reply.header("set-cookie","relay_refresh=; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=0");return reply.code(204).send();});

app.post("/api/v1/agents/enroll", async (request, reply) => {
  const parsed = enrollmentSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error:"invalid_request" });
  const codeHash = hashSecret(parsed.data.code);
  const credential = `rda_${randomBytes(32).toString("base64url")}`;
  const result = await pool.query("UPDATE agents SET credential_hash=$2,enrollment_code_hash=NULL,enrollment_expires_at=NULL,name=$3,version=$4,platform=$5,status='offline' WHERE enrollment_code_hash=$1 AND enrollment_expires_at>now() AND status='pending' RETURNING id", [codeHash,hashSecret(credential),parsed.data.name,parsed.data.version,parsed.data.platform]);
  if (!result.rowCount) return reply.code(401).send({ error:"invalid_or_expired_enrollment" });
  return { agentId:result.rows[0].id, credential, protocolVersion:1, websocketUrl:"/agent/ws" };
});

app.post("/api/v1/agents/enrollment", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const body=request.body as {name?:string};const code=`rde_${randomBytes(24).toString("base64url")}`;
  const agent=await pool.query("INSERT INTO agents(name,enrollment_code_hash,enrollment_expires_at) VALUES($1,$2,now()+interval '15 minutes') RETURNING id,enrollment_expires_at",[body.name?.trim()||"Windows Agent",hashSecret(code)]);
  return reply.code(201).send({agentId:agent.rows[0].id,enrollmentCode:code,expiresAt:agent.rows[0].enrollment_expires_at});
});

app.post("/api/v1/api-keys", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const body=request.body as {name?:string;scopes?:string[];accountIds?:string[]};const secret=`rdk_${randomBytes(32).toString("base64url")}`;
  const created=await pool.query("INSERT INTO api_keys(name,key_prefix,secret_hash,scopes,account_ids) VALUES($1,$2,$3,$4,$5) RETURNING id,name,scopes,account_ids,created_at",[body.name?.trim()||"External system",secret.slice(0,12),hashSecret(secret),body.scopes??["messages:read","messages:send"],body.accountIds??null]);
  return reply.code(201).send({...created.rows[0],secret});
});

app.post("/api/v1/webhooks", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const body=request.body as {name?:string;url?:string;eventTypes?:string[]};if(!body.url||!/^https?:\/\//.test(body.url))return reply.code(400).send({error:"invalid_url"});const secret=`rdw_${randomBytes(32).toString("base64url")}`;
  const created=await pool.query("INSERT INTO webhook_endpoints(name,url,secret_encrypted,event_types) VALUES($1,$2,$3,$4) RETURNING id,name,url,event_types,created_at",[body.name?.trim()||"Webhook",body.url,encryptAtRest(secret,config.DATA_ENCRYPTION_KEY),body.eventTypes??["message.received","message.status_changed","account.status_changed"]]);
  return reply.code(201).send({...created.rows[0],secret});
});

app.post("/api/v1/webhook-deliveries/:id/replay", {preHandler:authenticate}, async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const result=await pool.query("UPDATE webhook_deliveries SET state='pending',available_at=now(),last_error=NULL,completed_at=NULL WHERE id=$1 RETURNING id",[id]);return result.rowCount?reply.code(202).send({deliveryId:id,status:"pending"}):reply.code(404).send({error:"not_found"});});

app.get("/agent/media/:id", async (request,reply) => {
  const credential=request.headers.authorization?.replace(/^Bearer /,"");if(!credential)return reply.code(401).send({error:"unauthorized"});
  const agent=await pool.query("SELECT id FROM agents WHERE credential_hash=$1 AND status<>'revoked'",[hashSecret(credential)]);if(!agent.rowCount)return reply.code(401).send({error:"unauthorized"});
  const {id}=request.params as {id:string};const media=await pool.query("SELECT m.object_key,m.file_name,m.mime_type FROM media m LEFT JOIN whatsapp_accounts a ON a.id=m.account_id WHERE m.id=$1 AND (m.account_id IS NULL OR a.agent_id=$2)",[id,agent.rows[0].id]);if(!media.rowCount)return reply.code(404).send({error:"not_found"});
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:media.rows[0].object_key}));reply.header("content-type",media.rows[0].mime_type).header("x-file-name",encodeURIComponent(media.rows[0].file_name??"attachment"));return reply.send(object.Body);
});

app.post("/agent/media", async(request,reply)=>{
  const credential=request.headers.authorization?.replace(/^Bearer /,"");if(!credential)return reply.code(401).send({error:"unauthorized"});const query=request.query as {accountId?:string};if(!query.accountId)return reply.code(400).send({error:"account_id_required"});
  const account=await pool.query("SELECT a.id FROM whatsapp_accounts a JOIN agents g ON g.id=a.agent_id WHERE a.id=$1 AND g.credential_hash=$2 AND g.status<>'revoked'",[query.accountId,hashSecret(credential)]);if(!account.rowCount)return reply.code(403).send({error:"account_forbidden"});
  const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});const bytes=await file.toBuffer();const sha256=createHash("sha256").update(bytes).digest("hex");if(request.headers["x-content-sha256"]&&request.headers["x-content-sha256"]!==sha256)return reply.code(422).send({error:"checksum_mismatch"});const objectKey=`inbound/${query.accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:file.mimetype,Metadata:{sha256}}));const created=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[query.accountId,objectKey,file.filename,file.mimetype,bytes.length,sha256]);return reply.code(201).send({mediaId:created.rows[0].id,size:bytes.length,sha256});
});

app.get("/api/v1/accounts", { preHandler:authenticate }, async (request) => {
  const ids = request.principal?.accountIds;
  const result = await pool.query("SELECT id,display_name,phone_e164,status,status_reason,last_connected_at,last_event_at FROM whatsapp_accounts WHERE $1::uuid[] IS NULL OR id=ANY($1) ORDER BY display_name", [ids ?? null]);
  return { data:result.rows };
});

app.get("/api/v1/conversations", { preHandler:authenticate }, async (request) => {
  const query = request.query as { accountId?:string; status?:string; q?:string; limit?:string; before?:string };
  const limit = Math.min(100,Math.max(1,Number(query.limit ?? 30)));
  if (query.accountId && !canAccessAccount(request.principal,query.accountId)) return { data:[], nextCursor:null };
  const result = await pool.query(`SELECT c.id,c.status,c.favorite,c.unread_count,c.last_message_at,c.assigned_user_id,co.display_name,co.phone_e164,co.avatar_url,a.id account_id,a.display_name account_name,a.status account_status,m.text_content last_message,m.kind last_message_kind FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN whatsapp_accounts a ON a.id=c.account_id LEFT JOIN LATERAL (SELECT text_content,kind FROM messages WHERE conversation_id=c.id ORDER BY occurred_at DESC LIMIT 1)m ON true WHERE ($1::uuid IS NULL OR c.account_id=$1) AND ($2::text IS NULL OR c.status::text=$2) AND ($3::text IS NULL OR co.display_name ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%') AND ($4::timestamptz IS NULL OR c.last_message_at<$4) ORDER BY c.last_message_at DESC NULLS LAST LIMIT $5`, [query.accountId ?? null,query.status ?? null,query.q ?? null,query.before ?? null,limit+1]);
  const hasMore = result.rows.length > limit; const data = result.rows.slice(0,limit);
  return { data, nextCursor:hasMore ? data[data.length-1]?.last_message_at : null };
});

app.get("/api/v1/conversations/:id/messages", { preHandler:authenticate }, async (request, reply) => {
  const { id } = request.params as {id:string}; const query = request.query as { before?:string; limit?:string };
  const conversation = await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);
  if (!conversation.rowCount || !canAccessAccount(request.principal,conversation.rows[0].account_id)) return reply.code(404).send({error:"not_found"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??50)));
  const result=await pool.query("SELECT id,direction,kind,text_content,status,whatsapp_message_id,media_id,quoted_message_id,occurred_at FROM messages WHERE conversation_id=$1 AND ($2::timestamptz IS NULL OR occurred_at<$2) ORDER BY occurred_at DESC,id DESC LIMIT $3",[id,query.before??null,limit]);
  return {data:result.rows.reverse(),nextCursor:result.rows.length===limit?result.rows[result.rows.length-1]?.occurred_at:null};
});

app.post("/api/v1/messages", { preHandler:authenticate }, async (request, reply) => {
  const parsed=messageSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const result=await transaction(async(client)=>{
    const conversation=await client.query("SELECT c.id,c.account_id,a.agent_id,a.status,co.wa_jid FROM conversations c JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 AND c.account_id=$2",[parsed.data.conversationId,parsed.data.accountId]);
    if(!conversation.rowCount) return null;
    const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[parsed.data.accountId,parsed.data.clientMessageId]); if(existing.rowCount)return {messageId:existing.rows[0].id,status:existing.rows[0].status,deduplicated:true,agentId:conversation.rows[0].agent_id};
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,media_id,quoted_message_id,status,occurred_at) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,'queued',now()) RETURNING id,status",[parsed.data.conversationId,parsed.data.accountId,request.principal?.kind==='user'?request.principal.id:null,parsed.data.clientMessageId,parsed.data.type,parsed.data.text??null,parsed.data.mediaId??null,parsed.data.quotedMessageId??null]);
    const command=await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4) RETURNING id,sequence",[conversation.rows[0].agent_id,parsed.data.accountId,message.rows[0].id,JSON.stringify({...parsed.data,messageId:message.rows[0].id,toJid:conversation.rows[0].wa_jid})]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'message.queue','message',$3,$4)",[request.principal?.kind,request.principal?.id,message.rows[0].id,JSON.stringify({commandId:command.rows[0].id})]);
    return {messageId:message.rows[0].id,status:"queued",deduplicated:false,agentId:conversation.rows[0].agent_id};
  });
  if(!result)return reply.code(404).send({error:"conversation_not_found"});
  if(result.agentId)void dispatchPending(result.agentId); return reply.code(202).send(result);
});

app.post("/api/v1/media", { preHandler:authenticate }, async (request,reply) => {
  const file=await request.file(); if(!file)return reply.code(400).send({error:"file_required"});
  const allowed=new Set(["image/jpeg","image/png","image/webp","video/mp4","audio/ogg","audio/mpeg","application/pdf","application/zip"]); if(!allowed.has(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});
  const bytes=await file.toBuffer(); const sha256=createHash("sha256").update(bytes).digest("hex"); const id=randomBytes(16).toString("hex"); const objectKey=`uploads/${new Date().toISOString().slice(0,10)}/${id}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:file.mimetype,Metadata:{sha256}}));
  const media=await pool.query("INSERT INTO media(object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5) RETURNING id",[objectKey,file.filename,file.mimetype,bytes.length,sha256]); return reply.code(201).send({mediaId:media.rows[0].id,fileName:file.filename,mimeType:file.mimetype,size:bytes.length,sha256});
});

app.setErrorHandler((error,_request,reply)=>{app.log.error(error);void reply.code((error as {statusCode?:number}).statusCode??500).send({error:"internal_error",message:config.NODE_ENV==="production"?"服务暂时不可用":error.message});});

await registerAgentHub(app);

async function ensureAdmin():Promise<void>{
  const existing=await pool.query("SELECT id,password_hash,role,disabled_at FROM users WHERE lower(email)=lower($1)",[config.ADMIN_EMAIL]);
  if(!existing.rowCount){
    await pool.query("INSERT INTO users(email,display_name,password_hash,role) VALUES($1,'系统管理员',$2,'admin')",[config.ADMIN_EMAIL,hashPassword(config.ADMIN_PASSWORD)]);
    return;
  }
  const user=existing.rows[0];
  if(!verifyPassword(config.ADMIN_PASSWORD,user.password_hash)||user.role!=="admin"||user.disabled_at){
    await pool.query("UPDATE users SET password_hash=$2,role='admin',disabled_at=NULL,updated_at=now() WHERE id=$1",[user.id,hashPassword(config.ADMIN_PASSWORD)]);
  }
}

await ensureAdmin();
await app.listen({port:config.PORT,host:"0.0.0.0"});
