import { randomBytes, createHash } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { authenticate, canAccessAccount } from "./auth.js";
import { enrollmentSchema, loginSchema, messageSchema, messageTranslationsSchema, newConversationSchema, textToSpeechSchema, translationPreferenceSchema, translationPreviewSchema, translationProviderSettingsSchema, ttsProviderSettingsSchema } from "./schemas.js";
import { decryptAtRest, encryptAtRest, hashPassword, hashSecret, signToken, verifyPassword } from "./security.js";
import { registerAgentHub, dispatchPending, disconnectAgent, markStaleAgentsOffline } from "./agent-hub.js";
import { generateSpeech, TTS_PROVIDERS, ttsProviderDefaults, type TtsProvider } from "./tts-providers.js";
import { TRANSLATION_PROVIDERS, translateText, translationProviderDefaults, type TranslationProvider, type TranslationProviderSetting } from "./translation-providers.js";

const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact:["req.headers.authorization","password"] }, bodyLimit: 2_000_000 });
const s3 = new S3Client({ region:config.S3_REGION, endpoint:config.S3_ENDPOINT, forcePathStyle:true, credentials:{ accessKeyId:config.S3_ACCESS_KEY, secretAccessKey:config.S3_SECRET_KEY } });

await app.register(cors, { origin:config.CORS_ORIGIN, credentials:true });
await app.register(multipart, { limits:{ fileSize:64 * 1024 * 1024, files:1 } });
await app.register(websocket, { options:{ maxPayload:2_000_000 } });

await ensureTtsProviderSettingsTable();
await ensureTranslationTables();

app.get("/health", async () => { await pool.query("SELECT 1"); return { status:"ok", version:"0.1.0", time:new Date().toISOString() }; });
app.get("/api/v1/openapi.json", async () => ({ openapi:"3.1.0", info:{title:"RelayDesk API",version:"0.1.0"}, paths:{
  "/api/v1/messages":{post:{summary:"发送单条消息",responses:{"202":{description:"已进入持久队列"}}}},
  "/api/v1/conversations":{get:{summary:"分页查询会话"},post:{summary:"创建或复用单个联系人会话并发送首条文本消息"}},
  "/api/v1/conversations/{id}":{patch:{summary:"认领、收藏、关闭或标记已读"}},
  "/api/v1/agents":{get:{summary:"查询已注册 Agent"}},
  "/api/v1/agents/{id}":{patch:{summary:"重命名或撤销 Agent"},delete:{summary:"删除 Agent 登记"}},
  "/api/v1/media":{post:{summary:"上传媒体"}},
  "/api/v1/text-to-speech":{post:{summary:"使用当前 Provider 生成语音媒体"}},
  "/api/v1/me/translation-preferences":{get:{summary:"读取当前坐席翻译偏好"},put:{summary:"保存当前坐席翻译偏好"}},
  "/api/v1/translation/status":{get:{summary:"读取 AI 翻译可用状态"}},
  "/api/v1/translations/preview":{post:{summary:"生成待发送文本的翻译预览"}},
  "/api/v1/translations/messages":{post:{summary:"批量读取或生成接收消息译文"}},
  "/api/v1/admin/translation-providers":{get:{summary:"管理员读取翻译 Provider 配置"}},
  "/api/v1/admin/translation-providers/{provider}":{put:{summary:"管理员保存并启用翻译 Provider"}},
  "/api/v1/admin/tts-providers":{get:{summary:"管理员读取语音 Provider 配置"}},
  "/api/v1/admin/tts-providers/{provider}":{put:{summary:"管理员保存并启用语音 Provider"}}
} }));

app.post("/api/v1/auth/login", async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error:"invalid_request", details:parsed.error.flatten() });
  const user = await pool.query("SELECT id,email,display_name,password_hash,role FROM users WHERE lower(email)=lower($1) AND disabled_at IS NULL ORDER BY updated_at DESC,id LIMIT 1", [parsed.data.email]);
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

app.get("/api/v1/agents", {preHandler:authenticate}, async(request,reply)=>{
  if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});
  await markStaleAgentsOffline();
  const [agents,accounts]=await Promise.all([
    pool.query("SELECT id,name,status,version,protocol_version,platform,last_seen_at,last_acked_cursor,enrollment_expires_at,created_at FROM agents ORDER BY created_at DESC"),
    pool.query("SELECT id,agent_id,display_name,phone_e164,status,status_reason,last_event_at FROM whatsapp_accounts WHERE agent_id IS NOT NULL ORDER BY display_name"),
  ]);
  return {data:agents.rows.map(agent=>({...agent,accounts:accounts.rows.filter(account=>account.agent_id===agent.id)}))};
});

