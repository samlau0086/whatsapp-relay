import { randomBytes, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { authenticate, canAccessAccount, type Principal } from "./auth.js";
import { contactAliasSchema, contactCreateSchema, contactUpdateSchema, conversationTagsSchema, currencySchema, currencySettingsSchema, customerStageSchema, emailProviderSettingsSchema, emailProviderTestSchema, emailSendSchema, enrollmentSchema, loginSchema, messageSchema, messageTranslationsSchema, newConversationSchema, noteSchema, orderAddressSchema, orderSchema, orderSendSchema, orderSettingsSchema, orderUpdateSchema, paypalSettingsSchema, productBulkEditSchema, productBulkImportSchema, productCardBatchStatusSchema, productCardSendSchema, productCreateSchema, productUpdateSchema, reminderSchema, tagCreateSchema, tagUpdateSchema, textToSpeechSchema, translationPreferenceQuerySchema, translationPreferenceSchema, translationPreviewSchema, translationProviderSettingsSchema, ttsProviderSettingsSchema } from "./schemas.js";
import { decryptAtRest, encryptAtRest, hashPassword, hashSecret, signToken, verifyPassword } from "./security.js";
import { registerAgentHub, dispatchPending, disconnectAgent, markStaleAgentsOffline } from "./agent-hub.js";
import { generateSpeech, TTS_PROVIDERS, ttsProviderDefaults, type TtsProvider } from "./tts-providers.js";
import { TRANSLATION_PROVIDERS, transcribeAudio, translateText, translationProviderDefaults, type TranslationProvider, type TranslationProviderSetting } from "./translation-providers.js";
import { normalizeTranscriptionAudio } from "./audio-normalizer.js";
import { calculateOrderTotal, canManageSharedRecord, ensureCrmTables, primaryContactEmail, type OrderSummaryFee, type OrderSummaryItem } from "./crm.js";
import { renderTemplateOrderImage } from "./order-image.js";
import { DEFAULT_IMAGE_ORDER_TEMPLATE, DEFAULT_TEXT_ORDER_TEMPLATE, orderTemplateSchema, orderTemplateUpdateSchema, parseOrderTemplate, parseTranslatedSemanticOrder, renderSemanticOrder, renderTextOrder, serializeSemanticOrder, type OrderTemplateFormat } from "./order-template.js";
import { allocateOrderNumber, isValidTimeZone, orderNumberPreview, validateOrderNumberTemplate } from "./order-number.js";
import { pauseAgentForHuman } from "./agent-engine.js";
import { migrateAgentSchema } from "./migrate-agent.js";
import { PayPalApiError, PayPalClient, clearPayPalTokenCache, type PayPalEnvironment } from "./paypal.js";
import { DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE, DEFAULT_PAYPAL_NOTE_TEMPLATE, DEFAULT_PAYPAL_REFERENCE_TEMPLATE, renderPayPalTemplate, validatePayPalTemplate, type PayPalTemplateContext } from "./paypal-template.js";
import { DEFAULT_PRODUCT_CARD_TEMPLATE, parseProductCardTemplate, productCardTemplateSchema } from "./product-card-template.js";
import { renderProductCards, type ProductCardRenderProduct } from "./product-card-image.js";
import { fetchLatestExchangeRates } from "./exchange-rates.js";
import { emailShell, ensureEmailTables, escapeHtml, sendProviderTest, verifySmtp, type EmailProvider, type EmailProviderConfig } from "./email.js";
import { collageTemplateCreateSchema, collageTemplateUpdateSchema, materialGenerateSchema, parseCollageTemplate, productSlotIds, DEFAULT_COLLAGE_TEMPLATE, type CollageTemplate } from "./collage-template.js";
import { renderCollagePage, type CollageProduct } from "./collage-image.js";
import { registerTaskRoutes } from "./task-routes.js";

const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact:["req.headers.authorization","req.body.password","req.body.secret","req.body.apiKey","req.body.clientId","req.body.clientSecret","req.body.sandboxClientId","req.body.sandboxClientSecret","req.body.liveClientId","req.body.liveClientSecret"] }, bodyLimit: 2_000_000 });
const s3 = new S3Client({ region:config.S3_REGION, endpoint:config.S3_ENDPOINT, forcePathStyle:true, credentials:{ accessKeyId:config.S3_ACCESS_KEY, secretAccessKey:config.S3_SECRET_KEY } });

await app.register(cors, { origin:config.CORS_ORIGIN, credentials:true });
await app.register(multipart, { limits:{ fileSize:64 * 1024 * 1024, files:1 } });
await app.register(websocket, { options:{ maxPayload:2_000_000 } });

await migrateAgentSchema();
await ensureTtsProviderSettingsTable();
await ensureTranslationTables();
await ensureCrmTables(pool);
await ensureCurrencySettingsTable();
await ensureEmailTables();
await ensureCollageTables();
await registerTaskRoutes(app);

app.get("/health", async () => { await pool.query("SELECT 1"); return { status:"ok", version:"0.1.0", time:new Date().toISOString() }; });
app.get("/api/v1/openapi.json", async () => ({ openapi:"3.1.0", info:{title:"RelayDesk API",version:"0.1.0"}, paths:{
  "/api/v1/contacts":{get:{summary:"List contacts"}},
  "/api/v1/contacts/{id}":{get:{summary:"Read contact profile"},patch:{summary:"Update contact profile"}},
  "/api/v1/tasks":{get:{summary:"List tasks"},post:{summary:"Create a task"}},
  "/api/v1/tasks/{id}":{get:{summary:"Read task details"},patch:{summary:"Update a task"},delete:{summary:"Cancel a task"}},
  "/api/v1/tasks/{id}/generate":{post:{summary:"Generate a personalized message draft"}},
  "/api/v1/tasks/{id}/approve":{post:{summary:"Approve and schedule a task draft"}},
  "/api/v1/messages":{post:{summary:"发送单条消息",responses:{"202":{description:"已进入持久队列"}}}},
  "/api/v1/conversations":{get:{summary:"分页查询会话"},post:{summary:"创建或复用单个联系人会话并发送首条文本消息"}},
  "/api/v1/conversations/{id}":{patch:{summary:"认领、收藏、更新客户阶段、关闭或标记已读"},delete:{summary:"永久删除会话及其关联数据"}},
  "/api/v1/conversations/{id}/contact":{patch:{summary:"编辑联系人别名"}},
  "/api/v1/conversations/{id}/details":{get:{summary:"读取会话标签、备注、个人提醒与订单"}},
  "/api/v1/conversations/{id}/tags":{put:{summary:"替换会话标签"}},
  "/api/v1/conversations/{id}/notes":{post:{summary:"添加团队共享备注"}},
  "/api/v1/conversations/{id}/reminder":{put:{summary:"设置当前坐席提醒"},delete:{summary:"取消当前坐席提醒"}},
  "/api/v1/conversations/{id}/orders":{post:{summary:"保存包含多个商品和费用的订单草稿"}},
  "/api/v1/conversations/{id}/orders/{orderId}/send":{post:{summary:"以文字或完整图片格式发送或重新发送订单"}},
  "/api/v1/conversations/{id}/orders/{orderId}":{patch:{summary:"编辑订单"},delete:{summary:"从联系人资料中删除订单"}},
  "/api/v1/orders":{get:{summary:"集中查询订单"}},
  "/api/v1/admin/order-settings":{get:{summary:"读取订单号规则"},put:{summary:"更新订单号规则"}},
  "/api/v1/currencies":{get:{summary:"读取工作区币种与汇率"}},
  "/api/v1/admin/currencies":{put:{summary:"保存工作区币种、基准货币与汇率"}},
  "/api/v1/admin/currencies/refresh-rates":{post:{summary:"从公共汇率服务更新并保存工作区汇率"}},
  "/api/v1/admin/paypal-settings":{get:{summary:"读取 PayPal 收款配置"},put:{summary:"保存 PayPal 收款配置"}},
  "/api/v1/admin/email-providers":{get:{summary:"读取 SMTP 与 Resend 邮件配置"}},
  "/api/v1/admin/email-providers/{provider}":{put:{summary:"保存并启用邮件 Provider"}},
  "/api/v1/admin/email-providers/{provider}/test":{post:{summary:"发送 Provider 测试邮件"}},
  "/api/v1/conversations/{id}/email-sends":{post:{summary:"将订单或产品卡加入邮件发送队列"}},
  "/api/v1/conversations/{id}/email-activities":{get:{summary:"读取会话邮件活动"}},
  "/api/v1/orders/{orderId}/payment-request":{post:{summary:"创建 PayPal 付款请求"}},
  "/api/v1/orders/{orderId}/payment-request/refresh":{post:{summary:"刷新 PayPal 付款状态"}},
  "/api/v1/orders/{orderId}/payment-request/send":{post:{summary:"通过 WhatsApp 发送 PayPal 付款链接"}},
  "/api/v1/admin/order-templates":{get:{summary:"读取文字与图片订单模板"}},
  "/api/v1/admin/order-templates/{format}":{put:{summary:"更新指定格式的订单模板"}},
  "/api/v1/tags":{get:{summary:"读取标签目录"},post:{summary:"创建标签"}},
  "/api/v1/agents":{get:{summary:"查询已注册 Agent"}},
  "/api/v1/agents/{id}":{patch:{summary:"重命名或撤销 Agent"},delete:{summary:"删除 Agent 登记"}},
  "/api/v1/media":{post:{summary:"上传媒体"}},
  "/api/v1/text-to-speech":{post:{summary:"使用当前 Provider 生成语音媒体"}},
  "/api/v1/me/translation-preferences":{get:{summary:"读取当前坐席在指定会话中的翻译偏好"},put:{summary:"保存当前坐席在指定会话中的翻译偏好"}},
  "/api/v1/translation/status":{get:{summary:"读取 AI 翻译可用状态"}},
  "/api/v1/translations/preview":{post:{summary:"生成待发送文本的翻译预览"}},
  "/api/v1/translations/messages":{post:{summary:"批量读取或生成接收文字及语音消息译文"}},
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
  const principalUserId=request.principal?.kind==="user"?request.principal.id:null;
  const result = await pool.query(`SELECT c.id,c.status,c.favorite,c.unread_count,c.last_message_at,c.assigned_user_id,c.customer_stage,co.id contact_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) display_name,co.alias,co.display_name contact_name,co.phone_e164,co.avatar_url,(SELECT email FROM contact_emails WHERE contact_id=co.id AND is_primary LIMIT 1) primary_email,COALESCE((SELECT json_agg(json_build_object('id',method.id,'type',method.type,'label',method.label,'value',method.value) ORDER BY method.position,method.id) FROM contact_methods method WHERE method.contact_id=co.id),'[]'::json) contact_methods,a.id account_id,a.display_name account_name,a.status account_status,m.text_content last_message,m.kind last_message_kind,COALESCE(tag_list.tags,'[]'::json) tags,r.remind_at FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN whatsapp_accounts a ON a.id=c.account_id LEFT JOIN LATERAL (SELECT text_content,kind FROM messages WHERE conversation_id=c.id ORDER BY occurred_at DESC LIMIT 1)m ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name) tags FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=c.id)tag_list ON true LEFT JOIN reminders r ON r.conversation_id=c.id AND r.user_id=$5::uuid AND r.dismissed_at IS NULL WHERE a.agent_id IS NOT NULL AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::text IS NULL OR c.status::text=$2) AND ($3::text IS NULL OR co.alias ILIKE '%'||$3||'%' OR co.display_name ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%') AND ($4::timestamptz IS NULL OR c.last_message_at<$4) ORDER BY c.last_message_at DESC NULLS LAST LIMIT $6`, [query.accountId ?? null,query.status ?? null,query.q ?? null,query.before ?? null,principalUserId,limit+1]);
  const hasMore = result.rows.length > limit; const data = result.rows.slice(0,limit);
  return { data, nextCursor:hasMore ? data[data.length-1]?.last_message_at : null };
});

app.patch("/api/v1/conversations/:id", { preHandler:authenticate }, async (request,reply) => {
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {id}=request.params as {id:string};const body=(request.body??{}) as {assignedToMe?:boolean;favorite?:boolean;status?:string;read?:boolean;customerStage?:string};
  if(body.assignedToMe!==undefined&&typeof body.assignedToMe!=="boolean"||body.favorite!==undefined&&typeof body.favorite!=="boolean"||body.read!==undefined&&typeof body.read!=="boolean")return reply.code(400).send({error:"invalid_request"});
  if(body.status!==undefined&&!['open','closed','archived'].includes(body.status))return reply.code(400).send({error:"invalid_status"});
  if(body.customerStage!==undefined&&!customerStageSchema.safeParse(body.customerStage).success)return reply.code(400).send({error:"invalid_customer_stage"});
  const current=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);
  if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const updated=await pool.query("UPDATE conversations SET assigned_user_id=CASE WHEN $2::boolean IS NULL THEN assigned_user_id WHEN $2 THEN $6::uuid ELSE NULL END,favorite=COALESCE($3,favorite),status=COALESCE($4::conversation_status,status),closed_at=CASE WHEN $4='closed' THEN now() WHEN $4='open' THEN NULL ELSE closed_at END,unread_count=CASE WHEN $5 THEN 0 ELSE unread_count END,customer_stage=COALESCE($7,customer_stage) WHERE id=$1 RETURNING id,account_id,status,favorite,assigned_user_id,unread_count,closed_at,customer_stage",[id,body.assignedToMe??null,body.favorite??null,body.status??null,body.read??false,request.principal.id,body.customerStage??null]);
  if(["closed","archived"].includes(updated.rows[0].status)||["won","lost"].includes(updated.rows[0].customer_stage))await pool.query("UPDATE agent_jobs SET state='cancelled',completed_at=now(),last_error='conversation_no_longer_eligible' WHERE conversation_id=$1 AND state='pending' AND kind IN ('reply','followup')",[id]);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.update','conversation',$2,$3)",[request.principal.id,id,JSON.stringify(body)]);
  return updated.rows[0];
});

app.delete("/api/v1/conversations/:id", { preHandler:authenticate }, async (request,reply) => {
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required",message:"只有管理员或主管可以永久删除会话"});
  const principal=request.principal,{id}=request.params as {id:string};
  const result=await transaction(async client=>{
    const conversation=await client.query("SELECT c.account_id,c.contact_id,co.wa_jid FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 FOR UPDATE OF c",[id]);
    if(!conversation.rowCount||!canAccessAccount(principal,conversation.rows[0].account_id))return"not_found" as const;
    const payment=await client.query("SELECT 1 FROM order_payment_requests pr JOIN orders o ON o.id=pr.order_id WHERE o.conversation_id=$1 AND pr.is_current LIMIT 1",[id]);
    if(payment.rowCount)return"payment_request_exists" as const;
    const outbound=await client.query("SELECT 1 FROM outbound_commands oc JOIN messages m ON m.id=oc.message_id WHERE m.conversation_id=$1 AND oc.state IN ('pending','dispatched') LIMIT 1",[id]);
    if(outbound.rowCount)return"outbound_pending" as const;
    const pendingEmail=await client.query("SELECT 1 FROM email_messages WHERE conversation_id=$1 AND status IN ('queued','sending','retrying') LIMIT 1",[id]);
    if(pendingEmail.rowCount)return"email_pending" as const;
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.delete','conversation',$2,$3)",[principal.id,id,JSON.stringify({contactId:conversation.rows[0].contact_id,waJid:conversation.rows[0].wa_jid})]);
    await client.query("DELETE FROM conversations WHERE id=$1",[id]);
    return"deleted" as const;
  });
  if(result==="not_found")return reply.code(404).send({error:"not_found"});
  if(result==="payment_request_exists")return reply.code(409).send({error:"payment_request_exists",message:"该会话存在付款请求，请先处理或删除相关订单"});
  if(result==="outbound_pending")return reply.code(409).send({error:"outbound_pending",message:"该会话仍有待发送消息，请等待发送完成后再删除"});
  if(result==="email_pending")return reply.code(409).send({error:"email_pending",message:"该会话仍有待发送邮件，请等待发送完成后再删除"});
  return reply.code(204).send();
});

app.patch("/api/v1/conversations/:id/contact", { preHandler:authenticate }, async (request,reply) => {
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=contactAliasSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const {id}=request.params as {id:string};const current=await pool.query("SELECT c.account_id,c.contact_id FROM conversations c WHERE c.id=$1",[id]);
  if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const alias=parsed.data.alias||null;
  const result=await pool.query("UPDATE contacts SET alias=$2,updated_at=now() WHERE id=$1 RETURNING alias,COALESCE(NULLIF(alias,''),display_name,phone_e164) display_name",[current.rows[0].contact_id,alias]);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.alias.update','contact',$2,$3)",[request.principal.id,current.rows[0].contact_id,JSON.stringify({alias})]);
  return result.rows[0];
});

app.post("/api/v1/contacts",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=contactCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const phone=`+${parsed.data.phone}`,waJid=`${parsed.data.phone}@s.whatsapp.net`;
  try{
    const created=await transaction(async client=>{const contact=await client.query("INSERT INTO contacts(account_id,wa_jid,phone_e164,display_name,alias,updated_at) VALUES($1,$2,$3,$4,$4,now()) RETURNING id",[parsed.data.accountId,waJid,phone,parsed.data.name]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.create','contact',$2,$3)",[request.principal!.id,contact.rows[0].id,JSON.stringify({accountId:parsed.data.accountId,phone})]);return contact.rows[0];});
    return reply.code(201).send(await contactProfileById(pool,String(created.id)));
  }catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"contact_exists",message:"该 WhatsApp 号码已存在于当前账号的联系人中"});throw error;}
});

app.get("/api/v1/contacts",{preHandler:authenticate},async(request,reply)=>{
  const query=request.query as {q?:string;accountId?:string;limit?:string;offset?:string};
  if(query.accountId&&!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??30)||30)),offset=Math.max(0,Number(query.offset??0)||0),accountIds=request.principal?.accountIds??null;
  const result=await pool.query(`SELECT co.id,co.account_id,a.display_name account_name,co.alias,co.display_name contact_name,co.phone_e164,co.avatar_url,co.note,co.birthday_month,co.birthday_day,co.birthday_year,co.updated_at,c.id conversation_id,c.last_message_at,COUNT(*) OVER()::int total_count,
    COALESCE(email_list.emails,'[]'::json) emails,COALESCE(method_list.methods,'[]'::json) methods,COALESCE(address_list.addresses,'[]'::json) addresses,COALESCE(date_list.special_dates,'[]'::json) special_dates
    FROM contacts co JOIN whatsapp_accounts a ON a.id=co.account_id LEFT JOIN conversations c ON c.contact_id=co.id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',email.id,'label',email.label,'email',email.email,'isPrimary',email.is_primary) ORDER BY email.position,email.id) emails FROM contact_emails email WHERE email.contact_id=co.id)email_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',method.id,'type',method.type,'label',method.label,'value',method.value) ORDER BY method.position,method.id) methods FROM contact_methods method WHERE method.contact_id=co.id)method_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',address.id,'label',address.label,'recipientName',address.recipient_name,'phone',address.phone,'address',address.address) ORDER BY address.created_at,address.id) addresses FROM contact_addresses address WHERE address.contact_id=co.id)address_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',d.id,'kind',d.kind,'label',d.label,'month',d.month,'day',d.day,'year',d.year,'leadDays',d.lead_days) ORDER BY d.month,d.day,d.id) special_dates FROM contact_special_dates d WHERE d.contact_id=co.id)date_list ON true
    WHERE ($1::uuid IS NULL OR co.account_id=$1) AND ($2::uuid[] IS NULL OR co.account_id=ANY($2)) AND ($3::text IS NULL OR co.alias ILIKE '%'||$3||'%' OR co.display_name ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%' OR EXISTS(SELECT 1 FROM contact_emails e WHERE e.contact_id=co.id AND (e.email ILIKE '%'||$3||'%' OR e.label ILIKE '%'||$3||'%')) OR EXISTS(SELECT 1 FROM contact_methods m WHERE m.contact_id=co.id AND (m.value ILIKE '%'||$3||'%' OR m.label ILIKE '%'||$3||'%')))
    ORDER BY c.last_message_at DESC NULLS LAST,co.updated_at DESC,co.id LIMIT $4 OFFSET $5`,[query.accountId??null,accountIds,query.q?.trim()||null,limit,offset]);
  return{data:result.rows.map(mapContactRow),total:Number(result.rows[0]?.total_count??0),hasMore:offset+result.rows.length<Number(result.rows[0]?.total_count??0),nextOffset:offset+result.rows.length};
});

app.get("/api/v1/contacts/:id",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string},profile=await contactProfileById(pool,id);
  if(!profile||!canAccessAccount(request.principal,profile.accountId))return reply.code(404).send({error:"not_found"});
  return profile;
});