app.patch("/api/v1/agents/:id", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const {id}=request.params as {id:string};const body=(request.body??{}) as {name?:string;revoke?:boolean};const name=body.name?.trim();
  if(name!==undefined&&(name.length<2||name.length>80)||body.revoke!==undefined&&typeof body.revoke!=="boolean")return reply.code(400).send({error:"invalid_request"});
  const updated=await pool.query("UPDATE agents SET name=COALESCE($2,name),status=CASE WHEN $3 THEN 'revoked' ELSE status END,credential_hash=CASE WHEN $3 THEN NULL ELSE credential_hash END,enrollment_code_hash=CASE WHEN $3 THEN NULL ELSE enrollment_code_hash END,enrollment_expires_at=CASE WHEN $3 THEN NULL ELSE enrollment_expires_at END WHERE id=$1 RETURNING id,name,status,version,protocol_version,platform,last_seen_at,last_acked_cursor,created_at",[id,name??null,body.revoke===true]);
  if(!updated.rowCount)return reply.code(404).send({error:"not_found"});
  if(body.revoke)disconnectAgent(id);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,$2,'agent',$3,$4)",[request.principal.id,body.revoke?"agent.revoke":"agent.rename",id,JSON.stringify({name})]);
  return updated.rows[0];
});

app.delete("/api/v1/agents/:id", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const {id}=request.params as {id:string};
  const removed=await transaction(async client=>{
    const agent=await client.query("SELECT id FROM agents WHERE id=$1",[id]);if(!agent.rowCount)return false;
    await client.query("UPDATE whatsapp_accounts SET agent_id=NULL,status='offline',status_reason='agent_removed' WHERE agent_id=$1",[id]);
    await client.query("DELETE FROM agents WHERE id=$1",[id]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id) VALUES('user',$1,'agent.delete','agent',$2)",[request.principal?.id,id]);
    return true;
  });
  if(!removed)return reply.code(404).send({error:"not_found"});disconnectAgent(id,"deleted");return reply.code(204).send();
});

app.post("/agent/accounts", async(request,reply)=>{
  const credential=request.headers.authorization?.replace(/^Bearer /,"");
  if(!credential)return reply.code(401).send({error:"unauthorized"});
  const agent=await pool.query("SELECT id FROM agents WHERE credential_hash=$1 AND status<>'revoked'",[hashSecret(credential)]);
  if(!agent.rowCount)return reply.code(401).send({error:"unauthorized"});
  const body=request.body as {id?:string;name?:string};
  const id=body.id?.trim(),name=body.name?.trim();
  if(!id||!name||name.length<2||name.length>80||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return reply.code(400).send({error:"invalid_request"});
  const created=await pool.query("INSERT INTO whatsapp_accounts(id,agent_id,display_name,status) VALUES($1,$2,$3,'pairing') ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name,status='pairing' WHERE whatsapp_accounts.agent_id=$2 RETURNING id,display_name,status",[id,agent.rows[0].id,name]);
  if(!created.rowCount)return reply.code(409).send({error:"account_conflict"});
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('agent',$1,'account.create','whatsapp_account',$2,$3)",[agent.rows[0].id,id,JSON.stringify({displayName:name})]);
  return reply.code(201).send(created.rows[0]);
});

app.patch("/agent/accounts/:id", async(request,reply)=>{
  const credential=request.headers.authorization?.replace(/^Bearer /,"");
  if(!credential)return reply.code(401).send({error:"unauthorized"});
  const agent=await pool.query("SELECT id FROM agents WHERE credential_hash=$1 AND status<>'revoked'",[hashSecret(credential)]);
  if(!agent.rowCount)return reply.code(401).send({error:"unauthorized"});
  const {id}=request.params as {id:string};const body=request.body as {name?:string;status?:string};const name=body.name?.trim();
  if(name!==undefined&&(name.length<2||name.length>80))return reply.code(400).send({error:"invalid_request"});
  if(body.status!==undefined&&body.status!=="pairing")return reply.code(400).send({error:"invalid_request"});
  const updated=await pool.query("UPDATE whatsapp_accounts SET display_name=COALESCE($3,display_name),status=CASE WHEN $4='pairing' THEN 'pairing' ELSE status END,status_reason=CASE WHEN $4='pairing' THEN NULL ELSE status_reason END WHERE id=$1 AND agent_id=$2 RETURNING id,display_name,status",[id,agent.rows[0].id,name??null,body.status??null]);
  if(!updated.rowCount)return reply.code(404).send({error:"not_found"});
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('agent',$1,$2,'whatsapp_account',$3,$4)",[agent.rows[0].id,body.status==="pairing"?"account.repair":"account.rename",id,JSON.stringify({displayName:name})]);
  return updated.rows[0];
});

app.delete("/agent/accounts/:id", async(request,reply)=>{
  const credential=request.headers.authorization?.replace(/^Bearer /,"");
  if(!credential)return reply.code(401).send({error:"unauthorized"});
  const agent=await pool.query("SELECT id FROM agents WHERE credential_hash=$1 AND status<>'revoked'",[hashSecret(credential)]);
  if(!agent.rowCount)return reply.code(401).send({error:"unauthorized"});
  const {id}=request.params as {id:string};
  const removed=await pool.query("UPDATE whatsapp_accounts SET agent_id=NULL,status='logged_out',status_reason='removed_from_agent' WHERE id=$1 AND agent_id=$2 RETURNING id",[id,agent.rows[0].id]);
  if(!removed.rowCount)return reply.code(404).send({error:"not_found"});
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id) VALUES('agent',$1,'account.remove','whatsapp_account',$2)",[agent.rows[0].id,id]);
  return reply.code(204).send();
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
  const result = await pool.query("SELECT id,display_name,phone_e164,status,status_reason,last_connected_at,last_event_at FROM whatsapp_accounts WHERE agent_id IS NOT NULL AND ($1::uuid[] IS NULL OR id=ANY($1)) ORDER BY display_name", [ids ?? null]);
  return { data:result.rows };
});