app.patch("/api/v1/contacts/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=contactUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const principal=request.principal,{id}=request.params as {id:string};
  const updated=await transaction(async client=>{
    const current=await client.query("SELECT co.account_id,co.phone_e164,EXISTS(SELECT 1 FROM conversations c WHERE c.contact_id=co.id) has_conversation FROM contacts co WHERE co.id=$1 FOR UPDATE",[id]);
    if(!current.rowCount||!canAccessAccount(principal,current.rows[0].account_id))return false;
    const nextPhone=parsed.data.phone?`+${parsed.data.phone}`:null,phoneChanged=Boolean(nextPhone&&nextPhone!==current.rows[0].phone_e164);
    if(phoneChanged&&current.rows[0].phone_e164&&current.rows[0].has_conversation)return"phone_locked" as const;
    if(phoneChanged){const duplicate=await client.query("SELECT 1 FROM contacts WHERE account_id=$1 AND wa_jid=$2 AND id<>$3 LIMIT 1",[current.rows[0].account_id,`${parsed.data.phone}@s.whatsapp.net`,id]);if(duplicate.rowCount)return"contact_exists" as const;}
    await client.query("UPDATE contacts SET alias=$2,note=$3,phone_e164=CASE WHEN $4::text IS NULL THEN phone_e164 ELSE $4 END,wa_jid=CASE WHEN $5::text IS NULL THEN wa_jid ELSE $5 END,birthday_month=CASE WHEN $6 THEN $7 ELSE birthday_month END,birthday_day=CASE WHEN $6 THEN $8 ELSE birthday_day END,birthday_year=CASE WHEN $6 THEN $9 ELSE birthday_year END,updated_at=now() WHERE id=$1",[id,parsed.data.alias||null,parsed.data.note||null,nextPhone,parsed.data.phone?`${parsed.data.phone}@s.whatsapp.net`:null,parsed.data.birthday!==undefined,parsed.data.birthday?.month??null,parsed.data.birthday?.day??null,parsed.data.birthday?.year??null]);
    if(parsed.data.birthday!==undefined){await client.query("UPDATE task_rules SET enabled=false,updated_at=now() WHERE contact_id=$1 AND source='birthday'",[id]);await client.query("UPDATE tasks SET status='cancelled',last_error='contact_birthday_changed',updated_at=now() WHERE contact_id=$1 AND source='birthday' AND status IN ('planned','in_progress','waiting_approval','scheduled','overdue')",[id]);}
    await client.query("DELETE FROM contact_emails WHERE contact_id=$1",[id]);
    for(const [position,email] of parsed.data.emails.entries())await client.query("INSERT INTO contact_emails(contact_id,label,email,is_primary,position) VALUES($1,$2,$3,$4,$5)",[id,email.label,email.email,email.isPrimary,position]);
    await client.query("DELETE FROM contact_methods WHERE contact_id=$1",[id]);
    for(const [position,method] of parsed.data.methods.entries())await client.query("INSERT INTO contact_methods(contact_id,type,label,value,position) VALUES($1,$2,$3,$4,$5)",[id,method.type,method.label,method.value,position]);
    if(parsed.data.specialDates){await client.query("UPDATE task_rules SET enabled=false,updated_at=now() WHERE contact_id=$1 AND source='special_date'",[id]);await client.query("UPDATE tasks SET status='cancelled',last_error='contact_special_dates_changed',updated_at=now() WHERE contact_id=$1 AND source='special_date' AND status IN ('planned','in_progress','waiting_approval','scheduled','overdue')",[id]);const retainedDateIds:string[]=[];for(const date of parsed.data.specialDates){if(date.id){const saved=await client.query("UPDATE contact_special_dates SET kind=$3,label=$4,month=$5,day=$6,year=$7,lead_days=$8,updated_at=now() WHERE id=$1 AND contact_id=$2 RETURNING id",[date.id,id,date.kind,date.label,date.month,date.day,date.year??null,date.leadDays??null]);if(!saved.rowCount)throw Object.assign(new Error("invalid_contact_special_date"),{statusCode:400});retainedDateIds.push(String(saved.rows[0].id));}else{const saved=await client.query("INSERT INTO contact_special_dates(contact_id,kind,label,month,day,year,lead_days) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[id,date.kind,date.label,date.month,date.day,date.year??null,date.leadDays??null]);retainedDateIds.push(String(saved.rows[0].id));}}await client.query("DELETE FROM contact_special_dates WHERE contact_id=$1 AND NOT(id=ANY($2::uuid[]))",[id,retainedDateIds]);}
    const retainedAddressIds:string[]=[];
    for(const address of parsed.data.addresses){if(address.id){const saved=await client.query("UPDATE contact_addresses SET label=$3,recipient_name=$4,phone=$5,address=$6,updated_at=now() WHERE id=$1 AND contact_id=$2 RETURNING id",[address.id,id,address.label,address.recipientName||null,address.phone||null,address.address]);if(!saved.rowCount)throw Object.assign(new Error("invalid_contact_address"),{statusCode:400});retainedAddressIds.push(String(saved.rows[0].id));}else{const saved=await client.query("INSERT INTO contact_addresses(contact_id,label,recipient_name,phone,address,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[id,address.label,address.recipientName||null,address.phone||null,address.address,principal.id]);retainedAddressIds.push(String(saved.rows[0].id));}}
    await client.query("DELETE FROM contact_addresses WHERE contact_id=$1 AND NOT(id=ANY($2::uuid[]))",[id,retainedAddressIds]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.profile.update','contact',$2,$3)",[principal.id,id,JSON.stringify({alias:parsed.data.alias,phoneChanged,emailCount:parsed.data.emails.length,methodCount:parsed.data.methods.length,addressCount:parsed.data.addresses.length,hasNote:Boolean(parsed.data.note)})]);
    return true;
  });
  if(!updated)return reply.code(404).send({error:"not_found"});
  if(updated==="phone_locked")return reply.code(409).send({error:"phone_locked",message:"该联系人已有对应会话，WhatsApp 号码不可修改"});
  if(updated==="contact_exists")return reply.code(409).send({error:"contact_exists",message:"该 WhatsApp 号码已存在于当前账号的联系人中"});
  return contactProfileById(pool,id);
});

app.delete("/api/v1/contacts/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required",message:"只有管理员或主管可以删除联系人"});
  const principal=request.principal,{id}=request.params as {id:string};
  const removed=await transaction(async client=>{const current=await client.query("SELECT account_id,avatar_url FROM contacts WHERE id=$1 FOR UPDATE",[id]);if(!current.rowCount||!canAccessAccount(principal,current.rows[0].account_id))return null;const activeTask=await client.query("SELECT 1 FROM tasks WHERE contact_id=$1 AND status NOT IN ('completed','cancelled','failed') LIMIT 1",[id]);if(activeTask.rowCount)return"active_task_exists" as const;const payment=await client.query("SELECT 1 FROM order_payment_requests pr JOIN orders o ON o.id=pr.order_id JOIN conversations c ON c.id=o.conversation_id WHERE c.contact_id=$1 AND pr.is_current LIMIT 1",[id]);if(payment.rowCount)return"payment_request_exists" as const;const outbound=await client.query("SELECT 1 FROM outbound_commands oc JOIN messages m ON m.id=oc.message_id JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=$1 AND oc.state IN ('pending','dispatched') LIMIT 1",[id]);if(outbound.rowCount)return"outbound_pending" as const;const pendingEmail=await client.query("SELECT 1 FROM email_messages e JOIN conversations c ON c.id=e.conversation_id WHERE c.contact_id=$1 AND e.status IN ('queued','sending','retrying') LIMIT 1",[id]);if(pendingEmail.rowCount)return"email_pending" as const;await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.delete','contact',$2,$3)",[principal.id,id,JSON.stringify({accountId:current.rows[0].account_id})]);await client.query("DELETE FROM contacts WHERE id=$1",[id]);return{avatarUrl:String(current.rows[0].avatar_url??"")};});
  if(!removed)return reply.code(404).send({error:"not_found"});
  if(removed==="active_task_exists")return reply.code(409).send({error:"active_task_exists",message:"该联系人仍有未完成任务，请先取消或完成任务"});
  if(removed==="payment_request_exists")return reply.code(409).send({error:"payment_request_exists",message:"该联系人的会话存在付款请求，暂时不能删除"});
  if(removed==="outbound_pending")return reply.code(409).send({error:"outbound_pending",message:"该联系人的会话仍有待发送消息，发送完成后才能删除"});
  if(removed==="email_pending")return reply.code(409).send({error:"email_pending",message:"该联系人的会话仍有待发送邮件，发送完成后才能删除"});
  if(removed.avatarUrl.startsWith("contact-avatars/"))await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:removed.avatarUrl})).catch(()=>undefined);
  return reply.code(204).send();
});

app.get("/api/v1/contacts/:id/avatar",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string};const found=await pool.query("SELECT account_id,avatar_url FROM contacts WHERE id=$1",[id]);if(!found.rowCount||!canAccessAccount(request.principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const objectKey=String(found.rows[0].avatar_url??"");if(!objectKey.startsWith("contact-avatars/"))return reply.code(404).send({error:"avatar_not_found"});const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey}));reply.header("content-type","image/webp").header("cache-control","private, max-age=300");return reply.send(object.Body);
});

app.post("/api/v1/contacts/:id/avatar",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const current=await pool.query("SELECT account_id,avatar_url FROM contacts WHERE id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});if(!["image/jpeg","image/png","image/webp"].includes(file.mimetype))return reply.code(415).send({error:"unsupported_media_type",message:"头像仅支持 JPG、PNG 或 WebP 图片"});const bytes=await file.toBuffer();if(bytes.length>5*1024*1024)return reply.code(413).send({error:"file_too_large",message:"头像文件不能超过 5 MB"});let avatar:Buffer;try{avatar=await import("sharp").then(({default:sharp})=>sharp(bytes).rotate().resize(512,512,{fit:"cover",withoutEnlargement:true}).webp({quality:86}).toBuffer());}catch{return reply.code(400).send({error:"invalid_image",message:"无法读取该图片"});}const objectKey=`contact-avatars/${current.rows[0].account_id}/${id}/${randomBytes(16).toString("hex")}.webp`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:avatar,ContentType:"image/webp"}));await transaction(async client=>{await client.query("UPDATE contacts SET avatar_url=$2,updated_at=now() WHERE id=$1",[id,objectKey]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.avatar.update','contact',$2,$3)",[request.principal!.id,id,JSON.stringify({byteSize:avatar.length})]);});const previous=String(current.rows[0].avatar_url??"");if(previous.startsWith("contact-avatars/"))await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:previous})).catch(()=>undefined);return reply.code(200).send({avatarUrl:`/api/v1/contacts/${id}/avatar`});
});

app.delete("/api/v1/contacts/:id/avatar",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const current=await pool.query("SELECT account_id,avatar_url FROM contacts WHERE id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("UPDATE contacts SET avatar_url=NULL,updated_at=now() WHERE id=$1",[id]);const previous=String(current.rows[0].avatar_url??"");if(previous.startsWith("contact-avatars/"))await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:previous})).catch(()=>undefined);return reply.code(204).send();
});

app.get("/api/v1/tags",{preHandler:authenticate},async()=>{
  const result=await pool.query("SELECT id,name,color FROM tags ORDER BY lower(name)");
  return{data:result.rows};
});

app.post("/api/v1/tags",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required"});
  const parsed=tagCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  try{const created=await pool.query("INSERT INTO tags(name,color) VALUES($1,$2) RETURNING id,name,color",[parsed.data.name,parsed.data.color]);await auditCrm(request.principal.id,"tag.create","tag",created.rows[0].id,parsed.data);return reply.code(201).send(created.rows[0]);}
  catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"tag_name_exists"});throw error;}
});

app.patch("/api/v1/tags/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required"});
  const parsed=tagUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
  try{const updated=await pool.query("UPDATE tags SET name=COALESCE($2,name),color=COALESCE($3,color) WHERE id=$1 RETURNING id,name,color",[id,parsed.data.name??null,parsed.data.color??null]);if(!updated.rowCount)return reply.code(404).send({error:"not_found"});await auditCrm(request.principal.id,"tag.update","tag",id,parsed.data);return updated.rows[0];}
  catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"tag_name_exists"});throw error;}
});

app.delete("/api/v1/tags/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};
  const removed=await pool.query("DELETE FROM tags WHERE id=$1 RETURNING id,name",[id]);if(!removed.rowCount)return reply.code(404).send({error:"not_found"});await auditCrm(request.principal.id,"tag.delete","tag",id,removed.rows[0]);return reply.code(204).send();
});

app.get("/api/v1/products",{preHandler:authenticate},async(request,reply)=>{
  const query=request.query as {q?:string;tag?:string;currency?:string;limit?:string;offset?:string};
  const parsedCurrency=query.currency?currencySchema.safeParse(query.currency):null;if(parsedCurrency&&!parsedCurrency.success)return reply.code(400).send({error:"invalid_currency"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??40)||40)),offset=Math.max(0,Number(query.offset??0)||0);
  const [result,tagOptions]=await Promise.all([pool.query(`SELECT p.id,p.sku,p.name,p.description,p.default_unit_amount,p.currency,p.image_media_id,m.file_name image_name,p.created_at,p.updated_at,COUNT(*) OVER()::int total_count,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers
    FROM products p LEFT JOIN media m ON m.id=p.image_media_id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true
    WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.name ILIKE '%'||$1||'%' OR p.sku ILIKE '%'||$1||'%' OR p.description ILIKE '%'||$1||'%') AND ($2::text IS NULL OR p.currency=$2) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM product_labels filter_label WHERE filter_label.product_id=p.id AND lower(filter_label.name)=lower($3)))
    ORDER BY p.updated_at DESC,p.id LIMIT $4 OFFSET $5`,[query.q?.trim()||null,parsedCurrency?.data??null,query.tag?.trim()||null,limit+1,offset]),pool.query("SELECT DISTINCT label.name FROM product_labels label JOIN products p ON p.id=label.product_id WHERE p.deleted_at IS NULL ORDER BY label.name")]);
  return{data:result.rows.slice(0,limit).map(mapProductRow),total:Number(result.rows[0]?.total_count??0),hasMore:result.rows.length>limit,nextOffset:result.rows.length>limit?offset+limit:null,tags:tagOptions.rows.map(row=>String(row.name))};
});

app.post("/api/v1/products/selection",{preHandler:authenticate},async(request,reply)=>{
  const body=request.body as {productIds?:unknown},ids=Array.isArray(body?.productIds)?body.productIds:[];if(ids.length<1||ids.length>100||ids.some(id=>typeof id!=="string"||!/^[0-9a-f-]{36}$/i.test(id))||new Set(ids).size!==ids.length)return reply.code(400).send({error:"invalid_request"});
  const result=await pool.query(`SELECT p.id,p.sku,p.name,p.description,p.default_unit_amount,p.currency,p.image_media_id,m.file_name image_name,p.created_at,p.updated_at,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers FROM products p LEFT JOIN media m ON m.id=p.image_media_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[ids]);
  if(result.rowCount!==ids.length)return reply.code(409).send({error:"product_unavailable"});return{data:result.rows.map(mapProductRow)};
});

app.post("/api/v1/products",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=productCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  try{const result=await transaction(async client=>{const duplicate=await client.query("SELECT id FROM products WHERE client_product_id=$1",[parsed.data.clientProductId]);if(duplicate.rowCount)return{product:await productById(client,duplicate.rows[0].id),deduplicated:true};if(parsed.data.imageMediaId){const image=await client.query("SELECT id FROM media WHERE id=$1 AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[parsed.data.imageMediaId]);if(!image.rowCount)return null;}const created=await client.query("INSERT INTO products(client_product_id,sku,name,description,default_unit_amount,currency,image_media_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",[parsed.data.clientProductId,parsed.data.sku,parsed.data.name,parsed.data.description,parsed.data.priceTiers[0].unitAmount,parsed.data.currency,parsed.data.imageMediaId??null,principal.id]);await replaceProductLabels(client,created.rows[0].id,parsed.data.tags);await replaceProductPriceTiers(client,created.rows[0].id,parsed.data.priceTiers);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.create','product',$2,$3)",[principal.id,created.rows[0].id,JSON.stringify({source:"library",sku:parsed.data.sku,tagCount:parsed.data.tags.length,tierCount:parsed.data.priceTiers.length})]);return{product:await productById(client,created.rows[0].id),deduplicated:false};});if(!result)return reply.code(400).send({error:"invalid_product_image"});return reply.code(result.deduplicated?200:201).send({...result.product,deduplicated:result.deduplicated});}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
});

app.post("/api/v1/products/bulk-import",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=productBulkImportSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const currencies=[...new Set(parsed.data.products.map(product=>product.currency))],configured=await pool.query("SELECT code FROM currency_settings WHERE code=ANY($1::text[])",[currencies]),configuredCodes=new Set(configured.rows.map(row=>String(row.code))),invalidCurrencies=currencies.filter(code=>!configuredCodes.has(code));
  if(invalidCurrencies.length)return reply.code(400).send({error:"currency_not_configured",currencies:invalidCurrencies,message:`以下币种未在货币管理中启用：${invalidCurrencies.join("、")}`});
  const skus=parsed.data.products.map(product=>product.sku.trim());const existing=await pool.query("SELECT sku FROM products WHERE deleted_at IS NULL AND lower(btrim(sku))=ANY($1::text[])",[skus.map(sku=>sku.toLocaleLowerCase())]);
  if(existing.rowCount)return reply.code(409).send({error:"sku_exists",skus:existing.rows.map(row=>String(row.sku))});
  try{const products=await transaction(async client=>{const imported=[];for(const product of parsed.data.products){if(product.imageMediaId){const image=await client.query("SELECT id FROM media WHERE id=$1 AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[product.imageMediaId]);if(!image.rowCount)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}const created=await client.query("INSERT INTO products(client_product_id,sku,name,description,default_unit_amount,currency,image_media_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",[product.clientProductId,product.sku,product.name,product.description,product.priceTiers[0].unitAmount,product.currency,product.imageMediaId??null,principal.id]);await replaceProductLabels(client,created.rows[0].id,product.tags);await replaceProductPriceTiers(client,created.rows[0].id,product.priceTiers);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.create','product',$2,$3)",[principal.id,created.rows[0].id,JSON.stringify({source:"csv_import",sku:product.sku,tagCount:product.tags.length,tierCount:product.priceTiers.length})]);imported.push(await productById(client,created.rows[0].id));}return imported;});return reply.code(201).send({created:products.length,products});}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
});

app.patch("/api/v1/products/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=productUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
  if(parsed.data.currency&&!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  try{const result=await transaction(async client=>{const found=await client.query("SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[id]);if(!found.rowCount)return undefined;if(parsed.data.imageMediaId){const image=await client.query("SELECT id FROM media WHERE id=$1 AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[parsed.data.imageMediaId]);if(!image.rowCount)return null;}const hasImage=Object.prototype.hasOwnProperty.call(parsed.data,"imageMediaId"),firstPrice=parsed.data.priceTiers?.[0].unitAmount;await client.query("UPDATE products SET sku=CASE WHEN $2 THEN $3 ELSE sku END,name=CASE WHEN $4 THEN $5 ELSE name END,description=CASE WHEN $6 THEN $7 ELSE description END,default_unit_amount=CASE WHEN $8 THEN $9 ELSE default_unit_amount END,currency=CASE WHEN $10 THEN $11 ELSE currency END,image_media_id=CASE WHEN $12 THEN $13 ELSE image_media_id END,updated_at=now() WHERE id=$1",[id,parsed.data.sku!==undefined,parsed.data.sku??null,parsed.data.name!==undefined,parsed.data.name??null,parsed.data.description!==undefined,parsed.data.description??null,firstPrice!==undefined,firstPrice??null,parsed.data.currency!==undefined,parsed.data.currency??null,hasImage,parsed.data.imageMediaId??null]);if(parsed.data.tags)await replaceProductLabels(client,id,parsed.data.tags);if(parsed.data.priceTiers)await replaceProductPriceTiers(client,id,parsed.data.priceTiers);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.update','product',$2,$3)",[principal.id,id,JSON.stringify({fields:Object.keys(parsed.data)})]);return await productById(client,id);});if(result===undefined)return reply.code(404).send({error:"not_found"});if(result===null)return reply.code(400).send({error:"invalid_product_image"});return result;}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
});

app.patch("/api/v1/products/bulk-edit",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=productBulkEditSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",issues:parsed.error.issues});
  const {productIds,operation}=parsed.data;
  try{const products=await transaction(async client=>{const found=await client.query("SELECT id,name FROM products WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL FOR UPDATE",[productIds]);if(found.rowCount!==productIds.length)throw Object.assign(new Error("product_unavailable"),{statusCode:409});
    if(operation.field==="price"){
      const factor=operation.mode==="percentIncrease"?1+operation.value/100:operation.mode==="percentDecrease"?1-operation.value/100:null;
      const tiers=await client.query("SELECT product_id,unit_amount FROM product_price_tiers WHERE product_id=ANY($1::uuid[]) FOR UPDATE",[productIds]);
      if(tiers.rows.some(row=>{const current=Number(row.unit_amount),next=operation.mode==="set"?operation.value:operation.mode==="increase"?current+operation.value:operation.mode==="decrease"?current-operation.value:current*(factor??1);return next<0||next>99_999_999.99;}))throw Object.assign(new Error("invalid_resulting_price"),{statusCode:400});
      await client.query(`UPDATE product_price_tiers SET unit_amount=round((CASE $2 WHEN 'set' THEN $3 WHEN 'increase' THEN unit_amount+$3 WHEN 'decrease' THEN unit_amount-$3 WHEN 'percentIncrease' THEN unit_amount*(1+$3/100) ELSE unit_amount*(1-$3/100) END)::numeric,2) WHERE product_id=ANY($1::uuid[])`,[productIds,operation.mode,operation.value]);
      await client.query("UPDATE products p SET default_unit_amount=t.unit_amount,updated_at=now() FROM product_price_tiers t WHERE p.id=ANY($1::uuid[]) AND t.product_id=p.id AND t.min_quantity=1",[productIds]);
    }else if(operation.field==="tags"){
      if(operation.mode==="set")await client.query("DELETE FROM product_labels WHERE product_id=ANY($1::uuid[])",[productIds]);
      if(operation.mode==="remove")await client.query("DELETE FROM product_labels WHERE product_id=ANY($1::uuid[]) AND lower(name)=ANY($2::text[])",[productIds,operation.tags.map(tag=>tag.name.toLocaleLowerCase())]);
      else for(const productId of productIds)for(const tag of uniqueProductLabels(operation.tags))await client.query("INSERT INTO product_labels(product_id,name,color) VALUES($1,$2,$3) ON CONFLICT(product_id,lower(name)) DO UPDATE SET color=EXCLUDED.color",[productId,tag.name,tag.color]);
      await client.query("UPDATE products SET updated_at=now() WHERE id=ANY($1::uuid[])",[productIds]);
    }else{
      for(const row of found.rows){const current=String(row.name);let next:string;if(operation.mode==="set")next=operation.value;else if(operation.mode==="prefix")next=operation.value+current;else if(operation.mode==="suffix")next=current+operation.value;else if("search" in operation)next=current.replaceAll(operation.search,operation.value);else throw new Error("invalid_title_operation");if(!next.trim()||next.length>120)throw Object.assign(new Error("invalid_resulting_title"),{statusCode:400});await client.query("UPDATE products SET name=$2,updated_at=now() WHERE id=$1",[row.id,next]);}
    }
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.bulk_update','product',NULL,$2)",[principal.id,JSON.stringify({productIds,operation})]);return Promise.all(productIds.map(id=>productById(client,id)));});return{updated:products.length,products};
  }catch(error){const status=(error as {statusCode?:number}).statusCode;if(status)return reply.code(status).send({error:(error as Error).message});throw error;}
});

app.delete("/api/v1/products/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const removed=await pool.query("UPDATE products SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name",[id]);if(!removed.rowCount)return reply.code(404).send({error:"not_found"});await auditCrm(request.principal.id,"product.delete","product",id,{name:removed.rows[0].name});return reply.code(204).send();
});

app.get("/api/v1/products/media",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const query=request.query as {q?:string;limit?:string};const limit=Math.min(100,Math.max(1,Number(query.limit??60)));const result=await pool.query("SELECT m.id,m.file_name,m.mime_type,m.byte_size,m.sha256,m.created_at,(SELECT COUNT(*) FROM products p WHERE p.image_media_id=m.id)::int usage_count FROM media m WHERE m.account_id IS NULL AND m.status='ready' AND m.mime_type IN ('image/png','image/jpeg') AND ($1::text IS NULL OR m.file_name ILIKE '%'||$1||'%') ORDER BY m.created_at DESC LIMIT $2",[query.q?.trim()||null,limit]);return{data:result.rows};
});

app.post("/api/v1/products/media",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});if(!["image/png","image/jpeg"].includes(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});const bytes=await file.toBuffer(),sha256=createHash("sha256").update(bytes).digest("hex");const existing=await pool.query("SELECT id,file_name,mime_type,byte_size FROM media WHERE account_id IS NULL AND sha256=$1 AND status='ready' ORDER BY created_at DESC LIMIT 1",[sha256]);if(existing.rowCount)return reply.send({mediaId:existing.rows[0].id,fileName:existing.rows[0].file_name,mimeType:existing.rows[0].mime_type,size:Number(existing.rows[0].byte_size),sha256,deduplicated:true});const objectKey=`products/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:file.mimetype,Metadata:{sha256,source:"product-library"}}));const created=await transaction(async client=>{const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES(NULL,$1,$2,$3,$4,$5) RETURNING id",[objectKey,file.filename,file.mimetype,bytes.length,sha256]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.media_upload','media',$2,$3)",[principal.id,media.rows[0].id,JSON.stringify({fileName:file.filename,mimeType:file.mimetype,byteSize:bytes.length,sha256})]);return media.rows[0];});return reply.code(201).send({mediaId:created.id,fileName:file.filename,mimeType:file.mimetype,size:bytes.length,sha256,deduplicated:false});
});

app.get("/api/v1/collage-templates",{preHandler:authenticate},async()=>{
  const result=await pool.query("SELECT id,name,template,is_default,created_by,updated_by,created_at,updated_at FROM collage_templates WHERE deleted_at IS NULL ORDER BY is_default DESC,updated_at DESC,id");
  return{data:result.rows.map(row=>({...row,template:parseCollageTemplate(row.template),slotCount:productSlotIds(parseCollageTemplate(row.template)).length}))};
});