app.get("/api/v1/conversations", { preHandler:authenticate }, async (request) => {
  const query = request.query as { accountId?:string; status?:string; q?:string; limit?:string; before?:string };
  const limit = Math.min(100,Math.max(1,Number(query.limit ?? 30)));
  if (query.accountId && !canAccessAccount(request.principal,query.accountId)) return { data:[], nextCursor:null };
  const result = await pool.query(`SELECT c.id,c.status,c.favorite,c.unread_count,c.last_message_at,c.assigned_user_id,co.display_name,co.phone_e164,co.avatar_url,a.id account_id,a.display_name account_name,a.status account_status,m.text_content last_message,m.kind last_message_kind FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN whatsapp_accounts a ON a.id=c.account_id LEFT JOIN LATERAL (SELECT text_content,kind FROM messages WHERE conversation_id=c.id ORDER BY occurred_at DESC LIMIT 1)m ON true WHERE a.agent_id IS NOT NULL AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::text IS NULL OR c.status::text=$2) AND ($3::text IS NULL OR co.display_name ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%') AND ($4::timestamptz IS NULL OR c.last_message_at<$4) ORDER BY c.last_message_at DESC NULLS LAST LIMIT $5`, [query.accountId ?? null,query.status ?? null,query.q ?? null,query.before ?? null,limit+1]);
  const hasMore = result.rows.length > limit; const data = result.rows.slice(0,limit);
  return { data, nextCursor:hasMore ? data[data.length-1]?.last_message_at : null };
});

app.patch("/api/v1/conversations/:id", { preHandler:authenticate }, async (request,reply) => {
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {id}=request.params as {id:string};const body=(request.body??{}) as {assignedToMe?:boolean;favorite?:boolean;status?:string;read?:boolean};
  if(body.assignedToMe!==undefined&&typeof body.assignedToMe!=="boolean"||body.favorite!==undefined&&typeof body.favorite!=="boolean"||body.read!==undefined&&typeof body.read!=="boolean")return reply.code(400).send({error:"invalid_request"});
  if(body.status!==undefined&&!['open','closed','archived'].includes(body.status))return reply.code(400).send({error:"invalid_status"});
  const current=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);
  if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const updated=await pool.query("UPDATE conversations SET assigned_user_id=CASE WHEN $2::boolean IS NULL THEN assigned_user_id WHEN $2 THEN $6::uuid ELSE NULL END,favorite=COALESCE($3,favorite),status=COALESCE($4::conversation_status,status),closed_at=CASE WHEN $4='closed' THEN now() WHEN $4='open' THEN NULL ELSE closed_at END,unread_count=CASE WHEN $5 THEN 0 ELSE unread_count END WHERE id=$1 RETURNING id,account_id,status,favorite,assigned_user_id,unread_count,closed_at",[id,body.assignedToMe??null,body.favorite??null,body.status??null,body.read??false,request.principal.id]);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.update','conversation',$2,$3)",[request.principal.id,id,JSON.stringify(body)]);
  return updated.rows[0];
});