app.post("/api/v1/collage-templates",{preHandler:authenticate},async(request,reply)=>{
  if(!canManageMaterials(request.principal))return reply.code(403).send({error:"supervisor_required"});const parsed=collageTemplateCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!await collageMediaValid(parsed.data.template))return reply.code(400).send({error:"invalid_template_media"});
  const row=await transaction(async client=>{if(parsed.data.isDefault)await client.query("UPDATE collage_templates SET is_default=false,updated_at=now() WHERE is_default AND deleted_at IS NULL");const created=await client.query("INSERT INTO collage_templates(name,template,is_default,created_by,updated_by) VALUES($1,$2::jsonb,$3,$4,$4) RETURNING *",[parsed.data.name,JSON.stringify(parsed.data.template),parsed.data.isDefault,request.principal!.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'collage_template.create','collage_template',$2,$3)",[request.principal!.id,created.rows[0].id,JSON.stringify({name:parsed.data.name,slotCount:productSlotIds(parsed.data.template).length,isDefault:parsed.data.isDefault})]);return created.rows[0];});
  return reply.code(201).send({...row,template:parseCollageTemplate(row.template),slotCount:productSlotIds(parseCollageTemplate(row.template)).length});
});

app.patch("/api/v1/collage-templates/:id",{preHandler:authenticate},async(request,reply)=>{
  if(!canManageMaterials(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},parsed=collageTemplateUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(parsed.data.template&&!await collageMediaValid(parsed.data.template))return reply.code(400).send({error:"invalid_template_media"});
  const row=await transaction(async client=>{const found=await client.query("SELECT id FROM collage_templates WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[id]);if(!found.rowCount)return null;if(parsed.data.isDefault)await client.query("UPDATE collage_templates SET is_default=false,updated_at=now() WHERE id<>$1 AND is_default AND deleted_at IS NULL",[id]);const saved=await client.query("UPDATE collage_templates SET name=COALESCE($2,name),template=COALESCE($3::jsonb,template),is_default=COALESCE($4,is_default),updated_by=$5,updated_at=now() WHERE id=$1 RETURNING *",[id,parsed.data.name??null,parsed.data.template?JSON.stringify(parsed.data.template):null,parsed.data.isDefault??null,request.principal!.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'collage_template.update','collage_template',$2,$3)",[request.principal!.id,id,JSON.stringify({fields:Object.keys(parsed.data)})]);return saved.rows[0];});
  if(!row)return reply.code(404).send({error:"not_found"});return{...row,template:parseCollageTemplate(row.template),slotCount:productSlotIds(parseCollageTemplate(row.template)).length};
});

app.delete("/api/v1/collage-templates/:id",{preHandler:authenticate},async(request,reply)=>{
  if(!canManageMaterials(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const removed=await transaction(async client=>{const row=await client.query("UPDATE collage_templates SET deleted_at=now(),is_default=false,updated_by=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,name",[id,request.principal!.id]);if(!row.rowCount)return null;await client.query("UPDATE collage_templates SET is_default=true,updated_at=now() WHERE id=(SELECT id FROM collage_templates WHERE deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM collage_templates WHERE is_default AND deleted_at IS NULL)");await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'collage_template.delete','collage_template',$2,$3)",[request.principal!.id,id,JSON.stringify({name:row.rows[0].name})]);return row.rows[0];});if(!removed)return reply.code(404).send({error:"not_found"});return reply.code(204).send();
});

app.post("/api/v1/collage-template-assets",{preHandler:authenticate},async(request,reply)=>{
  if(!canManageMaterials(request.principal))return reply.code(403).send({error:"supervisor_required"});const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});if(!["image/png","image/jpeg","image/webp"].includes(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});const bytes=await file.toBuffer();try{await import("sharp").then(({default:sharp})=>sharp(bytes).metadata());}catch{return reply.code(400).send({error:"invalid_image"});}const stored=await storeSharedImage(file.filename,file.mimetype,bytes,"collage-template",request.principal!.id);return reply.code(stored.deduplicated?200:201).send(stored);
});

app.post("/api/v1/materials/generate",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=materialGenerateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const existing=await materialBatchByClientId(parsed.data.clientGenerationId);if(existing)return reply.send({...existing,deduplicated:true});
  const templateResult=await pool.query("SELECT id,name,template FROM collage_templates WHERE id=$1 AND deleted_at IS NULL",[parsed.data.templateId]);if(!templateResult.rowCount)return reply.code(404).send({error:"template_not_found"});const template=parseCollageTemplate(templateResult.rows[0].template),slotIds=productSlotIds(template);
  const productResult=await pool.query(`SELECT p.id,p.name,p.sku,p.currency,p.default_unit_amount,p.image_media_id,m.object_key,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(label_list.tags,'[]'::json) tags FROM products p LEFT JOIN media m ON m.id=p.image_media_id AND m.status='ready' LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) price_tiers FROM product_price_tiers t WHERE t.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('name',l.name) ORDER BY lower(l.name)) tags FROM product_labels l WHERE l.product_id=p.id) label_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[parsed.data.productIds]);
  if(productResult.rowCount!==parsed.data.productIds.length)return reply.code(409).send({error:"product_unavailable"});const missing=productResult.rows.filter(row=>!row.image_media_id||!row.object_key);if(missing.length)return reply.code(409).send({error:"product_image_required",products:missing.map(row=>({id:row.id,name:row.name,sku:row.sku}))});
  const products:CollageProduct[]=await Promise.all(productResult.rows.map(async row=>{const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));if(!object.Body)throw Object.assign(new Error("product_image_unavailable"),{statusCode:409});return{id:String(row.id),name:String(row.name),sku:String(row.sku),currency:String(row.currency),defaultUnitAmount:Number(row.default_unit_amount),priceTiers:(row.price_tiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})),tags:(row.tags as Array<Record<string,unknown>>).map(tag=>({name:String(tag.name)})),image:Buffer.from(await object.Body.transformToByteArray())};}));
  const assetIds=collageMediaIds(template),assetRows=assetIds.length?await pool.query("SELECT id,object_key FROM media WHERE id=ANY($1::uuid[]) AND account_id IS NULL AND status='ready'",[assetIds]):{rows:[],rowCount:0},assets=new Map<string,Buffer>();for(const row of assetRows.rows){const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));if(object.Body)assets.set(String(row.id),Buffer.from(await object.Body.transformToByteArray()));}
  const pages=[] as Array<{bytes:Buffer;productIds:string[];objectKey:string;sha256:string;fileName:string}>;let committed=false;try{for(let start=0,page=0;start<products.length;start+=slotIds.length,page++){const selected=products.slice(start,start+slotIds.length),bytes=await renderCollagePage(template,selected,assets),sha256=createHash("sha256").update(bytes).digest("hex"),objectKey=`materials/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}.png`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:"image/png",Metadata:{sha256,source:"material-collage"}}));pages.push({bytes,productIds:selected.map(product=>product.id),objectKey,sha256,fileName:`${safeFileName(parsed.data.name)}-${page+1}.png`});}
  const created=await transaction(async client=>{const duplicate=await client.query("SELECT id FROM material_batches WHERE client_generation_id=$1",[parsed.data.clientGenerationId]);if(duplicate.rowCount)return null;const snapshots=products.map(product=>({id:product.id,name:product.name,sku:product.sku,currency:product.currency,defaultUnitAmount:product.defaultUnitAmount,priceTiers:product.priceTiers,tags:product.tags})),batch=await client.query("INSERT INTO material_batches(client_generation_id,name,template_id,template_name,template_snapshot,product_snapshot,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING id",[parsed.data.clientGenerationId,parsed.data.name,parsed.data.templateId,templateResult.rows[0].name,JSON.stringify(template),JSON.stringify(snapshots),principal.id]);for(const [index,page] of pages.entries()){const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES(NULL,$1,$2,'image/png',$3,$4) RETURNING id",[page.objectKey,page.fileName,page.bytes.length,page.sha256]);await client.query("INSERT INTO material_assets(batch_id,media_id,page_index,product_ids) VALUES($1,$2,$3,$4::jsonb)",[batch.rows[0].id,media.rows[0].id,index,JSON.stringify(page.productIds)]);}await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'material.generate','material_batch',$2,$3)",[principal.id,batch.rows[0].id,JSON.stringify({templateId:parsed.data.templateId,productIds:parsed.data.productIds,pageCount:pages.length})]);return batch.rows[0].id;});if(!created){await Promise.allSettled(pages.map(page=>s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:page.objectKey}))));const duplicate=await materialBatchByClientId(parsed.data.clientGenerationId);return reply.send({...duplicate,deduplicated:true});}committed=true;const result=await materialBatchById(created);return reply.code(201).send({...result,deduplicated:false});}catch(error){if(!committed)await Promise.allSettled(pages.map(page=>s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:page.objectKey}))));if((error as {code?:string}).code==="23505"){const duplicate=await materialBatchByClientId(parsed.data.clientGenerationId);if(duplicate)return reply.send({...duplicate,deduplicated:true});}throw error;}
});

app.get("/api/v1/materials",{preHandler:authenticate},async(request)=>{const query=request.query as {q?:string;limit?:string;offset?:string},limit=Math.min(50,Math.max(1,Number(query.limit??20))),offset=Math.max(0,Number(query.offset??0));const [rows,count]=await Promise.all([pool.query(`SELECT b.id,b.name,b.template_id,b.template_name,b.created_at,u.display_name created_by_name,jsonb_array_length(b.product_snapshot)::int product_count,COUNT(a.media_id)::int page_count,(array_agg(a.media_id ORDER BY a.page_index))[1] cover_media_id FROM material_batches b LEFT JOIN users u ON u.id=b.created_by LEFT JOIN material_assets a ON a.batch_id=b.id WHERE ($1::text IS NULL OR b.name ILIKE '%'||$1||'%' OR b.template_name ILIKE '%'||$1||'%') GROUP BY b.id,u.display_name ORDER BY b.created_at DESC,b.id LIMIT $2 OFFSET $3`,[query.q?.trim()||null,limit,offset]),pool.query("SELECT COUNT(*)::int total FROM material_batches b WHERE ($1::text IS NULL OR b.name ILIKE '%'||$1||'%' OR b.template_name ILIKE '%'||$1||'%')",[query.q?.trim()||null])]);return{data:rows.rows,total:Number(count.rows[0]?.total??0)};});
app.get("/api/v1/materials/:id",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string},batch=await materialBatchById(id);return batch??reply.code(404).send({error:"not_found"});});
app.delete("/api/v1/materials/:id",{preHandler:authenticate},async(request,reply)=>{if(!canManageMaterials(request.principal))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string},found=await pool.query("SELECT a.media_id,m.object_key,((SELECT COUNT(*) FROM messages msg WHERE msg.media_id=m.id)+(SELECT COUNT(*) FROM order_items item WHERE item.image_media_id=m.id)+(SELECT COUNT(*) FROM orders o WHERE o.rendered_media_id=m.id)+(SELECT COUNT(*) FROM products p WHERE p.image_media_id=m.id)+(SELECT COUNT(*) FROM email_attachments e WHERE e.media_id=m.id))::int external_usage_count FROM material_assets a JOIN media m ON m.id=a.media_id WHERE a.batch_id=$1 ORDER BY a.page_index",[id]);if(!found.rowCount)return reply.code(404).send({error:"not_found"});const pageCount=found.rows.length,removable=found.rows.filter(row=>Number(row.external_usage_count)===0);await transaction(async client=>{await client.query("DELETE FROM material_assets WHERE batch_id=$1",[id]);await client.query("DELETE FROM material_batches WHERE id=$1",[id]);if(removable.length)await client.query("DELETE FROM media WHERE id=ANY($1::uuid[])",[removable.map(row=>row.media_id)]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'material.delete','material_batch',$2,$3)",[request.principal!.id,id,JSON.stringify({pageCount,removedMediaCount:removable.length,retainedMediaCount:pageCount-removable.length})]);});await Promise.allSettled(removable.map(row=>s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}))));return reply.code(204).send();});

app.get("/api/v1/conversations/:id/details",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string};const conversation=await pool.query("SELECT account_id,customer_stage,contact_id FROM conversations WHERE id=$1",[id]);
  if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const userId=request.principal?.kind==="user"?request.principal.id:null;
  const [tags,notes,reminder,orders,addresses,contact]=await Promise.all([
    pool.query("SELECT t.id,t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[id]),
    pool.query("SELECT n.id,n.body,n.user_id,n.created_at,n.updated_at,u.display_name author_name FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.conversation_id=$1 ORDER BY n.created_at DESC LIMIT 50",[id]),
    userId?pool.query("SELECT id,remind_at,created_at,updated_at FROM reminders WHERE conversation_id=$1 AND user_id=$2 AND dismissed_at IS NULL",[id,userId]):Promise.resolve({rows:[]}),
    pool.query("SELECT o.id,o.display_order_number,o.order_number,o.amount,o.currency,o.description,o.status,o.send_format,o.translate_on_send,o.target_language,o.address_id,o.shipping_address_snapshot,o.created_at,u.display_name created_by_name,COALESCE(m.status::text,o.status) message_status,COALESCE(item_list.items,'[]'::json) items,COALESCE(fee_list.fees,'[]'::json) fees,payment.payment_request FROM orders o LEFT JOIN users u ON u.id=o.created_by LEFT JOIN messages m ON m.id=o.summary_message_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',i.id,'name',i.product_name,'sku',i.product_sku,'quantity',i.quantity,'unitAmount',i.unit_amount,'imageMediaId',i.image_media_id,'imageName',media.file_name,'productId',i.product_id) ORDER BY i.position) items FROM order_items i LEFT JOIN media ON media.id=i.image_media_id WHERE i.order_id=o.id)item_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',f.id,'name',f.name,'amount',f.amount) ORDER BY f.position) fees FROM order_fees f WHERE f.order_id=o.id)fee_list ON true LEFT JOIN LATERAL (SELECT json_build_object('id',pr.id,'invoiceId',pr.provider_request_id,'url',pr.payment_url,'status',pr.status,'amount',pr.amount,'currency',pr.currency,'environment',pr.environment,'createdAt',pr.created_at,'lastSyncedAt',pr.last_synced_at) payment_request FROM order_payment_requests pr WHERE pr.order_id=o.id AND pr.is_current ORDER BY pr.created_at DESC LIMIT 1)payment ON true WHERE o.conversation_id=$1 AND o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 20",[id]),
    pool.query("SELECT ca.id,ca.label,ca.recipient_name,ca.phone,ca.address,ca.created_at,ca.updated_at FROM contact_addresses ca JOIN conversations c ON c.contact_id=ca.contact_id WHERE c.id=$1 ORDER BY ca.created_at DESC",[id]),
    contactProfileById(pool,conversation.rows[0].contact_id),
  ]);
  return{customerStage:conversation.rows[0].customer_stage,contact,tags:tags.rows,notes:notes.rows,reminder:reminder.rows[0]??null,orders:orders.rows,addresses:addresses.rows};
});

app.get("/api/v1/conversations/:id/addresses",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string};const conversation=await pool.query("SELECT account_id,contact_id FROM conversations WHERE id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});const result=await pool.query("SELECT id,label,recipient_name,phone,address,created_at,updated_at FROM contact_addresses WHERE contact_id=$1 ORDER BY created_at DESC",[conversation.rows[0].contact_id]);return{data:result.rows};
});

app.put("/api/v1/conversations/:id/tags",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=conversationTagsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
  const current=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const unique=[...new Set(parsed.data.tagIds)];const result=await transaction(async client=>{if(unique.length){const found=await client.query("SELECT id FROM tags WHERE id=ANY($1::uuid[])",[unique]);if(found.rowCount!==unique.length)return null;}await client.query("DELETE FROM conversation_tags WHERE conversation_id=$1",[id]);if(unique.length)await client.query("INSERT INTO conversation_tags(conversation_id,tag_id) SELECT $1,unnest($2::uuid[])",[id,unique]);const selected=await client.query("SELECT t.id,t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[id]);return selected.rows;});
  if(!result)return reply.code(400).send({error:"unknown_tag"});await auditCrm(request.principal.id,"conversation.tags","conversation",id,{tagIds:unique});return{data:result};
});

app.post("/api/v1/conversations/:id/notes",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=noteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
  const current=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});const created=await pool.query("INSERT INTO notes(conversation_id,user_id,body) VALUES($1,$2,$3) RETURNING id,body,user_id,created_at,updated_at",[id,request.principal.id,parsed.data.body]);await auditCrm(request.principal.id,"note.create","note",created.rows[0].id,{conversationId:id});return reply.code(201).send({...created.rows[0],author_name:null});
});

app.patch("/api/v1/conversations/:conversationId/notes/:noteId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=noteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,noteId}=request.params as {conversationId:string;noteId:string};const note=await pool.query("SELECT n.user_id,c.account_id FROM notes n JOIN conversations c ON c.id=n.conversation_id WHERE n.id=$1 AND n.conversation_id=$2",[noteId,conversationId]);if(!note.rowCount||!canAccessAccount(request.principal,note.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(!canManageSharedRecord(request.principal.role,note.rows[0].user_id,request.principal.id))return reply.code(403).send({error:"note_owner_required"});const updated=await pool.query("UPDATE notes SET body=$2,updated_at=now() WHERE id=$1 RETURNING id,body,user_id,created_at,updated_at",[noteId,parsed.data.body]);await auditCrm(request.principal.id,"note.update","note",noteId,{conversationId});return updated.rows[0];
});

app.delete("/api/v1/conversations/:conversationId/notes/:noteId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {conversationId,noteId}=request.params as {conversationId:string;noteId:string};const note=await pool.query("SELECT n.user_id,c.account_id FROM notes n JOIN conversations c ON c.id=n.conversation_id WHERE n.id=$1 AND n.conversation_id=$2",[noteId,conversationId]);if(!note.rowCount||!canAccessAccount(request.principal,note.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(!canManageSharedRecord(request.principal.role,note.rows[0].user_id,request.principal.id))return reply.code(403).send({error:"note_owner_required"});await pool.query("DELETE FROM notes WHERE id=$1",[noteId]);await auditCrm(request.principal.id,"note.delete","note",noteId,{conversationId});return reply.code(204).send();
});

app.put("/api/v1/conversations/:id/reminder",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=reminderSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};const current=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});const saved=await pool.query("INSERT INTO reminders(conversation_id,user_id,remind_at) VALUES($1,$2,$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET remind_at=EXCLUDED.remind_at,dismissed_at=NULL,updated_at=now() RETURNING id,remind_at,created_at,updated_at",[id,request.principal.id,parsed.data.remindAt]);await auditCrm(request.principal.id,"reminder.set","conversation",id,{remindAt:parsed.data.remindAt.toISOString()});return saved.rows[0];
});

app.delete("/api/v1/conversations/:id/reminder",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const current=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("UPDATE reminders SET dismissed_at=now(),updated_at=now() WHERE conversation_id=$1 AND user_id=$2 AND dismissed_at IS NULL",[id,request.principal.id]);await auditCrm(request.principal.id,"reminder.dismiss","conversation",id,{});return reply.code(204).send();
});

app.get("/api/v1/orders",{preHandler:authenticate},async(request,reply)=>{
  const query=request.query as {accountId?:string;status?:string;q?:string;dateFrom?:string;dateTo?:string;cursor?:string;limit?:string};
  if(query.accountId&&!canAccessAccount(request.principal,query.accountId))return{data:[],nextCursor:null,total:0};
  if(query.status&&!['draft','queued'].includes(query.status))return reply.code(400).send({error:"invalid_status"});
  const requestedLimit=Number(query.limit??30),limit=Number.isFinite(requestedLimit)?Math.min(100,Math.max(1,Math.trunc(requestedLimit))):30;
  if(query.dateFrom&&!/^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom)||query.dateTo&&!/^\d{4}-\d{2}-\d{2}$/.test(query.dateTo))return reply.code(400).send({error:"invalid_date"});
  let cursorDate:string|null=null,cursorId:string|null=null;
  if(query.cursor){try{const decoded=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")) as {createdAt?:string;id?:string};cursorDate=decoded.createdAt??null;cursorId=decoded.id??null;if(!cursorDate||Number.isNaN(Date.parse(cursorDate))||!cursorId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursorId))throw new Error("invalid cursor");}catch{return reply.code(400).send({error:"invalid_cursor"});}}
  const accountIds=request.principal?.accountIds??null;
  const result=await pool.query(`SELECT o.id,o.display_order_number,o.order_number,o.conversation_id,c.account_id,a.display_name account_name,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) customer_name,co.phone_e164 customer_phone,o.amount,o.currency,o.description,o.status,o.send_format,o.translate_on_send,o.target_language,o.address_id,o.shipping_address_snapshot,o.created_at,u.display_name created_by_name,COALESCE(m.status::text,o.status) message_status,COUNT(*) OVER()::int total_count,COALESCE(item_list.items,'[]'::json) items,COALESCE(fee_list.fees,'[]'::json) fees,payment.payment_request
    FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN users u ON u.id=o.created_by LEFT JOIN messages m ON m.id=o.summary_message_id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',i.id,'name',i.product_name,'sku',i.product_sku,'quantity',i.quantity,'unitAmount',i.unit_amount,'imageMediaId',i.image_media_id,'imageName',media.file_name,'productId',i.product_id) ORDER BY i.position) items FROM order_items i LEFT JOIN media ON media.id=i.image_media_id WHERE i.order_id=o.id)item_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',f.id,'name',f.name,'amount',f.amount) ORDER BY f.position) fees FROM order_fees f WHERE f.order_id=o.id)fee_list ON true
    LEFT JOIN LATERAL (SELECT json_build_object('id',pr.id,'invoiceId',pr.provider_request_id,'url',pr.payment_url,'status',pr.status,'amount',pr.amount,'currency',pr.currency,'environment',pr.environment,'createdAt',pr.created_at,'lastSyncedAt',pr.last_synced_at) payment_request FROM order_payment_requests pr WHERE pr.order_id=o.id AND pr.is_current ORDER BY pr.created_at DESC LIMIT 1)payment ON true
    WHERE o.deleted_at IS NULL AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::text IS NULL OR o.status=$2) AND ($3::text IS NULL OR o.display_order_number ILIKE '%'||$3||'%' OR co.alias ILIKE '%'||$3||'%' OR co.display_name ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%') AND ($4::date IS NULL OR o.created_at >= $4::date) AND ($5::date IS NULL OR o.created_at < $5::date + interval '1 day') AND ($6::timestamptz IS NULL OR (o.created_at,o.id)<($6::timestamptz,$7::uuid)) AND ($8::uuid[] IS NULL OR c.account_id=ANY($8))
    ORDER BY o.created_at DESC,o.id DESC LIMIT $9`,[query.accountId??null,query.status??null,query.q?.trim()||null,query.dateFrom??null,query.dateTo??null,cursorDate,cursorId,accountIds,limit+1]);
  const hasMore=result.rows.length>limit,data=result.rows.slice(0,limit),last=data[data.length-1];
  return{data,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({createdAt:last.created_at,id:last.id}),"utf8").toString("base64url"):null,total:Number(data[0]?.total_count??0)};
});

app.get("/api/v1/currencies",{preHandler:authenticate},async()=>{
  const [result,metadata]=await Promise.all([pool.query("SELECT code,name,rate,is_base FROM currency_settings ORDER BY position,code"),pool.query("SELECT source,rate_date,updated_at FROM currency_rate_metadata WHERE singleton=true")]),rateMetadata=metadata.rows[0];
  return{baseCurrency:String(result.rows.find(row=>row.is_base)?.code??"USD"),currencies:result.rows.map(row=>({code:String(row.code),name:String(row.name),rate:Number(row.rate)})),rateSource:rateMetadata?.source??null,rateDate:rateMetadata?.rate_date??null,rateUpdatedAt:rateMetadata?.updated_at??null};
});

app.put("/api/v1/admin/currencies",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const parsed=currencySettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const nextCodes=parsed.data.currencies.map(item=>item.code),inUse=await pool.query("SELECT currency,source FROM (SELECT DISTINCT currency,'product'::text source FROM products WHERE deleted_at IS NULL UNION ALL SELECT DISTINCT currency,'order'::text source FROM orders WHERE deleted_at IS NULL) used WHERE NOT(currency=ANY($1::text[])) LIMIT 1",[nextCodes]);
  if(inUse.rowCount)return reply.code(409).send({error:"currency_in_use",message:`${inUse.rows[0].currency} 仍被${inUse.rows[0].source==="product"?"产品":"订单"}使用，无法删除`});
  await transaction(async client=>{await client.query("UPDATE currency_settings SET is_base=false");await client.query("DELETE FROM currency_settings WHERE NOT(code=ANY($1::text[]))",[nextCodes]);for(const [position,item] of parsed.data.currencies.entries())await client.query("INSERT INTO currency_settings(code,name,rate,is_base,position,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,rate=EXCLUDED.rate,is_base=EXCLUDED.is_base,position=EXCLUDED.position,updated_by=EXCLUDED.updated_by,updated_at=now()",[item.code,item.name,item.rate,item.code===parsed.data.baseCurrency,position,request.principal!.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'currency.settings.update','currency_settings','workspace',$2)",[request.principal!.id,JSON.stringify({baseCurrency:parsed.data.baseCurrency,currencies:parsed.data.currencies})]);});
  return{baseCurrency:parsed.data.baseCurrency,currencies:parsed.data.currencies};
});

app.post("/api/v1/admin/currencies/refresh-rates",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const parsed=currencySettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const nextCodes=parsed.data.currencies.map(item=>item.code),inUse=await pool.query("SELECT currency,source FROM (SELECT DISTINCT currency,'product'::text source FROM products WHERE deleted_at IS NULL UNION ALL SELECT DISTINCT currency,'order'::text source FROM orders WHERE deleted_at IS NULL) used WHERE NOT(currency=ANY($1::text[])) LIMIT 1",[nextCodes]);
  if(inUse.rowCount)return reply.code(409).send({error:"currency_in_use",message:`${inUse.rows[0].currency} 仍被${inUse.rows[0].source==="product"?"产品":"订单"}使用，无法删除`});
  let latest:Awaited<ReturnType<typeof fetchLatestExchangeRates>>;try{latest=await fetchLatestExchangeRates(parsed.data.baseCurrency,parsed.data.currencies.map(item=>item.code));}catch(error){request.log.warn({error:error instanceof Error?error.message:String(error)},"Public exchange rate refresh failed");return reply.code(502).send({error:"exchange_rate_provider_unavailable",message:error instanceof Error?error.message:"公共汇率服务暂时不可用"});}
  const currencies=parsed.data.currencies.map(item=>({...item,rate:latest.rates[item.code]}));
  const rateUpdatedAt=await transaction(async client=>{await client.query("UPDATE currency_settings SET is_base=false");await client.query("DELETE FROM currency_settings WHERE NOT(code=ANY($1::text[]))",[nextCodes]);for(const [position,item] of currencies.entries())await client.query("INSERT INTO currency_settings(code,name,rate,is_base,position,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,rate=EXCLUDED.rate,is_base=EXCLUDED.is_base,position=EXCLUDED.position,updated_by=EXCLUDED.updated_by,updated_at=now()",[item.code,item.name,item.rate,item.code===parsed.data.baseCurrency,position,request.principal!.id]);const metadata=await client.query("INSERT INTO currency_rate_metadata(singleton,source,rate_date,updated_by) VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET source=EXCLUDED.source,rate_date=EXCLUDED.rate_date,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING updated_at",["Frankfurter",latest.date,request.principal!.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'currency.rates.refresh','currency_settings','workspace',$2)",[request.principal!.id,JSON.stringify({baseCurrency:parsed.data.baseCurrency,currencies:currencies.map(item=>item.code),source:"Frankfurter",rateDate:latest.date})]);return metadata.rows[0].updated_at;});
  return{baseCurrency:parsed.data.baseCurrency,currencies,rateSource:"Frankfurter",rateDate:latest.date,rateUpdatedAt,updatedCount:Math.max(0,currencies.length-1)};
});

app.get("/api/v1/admin/order-settings",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT number_template,timezone,updated_at FROM order_settings WHERE singleton=true");
  const row=result.rows[0]??{number_template:"{YYYY}{MM}{DD}-{SEQ:3}",timezone:"Asia/Shanghai",updated_at:null};
  return{numberTemplate:row.number_template,timezone:row.timezone,preview:orderNumberPreview({template:row.number_template,timezone:row.timezone}),updatedAt:row.updated_at};
});

app.put("/api/v1/admin/order-settings",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const parsed=orderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const templateError=validateOrderNumberTemplate(parsed.data.numberTemplate);if(templateError)return reply.code(400).send({error:"invalid_template",message:templateError});
  if(!isValidTimeZone(parsed.data.timezone))return reply.code(400).send({error:"invalid_timezone",message:"请输入有效的 IANA 时区"});
  const saved=await pool.query("INSERT INTO order_settings(singleton,number_template,timezone,updated_by) VALUES(true,$1,$2,$3) ON CONFLICT(singleton) DO UPDATE SET number_template=EXCLUDED.number_template,timezone=EXCLUDED.timezone,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING number_template,timezone,updated_at",[parsed.data.numberTemplate,parsed.data.timezone,request.principal.id]);
  await auditCrm(request.principal.id,"order.settings.update","order_settings","workspace",{numberTemplate:parsed.data.numberTemplate,timezone:parsed.data.timezone});
  const row=saved.rows[0];return{numberTemplate:row.number_template,timezone:row.timezone,preview:orderNumberPreview({template:row.number_template,timezone:row.timezone}),updatedAt:row.updated_at};
});

app.get("/api/v1/admin/paypal-settings",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  reply.header("cache-control","no-store");
  const result=await pool.query("SELECT enabled,environment,sandbox_client_id_encrypted,sandbox_client_secret_encrypted,live_client_id_encrypted,live_client_secret_encrypted,reference_template,note_template,item_name_template,updated_at FROM paypal_settings WHERE singleton=true"),row=result.rows[0]??{},environment:PayPalEnvironment=row.environment==="live"?"live":"sandbox",clientIdEncrypted=environment==="sandbox"?row.sandbox_client_id_encrypted:row.live_client_id_encrypted,clientSecretEncrypted=environment==="sandbox"?row.sandbox_client_secret_encrypted:row.live_client_secret_encrypted;
  return{enabled:Boolean(row.enabled),environment,clientIdConfigured:Boolean(clientIdEncrypted),clientSecretConfigured:Boolean(clientSecretEncrypted),clientId:clientIdEncrypted?decryptAtRest(clientIdEncrypted,config.DATA_ENCRYPTION_KEY):"",clientSecret:clientSecretEncrypted?decryptAtRest(clientSecretEncrypted,config.DATA_ENCRYPTION_KEY):"",sandboxClientIdConfigured:Boolean(row.sandbox_client_id_encrypted),sandboxClientSecretConfigured:Boolean(row.sandbox_client_secret_encrypted),sandboxClientId:row.sandbox_client_id_encrypted?decryptAtRest(row.sandbox_client_id_encrypted,config.DATA_ENCRYPTION_KEY):"",sandboxClientSecret:row.sandbox_client_secret_encrypted?decryptAtRest(row.sandbox_client_secret_encrypted,config.DATA_ENCRYPTION_KEY):"",liveClientIdConfigured:Boolean(row.live_client_id_encrypted),liveClientSecretConfigured:Boolean(row.live_client_secret_encrypted),liveClientId:row.live_client_id_encrypted?decryptAtRest(row.live_client_id_encrypted,config.DATA_ENCRYPTION_KEY):"",liveClientSecret:row.live_client_secret_encrypted?decryptAtRest(row.live_client_secret_encrypted,config.DATA_ENCRYPTION_KEY):"",referenceTemplate:row.reference_template??DEFAULT_PAYPAL_REFERENCE_TEMPLATE,noteTemplate:row.note_template??DEFAULT_PAYPAL_NOTE_TEMPLATE,itemNameTemplate:row.item_name_template??DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE,updatedAt:row.updated_at??null};
});

app.put("/api/v1/admin/paypal-settings",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const parsed=paypalSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  for(const [field,template,scope] of [["referenceTemplate",parsed.data.referenceTemplate,"global"],["noteTemplate",parsed.data.noteTemplate,"global"],["itemNameTemplate",parsed.data.itemNameTemplate,"item"]] as const){const templateError=validatePayPalTemplate(template,scope);if(templateError)return reply.code(400).send({error:"invalid_template",field,message:templateError});}
  const current=await pool.query("SELECT sandbox_client_id_encrypted,sandbox_client_secret_encrypted,live_client_id_encrypted,live_client_secret_encrypted FROM paypal_settings WHERE singleton=true"),row=current.rows[0]??{},legacyClientId=parsed.data.clientId,legacyClientSecret=parsed.data.clientSecret;
  const sandboxClientId=parsed.data.sandboxClientId??(parsed.data.environment==="sandbox"?legacyClientId:undefined),sandboxClientSecret=parsed.data.sandboxClientSecret??(parsed.data.environment==="sandbox"?legacyClientSecret:undefined),liveClientId=parsed.data.liveClientId??(parsed.data.environment==="live"?legacyClientId:undefined),liveClientSecret=parsed.data.liveClientSecret??(parsed.data.environment==="live"?legacyClientSecret:undefined);
  const sandboxClientIdEncrypted=sandboxClientId?encryptAtRest(sandboxClientId,config.DATA_ENCRYPTION_KEY):row.sandbox_client_id_encrypted??null,sandboxClientSecretEncrypted=sandboxClientSecret?encryptAtRest(sandboxClientSecret,config.DATA_ENCRYPTION_KEY):row.sandbox_client_secret_encrypted??null,liveClientIdEncrypted=liveClientId?encryptAtRest(liveClientId,config.DATA_ENCRYPTION_KEY):row.live_client_id_encrypted??null,liveClientSecretEncrypted=liveClientSecret?encryptAtRest(liveClientSecret,config.DATA_ENCRYPTION_KEY):row.live_client_secret_encrypted??null;
  const selectedClientIdEncrypted=parsed.data.environment==="sandbox"?sandboxClientIdEncrypted:liveClientIdEncrypted,selectedClientSecretEncrypted=parsed.data.environment==="sandbox"?sandboxClientSecretEncrypted:liveClientSecretEncrypted;
  if(parsed.data.enabled&&(!selectedClientIdEncrypted||!selectedClientSecretEncrypted))return reply.code(400).send({error:"credentials_required",message:`启用 PayPal 收款前必须填写 ${parsed.data.environment==="sandbox"?"Sandbox":"Live"} Client ID 和 Client Secret`});
  if(parsed.data.enabled){try{clearPayPalTokenCache();const client=new PayPalClient({environment:parsed.data.environment,clientId:decryptAtRest(selectedClientIdEncrypted,config.DATA_ENCRYPTION_KEY),clientSecret:decryptAtRest(selectedClientSecretEncrypted,config.DATA_ENCRYPTION_KEY)});await client.verify();}catch(error){request.log.warn({error:error instanceof PayPalApiError?error.code:String(error)},"PayPal credential verification failed");return reply.code(400).send({error:"paypal_credentials_invalid",message:`PayPal ${parsed.data.environment==="sandbox"?"Sandbox":"Live"} 凭据验证失败，请检查 Client ID 和 Client Secret`});}}
  const saved=await pool.query("INSERT INTO paypal_settings(singleton,enabled,environment,client_id_encrypted,client_secret_encrypted,sandbox_client_id_encrypted,sandbox_client_secret_encrypted,live_client_id_encrypted,live_client_secret_encrypted,reference_template,note_template,item_name_template,updated_by) VALUES(true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(singleton) DO UPDATE SET enabled=EXCLUDED.enabled,environment=EXCLUDED.environment,client_id_encrypted=EXCLUDED.client_id_encrypted,client_secret_encrypted=EXCLUDED.client_secret_encrypted,sandbox_client_id_encrypted=EXCLUDED.sandbox_client_id_encrypted,sandbox_client_secret_encrypted=EXCLUDED.sandbox_client_secret_encrypted,live_client_id_encrypted=EXCLUDED.live_client_id_encrypted,live_client_secret_encrypted=EXCLUDED.live_client_secret_encrypted,reference_template=EXCLUDED.reference_template,note_template=EXCLUDED.note_template,item_name_template=EXCLUDED.item_name_template,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING enabled,environment,reference_template,note_template,item_name_template,updated_at",[parsed.data.enabled,parsed.data.environment,selectedClientIdEncrypted,selectedClientSecretEncrypted,sandboxClientIdEncrypted,sandboxClientSecretEncrypted,liveClientIdEncrypted,liveClientSecretEncrypted,parsed.data.referenceTemplate,parsed.data.noteTemplate,parsed.data.itemNameTemplate,request.principal.id]);
  await auditCrm(request.principal.id,"paypal.settings.update","paypal_settings","workspace",{enabled:parsed.data.enabled,environment:parsed.data.environment,sandboxClientIdChanged:Boolean(sandboxClientId),sandboxClientSecretChanged:Boolean(sandboxClientSecret),liveClientIdChanged:Boolean(liveClientId),liveClientSecretChanged:Boolean(liveClientSecret),templatesChanged:true});clearPayPalTokenCache();
  return{enabled:saved.rows[0].enabled,environment:saved.rows[0].environment,sandboxClientIdConfigured:Boolean(sandboxClientIdEncrypted),sandboxClientSecretConfigured:Boolean(sandboxClientSecretEncrypted),liveClientIdConfigured:Boolean(liveClientIdEncrypted),liveClientSecretConfigured:Boolean(liveClientSecretEncrypted),referenceTemplate:saved.rows[0].reference_template,noteTemplate:saved.rows[0].note_template,itemNameTemplate:saved.rows[0].item_name_template,updatedAt:saved.rows[0].updated_at};
});

app.post("/api/v1/orders/:orderId/payment-request",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,{orderId}=request.params as {orderId:string},regenerate=(request.body as {regenerate?:unknown}|null)?.regenerate===true;
  const setting=await activePayPalSetting();if(!setting)return reply.code(409).send({error:"paypal_not_configured",message:"管理员尚未启用 PayPal 收款配置"});
  const context=await pool.query("SELECT o.id,o.display_order_number,o.amount,o.currency,o.description,o.shipping_address_snapshot,c.account_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) customer_name,co.phone_e164 customer_phone,COALESCE((SELECT timezone FROM order_settings WHERE singleton=true),'UTC') business_timezone FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN contacts co ON co.id=c.contact_id WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);if(!context.rowCount||!canAccessAccount(principal,context.rows[0].account_id))return reply.code(404).send({error:"not_found"});const order=context.rows[0];
  const [items,fees]=await Promise.all([pool.query("SELECT item.product_name name,COALESCE(NULLIF(item.product_sku,''),NULLIF(product.sku,'')) sku,item.quantity,item.unit_amount FROM order_items item LEFT JOIN products product ON product.id=item.product_id WHERE item.order_id=$1 ORDER BY item.position",[orderId]),pool.query("SELECT name,amount FROM order_fees WHERE order_id=$1 ORDER BY position",[orderId])]),missingRequiredSku=/{{\s*sku\s*}}/.test(setting.itemNameTemplate)&&items.rows.some(item=>!String(item.sku??"").trim());
  if(regenerate&&missingRequiredSku)return reply.code(409).send({error:"payment_request_template_data_missing",message:"Items · Name 使用了 {{sku}}，但订单中有商品没有 SKU。请先编辑订单补充 SKU，再重新创建付款请求"});
  if(regenerate){try{const cancelled=await cancelCurrentPaymentRequest(orderId,principal.id);if(cancelled==="paid")return reply.code(409).send({error:"paid_order_locked",message:"已付款订单不能重新生成付款请求"});}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice cancellation failed before regeneration");return reply.code(502).send({error:"paypal_cancel_failed",message:"旧付款请求作废失败，未生成新链接，请稍后重试"});}}
  const record=await transaction(async client=>{await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[orderId]);const current=await client.query("SELECT * FROM order_payment_requests WHERE order_id=$1 AND is_current FOR UPDATE",[orderId]);if(current.rowCount){const row=current.rows[0];if(row.environment===setting.environment&&row.status!=="CREATING")return{row,reused:true,create:false};if(row.environment===setting.environment){const recent=Date.now()-new Date(row.created_at).getTime()<120_000;return{row,reused:true,create:!recent};}await client.query("UPDATE order_payment_requests SET is_current=false,updated_at=now() WHERE id=$1",[row.id]);}const inserted=await client.query("INSERT INTO order_payment_requests(order_id,environment,status,amount,currency,created_by) VALUES($1,$2,'CREATING',$3,$4,$5) RETURNING *",[orderId,setting.environment,order.amount,order.currency,principal.id]);return{row:inserted.rows[0],reused:false,create:true};});
  if(!record.create)return reply.code(record.row.status==="CREATING"?409:200).send(record.row.status==="CREATING"?{error:"payment_request_in_progress",message:"付款链接正在生成，请稍后重试"}:paymentRequestResponse(record.row));
  if(missingRequiredSku){await pool.query("UPDATE order_payment_requests SET status='FAILED',is_current=false,failure_reason='missing_order_item_sku',updated_at=now() WHERE id=$1",[record.row.id]);return reply.code(409).send({error:"payment_request_template_data_missing",message:"Items · Name 使用了 {{sku}}，但订单中有商品没有 SKU。请先编辑订单补充 SKU，再重新创建付款请求"});}
  try{const currency=String(order.currency),address=order.shipping_address_snapshot&&typeof order.shipping_address_snapshot==="object"?order.shipping_address_snapshot as Record<string,unknown>:{},total=Number(order.amount),globalContext:PayPalTemplateContext={orderNumber:String(order.display_order_number),currentDate:new Intl.DateTimeFormat("en-CA",{timeZone:String(order.business_timezone),year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),recipientName:String(address.recipientName??order.customer_name??""),address:String(address.address??""),phone:String(address.phone??order.customer_phone??""),orderNotes:String(order.description??""),orderTotal:`${currency} ${total.toFixed(2)}`,currency,customerName:String(order.customer_name??""),customerPhone:String(order.customer_phone??""),productNames:items.rows.map(item=>String(item.name)).join(", "),productQuantity:String(items.rows.reduce((sum,item)=>sum+Number(item.quantity),0))};const renderItem=(name:string,sku:string,quantity:number,unitAmount:number)=>({name:renderPayPalTemplate(setting.itemNameTemplate,{...globalContext,productName:name,sku,productQuantity:String(quantity),unitAmount:unitAmount.toFixed(2),lineTotal:(quantity*unitAmount).toFixed(2)}).slice(0,200)||name.slice(0,200),quantity,unitAmount});const invoiceItems=[...items.rows.map(item=>renderItem(String(item.name),String(item.sku??""),Number(item.quantity),Number(item.unit_amount))),...fees.rows.map(fee=>renderItem(String(fee.name),"",1,Number(fee.amount)))];const client=new PayPalClient(setting),created=await client.createPayableInvoice({requestId:String(record.row.id),reference:renderPayPalTemplate(setting.referenceTemplate,globalContext).slice(0,120)||`Order #${order.display_order_number}`,currency,note:renderPayPalTemplate(setting.noteTemplate,globalContext).slice(0,4000)||undefined,items:invoiceItems});const saved=await pool.query("UPDATE order_payment_requests SET provider_request_id=$2,payment_url=$3,status=$4,last_synced_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[record.row.id,created.invoiceId,created.paymentUrl,created.status]);await auditCrm(principal.id,"payment_request.create","order",orderId,{paymentRequestId:record.row.id,paypalInvoiceId:created.invoiceId,environment:setting.environment,amount:Number(order.amount),currency:order.currency});return reply.code(201).send(paymentRequestResponse(saved.rows[0]));}
  catch(error){await pool.query("UPDATE order_payment_requests SET status='FAILED',is_current=false,failure_reason=$2,updated_at=now() WHERE id=$1",[record.row.id,error instanceof PayPalApiError?error.code:String(error)]);request.log.error({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice creation failed");return reply.code(502).send({error:"paypal_create_failed",message:paypalFailureMessage(error)});}
});

app.post("/api/v1/orders/:orderId/payment-request/refresh",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {orderId}=request.params as {orderId:string},context=await accessiblePaymentRequest(orderId,request.principal);if(!context)return reply.code(404).send({error:"not_found"});if(!context.request.provider_request_id)return reply.code(409).send({error:"payment_request_incomplete"});const setting=await activePayPalSetting(context.request.environment,false);if(!setting)return reply.code(409).send({error:"paypal_environment_not_configured",message:"当前 PayPal 环境与该付款请求不一致"});
  try{const detail=await new PayPalClient(setting).getInvoice(context.request.provider_request_id),saved=await pool.query("UPDATE order_payment_requests SET status=$2,payment_url=COALESCE($3,payment_url),last_synced_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[context.request.id,detail.status,detail.paymentUrl]);await auditCrm(request.principal.id,"payment_request.refresh","order",orderId,{paymentRequestId:context.request.id,status:detail.status});return paymentRequestResponse(saved.rows[0]);}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice refresh failed");return reply.code(502).send({error:"paypal_refresh_failed",message:paypalFailureMessage(error)});}
});

app.post("/api/v1/orders/:orderId/payment-request/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,{orderId}=request.params as {orderId:string},found=await pool.query("SELECT o.display_order_number,o.client_order_id,c.id conversation_id,c.account_id,a.agent_id,co.wa_jid,pr.id payment_request_id,pr.payment_url,pr.status,pr.amount,pr.currency FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id JOIN order_payment_requests pr ON pr.order_id=o.id AND pr.is_current WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const row=found.rows[0];if(!row.payment_url)return reply.code(409).send({error:"payment_url_unavailable"});const clientMessageId=`${row.client_order_id}:paypal:${row.payment_request_id}`,text=`Payment request for Order #${row.display_order_number}\n${row.currency} ${Number(row.amount).toFixed(2)}\n${row.payment_url}`;
  const queued=await transaction(async client=>{const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[row.account_id,clientMessageId]);if(existing.rowCount)return{messageId:existing.rows[0].id,status:existing.rows[0].status,deduplicated:true};const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id,status",[row.conversation_id,row.account_id,principal.id,clientMessageId,text]);await queueOrderCommand(client,row,row.conversation_id,message.rows[0].id,clientMessageId,"text",text);await client.query("UPDATE conversations SET status='open',closed_at=NULL,last_message_at=now() WHERE id=$1",[row.conversation_id]);await pauseAgentForHuman(client,row.conversation_id);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'payment_request.send','order',$2,$3)",[principal.id,orderId,JSON.stringify({paymentRequestId:row.payment_request_id,messageId:message.rows[0].id})]);return{messageId:message.rows[0].id,status:message.rows[0].status,deduplicated:false};});if(row.agent_id)void dispatchPending(row.agent_id);return reply.code(202).send(queued);
});

app.get("/api/v1/admin/order-templates",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT text_template,image_template,updated_at FROM order_settings WHERE singleton=true"),row=result.rows[0]??{};
  if(row.text_template&&!orderTemplateSchema.safeParse(row.text_template).success)request.log.error("Invalid stored text order template; using default");
  if(row.image_template&&!orderTemplateSchema.safeParse(row.image_template).success)request.log.error("Invalid stored image order template; using default");
  return{textTemplate:parseOrderTemplate(row.text_template??DEFAULT_TEXT_ORDER_TEMPLATE,"text"),imageTemplate:parseOrderTemplate(row.image_template??DEFAULT_IMAGE_ORDER_TEMPLATE,"image"),updatedAt:row.updated_at??null};
});

app.put("/api/v1/admin/order-templates/:format",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const {format}=request.params as {format:string};if(format!=="text"&&format!=="image")return reply.code(404).send({error:"not_found"});
  const parsed=orderTemplateUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const column=format==="text"?"text_template":"image_template",saved=await pool.query(`UPDATE order_settings SET ${column}=$1::jsonb,updated_by=$2,updated_at=now() WHERE singleton=true RETURNING updated_at`,[JSON.stringify(parsed.data),request.principal.id]);
  await auditCrm(request.principal.id,"order.template.update","order_settings","workspace",{format,blockCount:parsed.data.blocks.length});
  return{format,template:parsed.data,updatedAt:saved.rows[0]?.updated_at??null};
});

app.get("/api/v1/admin/product-card-template",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT template,updated_at FROM product_card_settings WHERE singleton=true"),row=result.rows[0];
  return{template:parseProductCardTemplate(row?.template??DEFAULT_PRODUCT_CARD_TEMPLATE),updatedAt:row?.updated_at??null};
});