app.post("/api/v1/conversations", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const principal=request.principal;
  const parsed=newConversationSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const result=await transaction(async client=>{
    const account=await client.query("SELECT id,agent_id,status FROM whatsapp_accounts WHERE id=$1 AND agent_id IS NOT NULL",[parsed.data.accountId]);if(!account.rowCount)return null;
    const existing=await client.query("SELECT m.id message_id,m.status,c.id conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.account_id=$1 AND m.client_message_id=$2",[parsed.data.accountId,parsed.data.clientMessageId]);
    if(existing.rowCount)return {conversationId:existing.rows[0].conversation_id,messageId:existing.rows[0].message_id,status:existing.rows[0].status,deduplicated:true,agentId:account.rows[0].agent_id};
    const phone=`+${parsed.data.phone}`,waJid=`${parsed.data.phone}@s.whatsapp.net`,displayName=parsed.data.displayName||phone;
    const contact=await client.query("INSERT INTO contacts(account_id,wa_jid,phone_e164,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,wa_jid) DO UPDATE SET phone_e164=EXCLUDED.phone_e164,display_name=CASE WHEN $5 THEN EXCLUDED.display_name ELSE COALESCE(contacts.display_name,EXCLUDED.display_name) END RETURNING id",[parsed.data.accountId,waJid,phone,displayName,Boolean(parsed.data.displayName)]);
    const conversation=await client.query("INSERT INTO conversations(account_id,contact_id,status,last_message_at) VALUES($1,$2,'open',now()) ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL,last_message_at=now() RETURNING id",[parsed.data.accountId,contact.rows[0].id]);
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id,status",[conversation.rows[0].id,parsed.data.accountId,principal.id,parsed.data.clientMessageId,parsed.data.firstMessage]);
    const command=await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4) RETURNING id",[account.rows[0].agent_id,parsed.data.accountId,message.rows[0].id,JSON.stringify({accountId:parsed.data.accountId,conversationId:conversation.rows[0].id,clientMessageId:parsed.data.clientMessageId,type:"text",text:parsed.data.firstMessage,messageId:message.rows[0].id,toJid:waJid})]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.initiate','conversation',$2,$3)",[principal.id,conversation.rows[0].id,JSON.stringify({contactId:contact.rows[0].id,messageId:message.rows[0].id,commandId:command.rows[0].id,phone})]);
    return {conversationId:conversation.rows[0].id,messageId:message.rows[0].id,status:message.rows[0].status,deduplicated:false,agentId:account.rows[0].agent_id};
  });
  if(!result)return reply.code(404).send({error:"account_not_found"});if(result.agentId)void dispatchPending(result.agentId);return reply.code(202).send(result);
});

app.get("/api/v1/conversations/:id/messages", { preHandler:authenticate }, async (request, reply) => {
  const { id } = request.params as {id:string}; const query = request.query as { before?:string; limit?:string };
  const conversation = await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);
  if (!conversation.rowCount || !canAccessAccount(request.principal,conversation.rows[0].account_id)) return reply.code(404).send({error:"not_found"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??50)));
  const result=await pool.query("SELECT msg.id,msg.direction,msg.kind,msg.text_content,msg.status,msg.whatsapp_message_id,msg.media_id,msg.quoted_message_id,msg.occurred_at,media.file_name,media.mime_type,media.byte_size FROM messages msg LEFT JOIN media ON media.id=msg.media_id WHERE msg.conversation_id=$1 AND ($2::timestamptz IS NULL OR msg.occurred_at<$2) ORDER BY msg.occurred_at DESC,msg.id DESC LIMIT $3",[id,query.before??null,limit]);
  return {data:result.rows.reverse(),nextCursor:result.rows.length===limit?result.rows[result.rows.length-1]?.occurred_at:null};
});

app.post("/api/v1/messages", { preHandler:authenticate }, async (request, reply) => {
  const parsed=messageSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const result=await transaction(async(client)=>{
    const conversation=await client.query("SELECT c.id,c.account_id,a.agent_id,a.status,co.wa_jid FROM conversations c JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 AND c.account_id=$2",[parsed.data.conversationId,parsed.data.accountId]);
    if(!conversation.rowCount) return null;
    if(parsed.data.mediaId){const media=await client.query("SELECT id FROM media WHERE id=$1 AND (account_id=$2 OR account_id IS NULL) AND status='ready'",[parsed.data.mediaId,parsed.data.accountId]);if(!media.rowCount)throw Object.assign(new Error("media_not_found"),{statusCode:404});}
    const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[parsed.data.accountId,parsed.data.clientMessageId]); if(existing.rowCount)return {messageId:existing.rows[0].id,status:existing.rows[0].status,deduplicated:true,agentId:conversation.rows[0].agent_id};
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,media_id,quoted_message_id,status,occurred_at) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,'queued',now()) RETURNING id,status",[parsed.data.conversationId,parsed.data.accountId,request.principal?.kind==='user'?request.principal.id:null,parsed.data.clientMessageId,parsed.data.type,parsed.data.text??null,parsed.data.mediaId??null,parsed.data.quotedMessageId??null]);
    await client.query("UPDATE conversations SET status='open',closed_at=NULL,last_message_at=now() WHERE id=$1",[parsed.data.conversationId]);
    const command=await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4) RETURNING id,sequence",[conversation.rows[0].agent_id,parsed.data.accountId,message.rows[0].id,JSON.stringify({...parsed.data,messageId:message.rows[0].id,toJid:conversation.rows[0].wa_jid})]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'message.queue','message',$3,$4)",[request.principal?.kind,request.principal?.id,message.rows[0].id,JSON.stringify({commandId:command.rows[0].id})]);
    return {messageId:message.rows[0].id,status:"queued",deduplicated:false,agentId:conversation.rows[0].agent_id};
  });
  if(!result)return reply.code(404).send({error:"conversation_not_found"});
  if(result.agentId)void dispatchPending(result.agentId); return reply.code(202).send(result);
});

app.get("/api/v1/me/translation-preferences", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const result=await pool.query("SELECT enabled,agent_language,customer_language,updated_at FROM user_translation_preferences WHERE user_id=$1",[request.principal.id]);
  const row=result.rows[0];
  return{enabled:Boolean(row?.enabled),agentLanguage:row?.agent_language??"zh-CN",customerLanguage:row?.customer_language??"en",updatedAt:row?.updated_at??null};
});

app.put("/api/v1/me/translation-preferences", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=translationPreferenceSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const provider=parsed.data.enabled?await pool.query("SELECT 1 FROM translation_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1"):null;
  if(parsed.data.enabled&&!provider?.rowCount)return reply.code(409).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  const result=await pool.query("INSERT INTO user_translation_preferences(user_id,enabled,agent_language,customer_language) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,agent_language=EXCLUDED.agent_language,customer_language=EXCLUDED.customer_language,updated_at=now() RETURNING enabled,agent_language,customer_language,updated_at",[request.principal.id,parsed.data.enabled,parsed.data.agentLanguage,parsed.data.customerLanguage]);
  const row=result.rows[0];
  return{enabled:row.enabled,agentLanguage:row.agent_language,customerLanguage:row.customer_language,updatedAt:row.updated_at};
});

app.get("/api/v1/translation/status", {preHandler:authenticate}, async()=>{
  const result=await pool.query("SELECT provider,model FROM translation_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1");
  return result.rowCount?{configured:true,provider:result.rows[0].provider,model:result.rows[0].model}:{configured:false};
});

app.post("/api/v1/translations/preview", {preHandler:authenticate}, async(request,reply)=>{
  const parsed=translationPreviewSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const setting=await activeTranslationSetting();if(!setting)return reply.code(503).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  try{
    const translatedText=await translateText(setting,{text:parsed.data.text,targetLanguage:parsed.data.targetLanguage});
    return{translatedText,targetLanguage:parsed.data.targetLanguage,provider:setting.provider,model:setting.model};
  }catch(error){request.log.error({provider:setting.provider,error:String(error)},"Translation preview failed");return reply.code(502).send({error:"translation_failed",message:"AI 翻译失败，请检查 Provider 配置或稍后重试"});}
});

app.post("/api/v1/translations/messages", {preHandler:authenticate}, async(request,reply)=>{
  const parsed=messageTranslationsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const found=await pool.query("SELECT m.id,m.account_id,m.direction,m.kind,m.text_content,mt.translated_text FROM messages m LEFT JOIN message_translations mt ON mt.message_id=m.id AND mt.target_language=$2 WHERE m.id=ANY($1::uuid[])",[parsed.data.messageIds,parsed.data.targetLanguage]);
  if(found.rowCount!==new Set(parsed.data.messageIds).size||found.rows.some(row=>!canAccessAccount(request.principal,row.account_id)))return reply.code(404).send({error:"message_not_found"});
  const eligible=found.rows.filter(row=>row.direction==="in"&&row.kind==="text"&&String(row.text_content??"").trim());
  const setting=eligible.some(row=>!row.translated_text)?await activeTranslationSetting():null;
  if(eligible.some(row=>!row.translated_text)&&!setting)return reply.code(503).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  const generated=await mapWithConcurrency(eligible.filter(row=>!row.translated_text),3,async row=>{
    try{
      const translatedText=await translateText(setting!,{text:String(row.text_content),targetLanguage:parsed.data.targetLanguage});
      await pool.query("INSERT INTO message_translations(message_id,target_language,translated_text,provider,model) VALUES($1,$2,$3,$4,$5) ON CONFLICT(message_id,target_language) DO NOTHING",[row.id,parsed.data.targetLanguage,translatedText,setting!.provider,setting!.model]);
      return{id:row.id,translatedText};
    }catch(error){request.log.error({messageId:row.id,provider:setting?.provider,error:String(error)},"Incoming message translation failed");return{id:row.id,error:"translation_failed"};}
  });
  const generatedById=new Map(generated.map(item=>[item.id,item]));
  return{data:parsed.data.messageIds.map(messageId=>{const row=found.rows.find(item=>item.id===messageId);if(!row||row.direction!=="in"||row.kind!=="text"||!String(row.text_content??"").trim())return{messageId,status:"skipped"};const item=generatedById.get(messageId);if(item?.error)return{messageId,status:"failed",error:item.error};return{messageId,status:"translated",translatedText:row.translated_text??item?.translatedText};})};
});

app.get("/api/v1/admin/translation-providers", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT provider,enabled,api_key_encrypted IS NOT NULL key_configured,base_url,model,updated_at FROM translation_provider_settings");const rows=new Map(result.rows.map(row=>[row.provider,row]));
  return{data:TRANSLATION_PROVIDERS.map(provider=>{const row=rows.get(provider),defaults=translationProviderDefaults(provider);return{provider,enabled:Boolean(row?.enabled),keyConfigured:Boolean(row?.key_configured),baseUrl:row?.base_url??defaults.baseUrl,model:row?.model??defaults.model,updatedAt:row?.updated_at??null};})};
});