app.put("/api/v1/admin/product-card-template",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const parsed=productCardTemplateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const saved=await pool.query("INSERT INTO product_card_settings(singleton,template,updated_by) VALUES(true,$1::jsonb,$2) ON CONFLICT(singleton) DO UPDATE SET template=EXCLUDED.template,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING updated_at",[JSON.stringify(parsed.data),request.principal.id]);
  await auditCrm(request.principal.id,"product_card.template.update","product_card_settings","workspace",{blockCount:parsed.data.blocks.length});return{template:parsed.data,updatedAt:saved.rows[0].updated_at};
});

app.get("/api/v1/admin/email-providers",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT provider,enabled,config,secret_encrypted,updated_at FROM email_provider_settings");const rows=new Map(result.rows.map(row=>[String(row.provider),row]));
  return{data:(["smtp","resend"] as EmailProvider[]).map(provider=>{const row=rows.get(provider),cfg=(row?.config??{}) as EmailProviderConfig;return{provider,enabled:Boolean(row?.enabled),configured:Boolean(row?.secret_encrypted),fromName:cfg.fromName??"",fromEmail:cfg.fromEmail??"",replyTo:cfg.replyTo??"",host:cfg.host??"",port:cfg.port??(provider==="smtp"?587:undefined),tls:cfg.tls??"starttls",username:cfg.username??"",updatedAt:row?.updated_at??null};})};
});

app.put("/api/v1/admin/email-providers/:provider",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(provider!=="smtp"&&provider!=="resend")return reply.code(404).send({error:"provider_not_found"});
  const parsed=emailProviderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(provider==="smtp"&&(!parsed.data.host||!parsed.data.port||!parsed.data.tls))return reply.code(400).send({error:"smtp_settings_required"});
  const current=await pool.query("SELECT secret_encrypted FROM email_provider_settings WHERE provider=$1",[provider]),secretEncrypted=parsed.data.secret?encryptAtRest(parsed.data.secret,config.DATA_ENCRYPTION_KEY):current.rows[0]?.secret_encrypted??null;
  if(parsed.data.enabled&&!secretEncrypted)return reply.code(400).send({error:"provider_secret_required"});
  const cfg:EmailProviderConfig={fromName:parsed.data.fromName,fromEmail:parsed.data.fromEmail,replyTo:parsed.data.replyTo||undefined,...(provider==="smtp"?{host:parsed.data.host,port:parsed.data.port,tls:parsed.data.tls,username:parsed.data.username||undefined}:{})};
  if(provider==="smtp"&&parsed.data.enabled)try{await verifySmtp(cfg,decryptAtRest(secretEncrypted,config.DATA_ENCRYPTION_KEY));}catch(error){return reply.code(400).send({error:"smtp_verification_failed",message:error instanceof Error?error.message:String(error)});}
  await transaction(async client=>{if(parsed.data.enabled)await client.query("UPDATE email_provider_settings SET enabled=false,updated_at=now() WHERE enabled");await client.query("INSERT INTO email_provider_settings(provider,enabled,config,secret_encrypted,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,config=EXCLUDED.config,secret_encrypted=EXCLUDED.secret_encrypted,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,JSON.stringify(cfg),secretEncrypted,request.principal!.id]);});
  await auditCrm(request.principal.id,"email.provider.update","email_provider",provider,{enabled:parsed.data.enabled,fromEmail:cfg.fromEmail});return{provider,enabled:parsed.data.enabled,configured:Boolean(secretEncrypted),...cfg};
});

app.post("/api/v1/admin/email-providers/:provider/test",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(provider!=="smtp"&&provider!=="resend")return reply.code(404).send({error:"provider_not_found"});const parsed=emailProviderTestSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const found=await pool.query("SELECT config,secret_encrypted FROM email_provider_settings WHERE provider=$1 AND secret_encrypted IS NOT NULL",[provider]);if(!found.rowCount)return reply.code(409).send({error:"provider_not_configured"});
  try{const messageId=await sendProviderTest(provider,found.rows[0].config,decryptAtRest(found.rows[0].secret_encrypted,config.DATA_ENCRYPTION_KEY),parsed.data.recipientEmail);return{accepted:true,messageId};}catch(error){request.log.warn({provider,error:String(error)},"Email provider test failed");return reply.code(502).send({error:"email_test_failed",message:error instanceof Error?error.message:String(error)});}
});

app.get("/api/v1/conversations/:conversationId/email-activities",{preHandler:authenticate},async(request,reply)=>{
  const {conversationId}=request.params as {conversationId:string};const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[conversationId]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const result=await pool.query("SELECT e.id,e.subject,e.recipients,e.content_type,e.status,e.attempt,e.last_error,e.created_at,e.updated_at,e.accepted_at,u.display_name sender_name,(SELECT COUNT(*)::int FROM email_attachments a WHERE a.email_id=e.id) attachment_count FROM email_messages e LEFT JOIN users u ON u.id=e.sender_user_id WHERE e.conversation_id=$1 ORDER BY e.created_at DESC LIMIT 100",[conversationId]);return{data:result.rows};
});

app.post("/api/v1/email-sends/:emailId/retry",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {emailId}=request.params as {emailId:string};const found=await pool.query("SELECT e.id,c.account_id FROM email_messages e JOIN conversations c ON c.id=e.conversation_id WHERE e.id=$1",[emailId]);if(!found.rowCount||!canAccessAccount(request.principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const updated=await pool.query("UPDATE email_messages SET status='queued',attempt=0,available_at=now(),last_error=NULL,completed_at=NULL,updated_at=now() WHERE id=$1 AND status='failed' RETURNING id,status",[emailId]);return updated.rowCount?reply.code(202).send(updated.rows[0]):reply.code(409).send({error:"email_not_failed"});
});

app.post("/api/v1/conversations/:conversationId/email-sends",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,{conversationId}=request.params as {conversationId:string},parsed=emailSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const duplicate=await pool.query("SELECT e.id,e.status,c.account_id FROM email_messages e JOIN conversations c ON c.id=e.conversation_id WHERE e.client_send_id=$1",[parsed.data.clientSendId]);if(duplicate.rowCount)return canAccessAccount(principal,duplicate.rows[0].account_id)?reply.code(202).send({emailId:duplicate.rows[0].id,status:duplicate.rows[0].status,deduplicated:true}):reply.code(404).send({error:"not_found"});
  const contextResult=await pool.query("SELECT c.account_id,c.contact_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) customer_name,co.phone_e164 customer_phone FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[conversationId]);if(!contextResult.rowCount||!canAccessAccount(principal,contextResult.rows[0].account_id))return reply.code(404).send({error:"not_found"});const context=contextResult.rows[0];
  const [recipientResult,providerResult]=await Promise.all([pool.query("SELECT id,label,email,is_primary FROM contact_emails WHERE contact_id=$1 AND id=ANY($2::uuid[]) ORDER BY position,id",[context.contact_id,parsed.data.recipientEmailIds]),pool.query("SELECT provider,config,secret_encrypted FROM email_provider_settings WHERE enabled AND secret_encrypted IS NOT NULL LIMIT 1")]);
  if(recipientResult.rowCount!==parsed.data.recipientEmailIds.length)return reply.code(400).send({error:"invalid_recipient_email"});if(!providerResult.rowCount)return reply.code(409).send({error:"email_provider_not_configured",message:"管理员尚未启用邮件 Provider"});
  const recipients=recipientResult.rows.map(row=>({id:String(row.id),label:String(row.label??""),email:String(row.email),isPrimary:Boolean(row.is_primary)})),provider=providerResult.rows[0];let textContent="",contentHtml="",contentType:"order_text"|"order_image"|"product_cards",orderId:string|null=null,productIds:string[]|null=null;const attachments:Array<{mediaId:string;fileName:string;contentId:string;byteSize:number}>=[];
  if(parsed.data.content.type==="order"){
    orderId=parsed.data.content.orderId;const orderResult=await pool.query("SELECT o.id,o.display_order_number,o.currency,o.description,o.shipping_address_snapshot FROM orders o WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!orderResult.rowCount)return reply.code(404).send({error:"order_not_found"});const order=orderResult.rows[0];
    const [itemResult,feeResult,templateResult]=await Promise.all([pool.query("SELECT i.product_name name,i.quantity,i.unit_amount,m.object_key FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id WHERE i.order_id=$1 ORDER BY i.position",[orderId]),pool.query("SELECT name,amount FROM order_fees WHERE order_id=$1 ORDER BY position",[orderId]),pool.query("SELECT text_template,image_template FROM order_settings WHERE singleton=true")]);const items:OrderSummaryItem[]=itemResult.rows.map(item=>({name:String(item.name),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)})),fees:OrderSummaryFee[]=feeResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)})),format=parsed.data.content.format,template=parseOrderTemplate(templateResult.rows[0]?.[format==="text"?"text_template":"image_template"],format),templateContext={orderNumber:String(order.display_order_number),currency:String(order.currency),customerName:String(context.customer_name??""),customerPhone:String(context.customer_phone??""),description:String(order.description??""),items,fees,address:order.shipping_address_snapshot??null};let blocks=renderSemanticOrder(template,templateContext);
    if(parsed.data.content.translate){const setting=await activeTranslationSetting();if(!setting)return reply.code(409).send({error:"translation_not_configured"});try{blocks=parseTranslatedSemanticOrder(await translateText(setting,{text:serializeSemanticOrder(blocks),targetLanguage:parsed.data.content.targetLanguage!}),blocks);}catch(error){request.log.warn({orderId,error:String(error)},"Email order translation failed");return reply.code(502).send({error:"translation_failed"});}}
    textContent=blocks.map(block=>block.lines.join("\n")).join("\n\n");contentHtml=`<div style="margin-top:20px;border-top:1px solid #dce7e1;padding-top:16px">${blocks.map(block=>`<div style="padding:10px 0">${block.lines.map(line=>`<div>${escapeHtml(line)}</div>`).join("")}</div>`).join("")}</div>`;contentType=format==="text"?"order_text":"order_image";
    if(format==="image"){const products=await Promise.all(itemResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));return object.Body?{name:String(item.name),image:Buffer.from(await object.Body.transformToByteArray())}:{name:String(item.name)};}));const png=await renderTemplateOrderImage(template,blocks,products),fileName=`order-${safeFileName(String(order.display_order_number))}.png`,stored=await storeEmailImage(context.account_id,fileName,png,"order");attachments.push({...stored,fileName,contentId:"order-image"});contentHtml=`<div style="margin-top:20px"><img alt="Order #${escapeHtml(String(order.display_order_number))}" src="cid:order-image" style="display:block;max-width:100%;height:auto"></div>`;}
  }else{
    const productContent=parsed.data.content,selectedProductIds=productContent.productIds;productIds=selectedProductIds;const productResult=await pool.query(`SELECT p.id,p.name,p.sku,p.currency,m.object_key,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(label_list.tags,'[]'::json) tags FROM products p LEFT JOIN media m ON m.id=p.image_media_id AND m.status='ready' LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) price_tiers FROM product_price_tiers t WHERE t.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('name',l.name) ORDER BY lower(l.name)) tags FROM product_labels l WHERE l.product_id=p.id) label_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[selectedProductIds]);if(productResult.rowCount!==selectedProductIds.length)return reply.code(409).send({error:"product_unavailable"});
    const products:ProductCardRenderProduct[]=await Promise.all(productResult.rows.map(async row=>{let image:Buffer|undefined;if(row.object_key){const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));if(object.Body)image=Buffer.from(await object.Body.transformToByteArray());}return{name:String(row.name),sku:String(row.sku),currency:String(row.currency),priceTiers:Array.isArray(row.price_tiers)?row.price_tiers.map((tier:Record<string,unknown>)=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[],tags:Array.isArray(row.tags)?row.tags.map((tag:Record<string,unknown>)=>({name:String(tag.name)})):[],image};}));const templateResult=await pool.query("SELECT template FROM product_card_settings WHERE singleton=true"),template=parseProductCardTemplate(templateResult.rows[0]?.template??DEFAULT_PRODUCT_CARD_TEMPLATE),pngs=productContent.mode==="combined"?[await renderProductCards(template,products,productContent.showPrice)]:await Promise.all(products.map(product=>renderProductCards(template,[product],productContent.showPrice)));
    if(pngs.reduce((sum,png)=>sum+png.length,0)>15*1024*1024)return reply.code(413).send({error:"email_attachments_too_large",message:"邮件图片超过 15 MB，请减少产品数量或改用合并长图"});
    for(const [index,png] of pngs.entries()){const fileName=productContent.mode==="combined"?`product-cards-${selectedProductIds.length}.png`:`product-${safeFileName(products[index].sku)}.png`,stored=await storeEmailImage(context.account_id,fileName,png,"product-card"),contentId=`product-card-${index}`;attachments.push({...stored,fileName,contentId});}
    textContent=products.map(product=>`${product.name} (${product.sku})`).join("\n");contentHtml=`<div style="margin-top:20px">${attachments.map((attachment,index)=>`<img alt="${escapeHtml(products[Math.min(index,products.length-1)].name)}" src="cid:${attachment.contentId}" style="display:block;max-width:100%;height:auto;margin:0 auto 18px">`).join("")}</div>`;contentType="product_cards";
  }
  if(attachments.reduce((sum,item)=>sum+item.byteSize,0)>15*1024*1024)return reply.code(413).send({error:"email_attachments_too_large",message:"邮件图片超过 15 MB，请减少产品数量或改用合并长图"});const textBody=[parsed.data.messageBody,textContent].filter(Boolean).join("\n\n"),htmlBody=emailShell(parsed.data.messageBody,contentHtml);
  const created=await transaction(async client=>{const inserted=await client.query("INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type,order_id,product_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(client_send_id) DO NOTHING RETURNING id,status",[parsed.data.clientSendId,conversationId,context.contact_id,principal.id,provider.provider,JSON.stringify(provider.config),provider.secret_encrypted,JSON.stringify(recipients),parsed.data.subject,parsed.data.messageBody,textBody,htmlBody,contentType,orderId,productIds?JSON.stringify(productIds):null]);if(!inserted.rowCount)return(await client.query("SELECT id,status FROM email_messages WHERE client_send_id=$1",[parsed.data.clientSendId])).rows[0];for(const [position,item] of attachments.entries())await client.query("INSERT INTO email_attachments(email_id,media_id,position,file_name,content_id,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,'image/png',$6)",[inserted.rows[0].id,item.mediaId,position,item.fileName,item.contentId,item.byteSize]);await client.query("UPDATE conversations SET status='open',closed_at=NULL,last_message_at=now() WHERE id=$1",[conversationId]);await pauseAgentForHuman(client,conversationId);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'email.queue','email_message',$2,$3)",[principal.id,inserted.rows[0].id,JSON.stringify({conversationId,contentType,recipientCount:recipients.length,attachmentCount:attachments.length})]);return inserted.rows[0];});return reply.code(202).send({emailId:created.id,status:created.status});
});

app.post("/api/v1/conversations/:id/product-cards/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,{id}=request.params as {id:string},parsed=productCardSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const contextResult=await pool.query("SELECT c.account_id,a.agent_id,co.wa_jid FROM conversations c JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 AND c.account_id=$2",[id,parsed.data.accountId]);if(!contextResult.rowCount||!canAccessAccount(principal,parsed.data.accountId))return reply.code(404).send({error:"conversation_not_found"});const context=contextResult.rows[0];
  const clientMessageIds=parsed.data.mode==="combined"?[`${parsed.data.clientBatchId}:combined`]:parsed.data.productIds.map((_,index)=>`${parsed.data.clientBatchId}:p:${index}`);
  const existing=await pool.query("SELECT id,client_message_id FROM messages WHERE account_id=$1 AND client_message_id=ANY($2::text[]) ORDER BY occurred_at,id",[parsed.data.accountId,clientMessageIds]);if(existing.rowCount){if(existing.rowCount!==clientMessageIds.length)return reply.code(409).send({error:"product_card_batch_conflict"});return reply.code(200).send({deduplicated:true,messageIds:existing.rows.map(row=>String(row.id))});}
  const productsResult=await pool.query(`SELECT p.id,p.name,p.sku,p.currency,m.object_key,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(label_list.tags,'[]'::json) tags FROM products p LEFT JOIN media m ON m.id=p.image_media_id AND m.status='ready' LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) price_tiers FROM product_price_tiers t WHERE t.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('name',l.name) ORDER BY lower(l.name)) tags FROM product_labels l WHERE l.product_id=p.id) label_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[parsed.data.productIds]);if(productsResult.rowCount!==parsed.data.productIds.length)return reply.code(409).send({error:"product_unavailable"});
  const products:ProductCardRenderProduct[]=await Promise.all(productsResult.rows.map(async row=>{let image:Buffer|undefined;if(row.object_key){const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));if(object.Body)image=Buffer.from(await object.Body.transformToByteArray());}return{name:String(row.name),sku:String(row.sku),currency:String(row.currency),priceTiers:(row.price_tiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})),tags:(row.tags as Array<Record<string,unknown>>).map(tag=>({name:String(tag.name)})),image};}));
  const templateResult=await pool.query("SELECT template FROM product_card_settings WHERE singleton=true"),template=parseProductCardTemplate(templateResult.rows[0]?.template??DEFAULT_PRODUCT_CARD_TEMPLATE);
  const rendered=parsed.data.mode==="combined"?[await renderProductCards(template,products,parsed.data.showPrice)]:await Promise.all(products.map(product=>renderProductCards(template,[product],parsed.data.showPrice)));
  const uploaded:Array<{objectKey:string;sha256:string;bytes:Buffer;fileName:string}>=[];
  try{for(const [index,bytes] of rendered.entries()){const sha256=createHash("sha256").update(bytes).digest("hex"),fileName=parsed.data.mode==="combined"?`product-cards-${parsed.data.clientBatchId}.png`:`product-${products[index].sku}.png`,objectKey=`product-cards/${parsed.data.accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}.png`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:"image/png",Metadata:{sha256,source:"product-card"}}));uploaded.push({objectKey,sha256,bytes,fileName});}
    const result=await transaction(async client=>{const duplicate=await client.query("SELECT id FROM messages WHERE account_id=$1 AND client_message_id=ANY($2::text[])",[parsed.data.accountId,clientMessageIds]);if(duplicate.rowCount)throw Object.assign(new Error("product_card_batch_conflict"),{statusCode:409});const messageIds:string[]=[];for(const [index,item] of uploaded.entries()){const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'image/png',$4,$5) RETURNING id",[parsed.data.accountId,item.objectKey,item.fileName,item.bytes.length,item.sha256]),clientMessageId=clientMessageIds[index],caption=parsed.data.mode==="combined"?`${products.length} products`: `${products[index].name} · ${products[index].sku}`;const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,media_id,status,occurred_at) VALUES($1,$2,$3,$4,'out','image',$5,$6,'queued',now()) RETURNING id",[id,parsed.data.accountId,principal.id,clientMessageId,caption,media.rows[0].id]);await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4)",[context.agent_id,parsed.data.accountId,message.rows[0].id,JSON.stringify({accountId:parsed.data.accountId,conversationId:id,clientMessageId,type:"image",text:caption,mediaId:media.rows[0].id,messageId:message.rows[0].id,toJid:context.wa_jid})]);messageIds.push(String(message.rows[0].id));}await client.query("UPDATE conversations SET status='open',closed_at=NULL,last_message_at=now() WHERE id=$1",[id]);await pauseAgentForHuman(client,id);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product_card.send','conversation',$2,$3)",[principal.id,id,JSON.stringify({clientBatchId:parsed.data.clientBatchId,productIds:parsed.data.productIds,mode:parsed.data.mode,showPrice:parsed.data.showPrice,messageIds})]);return{deduplicated:false,messageIds};});if(context.agent_id)void dispatchPending(context.agent_id);return reply.code(202).send(result);
  }catch(error){await Promise.allSettled(uploaded.map(item=>s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:item.objectKey}))));throw error;}
});

app.get("/api/v1/conversations/:id/product-cards/batches/:batchId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {id,batchId}=request.params as {id:string;batchId:string},parsed=productCardBatchStatusSchema.safeParse({batchId,accountId:(request.query as {accountId?:string}).accountId});
  if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
  const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1 AND account_id=$2",[id,parsed.data.accountId]);
  if(!access.rowCount||!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(404).send({error:"conversation_not_found"});
  const messages=await pool.query("SELECT id,status,client_message_id FROM messages WHERE conversation_id=$1 AND account_id=$2 AND left(client_message_id,length($3)+1)=$3||':' ORDER BY occurred_at,id",[id,parsed.data.accountId,parsed.data.batchId]);
  if(!messages.rowCount)return reply.code(404).send({committed:false,status:"not_found",messageIds:[]});
  return{committed:true,status:messages.rows.every(row=>row.status==="sent")?"sent":messages.rows.some(row=>row.status==="failed")?"failed":"queued",messageIds:messages.rows.map(row=>String(row.id)),messages:messages.rows.map(row=>({id:String(row.id),status:String(row.status),clientMessageId:String(row.client_message_id)}))};
});

app.post("/api/v1/conversations/:id/orders",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=orderSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
  if(!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  const result=await transaction(async client=>{
    const conversation=await client.query("SELECT c.account_id,c.contact_id FROM conversations c WHERE c.id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(principal,conversation.rows[0].account_id))return null;
    const duplicate=await client.query("SELECT id,display_order_number,conversation_id,status FROM orders WHERE client_order_id=$1",[parsed.data.clientOrderId]);if(duplicate.rowCount){if(duplicate.rows[0].conversation_id!==id)throw Object.assign(new Error("client_order_id_conflict"),{statusCode:409});return{...duplicate.rows[0],deduplicated:true};}
    const clientProductIds=parsed.data.items.flatMap(item=>item.clientProductId?[item.clientProductId]:[]);if(new Set(clientProductIds).size!==clientProductIds.length)throw Object.assign(new Error("duplicate_client_product_id"),{statusCode:400});const mediaIds=parsed.data.items.flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]);if(new Set(mediaIds).size!==mediaIds.length)throw Object.assign(new Error("duplicate_product_image"),{statusCode:400});if(mediaIds.length){const media=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND (account_id=$2 OR account_id IS NULL) AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds,conversation.rows[0].account_id]);if(media.rowCount!==mediaIds.length)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}
    const total=calculateOrderTotal(parsed.data.items,parsed.data.fees),number=await allocateOrderNumber(client),orderAddress=await resolveOrderAddress(client,conversation.rows[0].contact_id,principal.id,parsed.data.addressId,parsed.data.newAddress);const order=await client.query("INSERT INTO orders(client_order_id,conversation_id,created_by,amount,currency,description,status,translate_on_send,target_language,display_order_number,sequence_date,daily_sequence,address_id,shipping_address_snapshot) VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13) RETURNING id,display_order_number,status",[parsed.data.clientOrderId,id,principal.id,total,parsed.data.currency,parsed.data.description??null,parsed.data.translateOnSend,parsed.data.targetLanguage??null,number.displayOrderNumber,number.sequenceDate,number.dailySequence,orderAddress?.id??null,orderAddress?JSON.stringify(orderAddress.snapshot):null]);const orderRow=order.rows[0];
    const conversationTags=await client.query("SELECT t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[id]);for(const [position,item] of parsed.data.items.entries()){const productId=await resolveOrderProduct(client,item,String(orderRow.display_order_number),parsed.data.currency,principal.id,conversationTags.rows);await client.query("INSERT INTO order_items(order_id,position,product_name,product_sku,quantity,unit_amount,image_media_id,product_id) VALUES($1,$2,$3,COALESCE($4,(SELECT sku FROM products WHERE id=$8)),$5,$6,$7,$8)",[orderRow.id,position,item.name,item.sku??null,item.quantity,item.unitAmount,item.imageMediaId??null,productId]);}
    for(const [position,fee] of parsed.data.fees.entries())await client.query("INSERT INTO order_fees(order_id,position,name,amount) VALUES($1,$2,$3,$4)",[orderRow.id,position,fee.name,fee.amount]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.draft','order',$2,$3)",[principal.id,orderRow.id,JSON.stringify({conversationId:id,displayOrderNumber:orderRow.display_order_number,itemCount:parsed.data.items.length,feeCount:parsed.data.fees.length,translateOnSend:parsed.data.translateOnSend})]);return{id:orderRow.id,display_order_number:orderRow.display_order_number,status:orderRow.status,deduplicated:false};
  });
  if(!result)return reply.code(404).send({error:"not_found"});return reply.code(201).send({orderId:result.id,orderNumber:String(result.display_order_number),status:result.status,deduplicated:result.deduplicated});
});