app.put("/api/v1/admin/translation-providers/:provider", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(!TRANSLATION_PROVIDERS.includes(provider as TranslationProvider))return reply.code(404).send({error:"provider_not_found"});
  const actorId=request.principal.id;
  const parsed=translationProviderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const current=await pool.query("SELECT api_key_encrypted FROM translation_provider_settings WHERE provider=$1",[provider]);const encrypted=parsed.data.apiKey?encryptAtRest(parsed.data.apiKey,config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;if(parsed.data.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required",message:"启用 Provider 前必须填写 API Key"});
  await transaction(async client=>{if(parsed.data.enabled)await client.query("UPDATE translation_provider_settings SET enabled=false,updated_at=now() WHERE enabled=true AND provider<>$1",[provider]);await client.query("INSERT INTO translation_provider_settings(provider,enabled,api_key_encrypted,base_url,model,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,encrypted,parsed.data.baseUrl,parsed.data.model,actorId]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'translation_provider.update','translation_provider',$2,$3)",[actorId,provider,JSON.stringify({enabled:parsed.data.enabled,baseUrl:parsed.data.baseUrl,model:parsed.data.model,keyChanged:Boolean(parsed.data.apiKey)})]);});
  return{provider,enabled:parsed.data.enabled,keyConfigured:Boolean(encrypted),baseUrl:parsed.data.baseUrl,model:parsed.data.model};
});

app.post("/api/v1/text-to-speech", {preHandler:authenticate}, async(request,reply)=>{
  const parsed=textToSpeechSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const account=await pool.query("SELECT id FROM whatsapp_accounts WHERE id=$1",[parsed.data.accountId]);if(!account.rowCount)return reply.code(404).send({error:"account_not_found"});
  const configured=await pool.query("SELECT provider,api_key_encrypted,base_url,model,voice FROM tts_provider_settings WHERE enabled=true LIMIT 1");if(!configured.rowCount||!configured.rows[0].api_key_encrypted)return reply.code(503).send({error:"tts_not_configured",message:"管理员尚未启用文字转语音 Provider"});
  const setting=configured.rows[0];let generated:Awaited<ReturnType<typeof generateSpeech>>;
  try{generated=await generateSpeech({provider:setting.provider as TtsProvider,apiKey:decryptAtRest(setting.api_key_encrypted,config.DATA_ENCRYPTION_KEY),baseUrl:setting.base_url,model:setting.model,voice:setting.voice},parsed.data);}catch(error){request.log.error({provider:setting.provider,error:String(error)},"Text-to-speech provider request failed");return reply.code(502).send({error:"tts_generation_failed",message:"AI 语音生成失败，请检查 Provider 配置或稍后重试"});}
  const {bytes,mimeType,extension}=generated;
  const sha256=createHash("sha256").update(bytes).digest("hex");const existing=await pool.query("SELECT id,file_name,mime_type,byte_size FROM media WHERE account_id=$1 AND sha256=$2 AND status='ready' ORDER BY created_at DESC LIMIT 1",[parsed.data.accountId,sha256]);
  if(existing.rowCount)return reply.code(200).send({mediaId:existing.rows[0].id,fileName:existing.rows[0].file_name,mimeType:existing.rows[0].mime_type,size:Number(existing.rows[0].byte_size),sha256,deduplicated:true});
  const id=randomBytes(16).toString("hex"),fileName=`ai-voice-${Date.now()}.${extension}`,objectKey=`generated/${parsed.data.accountId}/${new Date().toISOString().slice(0,10)}/${id}.${extension}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mimeType,Metadata:{sha256,source:`${setting.provider}-tts`}}));
  const media=await transaction(async client=>{const created=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[parsed.data.accountId,objectKey,fileName,mimeType,bytes.length,sha256]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'media.tts_generate','media',$3,$4)",[request.principal?.kind,request.principal?.id,created.rows[0].id,JSON.stringify({accountId:parsed.data.accountId,provider:setting.provider,model:setting.model,voice:setting.voice,characterCount:parsed.data.text.length})]);return created;});
  return reply.code(201).send({mediaId:media.rows[0].id,fileName,mimeType,size:bytes.length,sha256,deduplicated:false});
});

app.get("/api/v1/tts/status", {preHandler:authenticate}, async()=>{const result=await pool.query("SELECT provider,voice FROM tts_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1");return result.rowCount?{configured:true,provider:result.rows[0].provider,voice:result.rows[0].voice}:{configured:false};});

app.get("/api/v1/admin/tts-providers", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT provider,enabled,api_key_encrypted IS NOT NULL key_configured,base_url,model,voice,updated_at FROM tts_provider_settings");const rows=new Map(result.rows.map(row=>[row.provider,row]));
  return{data:TTS_PROVIDERS.map(provider=>{const row=rows.get(provider),defaults=ttsProviderDefaults(provider);return{provider,enabled:Boolean(row?.enabled),keyConfigured:Boolean(row?.key_configured),baseUrl:row?.base_url??defaults.baseUrl,model:row?.model??defaults.model,voice:row?.voice??defaults.voice,updatedAt:row?.updated_at??null};})};
});

app.put("/api/v1/admin/tts-providers/:provider", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(!TTS_PROVIDERS.includes(provider as TtsProvider))return reply.code(404).send({error:"provider_not_found"});
  const parsed=ttsProviderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});if(provider!=="azure"&&!parsed.data.model)return reply.code(400).send({error:"model_required",message:"该 Provider 必须填写模型 ID"});const current=await pool.query("SELECT api_key_encrypted FROM tts_provider_settings WHERE provider=$1",[provider]);const encrypted=parsed.data.apiKey?encryptAtRest(parsed.data.apiKey,config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;if(parsed.data.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required",message:"启用 Provider 前必须填写 API Key"});
  await transaction(async client=>{if(parsed.data.enabled)await client.query("UPDATE tts_provider_settings SET enabled=false,updated_at=now() WHERE enabled=true AND provider<>$1",[provider]);await client.query("INSERT INTO tts_provider_settings(provider,enabled,api_key_encrypted,base_url,model,voice,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,voice=EXCLUDED.voice,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,encrypted,parsed.data.baseUrl,parsed.data.model,parsed.data.voice,request.principal?.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'tts_provider.update','tts_provider',$2,$3)",[request.principal?.id,provider,JSON.stringify({enabled:parsed.data.enabled,baseUrl:parsed.data.baseUrl,model:parsed.data.model,voice:parsed.data.voice,keyChanged:Boolean(parsed.data.apiKey)})]);});
  return{provider,enabled:parsed.data.enabled,keyConfigured:Boolean(encrypted),baseUrl:parsed.data.baseUrl,model:parsed.data.model,voice:parsed.data.voice};
});

app.get("/api/v1/media", {preHandler:authenticate}, async(request,reply)=>{
  const query=request.query as {accountId?:string;q?:string;limit?:string};if(!query.accountId)return reply.code(400).send({error:"account_required"});if(!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??60)));const result=await pool.query("SELECT m.id,m.file_name,m.mime_type,m.byte_size,m.sha256,m.created_at,COUNT(msg.id)::int usage_count FROM media m LEFT JOIN messages msg ON msg.media_id=m.id WHERE (m.account_id=$1 OR m.account_id IS NULL) AND m.status='ready' AND ($2::text IS NULL OR m.file_name ILIKE '%'||$2||'%') GROUP BY m.id ORDER BY m.created_at DESC LIMIT $3",[query.accountId,query.q?.trim()||null,limit]);return{data:result.rows};
});

app.get("/api/v1/media/:id", {preHandler:authenticate}, async(request,reply)=>{
  const {id}=request.params as {id:string};const found=await pool.query("SELECT id,account_id,object_key,file_name,mime_type FROM media WHERE id=$1 AND status='ready'",[id]);
  if(!found.rowCount)return reply.code(404).send({error:"not_found"});const item=found.rows[0];if(item.account_id&&!canAccessAccount(request.principal,item.account_id))return reply.code(403).send({error:"account_forbidden"});
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));reply.header("content-type",item.mime_type).header("content-disposition",`${String(item.mime_type).startsWith("image/")||String(item.mime_type).startsWith("video/")||String(item.mime_type).startsWith("audio/")?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(item.file_name??"attachment")}`).header("cache-control","private, max-age=300");return reply.send(object.Body);
});

app.delete("/api/v1/media/:id", {preHandler:authenticate}, async(request,reply)=>{
  const {id}=request.params as {id:string};const found=await pool.query("SELECT m.id,m.account_id,m.object_key,COUNT(msg.id)::int usage_count FROM media m LEFT JOIN messages msg ON msg.media_id=m.id WHERE m.id=$1 GROUP BY m.id",[id]);if(!found.rowCount)return reply.code(404).send({error:"not_found"});const item=found.rows[0];if(!canAccessAccount(request.principal,item.account_id))return reply.code(403).send({error:"account_forbidden"});if(Number(item.usage_count)>0)return reply.code(409).send({error:"media_in_use"});await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));await transaction(async client=>{await client.query("DELETE FROM media WHERE id=$1",[id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'media.delete','media',$3,$4)",[request.principal?.kind,request.principal?.id,id,JSON.stringify({accountId:item.account_id,objectKey:item.object_key})]);});return reply.code(204).send();
});

app.post("/api/v1/media", { preHandler:authenticate }, async (request,reply) => {
  const query=request.query as {accountId?:string};if(!query.accountId)return reply.code(400).send({error:"account_required"});if(!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const file=await request.file(); if(!file)return reply.code(400).send({error:"file_required"});
  const allowed=new Set(["image/jpeg","image/png","image/webp","video/mp4","audio/ogg","audio/mpeg","application/pdf","application/zip","text/plain","text/csv","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation"]); if(!allowed.has(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});
  const bytes=await file.toBuffer(); const sha256=createHash("sha256").update(bytes).digest("hex");const existing=await pool.query("SELECT id,file_name,mime_type,byte_size,sha256 FROM media WHERE account_id=$1 AND sha256=$2 AND status='ready' ORDER BY created_at DESC LIMIT 1",[query.accountId,sha256]);if(existing.rowCount)return reply.code(200).send({mediaId:existing.rows[0].id,fileName:existing.rows[0].file_name,mimeType:existing.rows[0].mime_type,size:Number(existing.rows[0].byte_size),sha256,deduplicated:true}); const id=randomBytes(16).toString("hex"); const objectKey=`uploads/${query.accountId}/${new Date().toISOString().slice(0,10)}/${id}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:file.mimetype,Metadata:{sha256}}));
  const media=await transaction(async client=>{const created=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[query.accountId,objectKey,file.filename,file.mimetype,bytes.length,sha256]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'media.upload','media',$3,$4)",[request.principal?.kind,request.principal?.id,created.rows[0].id,JSON.stringify({accountId:query.accountId,fileName:file.filename,mimeType:file.mimetype,byteSize:bytes.length,sha256})]);return created;}); return reply.code(201).send({mediaId:media.rows[0].id,fileName:file.filename,mimeType:file.mimetype,size:bytes.length,sha256});
});

app.setErrorHandler((error,_request,reply)=>{app.log.error(error);void reply.code((error as {statusCode?:number}).statusCode??500).send({error:"internal_error",message:config.NODE_ENV==="production"?"服务暂时不可用":error.message});});

await registerAgentHub(app);

async function activeTranslationSetting():Promise<TranslationProviderSetting|null>{
  const result=await pool.query("SELECT provider,api_key_encrypted,base_url,model FROM translation_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1");
  if(!result.rowCount)return null;const row=result.rows[0];
  return{provider:row.provider as TranslationProvider,apiKey:decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY),baseUrl:row.base_url,model:row.model};
}

async function mapWithConcurrency<T,R>(items:T[],limit:number,work:(item:T)=>Promise<R>):Promise<R[]>{
  const results=new Array<R>(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const index=cursor++;results[index]=await work(items[index]);}}));
  return results;
}

async function ensureTranslationTables():Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS user_translation_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    agent_language text NOT NULL DEFAULT 'zh-CN',
    customer_language text NOT NULL DEFAULT 'en',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS translation_provider_settings (
    provider text PRIMARY KEY CHECK (provider IN ('openai','openai_compatible')),
    enabled boolean NOT NULL DEFAULT false,
    api_key_encrypted text,
    base_url text NOT NULL,
    model text NOT NULL DEFAULT '',
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS translation_provider_one_enabled_idx ON translation_provider_settings ((enabled)) WHERE enabled");
  await pool.query(`CREATE TABLE IF NOT EXISTS message_translations (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    target_language text NOT NULL,
    translated_text text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id,target_language)
  )`);
}