app.patch("/api/v1/conversations/:conversationId/orders/:orderId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=orderUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};
  if(!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  const access=await pool.query("SELECT c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!access.rowCount||!canAccessAccount(principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});try{const cancellation=await cancelCurrentPaymentRequest(orderId,principal.id);if(cancellation==="paid")return reply.code(409).send({error:"paid_order_locked",message:"已付款订单不能修改商品、费用或金额"});}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice cancellation failed before order update");return reply.code(502).send({error:"paypal_cancel_failed",message:"旧付款请求作废失败，订单未修改，请稍后重试"});}
  const result=await transaction(async client=>{const found=await client.query("SELECT o.display_order_number,o.status,c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL FOR UPDATE OF o",[orderId,conversationId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return null;const clientProductIds=parsed.data.items.flatMap(item=>item.clientProductId?[item.clientProductId]:[]);if(new Set(clientProductIds).size!==clientProductIds.length)throw Object.assign(new Error("duplicate_client_product_id"),{statusCode:400});const mediaIds=parsed.data.items.flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]);if(new Set(mediaIds).size!==mediaIds.length)throw Object.assign(new Error("duplicate_product_image"),{statusCode:400});if(mediaIds.length){const media=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND (account_id=$2 OR account_id IS NULL) AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds,found.rows[0].account_id]);if(media.rowCount!==mediaIds.length)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}const total=calculateOrderTotal(parsed.data.items,parsed.data.fees);await client.query("UPDATE orders SET amount=$2,currency=$3,description=$4,translate_on_send=$5,target_language=$6 WHERE id=$1",[orderId,total,parsed.data.currency,parsed.data.description??null,parsed.data.translateOnSend,parsed.data.targetLanguage??null]);const conversationTags=await client.query("SELECT t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[conversationId]);const productIds=[];for(const item of parsed.data.items)productIds.push(await resolveOrderProduct(client,item,String(found.rows[0].display_order_number),parsed.data.currency,principal.id,conversationTags.rows));await client.query("DELETE FROM order_items WHERE order_id=$1",[orderId]);await client.query("DELETE FROM order_fees WHERE order_id=$1",[orderId]);for(const [position,item] of parsed.data.items.entries())await client.query("INSERT INTO order_items(order_id,position,product_name,product_sku,quantity,unit_amount,image_media_id,product_id) VALUES($1,$2,$3,COALESCE($4,(SELECT sku FROM products WHERE id=$8)),$5,$6,$7,$8)",[orderId,position,item.name,item.sku??null,item.quantity,item.unitAmount,item.imageMediaId??null,productIds[position]]);for(const [position,fee] of parsed.data.fees.entries())await client.query("INSERT INTO order_fees(order_id,position,name,amount) VALUES($1,$2,$3,$4)",[orderId,position,fee.name,fee.amount]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.update','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,itemCount:parsed.data.items.length,feeCount:parsed.data.fees.length,translateOnSend:parsed.data.translateOnSend,previouslySent:found.rows[0].status!=="draft"})]);return{orderNumber:String(found.rows[0].display_order_number)};});if(!result)return reply.code(404).send({error:"not_found"});return{orderId,orderNumber:result.orderNumber,status:"updated"};
});

app.patch("/api/v1/conversations/:conversationId/orders/:orderId/address",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=orderAddressSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};const context=await pool.query("SELECT c.account_id,c.contact_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!context.rowCount||!canAccessAccount(principal,context.rows[0].account_id))return reply.code(404).send({error:"not_found"});const selected=await resolveOrderAddress(pool,context.rows[0].contact_id,principal.id,parsed.data.addressId??undefined,parsed.data.newAddress);await pool.query("UPDATE orders SET address_id=$2,shipping_address_snapshot=$3 WHERE id=$1",[orderId,selected?.id??null,selected?JSON.stringify(selected.snapshot):null]);return{addressId:selected?.id??null,address:selected?.snapshot??null};
});

app.post("/api/v1/conversations/:conversationId/orders/:orderId/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=orderSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};
  const found=await pool.query("SELECT o.id,o.display_order_number,o.client_order_id,o.currency,o.description,o.status,o.send_format,o.translate_on_send,o.target_language,o.summary_message_id,o.shipping_address_snapshot,c.account_id,a.agent_id,co.wa_jid,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) customer_name,co.phone_e164 customer_phone,m.status message_status FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN messages m ON m.id=o.summary_message_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const order=found.rows[0],requestMessageId=parsed.data.clientSendId?`${order.client_order_id}:send:${parsed.data.clientSendId}`:`${order.client_order_id}:${parsed.data.format}`,shouldTranslate=parsed.data.translate??Boolean(order.translate_on_send),targetLanguage=parsed.data.targetLanguage??order.target_language;
  const [itemResult,feeResult,templateResult]=await Promise.all([pool.query("SELECT i.id,i.product_name name,i.quantity,i.unit_amount,i.image_media_id,m.object_key,m.mime_type FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id WHERE i.order_id=$1 ORDER BY i.position",[orderId]),pool.query("SELECT name,amount FROM order_fees WHERE order_id=$1 ORDER BY position",[orderId]),pool.query("SELECT text_template,image_template FROM order_settings WHERE singleton=true")]);const items:OrderSummaryItem[]=itemResult.rows.map(item=>({name:String(item.name),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)})),fees:OrderSummaryFee[]=feeResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)}));
  const format=parsed.data.format as OrderTemplateFormat,rawTemplate=templateResult.rows[0]?.[format==="text"?"text_template":"image_template"],template=parseOrderTemplate(rawTemplate,format),context={orderNumber:String(order.display_order_number),currency:String(order.currency),customerName:String(order.customer_name??""),customerPhone:String(order.customer_phone??""),description:String(order.description??""),items,fees,address:order.shipping_address_snapshot??null};
  if(rawTemplate&&!orderTemplateSchema.safeParse(rawTemplate).success)request.log.error({format},"Invalid stored order template; using default");
  const sourceBlocks=renderSemanticOrder(template,context),sourceText=renderTextOrder(template,sourceBlocks);let renderedBlocks=sourceBlocks,outgoingText=sourceText;
  if(shouldTranslate){if(!targetLanguage)return reply.code(400).send({error:"target_language_required",message:"请选择订单翻译的目标语言"});const setting=await activeTranslationSetting();if(!setting)return reply.code(409).send({error:"translation_not_configured",message:"AI 翻译服务尚未配置，订单未发送"});try{const translated=await translateText(setting,{text:serializeSemanticOrder(sourceBlocks),targetLanguage});renderedBlocks=parseTranslatedSemanticOrder(translated,sourceBlocks);outgoingText=renderTextOrder(template,renderedBlocks);}catch(error){request.log.error({orderId,error:String(error)},"Order translation failed");return reply.code(502).send({error:"translation_failed",message:"订单翻译失败，订单尚未发送"});}}
  let renderedMediaId:string|null=null;
  if(parsed.data.format==="image"){
    try{const products=await Promise.all(itemResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));if(!object.Body)return{name:String(item.name)};return{name:String(item.name),image:Buffer.from(await object.Body.transformToByteArray())};}));
      const png=await renderTemplateOrderImage(template,renderedBlocks,products),sha256=createHash("sha256").update(png).digest("hex"),objectKey=`orders/${order.account_id}/${orderId}/${sha256}.png`,fileName=`order-${safeFileName(String(order.display_order_number))}.png`;
      await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:png,ContentType:"image/png",Metadata:{sha256,orderId}}));
      const media=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'image/png',$4,$5) ON CONFLICT(object_key) DO UPDATE SET file_name=EXCLUDED.file_name,byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,status='ready' RETURNING id",[order.account_id,objectKey,fileName,png.length,sha256]);renderedMediaId=media.rows[0].id;
    }catch(error){request.log.error({orderId,error:String(error)},"Order image generation failed");return reply.code(502).send({error:"order_image_failed",message:"订单图片生成失败，草稿仍保留且尚未发送"});}
  }
  const queued=await transaction(async client=>{const locked=await client.query("SELECT deleted_at FROM orders WHERE id=$1 FOR UPDATE",[orderId]);if(!locked.rowCount||locked.rows[0].deleted_at)return null;const existing=await client.query("SELECT id FROM messages WHERE account_id=$1 AND client_message_id=$2",[order.account_id,requestMessageId]);if(existing.rowCount)return{messageId:existing.rows[0].id,format:parsed.data.format,deduplicated:true};const kind=parsed.data.format==="image"?"image":"text",caption=parsed.data.format==="image"?`Order #${String(order.display_order_number)}`:outgoingText;const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,translation_source_text,media_id,status,occurred_at) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,'queued',now()) RETURNING id,status",[conversationId,order.account_id,principal.id,requestMessageId,kind,caption,parsed.data.format==="text"&&shouldTranslate?sourceText:null,renderedMediaId]);await queueOrderCommand(client,order,conversationId,message.rows[0].id,requestMessageId,kind,caption,renderedMediaId??undefined);
    await client.query("UPDATE orders SET status='queued',send_format=$2,summary_message_id=$3,rendered_media_id=$4,translated_text=$5,sent_at=now() WHERE id=$1",[orderId,parsed.data.format,message.rows[0].id,renderedMediaId,shouldTranslate?outgoingText:null]);await client.query("UPDATE conversations SET status='open',closed_at=NULL,last_message_at=now() WHERE id=$1",[conversationId]);await pauseAgentForHuman(client,conversationId);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.send','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,resend:order.status!=="draft",format:parsed.data.format,translated:shouldTranslate,targetLanguage:shouldTranslate?targetLanguage:null,productImageCount:itemResult.rows.filter(item=>item.image_media_id).length})]);return{messageId:message.rows[0].id,format:parsed.data.format,deduplicated:false};});
  if(!queued)return reply.code(404).send({error:"not_found"});if(order.agent_id)void dispatchPending(order.agent_id);return reply.code(202).send({orderId,orderNumber:String(order.display_order_number),messageId:queued.messageId,status:"queued",format:queued.format,deduplicated:queued.deduplicated});
});

app.delete("/api/v1/conversations/:conversationId/orders/:orderId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};const access=await pool.query("SELECT c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!access.rowCount||!canAccessAccount(principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});try{const cancellation=await cancelCurrentPaymentRequest(orderId,principal.id);if(cancellation==="paid")return reply.code(409).send({error:"paid_order_locked",message:"已付款订单不能删除"});}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice cancellation failed before order delete");return reply.code(502).send({error:"paypal_cancel_failed",message:"付款请求作废失败，订单未删除，请稍后重试"});}const deleted=await transaction(async client=>{const found=await client.query("SELECT o.status,c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL FOR UPDATE",[orderId,conversationId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return false;await client.query("UPDATE orders SET deleted_at=now() WHERE id=$1",[orderId]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.delete','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,wasSent:found.rows[0].status!=="draft"})]);return true;});if(!deleted)return reply.code(404).send({error:"not_found"});return reply.code(204).send();
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
    const contact=await client.query("INSERT INTO contacts(account_id,wa_jid,phone_e164,display_name,alias) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN $4 ELSE NULL END) ON CONFLICT(account_id,wa_jid) DO UPDATE SET phone_e164=EXCLUDED.phone_e164,display_name=CASE WHEN $5 THEN EXCLUDED.display_name ELSE COALESCE(contacts.display_name,EXCLUDED.display_name) END,alias=CASE WHEN $5 THEN EXCLUDED.alias ELSE contacts.alias END RETURNING id",[parsed.data.accountId,waJid,phone,displayName,Boolean(parsed.data.displayName)]);
    const conversation=await client.query("INSERT INTO conversations(account_id,contact_id,status,last_message_at) VALUES($1,$2,'open',now()) ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL,last_message_at=now() RETURNING id",[parsed.data.accountId,contact.rows[0].id]);
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id,status",[conversation.rows[0].id,parsed.data.accountId,principal.id,parsed.data.clientMessageId,parsed.data.firstMessage]);
    await pauseAgentForHuman(client,conversation.rows[0].id);
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
  const principalUserId=request.principal?.kind==="user"?request.principal.id:null;
  const result=await pool.query("SELECT msg.id,msg.direction,msg.kind,msg.text_content,msg.translation_source_text,msg.status,msg.whatsapp_message_id,msg.media_id,msg.quoted_message_id,msg.occurred_at,media.file_name,media.mime_type,media.byte_size,preference.agent_language cached_translation_language,translation.translated_text cached_translation_text,transcription.transcript_text cached_transcription_text FROM messages msg LEFT JOIN media ON media.id=msg.media_id LEFT JOIN conversation_translation_preferences preference ON preference.conversation_id=msg.conversation_id AND preference.user_id=$4::uuid LEFT JOIN message_translations translation ON translation.message_id=msg.id AND translation.target_language=preference.agent_language LEFT JOIN message_transcriptions transcription ON transcription.message_id=msg.id WHERE msg.conversation_id=$1 AND ($2::timestamptz IS NULL OR msg.occurred_at<$2) ORDER BY msg.occurred_at DESC,msg.id DESC LIMIT $3",[id,query.before??null,limit,principalUserId]);
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
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,translation_source_text,media_id,quoted_message_id,status,occurred_at) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,'queued',now()) RETURNING id,status",[parsed.data.conversationId,parsed.data.accountId,request.principal?.kind==='user'?request.principal.id:null,parsed.data.clientMessageId,parsed.data.type,parsed.data.text??null,parsed.data.translationSourceText??null,parsed.data.mediaId??null,parsed.data.quotedMessageId??null]);
    await client.query("UPDATE conversations SET status='open',closed_at=NULL,last_message_at=now() WHERE id=$1",[parsed.data.conversationId]);
    if(request.principal?.kind==='user')await pauseAgentForHuman(client,parsed.data.conversationId);
    const outboundMessage={...parsed.data};delete outboundMessage.translationSourceText;
    const command=await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4) RETURNING id,sequence",[conversation.rows[0].agent_id,parsed.data.accountId,message.rows[0].id,JSON.stringify({...outboundMessage,messageId:message.rows[0].id,toJid:conversation.rows[0].wa_jid})]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'message.queue','message',$3,$4)",[request.principal?.kind,request.principal?.id,message.rows[0].id,JSON.stringify({commandId:command.rows[0].id})]);
    return {messageId:message.rows[0].id,status:"queued",deduplicated:false,agentId:conversation.rows[0].agent_id};
  });
  if(!result)return reply.code(404).send({error:"conversation_not_found"});
  if(result.agentId)void dispatchPending(result.agentId); return reply.code(202).send(result);
});

app.get("/api/v1/me/translation-preferences", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=translationPreferenceQuerySchema.safeParse(request.query);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[parsed.data.conversationId]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"conversation_not_found"});
  const result=await pool.query("SELECT enabled,agent_language,customer_language,updated_at FROM conversation_translation_preferences WHERE user_id=$1 AND conversation_id=$2",[request.principal.id,parsed.data.conversationId]);
  const row=result.rows[0];
  return{conversationId:parsed.data.conversationId,enabled:Boolean(row?.enabled),agentLanguage:row?.agent_language??"zh-CN",customerLanguage:row?.customer_language??"en",updatedAt:row?.updated_at??null};
});

app.put("/api/v1/me/translation-preferences", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=translationPreferenceSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[parsed.data.conversationId]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"conversation_not_found"});
  const provider=parsed.data.enabled?await pool.query("SELECT 1 FROM translation_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1"):null;
  if(parsed.data.enabled&&!provider?.rowCount)return reply.code(409).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  const result=await pool.query("INSERT INTO conversation_translation_preferences(user_id,conversation_id,enabled,agent_language,customer_language) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,conversation_id) DO UPDATE SET enabled=EXCLUDED.enabled,agent_language=EXCLUDED.agent_language,customer_language=EXCLUDED.customer_language,updated_at=now() RETURNING enabled,agent_language,customer_language,updated_at",[request.principal.id,parsed.data.conversationId,parsed.data.enabled,parsed.data.agentLanguage,parsed.data.customerLanguage]);
  const row=result.rows[0];
  return{conversationId:parsed.data.conversationId,enabled:row.enabled,agentLanguage:row.agent_language,customerLanguage:row.customer_language,updatedAt:row.updated_at};
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
  const found=await pool.query("SELECT m.id,m.account_id,m.direction,m.kind,m.text_content,m.media_id,media.object_key,media.file_name,media.mime_type,media.byte_size,mt.translated_text,transcription.transcript_text FROM messages m LEFT JOIN media ON media.id=m.media_id LEFT JOIN message_translations mt ON mt.message_id=m.id AND mt.target_language=$2 LEFT JOIN message_transcriptions transcription ON transcription.message_id=m.id WHERE m.id=ANY($1::uuid[])",[parsed.data.messageIds,parsed.data.targetLanguage]);
  if(found.rowCount!==new Set(parsed.data.messageIds).size||found.rows.some(row=>!canAccessAccount(request.principal,row.account_id)))return reply.code(404).send({error:"message_not_found"});
  const eligible=found.rows.filter(row=>row.direction==="in"&&((row.kind==="text"&&String(row.text_content??"").trim())||(row.kind==="audio"&&row.media_id&&row.object_key&&(row.translated_text||parsed.data.generateAudio))));
  const setting=eligible.some(row=>!row.translated_text)?await activeTranslationSetting():null;
  if(eligible.some(row=>!row.translated_text)&&!setting)return reply.code(503).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  const generated=await mapWithConcurrency(eligible.filter(row=>!row.translated_text),3,row=>singleFlight(messageTranslationFlights,`${row.id}:${parsed.data.targetLanguage}`,async()=>{
    try{
      let sourceText=String(row.text_content??"").trim();
      if(row.kind==="audio"){
        sourceText=String(row.transcript_text??"").trim();
        if(!sourceText){
          sourceText=await singleFlight(transcriptionFlights,row.id,async()=>{
            if(Number(row.byte_size)>25*1024*1024)throw new Error("audio_too_large");
            const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));
            if(!object.Body)throw new Error("audio_body_missing");
            const bytes=Buffer.from(await object.Body.transformToByteArray());
            const audio=await normalizeTranscriptionAudio({bytes,fileName:row.file_name??`voice-${row.id}.ogg`,mimeType:row.mime_type??"audio/ogg"});
            const transcript=await transcribeAudio(setting!,audio);
            await pool.query("INSERT INTO message_transcriptions(message_id,transcript_text,provider,model) VALUES($1,$2,$3,$4) ON CONFLICT(message_id) DO NOTHING",[row.id,transcript,setting!.provider,setting!.transcriptionModel]);
            return transcript;
          });
        }
      }
      const translatedText=await translateText(setting!,{text:sourceText,targetLanguage:parsed.data.targetLanguage});
      await pool.query("INSERT INTO message_translations(message_id,target_language,translated_text,provider,model) VALUES($1,$2,$3,$4,$5) ON CONFLICT(message_id,target_language) DO NOTHING",[row.id,parsed.data.targetLanguage,translatedText,setting!.provider,setting!.model]);
      return{id:row.id,translatedText,sourceText};
    }catch(error){const failure=translationFailure(error);request.log.error({messageId:row.id,provider:setting?.provider,error:String(error),failure:failure.error},"Incoming message translation failed");return{id:row.id,...failure};}
  }));
  const generatedById=new Map(generated.map(item=>[item.id,item]));
  return{data:parsed.data.messageIds.map(messageId=>{const row=found.rows.find(item=>item.id===messageId);const isText=row?.kind==="text"&&String(row.text_content??"").trim();const isAudio=row?.kind==="audio"&&row.media_id&&row.object_key;if(!row||row.direction!=="in"||(!isText&&!isAudio)||(isAudio&&!row.translated_text&&!parsed.data.generateAudio))return{messageId,status:"skipped"};const item=generatedById.get(messageId);if(item?.error)return{messageId,status:"failed",error:item.error,message:item.message};return{messageId,status:"translated",translatedText:row.translated_text??item?.translatedText,...(isAudio?{sourceText:row.transcript_text??item?.sourceText}:{})};})};
});

app.get("/api/v1/admin/translation-providers", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  reply.header("cache-control","no-store");
  const result=await pool.query("SELECT provider,enabled,api_key_encrypted,base_url,model,transcription_model,updated_at FROM translation_provider_settings");const rows=new Map(result.rows.map(row=>[row.provider,row]));
  return{data:TRANSLATION_PROVIDERS.map(provider=>{const row=rows.get(provider),defaults=translationProviderDefaults(provider);return{provider,enabled:Boolean(row?.enabled),keyConfigured:Boolean(row?.api_key_encrypted),apiKey:row?.api_key_encrypted?decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY):"",baseUrl:row?.base_url??defaults.baseUrl,model:row?.model??defaults.model,transcriptionModel:row?.transcription_model??defaults.transcriptionModel,updatedAt:row?.updated_at??null};})};
});

app.put("/api/v1/admin/translation-providers/:provider", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(!TRANSLATION_PROVIDERS.includes(provider as TranslationProvider))return reply.code(404).send({error:"provider_not_found"});
  const actorId=request.principal.id;
  const parsed=translationProviderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const current=await pool.query("SELECT api_key_encrypted FROM translation_provider_settings WHERE provider=$1",[provider]);const encrypted=parsed.data.apiKey?encryptAtRest(parsed.data.apiKey,config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;if(parsed.data.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required",message:"启用 Provider 前必须填写 API Key"});
  await transaction(async client=>{if(parsed.data.enabled)await client.query("UPDATE translation_provider_settings SET enabled=false,updated_at=now() WHERE enabled=true AND provider<>$1",[provider]);await client.query("INSERT INTO translation_provider_settings(provider,enabled,api_key_encrypted,base_url,model,transcription_model,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,transcription_model=EXCLUDED.transcription_model,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,encrypted,parsed.data.baseUrl,parsed.data.model,parsed.data.transcriptionModel,actorId]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'translation_provider.update','translation_provider',$2,$3)",[actorId,provider,JSON.stringify({enabled:parsed.data.enabled,baseUrl:parsed.data.baseUrl,model:parsed.data.model,transcriptionModel:parsed.data.transcriptionModel,keyChanged:Boolean(parsed.data.apiKey)})]);});
  return{provider,enabled:parsed.data.enabled,keyConfigured:Boolean(encrypted),baseUrl:parsed.data.baseUrl,model:parsed.data.model,transcriptionModel:parsed.data.transcriptionModel};
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
  reply.header("cache-control","no-store");
  const result=await pool.query("SELECT provider,enabled,api_key_encrypted,base_url,model,voice,updated_at FROM tts_provider_settings");const rows=new Map(result.rows.map(row=>[row.provider,row]));
  return{data:TTS_PROVIDERS.map(provider=>{const row=rows.get(provider),defaults=ttsProviderDefaults(provider);return{provider,enabled:Boolean(row?.enabled),keyConfigured:Boolean(row?.api_key_encrypted),apiKey:row?.api_key_encrypted?decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY):"",baseUrl:row?.base_url??defaults.baseUrl,model:row?.model??defaults.model,voice:row?.voice??defaults.voice,updatedAt:row?.updated_at??null};})};
});

app.put("/api/v1/admin/tts-providers/:provider", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(!TTS_PROVIDERS.includes(provider as TtsProvider))return reply.code(404).send({error:"provider_not_found"});
  const parsed=ttsProviderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});if(provider!=="azure"&&!parsed.data.model)return reply.code(400).send({error:"model_required",message:"该 Provider 必须填写模型 ID"});const current=await pool.query("SELECT api_key_encrypted FROM tts_provider_settings WHERE provider=$1",[provider]);const encrypted=parsed.data.apiKey?encryptAtRest(parsed.data.apiKey,config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;if(parsed.data.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required",message:"启用 Provider 前必须填写 API Key"});
  await transaction(async client=>{if(parsed.data.enabled)await client.query("UPDATE tts_provider_settings SET enabled=false,updated_at=now() WHERE enabled=true AND provider<>$1",[provider]);await client.query("INSERT INTO tts_provider_settings(provider,enabled,api_key_encrypted,base_url,model,voice,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,voice=EXCLUDED.voice,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,encrypted,parsed.data.baseUrl,parsed.data.model,parsed.data.voice,request.principal?.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'tts_provider.update','tts_provider',$2,$3)",[request.principal?.id,provider,JSON.stringify({enabled:parsed.data.enabled,baseUrl:parsed.data.baseUrl,model:parsed.data.model,voice:parsed.data.voice,keyChanged:Boolean(parsed.data.apiKey)})]);});
  return{provider,enabled:parsed.data.enabled,keyConfigured:Boolean(encrypted),baseUrl:parsed.data.baseUrl,model:parsed.data.model,voice:parsed.data.voice};
});

app.get("/api/v1/media", {preHandler:authenticate}, async(request,reply)=>{
  const query=request.query as {accountId?:string;q?:string;limit?:string};if(!query.accountId)return reply.code(400).send({error:"account_required"});if(!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??60)));const result=await pool.query("SELECT m.id,m.file_name,m.mime_type,m.byte_size,m.sha256,m.created_at,((SELECT COUNT(*) FROM messages msg WHERE msg.media_id=m.id)+(SELECT COUNT(*) FROM order_items item WHERE item.image_media_id=m.id)+(SELECT COUNT(*) FROM orders o WHERE o.rendered_media_id=m.id)+(SELECT COUNT(*) FROM products p WHERE p.image_media_id=m.id)+(SELECT COUNT(*) FROM email_attachments e WHERE e.media_id=m.id)+(SELECT COUNT(*) FROM material_assets a WHERE a.media_id=m.id)+(SELECT COUNT(*) FROM collage_templates t WHERE t.deleted_at IS NULL AND (t.template->'canvas'->>'backgroundMediaId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.template->'layers') layer WHERE layer->>'mediaId'=m.id::text))))::int usage_count FROM media m WHERE (m.account_id=$1 OR m.account_id IS NULL) AND m.status='ready' AND ($2::text IS NULL OR m.file_name ILIKE '%'||$2||'%') ORDER BY m.created_at DESC LIMIT $3",[query.accountId,query.q?.trim()||null,limit]);return{data:result.rows};
});

app.get("/api/v1/media/:id", {preHandler:authenticate}, async(request,reply)=>{
  const {id}=request.params as {id:string};const found=await pool.query("SELECT id,account_id,object_key,file_name,mime_type FROM media WHERE id=$1 AND status='ready'",[id]);
  if(!found.rowCount)return reply.code(404).send({error:"not_found"});const item=found.rows[0];if(item.account_id&&!canAccessAccount(request.principal,item.account_id))return reply.code(403).send({error:"account_forbidden"});
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));reply.header("content-type",item.mime_type).header("content-disposition",`${String(item.mime_type).startsWith("image/")||String(item.mime_type).startsWith("video/")||String(item.mime_type).startsWith("audio/")?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(item.file_name??"attachment")}`).header("cache-control","private, max-age=300");return reply.send(object.Body);
});

app.delete("/api/v1/media/:id", {preHandler:authenticate}, async(request,reply)=>{
  const {id}=request.params as {id:string};const found=await pool.query("SELECT m.id,m.account_id,m.object_key,((SELECT COUNT(*) FROM messages msg WHERE msg.media_id=m.id)+(SELECT COUNT(*) FROM order_items item WHERE item.image_media_id=m.id)+(SELECT COUNT(*) FROM orders o WHERE o.rendered_media_id=m.id)+(SELECT COUNT(*) FROM products p WHERE p.image_media_id=m.id)+(SELECT COUNT(*) FROM email_attachments e WHERE e.media_id=m.id)+(SELECT COUNT(*) FROM material_assets a WHERE a.media_id=m.id)+(SELECT COUNT(*) FROM collage_templates t WHERE t.deleted_at IS NULL AND (t.template->'canvas'->>'backgroundMediaId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.template->'layers') layer WHERE layer->>'mediaId'=m.id::text))))::int usage_count FROM media m WHERE m.id=$1",[id]);if(!found.rowCount)return reply.code(404).send({error:"not_found"});const item=found.rows[0];if(!canAccessAccount(request.principal,item.account_id))return reply.code(403).send({error:"account_forbidden"});if(Number(item.usage_count)>0)return reply.code(409).send({error:"media_in_use"});await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));await transaction(async client=>{await client.query("DELETE FROM media WHERE id=$1",[id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'media.delete','media',$3,$4)",[request.principal?.kind,request.principal?.id,id,JSON.stringify({accountId:item.account_id,objectKey:item.object_key})]);});return reply.code(204).send();
});

app.get("/api/v1/admin/agent-provider",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  reply.header("cache-control","no-store");
  const rows=await pool.query("SELECT provider,enabled,base_url,model,embedding_model,api_key_encrypted,updated_at FROM agent_provider_settings ORDER BY provider");
  const defaults=[{provider:"openai",base_url:"https://api.openai.com/v1",model:"gpt-5.6-luna",embedding_model:"text-embedding-3-small"},{provider:"openrouter",base_url:"https://openrouter.ai/api/v1",model:"openai/gpt-oss-20b",embedding_model:"openai/text-embedding-3-small"},{provider:"siliconflow",base_url:"https://api.siliconflow.cn/v1",model:"deepseek-ai/DeepSeek-V3.2",embedding_model:"Qwen/Qwen3-Embedding-4B"},{provider:"openai_compatible",base_url:"",model:"",embedding_model:""}];
  return{data:defaults.map(item=>{const row=rows.rows.find(value=>value.provider===item.provider);return row?{provider:row.provider,enabled:Boolean(row.enabled),key_configured:Boolean(row.api_key_encrypted),api_key:row.api_key_encrypted?decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY):"",base_url:row.base_url,model:row.model,embedding_model:row.embedding_model,updated_at:row.updated_at}:{...item,enabled:false,key_configured:false,api_key:"",updated_at:null};})};
});

app.put("/api/v1/admin/agent-provider/:provider",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {provider}=request.params as {provider:string};if(!["openai","openrouter","siliconflow","openai_compatible"].includes(provider))return reply.code(404).send({error:"not_found"});
  const body=(request.body??{}) as {enabled?:boolean;apiKey?:string;baseUrl?:string;model?:string;embeddingModel?:string};if(typeof body.enabled!=="boolean"||!body.baseUrl?.trim()||!body.model?.trim()||!body.embeddingModel?.trim())return reply.code(400).send({error:"invalid_request"});
  const baseUrl=body.baseUrl.trim(),model=body.model.trim(),embeddingModel=body.embeddingModel.trim();const current=await pool.query("SELECT api_key_encrypted FROM agent_provider_settings WHERE provider=$1",[provider]);const encrypted=body.apiKey?.trim()?encryptAtRest(body.apiKey.trim(),config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;if(body.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required"});
  await transaction(async client=>{if(body.enabled)await client.query("UPDATE agent_provider_settings SET enabled=false,updated_at=now() WHERE provider<>$1",[provider]);await client.query("INSERT INTO agent_provider_settings(provider,enabled,api_key_encrypted,base_url,model,embedding_model) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,embedding_model=EXCLUDED.embedding_model,updated_at=now()",[provider,body.enabled,encrypted,baseUrl,model,embeddingModel]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'agent.provider.update','agent_provider',$2,$3)",[request.principal!.id,provider,JSON.stringify({enabled:body.enabled,baseUrl,model,embeddingModel})]);});return{provider,enabled:body.enabled,keyConfigured:Boolean(encrypted)};
});

app.get("/api/v1/accounts/:id/agent-settings",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});const result=await pool.query("SELECT account_id,enabled,persona,reply_language,timezone,business_days,business_start::text,business_end::text,confidence_threshold,followup_enabled,followup_delays_hours,updated_at FROM account_agent_settings WHERE account_id=$1",[id]);const assigned=await pool.query("SELECT knowledge_base_id FROM account_knowledge_bases WHERE account_id=$1",[id]);return{...(result.rows[0]??{account_id:id,enabled:false,persona:'You are a helpful, concise customer service agent.',reply_language:'auto',timezone:'UTC',business_days:[1,2,3,4,5],business_start:'09:00',business_end:'18:00',confidence_threshold:.8,followup_enabled:true,followup_delays_hours:[24,72]}),knowledgeBaseIds:assigned.rows.map(row=>row.knowledge_base_id)};});

app.put("/api/v1/accounts/:id/agent-settings",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});const body=(request.body??{}) as Record<string,unknown>;const days=Array.isArray(body.businessDays)?body.businessDays.map(Number):[1,2,3,4,5],delays=Array.isArray(body.followupDelaysHours)?body.followupDelaysHours.map(Number):[24,72],threshold=Number(body.confidenceThreshold??.8);if(!days.every(day=>Number.isInteger(day)&&day>=0&&day<=6)||delays.length>5||!delays.every((value,index)=>Number.isInteger(value)&&value>0&&(index===0||value>delays[index-1]))||threshold<0||threshold>1)return reply.code(400).send({error:"invalid_request"});
  const knowledgeBaseIds=Array.isArray(body.knowledgeBaseIds)?body.knowledgeBaseIds.map(String):[];await transaction(async client=>{await client.query("INSERT INTO account_agent_settings(account_id,enabled,persona,reply_language,timezone,business_days,business_start,business_end,confidence_threshold,followup_enabled,followup_delays_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,persona=EXCLUDED.persona,reply_language=EXCLUDED.reply_language,timezone=EXCLUDED.timezone,business_days=EXCLUDED.business_days,business_start=EXCLUDED.business_start,business_end=EXCLUDED.business_end,confidence_threshold=EXCLUDED.confidence_threshold,followup_enabled=EXCLUDED.followup_enabled,followup_delays_hours=EXCLUDED.followup_delays_hours,updated_at=now()",[id,Boolean(body.enabled),String(body.persona??"").slice(0,5000)||"You are a helpful, concise customer service agent.",String(body.replyLanguage??"auto").slice(0,35),String(body.timezone??"UTC").slice(0,100),days,String(body.businessStart??"09:00"),String(body.businessEnd??"18:00"),threshold,body.followupEnabled!==false,delays]);await client.query("DELETE FROM account_knowledge_bases WHERE account_id=$1",[id]);if(knowledgeBaseIds.length)await client.query("INSERT INTO account_knowledge_bases(account_id,knowledge_base_id) SELECT $1,id FROM knowledge_bases WHERE id=ANY($2::uuid[])",[id,knowledgeBaseIds]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'agent.account_settings.update','whatsapp_account',$2,$3)",[request.principal!.id,id,JSON.stringify({enabled:Boolean(body.enabled),knowledgeBaseIds})]);});return reply.code(204).send();});

app.get("/api/v1/knowledge-bases",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const result=await pool.query(`SELECT kb.id,kb.name,kb.description,kb.created_at,kb.updated_at,(SELECT count(*)::int FROM knowledge_documents d WHERE d.knowledge_base_id=kb.id) document_count,(SELECT count(*)::int FROM knowledge_faqs f WHERE f.knowledge_base_id=kb.id) faq_count FROM knowledge_bases kb ORDER BY lower(kb.name)`);return{data:result.rows};});
app.post("/api/v1/knowledge-bases",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const body=(request.body??{}) as {name?:string;description?:string};if(!body.name?.trim()||body.name.trim().length>120)return reply.code(400).send({error:"invalid_request"});const result=await pool.query("INSERT INTO knowledge_bases(name,description,created_by) VALUES($1,$2,$3) RETURNING *",[body.name.trim(),body.description?.trim().slice(0,1000)??"",request.principal!.id]);return reply.code(201).send(result.rows[0]);});
app.patch("/api/v1/knowledge-bases/:id",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {name?:string;description?:string};if(!body.name?.trim()||body.name.trim().length>120)return reply.code(400).send({error:"invalid_request"});const description=body.description===undefined?null:body.description.trim().slice(0,1000);const result=await pool.query("UPDATE knowledge_bases SET name=$2,description=COALESCE($3,description),updated_at=now() WHERE id=$1 RETURNING *",[id,body.name.trim(),description]);return result.rowCount?result.rows[0]:reply.code(404).send({error:"not_found"});});
app.delete("/api/v1/knowledge-bases/:id",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {id}=request.params as {id:string};const docs=await pool.query("SELECT object_key FROM knowledge_documents WHERE knowledge_base_id=$1",[id]);for(const row of docs.rows)await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key})).catch(()=>undefined);await pool.query("DELETE FROM knowledge_bases WHERE id=$1",[id]);return reply.code(204).send();});
app.get("/api/v1/knowledge-bases/:id",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const [kb,docs,faqs]=await Promise.all([pool.query("SELECT * FROM knowledge_bases WHERE id=$1",[id]),pool.query("SELECT id,file_name,mime_type,byte_size,status,error,created_at,updated_at FROM knowledge_documents WHERE knowledge_base_id=$1 ORDER BY created_at DESC",[id]),pool.query("SELECT id,question,answer,created_at,updated_at FROM knowledge_faqs WHERE knowledge_base_id=$1 ORDER BY updated_at DESC",[id])]);if(!kb.rowCount)return reply.code(404).send({error:"not_found"});return{...kb.rows[0],documents:docs.rows,faqs:faqs.rows};});
app.post("/api/v1/knowledge-bases/:id/documents",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const exists=await pool.query("SELECT id FROM knowledge_bases WHERE id=$1",[id]);if(!exists.rowCount)return reply.code(404).send({error:"not_found"});const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});const bytes=await file.toBuffer();if(bytes.length>20*1024*1024)return reply.code(413).send({error:"file_too_large"});const lower=file.filename.toLowerCase();if(!["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","text/plain","text/markdown"].includes(file.mimetype)&&!/\.(pdf|docx|txt|md|markdown)$/.test(lower))return reply.code(415).send({error:"unsupported_document_type"});const objectKey=`knowledge/${id}/${randomBytes(16).toString("hex")}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:file.mimetype}));const created=await transaction(async client=>{const doc=await client.query("INSERT INTO knowledge_documents(knowledge_base_id,object_key,file_name,mime_type,byte_size,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status",[id,objectKey,file.filename,file.mimetype,bytes.length,request.principal!.id]);await client.query("INSERT INTO agent_jobs(document_id,kind) VALUES($1,'index_document')",[doc.rows[0].id]);return doc.rows[0];});return reply.code(202).send(created);});
app.post("/api/v1/knowledge-bases/:id/faqs",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {question?:string;answer?:string};if(!body.question?.trim()||!body.answer?.trim())return reply.code(400).send({error:"invalid_request"});const question=body.question.trim().slice(0,2000),answer=body.answer.trim().slice(0,10000);const created=await transaction(async client=>{const faq=await client.query("INSERT INTO knowledge_faqs(knowledge_base_id,question,answer) VALUES($1,$2,$3) RETURNING *",[id,question,answer]);await client.query("INSERT INTO agent_jobs(kind,payload) VALUES('index_faq',$1)",[JSON.stringify({faqId:faq.rows[0].id})]);return faq.rows[0];});return reply.code(201).send(created);});
app.delete("/api/v1/knowledge-bases/:id/faqs/:faqId",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id,faqId}=request.params as {id:string;faqId:string};await pool.query("DELETE FROM knowledge_faqs WHERE id=$1 AND knowledge_base_id=$2",[faqId,id]);return reply.code(204).send();});
app.patch("/api/v1/knowledge-bases/:id/faqs/:faqId",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id,faqId}=request.params as {id:string;faqId:string};const body=(request.body??{}) as {question?:string;answer?:string};if(!body.question?.trim()||!body.answer?.trim())return reply.code(400).send({error:"invalid_request"});const question=body.question.trim().slice(0,2000),answer=body.answer.trim().slice(0,10000);const updated=await transaction(async client=>{const faq=await client.query("UPDATE knowledge_faqs SET question=$3,answer=$4,updated_at=now() WHERE id=$1 AND knowledge_base_id=$2 RETURNING *",[faqId,id,question,answer]);if(faq.rowCount){await client.query("DELETE FROM agent_jobs WHERE kind='index_faq' AND payload->>'faqId'=$1 AND state='pending'",[faqId]);await client.query("INSERT INTO agent_jobs(kind,payload) VALUES('index_faq',$1)",[JSON.stringify({faqId})]);}return faq.rows[0]??null;});return updated??reply.code(404).send({error:"not_found"});});
app.post("/api/v1/knowledge-documents/:id/reindex",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};await transaction(async client=>{await client.query("UPDATE knowledge_documents SET status='pending',error=NULL,updated_at=now() WHERE id=$1",[id]);await client.query("INSERT INTO agent_jobs(document_id,kind) VALUES($1,'index_document')",[id]);});return reply.code(202).send({status:"pending"});});
app.delete("/api/v1/knowledge-documents/:id",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const doc=await pool.query("SELECT object_key FROM knowledge_documents WHERE id=$1",[id]);if(!doc.rowCount)return reply.code(404).send({error:"not_found"});await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:doc.rows[0].object_key})).catch(()=>undefined);await pool.query("DELETE FROM knowledge_documents WHERE id=$1",[id]);return reply.code(204).send();});

app.get("/api/v1/conversations/:id/agent",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});const [state,draft,runs]=await Promise.all([pool.query("SELECT COALESCE(st.mode,'human_paused') mode,st.pause_reason,COALESCE(st.followup_count,0) followup_count,COALESCE(s.enabled,false) account_enabled FROM conversations c LEFT JOIN conversation_agent_state st ON st.conversation_id=c.id LEFT JOIN account_agent_settings s ON s.account_id=c.account_id WHERE c.id=$1",[id]),pool.query("SELECT id,text_content,reply_zh,reason,citations,created_at FROM ai_drafts WHERE conversation_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[id]),pool.query("SELECT id,kind,decision,confidence,citations,status,error,created_at,completed_at FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20",[id])]);return{...state.rows[0],draft:draft.rows[0]??null,runs:runs.rows};});
app.put("/api/v1/conversations/:id/agent",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {mode?:string};if(!["cautious","full","human_paused"].includes(body.mode??""))return reply.code(400).send({error:"invalid_mode"});const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});await transaction(async client=>{await client.query("SELECT id FROM conversations WHERE id=$1 FOR UPDATE",[id]);await client.query("INSERT INTO conversation_agent_state(conversation_id,mode,pause_reason) VALUES($1,$2,$3) ON CONFLICT(conversation_id) DO UPDATE SET mode=EXCLUDED.mode,pause_reason=EXCLUDED.pause_reason,updated_at=now()",[id,body.mode,body.mode==="human_paused"?"manual_pause":null]);if(body.mode==="full")await client.query("UPDATE ai_drafts SET status='dismissed',resolved_at=now(),resolved_by=$2 WHERE conversation_id=$1 AND status='pending'",[id,request.principal!.id]);if(body.mode==="human_paused")await client.query("UPDATE agent_jobs SET state='cancelled',completed_at=now(),last_error='manual_pause' WHERE conversation_id=$1 AND state='pending' AND kind IN ('reply','followup')",[id]);});return{mode:body.mode};});
app.get("/api/v1/conversations/:id/memory",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});const [memory,facts]=await Promise.all([pool.query("SELECT summary,source_message_id,updated_at FROM conversation_memories WHERE conversation_id=$1",[id]),pool.query("SELECT f.id,f.fact_key,f.fact_value,f.confidence,f.source_message_id,f.updated_at,m.text_content source_text FROM customer_memory_facts f LEFT JOIN messages m ON m.id=f.source_message_id WHERE f.conversation_id=$1 ORDER BY f.updated_at DESC",[id])]);return{summary:memory.rows[0]?.summary??"",updatedAt:memory.rows[0]?.updated_at??null,facts:facts.rows};});
app.patch("/api/v1/conversations/:id/memory/facts/:factId",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id,factId}=request.params as {id:string;factId:string};const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});const body=(request.body??{}) as {key?:string;value?:string};if(!body.key?.trim()||!body.value?.trim())return reply.code(400).send({error:"invalid_request"});const result=await pool.query("UPDATE customer_memory_facts SET fact_key=$3,fact_value=$4,confidence=1,updated_at=now() WHERE id=$1 AND conversation_id=$2 RETURNING *",[factId,id,body.key.trim().slice(0,120),body.value.trim().slice(0,1000)]);return result.rowCount?result.rows[0]:reply.code(404).send({error:"not_found"});});
app.delete("/api/v1/conversations/:id/memory/facts/:factId",{preHandler:authenticate},async(request,reply)=>{const {id,factId}=request.params as {id:string;factId:string};const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("DELETE FROM customer_memory_facts WHERE id=$1 AND conversation_id=$2",[factId,id]);return reply.code(204).send();});
app.post("/api/v1/conversations/:id/memory/rebuild",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("INSERT INTO agent_jobs(conversation_id,kind,payload) VALUES($1,'refresh_memory',$2)",[id,JSON.stringify({memoryOnly:true})]);return reply.code(202).send({status:"pending"});});
app.post("/api/v1/ai-drafts/:id/send",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {text?:string};const result=await transaction(async client=>{const draft=await client.query("SELECT d.id,d.conversation_id,d.text_content,c.account_id,a.agent_id,co.wa_jid FROM ai_drafts d JOIN conversations c ON c.id=d.conversation_id JOIN whatsapp_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE d.id=$1 AND d.status='pending' FOR UPDATE",[id]);if(!draft.rowCount||!canAccessAccount(request.principal,draft.rows[0].account_id))return null;const row=draft.rows[0],text=body.text?.trim()||row.text_content,clientMessageId=`draft-${id}`;const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) ON CONFLICT(account_id,client_message_id) DO UPDATE SET text_content=messages.text_content RETURNING id",[row.conversation_id,row.account_id,request.principal!.id,clientMessageId,text]);await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) SELECT $1,$2,$3,'send_message',$4 WHERE NOT EXISTS(SELECT 1 FROM outbound_commands WHERE message_id=$3)",[row.agent_id,row.account_id,message.rows[0].id,JSON.stringify({accountId:row.account_id,conversationId:row.conversation_id,clientMessageId,type:"text",text,messageId:message.rows[0].id,toJid:row.wa_jid})]);await client.query("UPDATE ai_drafts SET status='sent',resolved_at=now(),resolved_by=$2 WHERE id=$1",[id,request.principal!.id]);await pauseAgentForHuman(client,row.conversation_id);return{messageId:message.rows[0].id,agentId:row.agent_id};});if(!result)return reply.code(404).send({error:"not_found"});if(result.agentId)void dispatchPending(result.agentId);return reply.code(202).send(result);});
app.post("/api/v1/ai-drafts/:id/dismiss",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const draft=await pool.query("SELECT c.account_id FROM ai_drafts d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=$1",[id]);if(!draft.rowCount||!canAccessAccount(request.principal,draft.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("UPDATE ai_drafts SET status='dismissed',resolved_at=now(),resolved_by=$2 WHERE id=$1 AND status='pending'",[id,request.principal?.id]);return reply.code(204).send();});

app.post("/api/v1/media", { preHandler:authenticate }, async (request,reply) => {
  const query=request.query as {accountId?:string};if(!query.accountId)return reply.code(400).send({error:"account_required"});if(!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const file=await request.file(); if(!file)return reply.code(400).send({error:"file_required"});
  const allowed=new Set(["image/jpeg","image/png","image/webp","video/mp4","audio/ogg","audio/mpeg","application/pdf","application/zip","text/plain","text/csv","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation"]); if(!allowed.has(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});
  const bytes=await file.toBuffer(); const sha256=createHash("sha256").update(bytes).digest("hex");const existing=await pool.query("SELECT id,file_name,mime_type,byte_size,sha256 FROM media WHERE account_id=$1 AND sha256=$2 AND status='ready' ORDER BY created_at DESC LIMIT 1",[query.accountId,sha256]);if(existing.rowCount)return reply.code(200).send({mediaId:existing.rows[0].id,fileName:existing.rows[0].file_name,mimeType:existing.rows[0].mime_type,size:Number(existing.rows[0].byte_size),sha256,deduplicated:true}); const id=randomBytes(16).toString("hex"); const objectKey=`uploads/${query.accountId}/${new Date().toISOString().slice(0,10)}/${id}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:file.mimetype,Metadata:{sha256}}));
  const media=await transaction(async client=>{const created=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[query.accountId,objectKey,file.filename,file.mimetype,bytes.length,sha256]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'media.upload','media',$3,$4)",[request.principal?.kind,request.principal?.id,created.rows[0].id,JSON.stringify({accountId:query.accountId,fileName:file.filename,mimeType:file.mimetype,byteSize:bytes.length,sha256})]);return created;}); return reply.code(201).send({mediaId:media.rows[0].id,fileName:file.filename,mimeType:file.mimetype,size:bytes.length,sha256});
});