async function ensureTtsProviderSettingsTable():Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS tts_provider_settings (
    provider text PRIMARY KEY CHECK (provider IN ('openai','elevenlabs','azure','openai_compatible')),
    enabled boolean NOT NULL DEFAULT false,
    api_key_encrypted text,
    base_url text NOT NULL,
    model text NOT NULL DEFAULT '',
    voice text NOT NULL DEFAULT '',
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS tts_provider_one_enabled_idx ON tts_provider_settings ((enabled)) WHERE enabled");
}

async function ensureAdmin():Promise<void>{
  const existing=await pool.query("SELECT id FROM users WHERE lower(email)=lower($1)",[config.ADMIN_EMAIL]);
  if(!existing.rowCount){
    await pool.query("INSERT INTO users(email,display_name,password_hash,role) VALUES($1,'系统管理员',$2,'admin')",[config.ADMIN_EMAIL,hashPassword(config.ADMIN_PASSWORD)]);
    return;
  }
  await pool.query("UPDATE users SET password_hash=$2,role='admin',disabled_at=NULL,updated_at=now() WHERE lower(email)=lower($1)",[config.ADMIN_EMAIL,hashPassword(config.ADMIN_PASSWORD)]);
}

async function removeLegacyDemoData():Promise<void>{
  const removed=await pool.query("DELETE FROM whatsapp_accounts WHERE id=ANY($1::uuid[]) RETURNING id",[["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002"]]);
  if(removed.rowCount)await pool.query("INSERT INTO audit_log(actor_type,action,target_type,metadata) VALUES('system','legacy_demo.remove','whatsapp_account',$1)",[JSON.stringify({accountIds:removed.rows.map(row=>row.id)})]);
}

await removeLegacyDemoData();
await ensureAdmin();
await app.listen({port:config.PORT,host:"0.0.0.0"});