app.setErrorHandler((error,_request,reply)=>{app.log.error(error);void reply.code((error as {statusCode?:number}).statusCode??500).send({error:"internal_error",message:config.NODE_ENV==="production"?"服务暂时不可用":error instanceof Error?error.message:String(error)});});

await registerAgentHub(app);

async function activeTranslationSetting():Promise<TranslationProviderSetting|null>{
  const result=await pool.query("SELECT provider,api_key_encrypted,base_url,model,transcription_model FROM translation_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1");
  if(!result.rowCount)return null;const row=result.rows[0];
  return{provider:row.provider as TranslationProvider,apiKey:decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY),baseUrl:row.base_url,model:row.model,transcriptionModel:row.transcription_model};
}

async function mapWithConcurrency<T,R>(items:T[],limit:number,work:(item:T)=>Promise<R>):Promise<R[]>{
  const results=new Array<R>(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const index=cursor++;results[index]=await work(items[index]);}}));
  return results;
}

type ProductLabelInput={name:string;color:string};
type OrderProductInput={name:string;sku?:string;quantity:number;unitAmount:number;imageMediaId?:string;productId?:string;clientProductId?:string};
type CustomerAddressInput={label:string;recipientName?:string;phone?:string;address:string};

function mapContactRow(row:Record<string,unknown>){
  const emails=Array.isArray(row.emails)?row.emails as Array<{id:string;label:string;email:string;isPrimary:boolean}>:[],methods=Array.isArray(row.methods)?row.methods as Array<{id:string;type:string;label:string;value:string}>:[],addresses=Array.isArray(row.addresses)?row.addresses:[],specialDates=Array.isArray(row.special_dates)?row.special_dates:[];
  return{id:String(row.id),accountId:String(row.account_id),accountName:String(row.account_name??""),alias:String(row.alias??""),contactName:String(row.contact_name??""),name:String(row.alias||row.contact_name||row.phone_e164||"未知联系人"),phone:String(row.phone_e164??""),avatarUrl:row.avatar_url?`/api/v1/contacts/${row.id}/avatar`:null,note:String(row.note??""),birthday:row.birthday_month?{month:Number(row.birthday_month),day:Number(row.birthday_day),year:row.birthday_year?Number(row.birthday_year):null}:null,specialDates,emails,primaryEmail:primaryContactEmail(emails),methods,addresses,conversationId:row.conversation_id?String(row.conversation_id):null,hasConversation:Boolean(row.conversation_id),lastMessageAt:row.last_message_at?String(row.last_message_at):null,updatedAt:String(row.updated_at??"")};
}

async function contactProfileById(db:typeof pool|PoolClient,id:string){
  const [contact,emails,methods,addresses,specialDates]=await Promise.all([
    db.query("SELECT co.id,co.account_id,a.display_name account_name,co.alias,co.display_name contact_name,co.phone_e164,co.avatar_url,co.note,co.birthday_month,co.birthday_day,co.birthday_year,co.updated_at,c.id conversation_id,c.last_message_at FROM contacts co JOIN whatsapp_accounts a ON a.id=co.account_id LEFT JOIN conversations c ON c.contact_id=co.id WHERE co.id=$1",[id]),
    db.query("SELECT id,label,email,is_primary \"isPrimary\" FROM contact_emails WHERE contact_id=$1 ORDER BY position,id",[id]),
    db.query("SELECT id,type,label,value FROM contact_methods WHERE contact_id=$1 ORDER BY position,id",[id]),
    db.query("SELECT id,label,recipient_name \"recipientName\",phone,address FROM contact_addresses WHERE contact_id=$1 ORDER BY created_at,id",[id]),
    db.query("SELECT id,kind,label,month,day,year,lead_days \"leadDays\" FROM contact_special_dates WHERE contact_id=$1 ORDER BY month,day,id",[id]),
  ]);
  return contact.rowCount?mapContactRow({...contact.rows[0],emails:emails.rows,methods:methods.rows,addresses:addresses.rows,special_dates:specialDates.rows}):null;
}

async function resolveOrderAddress(client:{query:(text:string,values?:unknown[])=>Promise<{rowCount:number|null;rows:Array<Record<string,unknown>>}>},contactId:string,actorId:string,addressId?:string|null,newAddress?:CustomerAddressInput){
  if(addressId){const found=await client.query("SELECT id,label,recipient_name,phone,address FROM contact_addresses WHERE id=$1 AND contact_id=$2",[addressId,contactId]);if(!found.rowCount)throw Object.assign(new Error("invalid_customer_address"),{statusCode:400});const row=found.rows[0];return{id:String(row.id),snapshot:{label:String(row.label),recipientName:String(row.recipient_name??""),phone:String(row.phone??""),address:String(row.address)}};}
  if(!newAddress)return null;
  const created=await client.query("INSERT INTO contact_addresses(contact_id,label,recipient_name,phone,address,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,label,recipient_name,phone,address",[contactId,newAddress.label,newAddress.recipientName??null,newAddress.phone??null,newAddress.address,actorId]);const row=created.rows[0];return{id:String(row.id),snapshot:{label:String(row.label),recipientName:String(row.recipient_name??""),phone:String(row.phone??""),address:String(row.address)}};
}

function mapProductRow(row:Record<string,unknown>){const tiers=Array.isArray(row.price_tiers)?(row.price_tiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[];return{id:String(row.id),sku:String(row.sku),name:String(row.name),description:String(row.description??""),defaultUnitAmount:tiers[0]?.unitAmount??Number(row.default_unit_amount),priceTiers:tiers,currency:String(row.currency),imageMediaId:row.image_media_id?String(row.image_media_id):null,imageName:String(row.image_name??""),tags:Array.isArray(row.tags)?row.tags:[],createdAt:String(row.created_at),updatedAt:String(row.updated_at)};}

async function productById(client:PoolClient,id:string){const result=await client.query(`SELECT p.id,p.sku,p.name,p.description,p.default_unit_amount,p.currency,p.image_media_id,m.file_name image_name,p.created_at,p.updated_at,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers FROM products p LEFT JOIN media m ON m.id=p.image_media_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true WHERE p.id=$1`,[id]);return result.rowCount?mapProductRow(result.rows[0]):null;}

function uniqueProductLabels(labels:ProductLabelInput[]){const seen=new Set<string>();return labels.filter(label=>{const key=label.name.trim().toLocaleLowerCase();if(!key||seen.has(key))return false;seen.add(key);return true;}).map(label=>({name:label.name.trim(),color:label.color}));}

async function replaceProductLabels(client:PoolClient,productId:string,labels:ProductLabelInput[]){await client.query("DELETE FROM product_labels WHERE product_id=$1",[productId]);for(const label of uniqueProductLabels(labels))await client.query("INSERT INTO product_labels(product_id,name,color) VALUES($1,$2,$3)",[productId,label.name,label.color]);}
async function replaceProductPriceTiers(client:PoolClient,productId:string,tiers:Array<{minQuantity:number;unitAmount:number}>){await client.query("DELETE FROM product_price_tiers WHERE product_id=$1",[productId]);for(const tier of tiers)await client.query("INSERT INTO product_price_tiers(product_id,min_quantity,unit_amount) VALUES($1,$2,$3)",[productId,tier.minQuantity,tier.unitAmount]);}

async function resolveOrderProduct(client:PoolClient,item:OrderProductInput,orderNumber:string,currency:string,actorId:string,conversationLabels:ProductLabelInput[]):Promise<string|null>{
  if(item.productId){const selected=await client.query("SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL",[item.productId]);if(!selected.rowCount)throw Object.assign(new Error("invalid_order_product"),{statusCode:400});return selected.rows[0].id;}
  if(!item.clientProductId)return null;
  const existing=await client.query("SELECT id,currency FROM products WHERE client_product_id=$1",[item.clientProductId]);if(existing.rowCount){if(existing.rows[0].currency!==currency)throw Object.assign(new Error("product_currency_mismatch"),{statusCode:400});return existing.rows[0].id;}
  const duplicateSku=await client.query("SELECT id FROM products WHERE deleted_at IS NULL AND lower(btrim(sku))=lower(btrim($1))",[item.sku]);if(duplicateSku.rowCount)throw Object.assign(new Error("sku_exists"),{statusCode:409});
  const created=await client.query("INSERT INTO products(client_product_id,sku,name,default_unit_amount,currency,image_media_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[item.clientProductId,item.sku,item.name,item.unitAmount,currency,item.imageMediaId??null,actorId]);await replaceProductPriceTiers(client,created.rows[0].id,[{minQuantity:1,unitAmount:item.unitAmount}]);
  const labels=[{name:`订单 #${orderNumber}`,color:"#E8EEF7"},...conversationLabels];await replaceProductLabels(client,created.rows[0].id,labels);
  await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.create','product',$2,$3)",[actorId,created.rows[0].id,JSON.stringify({source:"order",orderNumber,tagCount:uniqueProductLabels(labels).length})]);return created.rows[0].id;
}

function safeFileName(value:string):string{return value.replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,100)||"order";}
async function storeEmailImage(accountId:string,fileName:string,bytes:Buffer,source:string):Promise<{mediaId:string;byteSize:number}>{const sha256=createHash("sha256").update(bytes).digest("hex"),objectKey=`email/${accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}.png`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:"image/png",Metadata:{sha256,source}}));const media=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'image/png',$4,$5) RETURNING id",[accountId,objectKey,fileName,bytes.length,sha256]);return{mediaId:String(media.rows[0].id),byteSize:bytes.length};}

async function auditCrm(actorId:string,action:string,targetType:string,targetId:string,metadata:unknown):Promise<void>{
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,$2,$3,$4,$5)",[actorId,action,targetType,targetId,JSON.stringify(metadata)]);
}

async function queueOrderCommand(client:import("pg").PoolClient,conversation:{account_id:string;agent_id:string;wa_jid:string},conversationId:string,messageId:string,clientMessageId:string,type:"text"|"image",text:string,mediaId?:string):Promise<void>{
  await client.query("INSERT INTO outbound_commands(agent_id,account_id,message_id,command,payload) VALUES($1,$2,$3,'send_message',$4)",[conversation.agent_id,conversation.account_id,messageId,JSON.stringify({accountId:conversation.account_id,conversationId,clientMessageId,type,text,...(mediaId?{mediaId}:{}),messageId,toJid:conversation.wa_jid})]);
}

type PayPalSetting={environment:PayPalEnvironment;clientId:string;clientSecret:string;referenceTemplate:string;noteTemplate:string;itemNameTemplate:string};
async function activePayPalSetting(requiredEnvironment?:string,requireEnabled=true):Promise<PayPalSetting|null>{const result=await pool.query("SELECT enabled,environment,sandbox_client_id_encrypted,sandbox_client_secret_encrypted,live_client_id_encrypted,live_client_secret_encrypted,reference_template,note_template,item_name_template FROM paypal_settings WHERE singleton=true"),row=result.rows[0];if(!row||requireEnabled&&!row.enabled)return null;const environment=(requiredEnvironment??row.environment) as PayPalEnvironment;if(environment!=="sandbox"&&environment!=="live")return null;const clientIdEncrypted=environment==="sandbox"?row.sandbox_client_id_encrypted:row.live_client_id_encrypted,clientSecretEncrypted=environment==="sandbox"?row.sandbox_client_secret_encrypted:row.live_client_secret_encrypted;if(!clientIdEncrypted||!clientSecretEncrypted)return null;return{environment,clientId:decryptAtRest(clientIdEncrypted,config.DATA_ENCRYPTION_KEY),clientSecret:decryptAtRest(clientSecretEncrypted,config.DATA_ENCRYPTION_KEY),referenceTemplate:String(row.reference_template??DEFAULT_PAYPAL_REFERENCE_TEMPLATE),noteTemplate:String(row.note_template??DEFAULT_PAYPAL_NOTE_TEMPLATE),itemNameTemplate:String(row.item_name_template??DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE)};}

function paymentRequestResponse(row:Record<string,unknown>):Record<string,unknown>{return{id:String(row.id),invoiceId:row.provider_request_id?String(row.provider_request_id):null,url:row.payment_url?String(row.payment_url):null,status:String(row.status),amount:Number(row.amount),currency:String(row.currency),environment:String(row.environment),createdAt:row.created_at,lastSyncedAt:row.last_synced_at??null};}

async function accessiblePaymentRequest(orderId:string,principal:Principal):Promise<{request:{id:string;provider_request_id:string|null;environment:string}}|null>{const result=await pool.query("SELECT pr.id,pr.provider_request_id,pr.environment,c.account_id FROM order_payment_requests pr JOIN orders o ON o.id=pr.order_id JOIN conversations c ON c.id=o.conversation_id WHERE pr.order_id=$1 AND pr.is_current AND o.deleted_at IS NULL",[orderId]);if(!result.rowCount||!canAccessAccount(principal,result.rows[0].account_id))return null;return{request:{id:String(result.rows[0].id),provider_request_id:result.rows[0].provider_request_id?String(result.rows[0].provider_request_id):null,environment:String(result.rows[0].environment)}};}

const PAID_PAYPAL_STATUSES=new Set(["PAID","MARKED_AS_PAID","PAID_EXTERNAL","PARTIALLY_PAID","PAYMENT_PENDING"]);
async function cancelCurrentPaymentRequest(orderId:string,actorId:string):Promise<"none"|"cancelled"|"paid">{const result=await pool.query("SELECT * FROM order_payment_requests WHERE order_id=$1 AND is_current ORDER BY created_at DESC LIMIT 1",[orderId]);if(!result.rowCount)return"none";const row=result.rows[0],status=String(row.status).toUpperCase();if(PAID_PAYPAL_STATUSES.has(status))return"paid";if(row.provider_request_id){const setting=await activePayPalSetting(String(row.environment),false);if(!setting)throw new PayPalApiError(409,"paypal_environment_not_configured","PayPal environment is not configured");await new PayPalClient(setting).cancelInvoice(String(row.provider_request_id),status);}await pool.query("UPDATE order_payment_requests SET status='CANCELLED',is_current=false,cancelled_at=now(),updated_at=now() WHERE id=$1",[row.id]);await auditCrm(actorId,"payment_request.cancel","order",orderId,{paymentRequestId:row.id,paypalInvoiceId:row.provider_request_id??null});return"cancelled";}

function paypalFailureMessage(error:unknown):string{if(error instanceof PayPalApiError){if(error.status===401||error.status===403)return"PayPal 鉴权失败，请管理员检查凭据和环境";if(error.status===422||error.status===400)return`PayPal 拒绝了该订单：${error.message}`;if(error.status===429)return"PayPal 请求过于频繁，请稍后重试";}return"PayPal 服务暂时不可用，请稍后重试";}

const transcriptionFlights=new Map<string,Promise<string>>();
const messageTranslationFlights=new Map<string,Promise<{id:string;translatedText?:string;sourceText?:string;error?:string;message?:string}>>();
async function singleFlight<T>(flights:Map<string,Promise<T>>,key:string,work:()=>Promise<T>):Promise<T>{
  const current=flights.get(key);if(current)return current;
  const pending=work().finally(()=>flights.delete(key));flights.set(key,pending);return pending;
}

function translationFailure(error:unknown):{error:string;message:string}{
  const detail=String(error);
  if(detail.includes("audio_conversion_"))return{error:"audio_conversion_failed",message:"语音格式转换失败，请稍后重试"};
  if(/transcription_provider_http_(401|403)/.test(detail))return{error:"transcription_auth_failed",message:"语音转写 Provider 鉴权失败，请联系管理员"};
  if(detail.includes("transcription_provider_http_404"))return{error:"transcription_endpoint_missing",message:"当前 Provider 不支持语音转写接口"};
  if(detail.includes("transcription_provider_http_429"))return{error:"transcription_rate_limited",message:"语音转写请求过于频繁，请稍后重试"};
  if(detail.includes("transcription_provider_http_400"))return{error:"transcription_rejected",message:"转写 Provider 拒绝了音频，请检查转写模型配置"};
  if(detail.includes("transcription_provider_"))return{error:"transcription_failed",message:"语音转写失败，请检查 Provider 配置"};
  return{error:"translation_failed",message:"译文生成失败，请稍后重试"};
}

async function ensureTranslationTables():Promise<void>{
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS translation_source_text text");
  await pool.query(`CREATE TABLE IF NOT EXISTS conversation_translation_preferences (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    agent_language text NOT NULL DEFAULT 'zh-CN',
    customer_language text NOT NULL DEFAULT 'en',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id,conversation_id)
  )`);
  await pool.query(`DO $$ BEGIN
    IF to_regclass('public.user_translation_preferences') IS NOT NULL THEN
      INSERT INTO conversation_translation_preferences(user_id,conversation_id,enabled,agent_language,customer_language,created_at,updated_at)
      SELECT preference.user_id,conversation.id,preference.enabled,preference.agent_language,preference.customer_language,preference.created_at,preference.updated_at
      FROM user_translation_preferences preference CROSS JOIN conversations conversation
      ON CONFLICT(user_id,conversation_id) DO NOTHING;
    END IF;
  END $$`);
  await pool.query("DROP TABLE IF EXISTS user_translation_preferences");
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
  await pool.query("ALTER TABLE translation_provider_settings ADD COLUMN IF NOT EXISTS transcription_model text NOT NULL DEFAULT 'gpt-4o-mini-transcribe'");
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
  await pool.query(`CREATE TABLE IF NOT EXISTS message_transcriptions (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    transcript_text text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
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

async function ensureCurrencySettingsTable():Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS currency_settings (
    code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),name text NOT NULL,
    rate numeric(20,8) NOT NULL CHECK (rate > 0),is_base boolean NOT NULL DEFAULT false,
    position integer NOT NULL DEFAULT 0,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS currency_settings_one_base_idx ON currency_settings ((is_base)) WHERE is_base");
  await pool.query(`CREATE TABLE IF NOT EXISTS currency_rate_metadata (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),source text NOT NULL,
    rate_date date NOT NULL,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`INSERT INTO currency_settings(code,name,rate,is_base,position) SELECT * FROM (VALUES
    ('USD','美元',1::numeric,true,0),('CNY','人民币',7.2,false,1),('EUR','欧元',0.92,false,2),('GBP','英镑',0.78,false,3),('JPY','日元',157,false,4),('HKD','港币',7.8,false,5),('SGD','新加坡元',1.35,false,6),('AUD','澳元',1.5,false,7),('CAD','加元',1.37,false,8),('AED','阿联酋迪拉姆',3.6725,false,9)) defaults(code,name,rate,is_base,position) WHERE NOT EXISTS (SELECT 1 FROM currency_settings) ON CONFLICT(code) DO NOTHING`);
  await pool.query("ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_currency_check");
  await pool.query("ALTER TABLE products DROP CONSTRAINT IF EXISTS products_currency_check");
}

async function ensureCollageTables():Promise<void>{
  await pool.query(`CREATE TABLE IF NOT EXISTS collage_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),template jsonb NOT NULL,is_default boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz)`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS collage_templates_one_default_idx ON collage_templates ((is_default)) WHERE is_default AND deleted_at IS NULL");
  await pool.query("CREATE INDEX IF NOT EXISTS collage_templates_active_idx ON collage_templates (updated_at DESC,id) WHERE deleted_at IS NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS material_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_generation_id uuid UNIQUE NOT NULL,name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),template_id uuid REFERENCES collage_templates(id) ON DELETE SET NULL,
    template_name text NOT NULL,template_snapshot jsonb NOT NULL,product_snapshot jsonb NOT NULL,created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query("CREATE INDEX IF NOT EXISTS material_batches_created_idx ON material_batches (created_at DESC,id)");
  await pool.query(`CREATE TABLE IF NOT EXISTS material_assets (
    batch_id uuid NOT NULL REFERENCES material_batches(id) ON DELETE CASCADE,media_id uuid NOT NULL UNIQUE REFERENCES media(id) ON DELETE RESTRICT,page_index integer NOT NULL CHECK (page_index >= 0),product_ids jsonb NOT NULL,PRIMARY KEY (batch_id,page_index))`);
  await pool.query("INSERT INTO collage_templates(name,template,is_default) SELECT '四宫格商品素材',$1::jsonb,true WHERE NOT EXISTS(SELECT 1 FROM collage_templates WHERE deleted_at IS NULL)",[JSON.stringify(DEFAULT_COLLAGE_TEMPLATE)]);
}

function canManageMaterials(principal:Principal|undefined):boolean{return principal?.kind==="user"&&["admin","supervisor"].includes(principal.role??"");}
function collageMediaIds(template:CollageTemplate):string[]{return[...new Set([...(template.canvas.backgroundMediaId?[template.canvas.backgroundMediaId]:[]),...template.layers.flatMap(layer=>layer.type==="image"?[layer.mediaId]:[])])];}
async function collageMediaValid(template:CollageTemplate):Promise<boolean>{const ids=collageMediaIds(template);if(!ids.length)return true;const found=await pool.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg','image/webp')",[ids]);return found.rowCount===ids.length;}
async function storeSharedImage(fileName:string,mimeType:string,bytes:Buffer,source:string,actorId:string){const sha256=createHash("sha256").update(bytes).digest("hex"),existing=await pool.query("SELECT id,file_name,mime_type,byte_size FROM media WHERE account_id IS NULL AND sha256=$1 AND status='ready' ORDER BY created_at DESC LIMIT 1",[sha256]);if(existing.rowCount)return{mediaId:existing.rows[0].id,fileName:existing.rows[0].file_name,mimeType:existing.rows[0].mime_type,size:Number(existing.rows[0].byte_size),sha256,deduplicated:true};const objectKey=`collage-assets/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mimeType,Metadata:{sha256,source}}));try{const created=await transaction(async client=>{const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES(NULL,$1,$2,$3,$4,$5) RETURNING id",[objectKey,fileName,mimeType,bytes.length,sha256]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'collage.asset_upload','media',$2,$3)",[actorId,media.rows[0].id,JSON.stringify({fileName,mimeType,byteSize:bytes.length,sha256})]);return media.rows[0];});return{mediaId:created.id,fileName,mimeType,size:bytes.length,sha256,deduplicated:false};}catch(error){await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey}));throw error;}}
async function materialBatchByClientId(clientGenerationId:string){const row=await pool.query("SELECT id FROM material_batches WHERE client_generation_id=$1",[clientGenerationId]);return row.rowCount?materialBatchById(String(row.rows[0].id)):null;}
async function materialBatchById(id:string){const result=await pool.query(`SELECT b.id,b.client_generation_id,b.name,b.template_id,b.template_name,b.template_snapshot,b.product_snapshot,b.created_at,u.display_name created_by_name,COALESCE(json_agg(json_build_object('mediaId',a.media_id,'pageIndex',a.page_index,'productIds',a.product_ids,'fileName',m.file_name,'byteSize',m.byte_size) ORDER BY a.page_index) FILTER (WHERE a.media_id IS NOT NULL),'[]'::json) assets FROM material_batches b LEFT JOIN users u ON u.id=b.created_by LEFT JOIN material_assets a ON a.batch_id=b.id LEFT JOIN media m ON m.id=a.media_id WHERE b.id=$1 GROUP BY b.id,u.display_name`,[id]);return result.rowCount?result.rows[0]:null;}

async function isConfiguredCurrency(code:string):Promise<boolean>{const result=await pool.query("SELECT 1 FROM currency_settings WHERE code=$1",[code]);return Boolean(result.rowCount);}

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
