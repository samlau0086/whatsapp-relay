import { randomBytes, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import Fastify,{type FastifyReply,type FastifyRequest} from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ifNoneMatchMatches, IMMUTABLE_PRIVATE_CACHE_CONTROL, strongEtag } from "./http-cache.js";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { authenticate, canAccessAccount, hasScope, type Principal } from "./auth.js";
import { apiKeyCreateSchema, contactAliasSchema, contactCreateSchema, contactUpdateSchema, conversationAgentModeSchema, conversationTagsSchema, conversationTransferSchema, currencySchema, currencySettingsSchema, customerStageSchema, emailProviderSettingsSchema, emailProviderTestSchema, emailSendSchema, enrollmentSchema, loginSchema, materialSendBatchStatusSchema, materialSendSchema, messageCommentSchema, messageCommentVoteSchema, messageRetrySchema, messageSchema, messageTranslationsSchema, newConversationSchema, noteSchema, orderAddressSchema, orderBusinessStatusUpdateSchema, orderSchema, orderSendSchema, orderSettingsSchema, orderTrackingSchema, orderUpdateSchema, paymentSendSchema, paypalSettingsSchema, productBulkEditSchema, productBulkImportSchema, productBulkUpdateSchema, productCardBatchStatusSchema, productCardSendSchema, productCreateSchema, productLabelCatalogDeleteSchema, productLabelCatalogUpdateSchema, productNameTranslationPreviewSchema, productSkuQuerySchema, productUpdateSchema, reminderSchema, tagCreateSchema, tagUpdateSchema, textToSpeechSchema, translationPreferenceQuerySchema, translationPreferenceSchema, translationPreviewSchema, translationProviderSettingsSchema, transcriptionProviderSettingsSchema, ttsProviderSettingsSchema } from "./schemas.js";
import { decryptAtRest, encryptAtRest, hashPassword, hashSecret, signToken, verifyPassword } from "./security.js";
import { registerAgentHub, dispatchPending, disconnectAgent, markStaleAgentsOffline, clearAgentAttention } from "./agent-hub.js";
import { generateSpeech, ttsProviderFailureMessage, TTS_PROVIDERS, ttsProviderDefaults, type TtsProvider } from "./tts-providers.js";
import { TRANSLATION_PROVIDERS, transcribeAudio, translateProductNames, translateText, translateTextWithDetection, translationProviderDefaults, type TranslationProvider, type TranslationProviderSetting, type TranscriptionProviderSetting } from "./translation-providers.js";
import { normalizeTranscriptionAudio } from "./audio-normalizer.js";
import { isBrowserCompatibleVideo, normalizeBrowserVideo } from "./video-normalizer.js";
import { calculateOrderTotal, canManageSharedRecord, ensureCrmTables, primaryContactEmail, type OrderSummaryFee, type OrderSummaryItem } from "./crm.js";
import { renderTemplateOrderImage } from "./order-image.js";
import { renderTemplateOrderPdf } from "./order-pdf.js";
import { DEFAULT_CI_ORDER_TEMPLATE, DEFAULT_IMAGE_ORDER_TEMPLATE, DEFAULT_PDF_ORDER_TEMPLATE, DEFAULT_PI_ORDER_TEMPLATE, DEFAULT_QT_ORDER_TEMPLATE, DEFAULT_SC_ORDER_TEMPLATE, DEFAULT_TEXT_ORDER_TEMPLATE, orderTemplateSchema, orderTemplateUpdateSchema, parseOrderTemplate, parseTranslatedSemanticOrder, renderSemanticOrder, renderTextOrder, serializeSemanticOrder, type OrderTemplateFormat } from "./order-template.js";
import { allocateOrderNumber, isValidTimeZone, orderNumberPreview, validateOrderNumberTemplate } from "./order-number.js";
import { resolveContactTimeZone } from "./contact-timezone.js";
import { generateSalesReplySuggestion, pauseAgentForHuman } from "./agent-engine.js";
import { migrateAgentSchema } from "./migrate-agent.js";
import { PayPalApiError, PayPalClient, clearPayPalTokenCache, type PayPalEnvironment } from "./paypal.js";
import { DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE, DEFAULT_PAYPAL_NOTE_TEMPLATE, DEFAULT_PAYPAL_REFERENCE_TEMPLATE, renderPayPalTemplate, validatePayPalTemplate, type PayPalTemplateContext } from "./paypal-template.js";
import { DEFAULT_PRODUCT_CARD_TEMPLATE, parseProductCardTemplate, productCardTemplateSchema, renderProductCardCaption } from "./product-card-template.js";
import { renderProductCardGridPages, renderProductCardGridPdf, renderProductCards, type ProductCardRenderProduct } from "./product-card-image.js";
import { fetchLatestExchangeRates } from "./exchange-rates.js";
import { emailShell, ensureEmailTables, escapeHtml, sendProviderTest, verifySmtp, type EmailProvider, type EmailProviderConfig } from "./email.js";
import { collageTemplateCreateSchema, collageTemplateUpdateSchema, materialGenerateSchema, parseCollageTemplate, productSlotIds, DEFAULT_COLLAGE_TEMPLATE, MATERIAL_PRODUCT_LIMIT, type CollageTemplate } from "./collage-template.js";
import { renderCollagePage, type CollageProduct } from "./collage-image.js";
import { stitchMaterialImages } from "./material-stitch-image.js";
import { registerTaskRoutes } from "./task-routes.js";
import {registerStatusRoutes} from "./status-routes.js";
import {registerWhatsAppCloudRoutes} from "./whatsapp-cloud.js";
import {registerMessengerRoutes} from "./messenger.js";
import {isMessengerReplyWindowClosedError,isTemplateRequiredError,queueChannelCommand,queueGroupCreateCommand,queueWhatsAppBlockCommand} from "./whatsapp-outbound.js";
import {registerBrowserEvents} from "./browser-events.js";
import {isPostgresUuid} from "./conversation-cursor.js";
import { paypalProfileSetting, registerPaymentMethodRoutes, resolvePaymentProfile, type PaymentProfileSnapshot } from "./payment-methods.js";
import { calculatePayPalFee, PAYPAL_FEE_NAME } from "./paypal-fee.js";
import { calculateShippingQuote, registerShippingRoutes } from "./shipping-routes.js";

const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact:["req.headers.authorization","req.body.password","req.body.secret","req.body.apiKey","req.body.clientId","req.body.clientSecret","req.body.sandboxClientId","req.body.sandboxClientSecret","req.body.liveClientId","req.body.liveClientSecret","req.body.accessToken","req.body.pageAccessToken","req.body.appSecret"] }, bodyLimit: 2_000_000 });
const s3 = new S3Client({ region:config.S3_REGION, endpoint:config.S3_ENDPOINT, forcePathStyle:true, credentials:{ accessKeyId:config.S3_ACCESS_KEY, secretAccessKey:config.S3_SECRET_KEY } });
const videoNormalizationJobs=new Map<string,Promise<{object_key:string;file_name:string;mime_type:string;sha256:string}>>();
const mediaPreviewCache=new Map<string,Buffer>();
const mediaPreviewJobs=new Map<string,Promise<Buffer>>();
const refreshCookie=(token:string,persistent:boolean)=>`relay_refresh=${token}; HttpOnly; SameSite=Lax; Path=/api/v1/auth${persistent?"; Max-Age=34560000":""}${config.NODE_ENV==="production"?"; Secure":""}`;

function orderFeesWithPayPalFee(fees:OrderSummaryFee[],items:OrderSummaryItem[],shippingAmount:number,paymentProfile:PaymentProfileSnapshot|null):Array<OrderSummaryFee&{source:"manual"|"paypal"}>{
  const manual=fees.map(fee=>({...fee,source:"manual" as const}));
  if(paymentProfile?.methodType!=="paypal")return manual;
  const netAmount=calculateOrderTotal(items,fees,shippingAmount);
  const amount=calculatePayPalFee(netAmount,paymentProfile.paypalFeeRatePercent,paymentProfile.paypalFixedFee);
  return amount>0?[...manual,{name:paymentProfile.paypalFeeLabel||PAYPAL_FEE_NAME,amount,source:"paypal"}]:manual;
}

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
await registerStatusRoutes(app);
await registerWhatsAppCloudRoutes(app);
await registerMessengerRoutes(app);
await registerBrowserEvents(app);
await registerPaymentMethodRoutes(app);
await registerShippingRoutes(app);
app.setErrorHandler((error,request,reply)=>{
  if(isTemplateRequiredError(error))return reply.code(409).send({error:"template_required",message:error.message,serviceWindowExpiresAt:error.serviceWindowExpiresAt});
  if(isMessengerReplyWindowClosedError(error))return reply.code(409).send({error:error.code,message:error.message,replyWindowExpiresAt:error.replyWindowExpiresAt});
  request.log.error({error},"request failed");
  const failure=error instanceof Error?error:new Error(String(error));
  return reply.code((error as {statusCode?:number}).statusCode??500).send({error:failure.message||"internal_error"});
});

app.get("/health", async () => { await pool.query("SELECT 1"); return { status:"ok", version:"0.1.0", time:new Date().toISOString() }; });
app.get("/api/v1/openapi.json", async () => ({ openapi:"3.1.0", info:{title:"RelayDesk API",version:"0.1.0"}, paths:{
  "/api/v1/contacts":{get:{summary:"List contacts"}},
  "/api/v1/contacts/{id}":{get:{summary:"Read contact profile"},patch:{summary:"Update contact profile"}},
  "/api/v1/tasks":{get:{summary:"List tasks"},post:{summary:"Create a task"}},
  "/api/v1/tasks/{id}":{get:{summary:"Read task details"},patch:{summary:"Update a task"},delete:{summary:"Cancel a task"}},
  "/api/v1/tasks/{id}/generate":{post:{summary:"Generate a personalized message draft"}},
  "/api/v1/tasks/{id}/approve":{post:{summary:"Approve and schedule a task draft"}},
  "/api/v1/status-campaigns":{get:{summary:"List WhatsApp Status campaigns"},post:{summary:"Create a WhatsApp Status campaign"}},
  "/api/v1/status-campaigns/{id}":{get:{summary:"Read a WhatsApp Status campaign"},patch:{summary:"Update a draft or paused campaign"},delete:{summary:"Cancel a campaign"}},
  "/api/v1/status-posts":{get:{summary:"List scheduled WhatsApp Status posts"}},
  "/api/v1/messages":{post:{summary:"发送单条消息",responses:{"202":{description:"已进入持久队列"}}}},
  "/api/v1/messages/{id}/retry":{post:{summary:"人工重新发送失败或待确认的消息",responses:{"202":{description:"原消息已重新进入持久队列"}}}},
  "/api/v1/conversations/{id}/messages/failed":{delete:{summary:"清除当前会话中失败或待确认的发出消息"}},
  "/api/v1/admin/whatsapp-cloud/accounts":{get:{summary:"读取 Cloud API 账号"},post:{summary:"验证并添加 Cloud API 账号"}},
  "/api/v1/admin/whatsapp-cloud/accounts/{id}":{patch:{summary:"更新或停用 Cloud API 账号"}},
  "/api/v1/admin/whatsapp-cloud/accounts/{id}/test":{post:{summary:"验证 Cloud API 凭据"}},
  "/api/v1/admin/whatsapp-cloud/accounts/{id}/templates/sync":{post:{summary:"从 Meta 同步消息模板"}},
  "/api/v1/admin/messenger/pages":{get:{summary:"读取 Messenger Pages"},post:{summary:"验证并添加 Messenger Page"}},
  "/api/v1/admin/messenger/oauth/settings":{get:{summary:"读取 Messenger OAuth 配置"},put:{summary:"保存 Messenger OAuth 配置"}},
  "/api/v1/admin/messenger/oauth/start":{post:{summary:"开始 Facebook Login for Business 授权"}},
  "/api/v1/meta/messenger/oauth/callback":{get:{summary:"处理 Facebook OAuth 回调"}},
  "/api/v1/admin/messenger/pages/{id}":{patch:{summary:"更新或停用 Messenger Page"}},
  "/api/v1/admin/messenger/pages/{id}/test":{post:{summary:"验证 Messenger Page 凭据"}},
  "/api/v1/meta/messenger/webhook":{get:{summary:"Messenger Webhook challenge"},post:{summary:"接收 Messenger Page 事件"}},
  "/api/v1/accounts/{id}/templates":{get:{summary:"读取账号的已审核模板"}},
  "/api/v1/meta/whatsapp/webhook":{get:{summary:"Meta Webhook challenge"},post:{summary:"接收 Meta Webhook 事件"}},
  "/api/v1/conversations":{get:{summary:"分页查询会话"},post:{summary:"创建或复用单个联系人会话并发送首条文本消息"}},
  "/api/v1/conversations/counts":{get:{summary:"按账号和日期统计会话筛选数量"}},
  "/api/v1/conversations/{id}/summary":{get:{summary:"读取单个会话摘要并判断是否匹配当前筛选"}},
  "/api/v1/events/ticket":{post:{summary:"签发 30 秒有效的浏览器事件 WebSocket 票据"}},
  "/api/v1/events/ws":{get:{summary:"接收账号权限范围内的会话增量事件"}},
  "/api/v1/conversations/{id}":{patch:{summary:"认领、收藏、更新客户阶段、关闭或标记已读"},delete:{summary:"永久删除会话及其关联数据"}},
  "/api/v1/conversations/{id}/transfer":{post:{summary:"将会话及联系人关联转移到另一个同渠道账号"}},
  "/api/v1/conversations/{id}/contact":{patch:{summary:"编辑联系人别名"}},
  "/api/v1/conversations/{id}/details":{get:{summary:"读取会话标签、备注、个人提醒与订单"}},
  "/api/v1/conversations/{id}/materials/send":{post:{summary:"跨素材库拼接或逐张发送所选图片"}},
  "/api/v1/conversations/{id}/materials/batches/{batchId}":{get:{summary:"确认素材图片发送批次状态"}},
  "/api/v1/conversations/{id}/tags":{put:{summary:"替换会话标签"}},
  "/api/v1/conversations/{id}/notes":{post:{summary:"添加团队共享备注"}},
  "/api/v1/conversations/{id}/reminder":{put:{summary:"设置当前坐席提醒"},delete:{summary:"取消当前坐席提醒"}},
  "/api/v1/conversations/{id}/orders":{post:{summary:"保存包含多个商品和费用的订单草稿"}},
  "/api/v1/conversations/{id}/orders/{orderId}/send":{post:{summary:"以文字、完整图片或 PDF 格式发送或重新发送订单"}},
  "/api/v1/conversations/{id}/orders/{orderId}":{patch:{summary:"编辑订单"},delete:{summary:"从联系人资料中删除订单"}},
  "/api/v1/orders":{get:{summary:"集中查询订单"}},
  "/api/v1/admin/order-settings":{get:{summary:"读取订单号规则"},put:{summary:"更新订单号规则"}},
  "/api/v1/shipping-classes":{get:{summary:"读取启用的 shipping classes"}},
  "/api/v1/shipping-templates":{get:{summary:"读取启用的运费模板"}},
  "/api/v1/shipping/quotes":{post:{summary:"按订单草稿计算建议运费"}},
  "/api/v1/admin/shipping-classes":{get:{summary:"管理 shipping classes"},post:{summary:"新增 shipping class"}},
  "/api/v1/admin/shipping-templates":{get:{summary:"管理运费模板"},post:{summary:"新增运费模板"}},
  "/api/v1/currencies":{get:{summary:"读取工作区币种与汇率"}},
  "/api/v1/admin/currencies":{put:{summary:"保存工作区币种、基准货币与汇率"}},
  "/api/v1/admin/currencies/refresh-rates":{post:{summary:"从公共汇率服务更新并保存工作区汇率"}},
  "/api/v1/admin/paypal-settings":{get:{summary:"读取 PayPal 收款配置"},put:{summary:"保存 PayPal 收款配置"}},
  "/api/v1/admin/payment-methods":{get:{summary:"读取付款方式与 Profiles"},post:{summary:"新增付款方式"}},
  "/api/v1/admin/payment-methods/{methodId}":{patch:{summary:"更新付款方式"},delete:{summary:"删除付款方式"}},
  "/api/v1/admin/payment-methods/{methodId}/profiles":{post:{summary:"新增付款 Profile"}},
  "/api/v1/admin/payment-methods/{methodId}/profiles/{profileId}":{patch:{summary:"更新付款 Profile"},delete:{summary:"删除付款 Profile"}},
  "/api/v1/payment-profiles":{get:{summary:"读取订单可选付款 Profiles"}},
  "/api/v1/admin/email-providers":{get:{summary:"读取 SMTP 与 Resend 邮件配置"}},
  "/api/v1/admin/email-providers/{provider}":{put:{summary:"保存并启用邮件 Provider"}},
  "/api/v1/admin/email-providers/{provider}/test":{post:{summary:"发送 Provider 测试邮件"}},
  "/api/v1/conversations/{id}/email-sends":{post:{summary:"将订单或产品卡加入邮件发送队列"}},
  "/api/v1/conversations/{id}/email-activities":{get:{summary:"读取会话邮件活动"}},
  "/api/v1/orders/{orderId}/payment-request":{post:{summary:"创建 PayPal 付款请求"}},
  "/api/v1/orders/{orderId}/payment-request/refresh":{post:{summary:"刷新 PayPal 付款状态"}},
  "/api/v1/orders/{orderId}/payment-request/send":{post:{summary:"通过 WhatsApp 发送 PayPal 付款链接"}},
  "/api/v1/orders/{orderId}/payment-send":{post:{summary:"通过 WhatsApp 发送订单付款说明"}},
  "/api/v1/admin/order-templates":{get:{summary:"读取文字、图片与 PDF 订单模板"}},
  "/api/v1/admin/order-templates/{format}":{put:{summary:"更新指定格式的订单模板"}},
  "/api/v1/tags":{get:{summary:"读取标签目录"},post:{summary:"创建标签"}},
  "/api/v1/agents":{get:{summary:"查询已注册 Agent"}},
  "/api/v1/agents/{id}":{patch:{summary:"重命名或撤销 Agent"},delete:{summary:"删除 Agent 登记"}},
  "/api/v1/media":{post:{summary:"上传媒体"}},
  "/api/v1/text-to-speech":{post:{summary:"使用当前 Provider 生成语音媒体"}},
  "/api/v1/me/translation-preferences":{get:{summary:"读取当前坐席在指定会话中的翻译偏好"},put:{summary:"保存当前坐席在指定会话中的翻译偏好"}},
  "/api/v1/translation/status":{get:{summary:"读取 AI 翻译可用状态"}},
  "/api/v1/translations/preview":{post:{summary:"生成待发送文本的翻译预览"}},
  "/api/v1/translations/messages":{post:{summary:"批量读取或生成接收文字、媒体说明及语音消息译文"}},
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
  const refreshToken=`rdr_${randomBytes(48).toString("base64url")}`;
  await pool.query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at,persistent) VALUES($1,$2,now()+CASE WHEN $3 THEN interval '400 days' ELSE interval '30 days' END,$3)",[user.rows[0].id,hashSecret(refreshToken),parsed.data.rememberMe]);
  reply.header("set-cookie",refreshCookie(refreshToken,parsed.data.rememberMe));
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,ip) VALUES('user',$1,'auth.login','user',$1,$2)", [user.rows[0].id,request.ip]);
  return { accessToken:token, expiresIn:900, user:{ id:user.rows[0].id, email:user.rows[0].email, displayName:user.rows[0].display_name, role:user.rows[0].role } };
});

app.post("/api/v1/auth/refresh",async(request,reply)=>{const raw=request.headers.cookie?.split(";").map(value=>value.trim()).find(value=>value.startsWith("relay_refresh="))?.slice(14);if(!raw)return reply.code(401).send({error:"refresh_required"});const found=await pool.query("SELECT r.id,r.user_id,r.persistent,u.email,u.role FROM refresh_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=$1 AND r.revoked_at IS NULL AND r.expires_at>now() AND u.disabled_at IS NULL",[hashSecret(raw)]);if(!found.rowCount)return reply.code(401).send({error:"invalid_refresh"});const replacement=`rdr_${randomBytes(48).toString("base64url")}`,persistent=Boolean(found.rows[0].persistent);await transaction(async(client)=>{const next=await client.query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at,persistent) VALUES($1,$2,now()+CASE WHEN $3 THEN interval '400 days' ELSE interval '30 days' END,$3) RETURNING id",[found.rows[0].user_id,hashSecret(replacement),persistent]);await client.query("UPDATE refresh_tokens SET revoked_at=now(),replaced_by=$2 WHERE id=$1",[found.rows[0].id,next.rows[0].id]);});reply.header("set-cookie",refreshCookie(replacement,persistent));return {accessToken:signToken({sub:found.rows[0].user_id,role:found.rows[0].role,email:found.rows[0].email},config.JWT_SECRET),expiresIn:900};});

app.post("/api/v1/auth/logout",async(request,reply)=>{const raw=request.headers.cookie?.split(";").map(value=>value.trim()).find(value=>value.startsWith("relay_refresh="))?.slice(14);if(raw)await pool.query("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1",[hashSecret(raw)]);reply.header("set-cookie","relay_refresh=; HttpOnly; SameSite=Lax; Path=/api/v1/auth; Max-Age=0");return reply.code(204).send();});

app.post("/api/v1/agents/enroll", async (request, reply) => {
  const parsed = enrollmentSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error:"invalid_request" });
  const codeHash = hashSecret(parsed.data.code);
  const credential = `rda_${randomBytes(32).toString("base64url")}`;
  const result = await pool.query("UPDATE agents SET credential_hash=$2,enrollment_code_hash=NULL,enrollment_expires_at=NULL,name=$3,version=$4,platform=$5,status='offline' WHERE enrollment_code_hash=$1 AND enrollment_expires_at>now() AND status='pending' RETURNING id", [codeHash,hashSecret(credential),parsed.data.name,parsed.data.version,parsed.data.platform]);
  if (!result.rowCount) return reply.code(401).send({ error:"invalid_or_expired_enrollment" });
  return { agentId:result.rows[0].id, credential, protocolVersion:2, websocketUrl:"/agent/ws" };
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
    pool.query("SELECT id,name,status,version,protocol_version,capabilities,platform,last_seen_at,last_acked_cursor,enrollment_expires_at,created_at FROM agents ORDER BY created_at DESC"),
    pool.query("SELECT id,agent_id,display_name,phone_e164,status,status_reason,last_event_at,transport FROM channel_accounts WHERE transport='web' AND agent_id IS NOT NULL ORDER BY display_name"),
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
    await client.query("UPDATE channel_accounts SET agent_id=NULL,status='offline',status_reason='agent_removed' WHERE agent_id=$1",[id]);
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
  const created=await pool.query("INSERT INTO channel_accounts(id,agent_id,display_name,status) VALUES($1,$2,$3,'pairing') ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name,status='pairing' WHERE channel_accounts.agent_id=$2 RETURNING id,display_name,status",[id,agent.rows[0].id,name]);
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
  const updated=await pool.query("UPDATE channel_accounts SET display_name=COALESCE($3,display_name),status=CASE WHEN $4='pairing' THEN 'pairing' ELSE status END,status_reason=CASE WHEN $4='pairing' THEN NULL ELSE status_reason END WHERE id=$1 AND agent_id=$2 RETURNING id,display_name,status",[id,agent.rows[0].id,name??null,body.status??null]);
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
  const removed=await pool.query("UPDATE channel_accounts SET agent_id=NULL,status='logged_out',status_reason='removed_from_agent' WHERE id=$1 AND agent_id=$2 RETURNING id",[id,agent.rows[0].id]);
  if(!removed.rowCount)return reply.code(404).send({error:"not_found"});
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id) VALUES('agent',$1,'account.remove','whatsapp_account',$2)",[agent.rows[0].id,id]);
  return reply.code(204).send();
});

app.get("/api/v1/api-keys", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT id,name,key_prefix,scopes,last_used_at,expires_at,revoked_at,created_at,(expires_at IS NOT NULL AND expires_at<=now()) expired FROM api_keys ORDER BY created_at DESC");
  return{data:result.rows.map(row=>({id:String(row.id),name:String(row.name),keyPrefix:String(row.key_prefix),scopes:row.scopes,lastUsedAt:row.last_used_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,createdAt:row.created_at,expired:Boolean(row.expired)}))};
});

app.post("/api/v1/api-keys", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const parsed=apiKeyCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const secret=`rdk_${randomBytes(32).toString("base64url")}`;
  const created=await pool.query("INSERT INTO api_keys(name,key_prefix,secret_hash,scopes,expires_at) VALUES($1,$2,$3,$4,CASE WHEN $5::int IS NULL THEN NULL ELSE now()+make_interval(days=>$5) END) RETURNING id,name,key_prefix,scopes,expires_at,created_at",[parsed.data.name,secret.slice(0,12),hashSecret(secret),parsed.data.scopes,parsed.data.expiresInDays]);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'api_key.create','api_key',$2,$3)",[request.principal.id,created.rows[0].id,JSON.stringify({name:parsed.data.name,scopes:parsed.data.scopes,expiresInDays:parsed.data.expiresInDays})]);
  return reply.code(201).send({id:String(created.rows[0].id),name:String(created.rows[0].name),keyPrefix:String(created.rows[0].key_prefix),scopes:created.rows[0].scopes,expiresAt:created.rows[0].expires_at,createdAt:created.rows[0].created_at,secret});
});

app.delete("/api/v1/api-keys/:id", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {id}=request.params as {id:string};if(!/^[0-9a-f-]{36}$/i.test(id))return reply.code(400).send({error:"invalid_request"});
  const revoked=await pool.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id,name,key_prefix",[id]);if(!revoked.rowCount)return reply.code(404).send({error:"not_found"});
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'api_key.revoke','api_key',$2,$3)",[request.principal.id,id,JSON.stringify({name:revoked.rows[0].name,keyPrefix:revoked.rows[0].key_prefix})]);
  return reply.code(204).send();
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
  const {id}=request.params as {id:string};const media=await pool.query("SELECT m.object_key,m.file_name,m.mime_type FROM media m LEFT JOIN channel_accounts a ON a.id=m.account_id WHERE m.id=$1 AND (m.account_id IS NULL OR a.agent_id=$2)",[id,agent.rows[0].id]);if(!media.rowCount)return reply.code(404).send({error:"not_found"});
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:media.rows[0].object_key}));reply.header("content-type",media.rows[0].mime_type).header("x-file-name",encodeURIComponent(media.rows[0].file_name??"attachment"));return reply.send(object.Body);
});

app.post("/agent/media", async(request,reply)=>{
  const credential=request.headers.authorization?.replace(/^Bearer /,"");if(!credential)return reply.code(401).send({error:"unauthorized"});const query=request.query as {accountId?:string};if(!query.accountId)return reply.code(400).send({error:"account_id_required"});
  const account=await pool.query("SELECT a.id FROM channel_accounts a JOIN agents g ON g.id=a.agent_id WHERE a.id=$1 AND g.credential_hash=$2 AND g.status<>'revoked'",[query.accountId,hashSecret(credential)]);if(!account.rowCount)return reply.code(403).send({error:"account_forbidden"});
  const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});const sourceBytes=await file.toBuffer();const sourceSha256=createHash("sha256").update(sourceBytes).digest("hex");if(request.headers["x-content-sha256"]&&request.headers["x-content-sha256"]!==sourceSha256)return reply.code(422).send({error:"checksum_mismatch"});let media={bytes:sourceBytes,fileName:file.filename,mimeType:file.mimetype};if(file.mimetype.startsWith("video/"))try{media=await normalizeBrowserVideo(media);}catch(error){request.log.warn({error},"inbound video normalization failed");}const sha256=createHash("sha256").update(media.bytes).digest("hex"),objectKey=`inbound/${query.accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:media.bytes,ContentType:media.mimeType,Metadata:{sha256}}));const created=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[query.accountId,objectKey,media.fileName,media.mimeType,media.bytes.length,sha256]);return reply.code(201).send({mediaId:created.rows[0].id,size:media.bytes.length,sha256});
});

app.post("/agent/contacts/:id/avatar", async(request,reply)=>{
  const credential=request.headers.authorization?.replace(/^Bearer /,"");if(!credential)return reply.code(401).send({error:"unauthorized"});
  const {id}=request.params as {id:string};const query=request.query as {accountId?:string};if(!query.accountId)return reply.code(400).send({error:"account_id_required"});
  const current=await pool.query("SELECT co.id,co.avatar_url FROM contacts co JOIN channel_accounts a ON a.id=co.account_id JOIN agents g ON g.id=a.agent_id WHERE co.id=$1 AND co.account_id=$2 AND g.credential_hash=$3 AND g.status<>'revoked'",[id,query.accountId,hashSecret(credential)]);if(!current.rowCount)return reply.code(404).send({error:"not_found"});if(current.rows[0].avatar_url)return reply.code(200).send({updated:false});
  const file=await request.file();if(!file)return reply.code(400).send({error:"file_required"});if(!["image/jpeg","image/png","image/webp"].includes(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});const source=await file.toBuffer();if(source.length>5*1024*1024)return reply.code(413).send({error:"file_too_large"});
  let avatar:Buffer;try{avatar=await import("sharp").then(({default:sharp})=>sharp(source).rotate().resize(512,512,{fit:"cover",withoutEnlargement:true}).webp({quality:86}).toBuffer());}catch{return reply.code(400).send({error:"invalid_image"});}
  const objectKey=`contact-avatars/${query.accountId}/${id}/${randomBytes(16).toString("hex")}.webp`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:avatar,ContentType:"image/webp"}));
  const updated=await pool.query("UPDATE contacts SET avatar_url=$2,updated_at=now() WHERE id=$1 AND avatar_url IS NULL RETURNING id",[id,objectKey]);if(!updated.rowCount){await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey})).catch(()=>undefined);return reply.code(200).send({updated:false});}
  await pool.query("INSERT INTO audit_log(actor_type,action,target_type,target_id,metadata) VALUES('agent','contact.avatar.sync','contact',$1,$2)",[id,JSON.stringify({accountId:query.accountId,byteSize:avatar.length})]);return reply.code(201).send({updated:true});
});

app.get("/api/v1/accounts", { preHandler:authenticate }, async (request) => {
  const ids = request.principal?.accountIds;
  const result = await pool.query(`SELECT a.id,a.display_name,a.phone_e164,a.status,a.status_reason,a.last_connected_at,a.last_event_at,a.transport,a.platform,mp.page_id,
    CASE WHEN a.platform='whatsapp' AND a.transport='cloud' THEN CASE WHEN c.webhook_verified_at IS NULL THEN 'pending' ELSE 'verified' END
         WHEN a.platform='messenger' THEN CASE WHEN mp.webhook_verified_at IS NULL THEN 'pending' ELSE 'verified' END END webhook_status,
    CASE WHEN a.platform='whatsapp' AND a.transport='cloud' THEN CASE WHEN c.credentials_verified_at IS NULL THEN 'unverified' ELSE 'verified' END
         WHEN a.platform='messenger' THEN CASE WHEN mp.credentials_verified_at IS NULL THEN 'unverified' ELSE 'verified' END END credentials_status
    FROM channel_accounts a LEFT JOIN whatsapp_cloud_accounts c ON c.account_id=a.id LEFT JOIN messenger_page_accounts mp ON mp.account_id=a.id
    WHERE (a.transport='cloud' OR a.agent_id IS NOT NULL) AND ($1::uuid[] IS NULL OR a.id=ANY($1)) ORDER BY a.display_name`, [ids ?? null]);
  return { data:result.rows };
});

type ConversationFilter="all"|"groups"|"mine"|"unassigned"|"favorite"|"closed"|"archived"|"reminders"|"blocked";
type ConversationQuery={accountId?:string;status?:string;q?:string;tagId?:string;customerStage?:string;latestOrderStatus?:string;filter?:string;limit?:string;before?:string;cursor?:string;lastMessageFrom?:string;lastMessageBefore?:string;unreplied?:string;sendFailed?:string};
const CONVERSATION_FILTERS=new Set<ConversationFilter>(["all","groups","mine","unassigned","favorite","closed","archived","reminders","blocked"]);
const CONVERSATION_CUSTOMER_STAGES=new Set(["new","considering","qualified","won","lost"]);
const CONVERSATION_ORDER_STATUSES=new Set(["none","any","quotation","pending_confirmation","pending_payment","paid","processing","shipped","completed","cancelled"]);

function parseConversationRange(query:ConversationQuery){
  const from=query.lastMessageFrom?new Date(query.lastMessageFrom):null,before=query.lastMessageBefore?new Date(query.lastMessageBefore):null;
  if(from&&Number.isNaN(from.getTime())||before&&Number.isNaN(before.getTime())||from&&before&&from>=before)return null;
  return{from:from?.toISOString()??null,before:before?.toISOString()??null};
}

function parseConversationCursor(value:string|undefined):{sortAt:string;id:string}|null|"invalid"{
  if(!value)return null;
  try{
    const decoded=JSON.parse(Buffer.from(value,"base64url").toString("utf8")) as {sortAt?:string;id?:string};
    if(!decoded.sortAt||Number.isNaN(Date.parse(decoded.sortAt))||!decoded.id||!isPostgresUuid(decoded.id))return"invalid";
    return{sortAt:new Date(decoded.sortAt).toISOString(),id:decoded.id};
  }catch{return"invalid";}
}

function countBlockedConversations(params:unknown[]){
  return pool.query(`SELECT COUNT(*)::int blocked
    FROM contacts co JOIN conversations c ON c.account_id=co.account_id AND c.contact_id=co.id JOIN channel_accounts a ON a.id=c.account_id
    LEFT JOIN LATERAL (SELECT direction FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
    WHERE co.whatsapp_blocked_at IS NOT NULL AND (a.transport='cloud' OR a.agent_id IS NOT NULL)
      AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::uuid[] IS NULL OR c.account_id=ANY($2))
      AND ($3::timestamptz IS NULL OR c.last_message_at>=$3) AND ($4::timestamptz IS NULL OR c.last_message_at<$4)
      AND ($5::boolean IS NOT TRUE OR COALESCE(c.last_message_direction,m.direction)='in') AND ($6::timestamptz IS NULL OR c.last_message_at<$6)
      AND ($7::boolean IS NOT TRUE OR EXISTS(SELECT 1 FROM messages failed_message WHERE failed_message.conversation_id=c.id AND failed_message.direction='out' AND failed_message.status='failed'))
  `,params);
}

app.get("/api/v1/conversations", { preHandler:authenticate }, async (request,reply) => {
  const query=request.query as ConversationQuery,limit=Math.min(100,Math.max(1,Number(query.limit)||40));
  if(query.accountId&&!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  if(query.unreplied!==undefined&&query.unreplied!=="true"&&query.unreplied!=="false")return reply.code(400).send({error:"invalid_unreplied_filter"});
  if(query.sendFailed!==undefined&&query.sendFailed!=="true"&&query.sendFailed!=="false")return reply.code(400).send({error:"invalid_send_failed_filter"});
  if(query.filter&&!CONVERSATION_FILTERS.has(query.filter as ConversationFilter))return reply.code(400).send({error:"invalid_conversation_filter"});
  if(query.customerStage&&!CONVERSATION_CUSTOMER_STAGES.has(query.customerStage))return reply.code(400).send({error:"invalid_customer_stage_filter"});
  if(query.latestOrderStatus&&!CONVERSATION_ORDER_STATUSES.has(query.latestOrderStatus))return reply.code(400).send({error:"invalid_latest_order_status_filter"});
  const range=parseConversationRange(query);if(!range)return reply.code(400).send({error:"invalid_conversation_date_range"});
  const cursor=parseConversationCursor(query.cursor);if(cursor==="invalid")return reply.code(400).send({error:"invalid_cursor"});
  if(query.tagId&&!isPostgresUuid(query.tagId))return reply.code(400).send({error:"invalid_tag_filter"});
  const keyword=query.q?.trim()||null;if(keyword&&keyword.length>100)return reply.code(400).send({error:"conversation_query_too_long"});
  const principalUserId=request.principal?.kind==="user"?request.principal.id:null,accountIds=request.principal?.accountIds??null,filter=query.filter??null;
  const reminderMode=filter==="reminders";
  // Deployments finish the summary backfill before serving traffic. Keeping the
  // candidate sort on summary columns lets global and per-account keyset
  // pagination use their indexes; the detail query retains the legacy fallback.
  const latestSort="COALESCE(c.last_message_at,c.created_at)";
  const searchCte=keyword?`search_conversations AS MATERIALIZED (
    SELECT search_conversation.id,search_conversation.account_id,search_conversation.contact_id,search_conversation.status,search_conversation.favorite,
      search_conversation.assigned_user_id,search_conversation.customer_stage,search_conversation.last_message_at,search_conversation.last_message_direction,search_conversation.summary_updated_at,search_conversation.created_at
    FROM conversations search_conversation
    WHERE search_conversation.last_message_text ILIKE '%'||$4||'%'
    UNION
    SELECT contact_conversation.id,contact_conversation.account_id,contact_conversation.contact_id,contact_conversation.status,contact_conversation.favorite,
      contact_conversation.assigned_user_id,contact_conversation.customer_stage,contact_conversation.last_message_at,contact_conversation.last_message_direction,contact_conversation.summary_updated_at,contact_conversation.created_at
    FROM contacts search_contact
    JOIN conversations contact_conversation ON contact_conversation.contact_id=search_contact.id
    WHERE (COALESCE(search_contact.alias,'') || ' ' || COALESCE(search_contact.display_name,'') || ' ' || COALESCE(search_contact.phone_e164,'') || ' ' || search_contact.provider_user_id) ILIKE '%'||$4||'%'
  ),`:"";
  const candidateSource=keyword?"search_conversations c":"conversations c";
  const candidateFilter=filter==="closed"?"AND c.status='closed'":filter==="archived"?"AND c.status='archived'":filter==="blocked"?"AND EXISTS(SELECT 1 FROM contacts blocked_contact WHERE blocked_contact.id=c.contact_id AND blocked_contact.whatsapp_blocked_at IS NOT NULL)":filter==="groups"?"AND c.status NOT IN ('closed','archived') AND EXISTS(SELECT 1 FROM contacts group_contact WHERE group_contact.id=c.contact_id AND group_contact.entity_type='group')":filter==="mine"?"AND c.status<>'closed' AND c.assigned_user_id=$9::uuid":filter==="unassigned"?"AND c.status<>'closed' AND c.assigned_user_id IS NULL":filter==="favorite"?"AND c.status<>'closed' AND c.favorite":filter==="reminders"?"AND c.status<>'closed'":filter==="all"||!query.status?"AND c.status NOT IN ('closed','archived')":"";
  const latestOrderJoin=query.latestOrderStatus?"LEFT JOIN LATERAL (SELECT business_status FROM orders WHERE conversation_id=c.id AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) latest_order ON true":"";
  const latestOrderFilter=query.latestOrderStatus==="none"?"AND latest_order.business_status IS NULL":query.latestOrderStatus==="any"?"AND latest_order.business_status IS NOT NULL":query.latestOrderStatus?"AND latest_order.business_status=$16::text":"";
  const candidateCursor=!cursor?"":reminderMode?"AND (reminder_task.due_at>$11 OR (reminder_task.due_at=$11 AND c.id<$12::uuid))":`AND (${latestSort}<$11 OR (${latestSort}=$11 AND c.id<$12::uuid))`;
  const result=await pool.query(`WITH parameter_types AS NOT MATERIALIZED (
    SELECT $4::text keyword_value,$9::uuid principal_user_id,$10::text filter_value,$11::timestamptz cursor_at,$12::uuid cursor_id,$14::uuid tag_id,$15::text customer_stage,$16::text latest_order_status,$17::boolean send_failed
  ), ${searchCte} candidates AS MATERIALIZED (
    SELECT c.id,${reminderMode?"reminder_task.due_at":latestSort} sort_at
    FROM ${candidateSource} JOIN channel_accounts a ON a.id=c.account_id
    LEFT JOIN LATERAL (SELECT direction,occurred_at FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
    ${latestOrderJoin}
    ${reminderMode?`JOIN LATERAL (
      SELECT task.due_at FROM tasks task
      WHERE (task.conversation_id=c.id OR (task.conversation_id IS NULL AND task.contact_id=c.contact_id))
        AND task.assigned_user_id=$9::uuid AND task.status NOT IN ('completed','cancelled','failed')
        AND task.due_at<now()+interval '3 days'
      ORDER BY task.due_at,task.id LIMIT 1
    ) reminder_task ON true`:""}
    WHERE (a.transport='cloud' OR a.agent_id IS NOT NULL) AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::uuid[] IS NULL OR c.account_id=ANY($2))
      AND ($3::text IS NULL OR c.status::text=$3)
      AND ($14::uuid IS NULL OR EXISTS(SELECT 1 FROM conversation_tags selected_tag WHERE selected_tag.conversation_id=c.id AND selected_tag.tag_id=$14))
      AND ($15::text IS NULL OR c.customer_stage=$15::text)
      AND ($5::timestamptz IS NULL OR c.last_message_at<$5) AND ($6::timestamptz IS NULL OR c.last_message_at>=$6) AND ($7::timestamptz IS NULL OR c.last_message_at<$7)
      AND ($8::boolean IS NOT TRUE OR COALESCE(c.last_message_direction,m.direction)='in')
      AND ($17::boolean IS NOT TRUE OR EXISTS(SELECT 1 FROM messages failed_message WHERE failed_message.conversation_id=c.id AND failed_message.direction='out' AND failed_message.status='failed'))
      ${candidateFilter}
      ${latestOrderFilter}
      ${candidateCursor}
    ORDER BY sort_at ${reminderMode?"ASC":"DESC"},c.id DESC
    LIMIT $13
  )
    SELECT c.id,c.status,c.favorite,c.unread_count,CASE WHEN c.summary_updated_at IS NOT NULL THEN c.last_message_at ELSE m.occurred_at END last_message_at,c.created_at,c.service_window_expires_at,c.service_window_expires_at reply_window_expires_at,c.assigned_user_id,c.customer_stage,
      co.id contact_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) display_name,co.alias,co.display_name contact_name,co.phone_e164,co.provider_user_id,co.avatar_url,co.whatsapp_blocked_at IS NOT NULL blocked,
      CASE WHEN co.entity_type='group' THEN 'group' ELSE 'direct' END conversation_type,wg.group_jid,wg.subject group_subject,wg.participant_count group_participant_count,wg.active group_active,c.last_message_sender_name,
      (SELECT email FROM contact_emails WHERE contact_id=co.id AND is_primary LIMIT 1) primary_email,
      COALESCE((SELECT json_agg(json_build_object('id',method.id,'type',method.type,'label',method.label,'value',method.value) ORDER BY method.position,method.id) FROM contact_methods method WHERE method.contact_id=co.id),'[]'::json) contact_methods,
      a.id account_id,a.display_name account_name,a.status account_status,a.transport,a.platform,mp.page_id,COALESCE(c.last_message_text,m.text_content) last_message,COALESCE(c.last_message_kind,m.kind) last_message_kind,COALESCE(c.last_message_direction,m.direction) last_message_direction,COALESCE(c.last_message_status,m.status) last_message_status,
      COALESCE(tag_list.tags,'[]'::json) tags,CASE WHEN $10::text='reminders' THEN candidates.sort_at END remind_at,candidates.sort_at
    FROM candidates JOIN conversations c ON c.id=candidates.id JOIN contacts co ON co.id=c.contact_id JOIN channel_accounts a ON a.id=c.account_id LEFT JOIN messenger_page_accounts mp ON mp.account_id=a.id LEFT JOIN whatsapp_groups wg ON wg.contact_id=co.id
    LEFT JOIN LATERAL (SELECT text_content,kind,direction,status,occurred_at FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name) tags FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=c.id)tag_list ON true
    ORDER BY candidates.sort_at ${reminderMode?"ASC":"DESC"},c.id DESC`,
    [query.accountId??null,accountIds,query.status??null,keyword,query.before??null,range.from,range.before,query.unreplied==="true",principalUserId,filter,cursor?.sortAt??null,cursor?.id??null,limit+1,query.tagId??null,query.customerStage??null,query.latestOrderStatus??null,query.sendFailed==="true"]);
  const hasMore=result.rows.length>limit,data=result.rows.slice(0,limit),last=data[data.length-1];
  return{data,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({sortAt:last.sort_at,id:last.id}),"utf8").toString("base64url"):null,total:null};
});

app.get("/api/v1/conversations/counts",{preHandler:authenticate},async(request,reply)=>{
  const query=request.query as ConversationQuery;
  if(query.accountId&&!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  if(query.unreplied!==undefined&&query.unreplied!=="true"&&query.unreplied!=="false")return reply.code(400).send({error:"invalid_unreplied_filter"});
  if(query.sendFailed!==undefined&&query.sendFailed!=="true"&&query.sendFailed!=="false")return reply.code(400).send({error:"invalid_send_failed_filter"});
  const range=parseConversationRange(query);if(!range)return reply.code(400).send({error:"invalid_conversation_date_range"});
  const principalUserId=request.principal?.kind==="user"?request.principal.id:null,accountIds=request.principal?.accountIds??null;
  const countParams=[query.accountId??null,accountIds,range.from,range.before,query.unreplied==="true",query.before??null,query.sendFailed==="true",principalUserId];
  const blockedPromise=countBlockedConversations(countParams.slice(0,7));
  const dueReminderPromise=request.principal?.kind==="user"?pool.query(`SELECT task.id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) display_name,task.due_at remind_at
    FROM tasks task JOIN contacts co ON co.id=task.contact_id
    WHERE task.assigned_user_id=$1 AND task.status NOT IN ('completed','cancelled','failed') AND task.due_at<=now()
      AND EXISTS(SELECT 1 FROM conversations linked WHERE linked.status<>'closed' AND (linked.id=task.conversation_id OR (task.conversation_id IS NULL AND linked.contact_id=task.contact_id)))
      AND ($2::uuid[] IS NULL OR task.account_id=ANY($2))
    ORDER BY task.due_at,task.id LIMIT 20`,[request.principal.id,accountIds]):Promise.resolve({rows:[]});
  // Group contacts are sparse; keep their lookup off the primary 100k-row aggregate.
  const [result,groupResult,reminderResult,dueReminderResult]=await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER(WHERE c.status NOT IN ('closed','archived'))::int all_count,COUNT(*) FILTER(WHERE c.status<>'closed' AND c.assigned_user_id=$8::uuid)::int mine,
      COUNT(*) FILTER(WHERE c.status<>'closed' AND c.assigned_user_id IS NULL)::int unassigned,COUNT(*) FILTER(WHERE c.status<>'closed' AND c.favorite)::int favorite,
      COUNT(*) FILTER(WHERE c.status='closed')::int closed,COUNT(*) FILTER(WHERE c.status='archived')::int archived
    FROM conversations c JOIN channel_accounts a ON a.id=c.account_id
    LEFT JOIN LATERAL (SELECT direction FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
    WHERE (a.transport='cloud' OR a.agent_id IS NOT NULL) AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::uuid[] IS NULL OR c.account_id=ANY($2))
      AND ($3::timestamptz IS NULL OR c.last_message_at>=$3) AND ($4::timestamptz IS NULL OR c.last_message_at<$4)
      AND ($5::boolean IS NOT TRUE OR COALESCE(c.last_message_direction,m.direction)='in') AND ($6::timestamptz IS NULL OR c.last_message_at<$6)
      AND ($7::boolean IS NOT TRUE OR EXISTS(SELECT 1 FROM messages failed_message WHERE failed_message.conversation_id=c.id AND failed_message.direction='out' AND failed_message.status='failed'))
    `,countParams),
    pool.query(`SELECT COUNT(*)::int groups
    FROM contacts co JOIN conversations c ON c.account_id=co.account_id AND c.contact_id=co.id JOIN channel_accounts a ON a.id=c.account_id
    LEFT JOIN LATERAL (SELECT direction FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
    WHERE co.entity_type='group' AND c.status NOT IN ('closed','archived') AND (a.transport='cloud' OR a.agent_id IS NOT NULL)
      AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::uuid[] IS NULL OR c.account_id=ANY($2))
      AND ($3::timestamptz IS NULL OR c.last_message_at>=$3) AND ($4::timestamptz IS NULL OR c.last_message_at<$4)
      AND ($5::boolean IS NOT TRUE OR COALESCE(c.last_message_direction,m.direction)='in') AND ($6::timestamptz IS NULL OR c.last_message_at<$6)
      AND ($7::boolean IS NOT TRUE OR EXISTS(SELECT 1 FROM messages failed_message WHERE failed_message.conversation_id=c.id AND failed_message.direction='out' AND failed_message.status='failed'))
    `,countParams.slice(0,7)),
    pool.query(`SELECT COUNT(*)::int reminders FROM (
      SELECT c.id FROM tasks task
      JOIN conversations c ON c.id=task.conversation_id
      JOIN channel_accounts a ON a.id=c.account_id
      LEFT JOIN LATERAL (SELECT direction FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
      WHERE task.conversation_id IS NOT NULL AND task.assigned_user_id=$8::uuid AND c.status<>'closed'
        AND task.status NOT IN ('completed','cancelled','failed') AND task.due_at<now()+interval '3 days'
        AND (a.transport='cloud' OR a.agent_id IS NOT NULL) AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::uuid[] IS NULL OR c.account_id=ANY($2))
        AND ($3::timestamptz IS NULL OR c.last_message_at>=$3) AND ($4::timestamptz IS NULL OR c.last_message_at<$4)
        AND ($5::boolean IS NOT TRUE OR COALESCE(c.last_message_direction,m.direction)='in') AND ($6::timestamptz IS NULL OR c.last_message_at<$6)
        AND ($7::boolean IS NOT TRUE OR EXISTS(SELECT 1 FROM messages failed_message WHERE failed_message.conversation_id=c.id AND failed_message.direction='out' AND failed_message.status='failed'))
      UNION
      SELECT c.id FROM tasks task
      JOIN conversations c ON c.contact_id=task.contact_id
      JOIN channel_accounts a ON a.id=c.account_id
      LEFT JOIN LATERAL (SELECT direction FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
      WHERE task.conversation_id IS NULL AND task.contact_id IS NOT NULL AND task.assigned_user_id=$8::uuid AND c.status<>'closed'
        AND task.status NOT IN ('completed','cancelled','failed') AND task.due_at<now()+interval '3 days'
        AND (a.transport='cloud' OR a.agent_id IS NOT NULL) AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::uuid[] IS NULL OR c.account_id=ANY($2))
        AND ($3::timestamptz IS NULL OR c.last_message_at>=$3) AND ($4::timestamptz IS NULL OR c.last_message_at<$4)
        AND ($5::boolean IS NOT TRUE OR COALESCE(c.last_message_direction,m.direction)='in') AND ($6::timestamptz IS NULL OR c.last_message_at<$6)
        AND ($7::boolean IS NOT TRUE OR EXISTS(SELECT 1 FROM messages failed_message WHERE failed_message.conversation_id=c.id AND failed_message.direction='out' AND failed_message.status='failed'))
    ) reminder_conversations`,countParams),
    dueReminderPromise
  ]);
  const blockedResult=await blockedPromise,row=result.rows[0]??{},groupRow=groupResult.rows[0]??{},reminderRow=reminderResult.rows[0]??{},blockedRow=blockedResult.rows[0]??{},dueReminders=dueReminderResult.rows;
  return{all:Number(row.all_count??0),groups:Number(groupRow.groups??0),mine:Number(row.mine??0),unassigned:Number(row.unassigned??0),favorite:Number(row.favorite??0),closed:Number(row.closed??0),archived:Number(row.archived??0),blocked:Number(blockedRow.blocked??0),reminders:Number(reminderRow.reminders??0),dueReminders};
});

app.get("/api/v1/conversations/:id/summary",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string},query=request.query as ConversationQuery;
  if(query.unreplied!==undefined&&query.unreplied!=="true"&&query.unreplied!=="false")return reply.code(400).send({error:"invalid_unreplied_filter"});
  if(query.sendFailed!==undefined&&query.sendFailed!=="true"&&query.sendFailed!=="false")return reply.code(400).send({error:"invalid_send_failed_filter"});
  if(query.filter&&!CONVERSATION_FILTERS.has(query.filter as ConversationFilter))return reply.code(400).send({error:"invalid_conversation_filter"});
  if(query.tagId&&!isPostgresUuid(query.tagId))return reply.code(400).send({error:"invalid_tag_filter"});
  if(query.customerStage&&!CONVERSATION_CUSTOMER_STAGES.has(query.customerStage))return reply.code(400).send({error:"invalid_customer_stage_filter"});
  if(query.latestOrderStatus&&!CONVERSATION_ORDER_STATUSES.has(query.latestOrderStatus))return reply.code(400).send({error:"invalid_latest_order_status_filter"});
  const range=parseConversationRange(query);if(!range)return reply.code(400).send({error:"invalid_conversation_date_range"});
  const keyword=query.q?.trim().toLocaleLowerCase()||"";if(keyword.length>100)return reply.code(400).send({error:"conversation_query_too_long"});
  const principalUserId=request.principal?.kind==="user"?request.principal.id:null;
  const result=await pool.query(`SELECT c.id,c.status,c.favorite,c.unread_count,CASE WHEN c.summary_updated_at IS NOT NULL THEN c.last_message_at ELSE m.occurred_at END last_message_at,
    c.created_at,c.service_window_expires_at,c.service_window_expires_at reply_window_expires_at,c.assigned_user_id,c.customer_stage,co.id contact_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) display_name,
    co.alias,co.display_name contact_name,co.phone_e164,co.provider_user_id,co.avatar_url,co.whatsapp_blocked_at IS NOT NULL blocked,(SELECT email FROM contact_emails WHERE contact_id=co.id AND is_primary LIMIT 1) primary_email,
    CASE WHEN co.entity_type='group' THEN 'group' ELSE 'direct' END conversation_type,wg.group_jid,wg.subject group_subject,wg.participant_count group_participant_count,wg.active group_active,c.last_message_sender_name,
    COALESCE((SELECT json_agg(json_build_object('id',method.id,'type',method.type,'label',method.label,'value',method.value) ORDER BY method.position,method.id) FROM contact_methods method WHERE method.contact_id=co.id),'[]'::json) contact_methods,
    a.id account_id,a.display_name account_name,a.status account_status,a.transport,a.platform,mp.page_id,COALESCE(c.last_message_text,m.text_content) last_message,
    COALESCE(c.last_message_kind,m.kind) last_message_kind,COALESCE(c.last_message_direction,m.direction) last_message_direction,COALESCE(c.last_message_status,m.status) last_message_status,
    COALESCE(tag_list.tags,'[]'::json) tags,reminder_task.due_at remind_at,latest_order.business_status latest_order_status
    FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN channel_accounts a ON a.id=c.account_id LEFT JOIN messenger_page_accounts mp ON mp.account_id=a.id LEFT JOIN whatsapp_groups wg ON wg.contact_id=co.id
    LEFT JOIN LATERAL (SELECT text_content,kind,direction,status,occurred_at FROM messages WHERE conversation_id=c.id AND c.summary_updated_at IS NULL ORDER BY occurred_at DESC,id DESC LIMIT 1)m ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.name) tags FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=c.id)tag_list ON true
    LEFT JOIN LATERAL (SELECT business_status FROM orders WHERE conversation_id=c.id AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) latest_order ON true
    LEFT JOIN LATERAL (
      SELECT task.due_at FROM tasks task
      WHERE (task.conversation_id=c.id OR (task.conversation_id IS NULL AND task.contact_id=c.contact_id))
        AND task.assigned_user_id=$2::uuid AND task.status NOT IN ('completed','cancelled','failed')
        AND task.due_at<now()+interval '3 days'
      ORDER BY task.due_at,task.id LIMIT 1
    ) reminder_task ON true WHERE c.id=$1`,[id,principalUserId]);
  const row=result.rows[0];if(!row||!canAccessAccount(request.principal,String(row.account_id)))return reply.code(404).send({error:"not_found"});
  const hasFailedOutgoing=query.sendFailed!=="true"||Boolean((await pool.query("SELECT 1 FROM messages WHERE conversation_id=$1 AND direction='out' AND status='failed' LIMIT 1",[id])).rowCount);
  const lastAt=row.last_message_at?new Date(row.last_message_at).getTime():null,from=range.from?new Date(range.from).getTime():null,before=range.before?new Date(range.before).getTime():null,legacyBefore=query.before?new Date(query.before).getTime():null;
  const filter=query.filter as ConversationFilter|undefined;
  const matches=(!query.accountId||row.account_id===query.accountId)
    &&(!query.status||row.status===query.status)
    &&(!query.tagId||Array.isArray(row.tags)&&row.tags.some((tag:{id?:unknown})=>String(tag.id)===query.tagId))
    &&(!query.customerStage||row.customer_stage===query.customerStage)
    &&(!query.latestOrderStatus||(query.latestOrderStatus==="none"&&!row.latest_order_status)||(query.latestOrderStatus==="any"&&Boolean(row.latest_order_status))||row.latest_order_status===query.latestOrderStatus)
    &&(!keyword||[row.display_name,row.phone_e164,row.last_message].some(value=>String(value??"").toLocaleLowerCase().includes(keyword)))
    &&(legacyBefore===null||lastAt!==null&&lastAt<legacyBefore)&&(from===null||lastAt!==null&&lastAt>=from)&&(before===null||lastAt!==null&&lastAt<before)
    &&(query.unreplied!=="true"||row.last_message_direction==="in")
    &&hasFailedOutgoing
    &&((!filter&&Boolean(query.status))||(!filter&&row.status!=="closed"&&row.status!=="archived")||(filter==="all"&&row.status!=="closed"&&row.status!=="archived")||(filter==="blocked"&&row.blocked)||(filter==="groups"&&row.conversation_type==="group"&&row.status!=="closed"&&row.status!=="archived")||(filter==="mine"&&row.status!=="closed"&&row.assigned_user_id===principalUserId)||(filter==="unassigned"&&row.status!=="closed"&&!row.assigned_user_id)||(filter==="favorite"&&row.status!=="closed"&&row.favorite)||(filter==="closed"&&row.status==="closed")||(filter==="archived"&&row.status==="archived")||(filter==="reminders"&&row.status!=="closed"&&row.remind_at));
  return{data:row,matches:Boolean(matches)};
});

app.get("/api/v1/conversations/:id/group",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string};
  const group=await pool.query(`SELECT g.id,g.account_id,g.group_jid,g.subject,g.description,g.owner_jid,g.participant_count,g.is_announcement,g.is_community,g.active,g.updated_at
    FROM conversations c JOIN whatsapp_groups g ON g.contact_id=c.contact_id WHERE c.id=$1`,[id]);
  if(!group.rowCount||!canAccessAccount(request.principal,String(group.rows[0].account_id)))return reply.code(404).send({error:"not_found"});
  const participants=await pool.query(`SELECT participant.participant_jid,participant.phone_jid,participant.lid_jid,participant.display_name,participant.role,
    contact.id contact_id,COALESCE(NULLIF(contact.alias,''),NULLIF(concat_ws(' ',contact.first_name,contact.middle_name,contact.last_name),''),contact.display_name,contact.phone_e164) contact_name,
    contact.phone_e164 contact_phone,contact.avatar_url contact_avatar_url,direct.id direct_conversation_id
    FROM whatsapp_group_participants participant JOIN whatsapp_groups joined_group ON joined_group.id=participant.group_id
    LEFT JOIN LATERAL (SELECT person.* FROM contacts person WHERE person.account_id=joined_group.account_id AND person.entity_type='person'
      AND (person.provider_user_id=COALESCE(participant.phone_jid,CASE WHEN participant.participant_jid LIKE '%@s.whatsapp.net' THEN participant.participant_jid END)
        OR person.phone_e164='+'||split_part(COALESCE(participant.phone_jid,CASE WHEN participant.participant_jid LIKE '%@s.whatsapp.net' THEN participant.participant_jid END),'@',1))
      ORDER BY CASE WHEN person.provider_user_id=participant.phone_jid THEN 0 ELSE 1 END,person.updated_at DESC LIMIT 1) contact ON true
    LEFT JOIN conversations direct ON direct.account_id=joined_group.account_id AND direct.contact_id=contact.id
    WHERE participant.group_id=$1
    ORDER BY CASE participant.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,lower(COALESCE(NULLIF(contact.alias,''),NULLIF(concat_ws(' ',contact.first_name,contact.middle_name,contact.last_name),''),contact.display_name,participant.display_name,participant.phone_jid,participant.participant_jid)),participant.participant_jid`,[group.rows[0].id]);
  return{...group.rows[0],participants:participants.rows};
});

app.post("/api/v1/conversations/:id/group/direct-conversation",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {id}=request.params as {id:string},participantJid=String((request.body as {participantJid?:unknown}|null)?.participantJid??"").trim().toLowerCase();
  if(!/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(participantJid))return reply.code(400).send({error:"invalid_participant"});
  const member=await pool.query(`SELECT joined_group.account_id,participant.participant_jid,participant.phone_jid,participant.display_name
    FROM conversations group_conversation JOIN whatsapp_groups joined_group ON joined_group.contact_id=group_conversation.contact_id
    JOIN whatsapp_group_participants participant ON participant.group_id=joined_group.id
    WHERE group_conversation.id=$1 AND participant.participant_jid=$2`,[id,participantJid]);
  if(!member.rowCount||!canAccessAccount(request.principal,member.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const phoneJid=String(member.rows[0].phone_jid??(participantJid.endsWith("@s.whatsapp.net")?participantJid:""));
  if(!/^\d{7,15}@s\.whatsapp\.net$/.test(phoneJid))return reply.code(409).send({error:"participant_phone_unavailable",message:"该成员尚无可用的 WhatsApp 手机号"});
  const phoneUser=phoneJid.slice(0,phoneJid.indexOf("@")),phone=`+${phoneUser}`,displayName=String(member.rows[0].display_name??"").trim().slice(0,240)||phone;
  const created=await transaction(async client=>{
    const contact=await client.query("INSERT INTO contacts(account_id,provider_user_id,phone_e164,display_name,entity_type,last_seen_at) VALUES($1,$2,$3,$4,'person',now()) ON CONFLICT(account_id,provider_user_id) DO UPDATE SET phone_e164=COALESCE(contacts.phone_e164,EXCLUDED.phone_e164),display_name=COALESCE(NULLIF(contacts.display_name,''),EXCLUDED.display_name),last_seen_at=now(),updated_at=now() RETURNING id",[member.rows[0].account_id,phoneJid,phone,displayName]);
    const conversation=await client.query("INSERT INTO conversations(account_id,contact_id,status) VALUES($1,$2,'open') ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL RETURNING id",[member.rows[0].account_id,contact.rows[0].id]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'group_participant.open_direct','conversation',$2,$3)",[request.principal!.id,conversation.rows[0].id,JSON.stringify({groupConversationId:id,participantJid,phoneJid,contactId:contact.rows[0].id})]);
    return{conversationId:String(conversation.rows[0].id),contactId:String(contact.rows[0].id)};
  });
  return reply.code(201).send(created);
});

app.patch("/api/v1/conversations/:id", { preHandler:authenticate }, async (request,reply) => {
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {id}=request.params as {id:string};const body=(request.body??{}) as {assignedToMe?:boolean;favorite?:boolean;status?:string;read?:boolean;unread?:boolean;customerStage?:string};
  if(body.assignedToMe!==undefined&&typeof body.assignedToMe!=="boolean"||body.favorite!==undefined&&typeof body.favorite!=="boolean"||body.read!==undefined&&typeof body.read!=="boolean"||body.unread!==undefined&&typeof body.unread!=="boolean"||body.read&&body.unread)return reply.code(400).send({error:"invalid_request"});
  if(body.status!==undefined&&!['open','closed','archived'].includes(body.status))return reply.code(400).send({error:"invalid_status"});
  if(body.customerStage!==undefined&&!customerStageSchema.safeParse(body.customerStage).success)return reply.code(400).send({error:"invalid_customer_stage"});
  const current=await pool.query("SELECT c.account_id,a.agent_id,co.provider_user_id,co.entity_type FROM conversations c JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);
  if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  if(current.rows[0].entity_type==="group"&&body.customerStage!==undefined)return reply.code(409).send({error:"group_feature_unavailable"});
  const updated=await pool.query("UPDATE conversations SET assigned_user_id=CASE WHEN $2::boolean IS NULL THEN assigned_user_id WHEN $2 THEN $6::uuid ELSE NULL END,favorite=COALESCE($3,favorite),status=COALESCE($4::conversation_status,status),closed_at=CASE WHEN $4='closed' THEN now() WHEN $4='open' THEN NULL ELSE closed_at END,unread_count=CASE WHEN $8 THEN GREATEST(unread_count,1) WHEN $5 THEN 0 ELSE unread_count END,customer_stage=COALESCE($7,customer_stage) WHERE id=$1 RETURNING id,account_id,status,favorite,assigned_user_id,unread_count,closed_at,customer_stage",[id,body.assignedToMe??null,body.favorite??null,body.status??null,body.read??false,request.principal.id,body.customerStage??null,body.unread??false]);
  if(body.read&&current.rows[0].agent_id&&current.rows[0].provider_user_id)clearAgentAttention(String(current.rows[0].agent_id),String(current.rows[0].account_id),String(current.rows[0].provider_user_id));
  if(["closed","archived"].includes(updated.rows[0].status)||["won","lost"].includes(updated.rows[0].customer_stage))await pool.query("UPDATE agent_jobs SET state='cancelled',completed_at=now(),last_error='conversation_no_longer_eligible' WHERE conversation_id=$1 AND state='pending' AND kind IN ('reply','followup')",[id]);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.update','conversation',$2,$3)",[request.principal.id,id,JSON.stringify(body)]);
  return updated.rows[0];
});

async function queueConversationBlock(request:FastifyRequest,reply:FastifyReply,action:"block"|"unblock"){
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const principal=request.principal,{id}=request.params as {id:string};
  const result=await transaction(async client=>{
    const current=await client.query("SELECT c.account_id,co.provider_user_id,co.entity_type,a.platform,a.transport,agent.capabilities FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN channel_accounts a ON a.id=c.account_id LEFT JOIN agents agent ON agent.id=a.agent_id WHERE c.id=$1 FOR UPDATE OF c,co,a",[id]);
    if(!current.rowCount||!canAccessAccount(principal,current.rows[0].account_id))return{status:"not_found" as const};
    const row=current.rows[0],toJid=String(row.provider_user_id??"");
    if(row.entity_type==="group")return{status:"group_unsupported" as const};
    if(row.platform!=="whatsapp"||row.transport!=="web")return{status:"unsupported" as const};
    if(!Array.isArray(row.capabilities)||!row.capabilities.includes("contact_block_v1"))return{status:"agent_upgrade_required" as const};
    if(!/^\d{7,15}@s\.whatsapp\.net$/.test(toJid))return{status:"invalid_contact" as const};
    const command=await queueWhatsAppBlockCommand(client,{accountId:String(row.account_id),toJid,action,actorId:principal.id});
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,$2,'conversation',$3,$4)",[principal.id,action==="block"?"conversation.block":"conversation.unblock",id,JSON.stringify({accountId:row.account_id,toJid,commandId:command.commandId})]);
    return{status:"queued" as const,...command};
  });
  if(result.status==="not_found")return reply.code(404).send({error:"not_found"});
  if(result.status==="group_unsupported")return reply.code(409).send({error:"group_feature_unavailable",message:"群聊不能管理黑名单"});
  if(result.status==="unsupported")return reply.code(409).send({error:"contact_block_unsupported",message:"只有已连接的网页版 WhatsApp 账号支持黑名单管理"});
  if(result.status==="agent_upgrade_required")return reply.code(409).send({error:"agent_upgrade_required",message:"请升级并重新连接 WhatsApp Agent 后再管理黑名单"});
  if(result.status==="invalid_contact")return reply.code(409).send({error:"invalid_contact",message:"该联系人没有可用的 WhatsApp 手机号"});
  void dispatchPending(result.agentId);
  return reply.code(202).send(result);
}

app.post("/api/v1/conversations/:id/block", {preHandler:authenticate}, async(request,reply)=>{
  return queueConversationBlock(request,reply,"block");
});

app.delete("/api/v1/conversations/:id/block", {preHandler:authenticate}, async(request,reply)=>{
  return queueConversationBlock(request,reply,"unblock");
});

app.post("/api/v1/conversations/:id/transfer", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=conversationTransferSchema.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const principal=request.principal,{id}=request.params as {id:string},targetAccountId=parsed.data.accountId;
  const result=await transaction(async client=>{
    const current=await client.query(`SELECT c.account_id,c.contact_id,co.provider_user_id,co.entity_type,a.platform,a.display_name account_name
      FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN channel_accounts a ON a.id=c.account_id
      WHERE c.id=$1 FOR UPDATE OF c,co`,[id]);
    if(!current.rowCount||!canAccessAccount(principal,current.rows[0].account_id))return{status:"not_found" as const};
    const source=current.rows[0];
    if(source.account_id===targetAccountId)return{status:"same_account" as const};
    if(source.entity_type==="group")return{status:"group_unsupported" as const};
    const target=await client.query("SELECT id,display_name,platform FROM channel_accounts WHERE id=$1",[targetAccountId]);
    if(!target.rowCount||!canAccessAccount(principal,targetAccountId))return{status:"target_forbidden" as const};
    if(target.rows[0].platform!==source.platform)return{status:"platform_mismatch" as const};
    const duplicate=await client.query("SELECT c.id FROM contacts co LEFT JOIN conversations c ON c.contact_id=co.id WHERE co.account_id=$1 AND co.provider_user_id=$2 LIMIT 1",[targetAccountId,source.provider_user_id]);
    if(duplicate.rowCount)return{status:"contact_conflict" as const};
    const pending=await client.query("SELECT 1 FROM outbound_commands oc JOIN messages m ON m.id=oc.message_id WHERE m.conversation_id=$1 AND oc.state IN ('pending','dispatched') LIMIT 1",[id]);
    if(pending.rowCount)return{status:"outbound_pending" as const};
    const ruleConflict=await client.query(`SELECT 1 FROM task_rules moving JOIN task_rules existing
      ON existing.account_id=$2 AND existing.contact_id=moving.contact_id AND existing.source=moving.source AND existing.source_key=moving.source_key AND existing.id<>moving.id
      WHERE moving.contact_id=$1 LIMIT 1`,[source.contact_id,targetAccountId]);
    if(ruleConflict.rowCount)return{status:"task_rule_conflict" as const};
    await client.query("UPDATE contacts SET account_id=$2,updated_at=now() WHERE id=$1",[source.contact_id,targetAccountId]);
    await client.query("UPDATE conversations SET account_id=$2 WHERE id=$1",[id,targetAccountId]);
    await client.query("UPDATE tasks SET account_id=$2,updated_at=now() WHERE conversation_id=$1 OR contact_id=$3",[id,targetAccountId,source.contact_id]);
    await client.query("UPDATE task_rules SET account_id=$2,updated_at=now() WHERE contact_id=$1",[source.contact_id,targetAccountId]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.transfer','conversation',$2,$3)",[principal.id,id,JSON.stringify({fromAccountId:source.account_id,fromAccountName:source.account_name,toAccountId:targetAccountId,toAccountName:target.rows[0].display_name,contactId:source.contact_id})]);
    return{status:"transferred" as const,accountId:targetAccountId,accountName:String(target.rows[0].display_name)};
  });
  if(result.status==="not_found")return reply.code(404).send({error:"not_found"});
  if(result.status==="target_forbidden")return reply.code(403).send({error:"target_account_forbidden",message:"目标账号不存在或你没有访问权限"});
  if(result.status==="same_account")return reply.code(400).send({error:"same_account",message:"会话已经属于该账号"});
  if(result.status==="group_unsupported")return reply.code(409).send({error:"group_transfer_unsupported",message:"群会话不能转移账号"});
  if(result.status==="platform_mismatch")return reply.code(409).send({error:"platform_mismatch",message:"会话只能转移到相同渠道类型的账号"});
  if(result.status==="contact_conflict")return reply.code(409).send({error:"contact_conflict",message:"目标账号已存在该联系人，无法转移为重复会话"});
  if(result.status==="outbound_pending")return reply.code(409).send({error:"outbound_pending",message:"该会话仍有待发送消息，请发送完成后再转移"});
  if(result.status==="task_rule_conflict")return reply.code(409).send({error:"task_rule_conflict",message:"目标账号已存在该联系人的相同任务规则，请先处理冲突规则"});
  return reply.send({id,...result});
});

app.delete("/api/v1/conversations/:id", { preHandler:authenticate }, async (request,reply) => {
  if(request.principal?.kind!=="user"||!["admin","supervisor"].includes(request.principal.role??""))return reply.code(403).send({error:"supervisor_required",message:"只有管理员或主管可以永久删除会话"});
  const principal=request.principal,{id}=request.params as {id:string};
  const result=await transaction(async client=>{
    const conversation=await client.query("SELECT c.account_id,c.contact_id,co.provider_user_id FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 FOR UPDATE OF c",[id]);
    if(!conversation.rowCount||!canAccessAccount(principal,conversation.rows[0].account_id))return"not_found" as const;
    const payment=await client.query("SELECT 1 FROM order_payment_requests pr JOIN orders o ON o.id=pr.order_id WHERE o.conversation_id=$1 AND pr.is_current LIMIT 1",[id]);
    if(payment.rowCount)return"payment_request_exists" as const;
    const outbound=await client.query("SELECT 1 FROM outbound_commands oc JOIN messages m ON m.id=oc.message_id WHERE m.conversation_id=$1 AND oc.state IN ('pending','dispatched') LIMIT 1",[id]);
    if(outbound.rowCount)return"outbound_pending" as const;
    const pendingEmail=await client.query("SELECT 1 FROM email_messages WHERE conversation_id=$1 AND status IN ('queued','sending','retrying') LIMIT 1",[id]);
    if(pendingEmail.rowCount)return"email_pending" as const;
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.delete','conversation',$2,$3)",[principal.id,id,JSON.stringify({contactId:conversation.rows[0].contact_id,waJid:conversation.rows[0].provider_user_id})]);
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
  const {id}=request.params as {id:string};const current=await pool.query("SELECT c.account_id,c.contact_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);
  if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  if(current.rows[0].entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});
  const alias=parsed.data.alias||null;
  const result=await pool.query("UPDATE contacts SET alias=$2,updated_at=now() WHERE id=$1 RETURNING alias,COALESCE(NULLIF(alias,''),display_name,phone_e164,provider_user_id) display_name",[current.rows[0].contact_id,alias]);
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.alias.update','contact',$2,$3)",[request.principal.id,current.rows[0].contact_id,JSON.stringify({alias})]);
  return result.rows[0];
});

app.post("/api/v1/contacts",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=contactCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const targetAccount=await pool.query("SELECT platform FROM channel_accounts WHERE id=$1",[parsed.data.accountId]);
  if(!targetAccount.rowCount)return reply.code(404).send({error:"account_not_found"});
  if(targetAccount.rows[0].platform!=="whatsapp")return reply.code(409).send({error:"messenger_contact_initiation_unsupported"});
  const phone=`+${parsed.data.phone}`,waJid=`${parsed.data.phone}@s.whatsapp.net`,structuredName=[parsed.data.firstName,parsed.data.middleName,parsed.data.lastName].filter(Boolean).join(" "),displayName=structuredName||parsed.data.name!.trim();
  try{
    const created=await transaction(async client=>{const contact=await client.query("INSERT INTO contacts(account_id,provider_user_id,phone_e164,display_name,alias,first_name,middle_name,last_name,company_name,job_title,country,province,city,updated_at) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) RETURNING id",[parsed.data.accountId,waJid,phone,displayName,parsed.data.firstName||null,parsed.data.middleName||null,parsed.data.lastName||null,parsed.data.companyName||null,parsed.data.jobTitle||null,parsed.data.country||null,parsed.data.province||null,parsed.data.city||null]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.create','contact',$2,$3)",[request.principal!.id,contact.rows[0].id,JSON.stringify({accountId:parsed.data.accountId,phone})]);return contact.rows[0];});
    return reply.code(201).send(await contactProfileById(pool,String(created.id)));
  }catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"contact_exists",message:"该 WhatsApp 号码已存在于当前账号的联系人中"});throw error;}
});

app.get("/api/v1/contacts",{preHandler:authenticate},async(request,reply)=>{
  const query=request.query as {q?:string;accountId?:string;blacklist?:string;limit?:string;offset?:string};
  if(query.accountId&&!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  if(query.blacklist!==undefined&&query.blacklist!=="true"&&query.blacklist!=="false")return reply.code(400).send({error:"invalid_blacklist_filter"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??30)||30)),offset=Math.max(0,Number(query.offset??0)||0),accountIds=request.principal?.accountIds??null;
  const result=await pool.query(`SELECT co.id,co.account_id,a.display_name account_name,a.platform,a.transport,co.provider_user_id,co.alias,co.display_name contact_name,co.first_name,co.middle_name,co.last_name,co.company_name,co.job_title,co.country,co.province,co.city,co.phone_e164,co.avatar_url,co.note,co.timezone,co.preferred_language,co.birthday_month,co.birthday_day,co.birthday_year,co.whatsapp_blocked_at,co.updated_at,c.id conversation_id,c.last_message_at,COUNT(*) OVER()::int total_count,
    COALESCE(email_list.emails,'[]'::json) emails,COALESCE(method_list.methods,'[]'::json) methods,COALESCE(address_list.addresses,'[]'::json) addresses,COALESCE(date_list.special_dates,'[]'::json) special_dates
    FROM contacts co JOIN channel_accounts a ON a.id=co.account_id LEFT JOIN conversations c ON c.contact_id=co.id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',email.id,'label',email.label,'email',email.email,'isPrimary',email.is_primary) ORDER BY email.position,email.id) emails FROM contact_emails email WHERE email.contact_id=co.id)email_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',method.id,'type',method.type,'label',method.label,'value',method.value) ORDER BY method.position,method.id) methods FROM contact_methods method WHERE method.contact_id=co.id)method_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',address.id,'label',address.label,'recipientName',address.recipient_name,'phone',address.phone,'address',address.address,'countryCode',address.country_code,'province',address.province,'city',address.city,'street1',COALESCE(address.street_line_1,address.address),'street2',address.street_line_2,'postalCode',address.postal_code,'isDefault',address.is_default) ORDER BY address.is_default DESC,address.created_at,address.id) addresses FROM contact_addresses address WHERE address.contact_id=co.id)address_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',d.id,'kind',d.kind,'label',d.label,'month',d.month,'day',d.day,'year',d.year,'leadDays',d.lead_days) ORDER BY d.month,d.day,d.id) special_dates FROM contact_special_dates d WHERE d.contact_id=co.id)date_list ON true
    WHERE co.entity_type='person' AND ($1::uuid IS NULL OR co.account_id=$1) AND ($2::uuid[] IS NULL OR co.account_id=ANY($2)) AND ($3::text IS NULL OR co.alias ILIKE '%'||$3||'%' OR co.display_name ILIKE '%'||$3||'%' OR co.first_name ILIKE '%'||$3||'%' OR co.middle_name ILIKE '%'||$3||'%' OR co.last_name ILIKE '%'||$3||'%' OR co.company_name ILIKE '%'||$3||'%' OR co.job_title ILIKE '%'||$3||'%' OR co.country ILIKE '%'||$3||'%' OR co.province ILIKE '%'||$3||'%' OR co.city ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%' OR co.provider_user_id ILIKE '%'||$3||'%' OR EXISTS(SELECT 1 FROM contact_emails e WHERE e.contact_id=co.id AND (e.email ILIKE '%'||$3||'%' OR e.label ILIKE '%'||$3||'%')) OR EXISTS(SELECT 1 FROM contact_methods m WHERE m.contact_id=co.id AND (m.value ILIKE '%'||$3||'%' OR m.label ILIKE '%'||$3||'%')))
      AND ($4::boolean IS NULL OR (co.whatsapp_blocked_at IS NOT NULL)=$4::boolean)
    ORDER BY c.last_message_at DESC NULLS LAST,co.updated_at DESC,co.id LIMIT $5 OFFSET $6`,[query.accountId??null,accountIds,query.q?.trim()||null,query.blacklist===undefined?null:query.blacklist==="true",limit,offset]);
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
  if(parsed.data.timezone&&!isValidTimeZone(parsed.data.timezone))return reply.code(400).send({error:"invalid_timezone",message:"请输入有效的 IANA 时区"});
  const principal=request.principal,{id}=request.params as {id:string};
  const updated=await transaction(async client=>{
    const current=await client.query("SELECT co.account_id,co.phone_e164,EXISTS(SELECT 1 FROM conversations c WHERE c.contact_id=co.id) has_conversation FROM contacts co WHERE co.id=$1 AND co.entity_type='person' FOR UPDATE",[id]);
    if(!current.rowCount||!canAccessAccount(principal,current.rows[0].account_id))return false;
    const nextPhone=parsed.data.phone?`+${parsed.data.phone}`:null,phoneChanged=Boolean(nextPhone&&nextPhone!==current.rows[0].phone_e164);
    if(phoneChanged&&current.rows[0].phone_e164&&current.rows[0].has_conversation)return"phone_locked" as const;
    if(phoneChanged){const duplicate=await client.query("SELECT 1 FROM contacts WHERE account_id=$1 AND provider_user_id=$2 AND id<>$3 LIMIT 1",[current.rows[0].account_id,`${parsed.data.phone}@s.whatsapp.net`,id]);if(duplicate.rowCount)return"contact_exists" as const;}
    await client.query("UPDATE contacts SET alias=$2,note=$3,phone_e164=CASE WHEN $4::text IS NULL THEN phone_e164 ELSE $4 END,provider_user_id=CASE WHEN $5::text IS NULL THEN provider_user_id ELSE $5 END,birthday_month=CASE WHEN $6 THEN $7 ELSE birthday_month END,birthday_day=CASE WHEN $6 THEN $8 ELSE birthday_day END,birthday_year=CASE WHEN $6 THEN $9 ELSE birthday_year END,timezone=CASE WHEN $10 THEN $11 ELSE timezone END,preferred_language=CASE WHEN $12 THEN $13 ELSE preferred_language END,first_name=CASE WHEN $14 THEN $15 ELSE first_name END,middle_name=CASE WHEN $16 THEN $17 ELSE middle_name END,last_name=CASE WHEN $18 THEN $19 ELSE last_name END,company_name=CASE WHEN $20 THEN $21 ELSE company_name END,job_title=CASE WHEN $22 THEN $23 ELSE job_title END,country=CASE WHEN $24 THEN $25 ELSE country END,province=CASE WHEN $26 THEN $27 ELSE province END,city=CASE WHEN $28 THEN $29 ELSE city END,updated_at=now() WHERE id=$1",[id,parsed.data.alias||null,parsed.data.note||null,nextPhone,parsed.data.phone?`${parsed.data.phone}@s.whatsapp.net`:null,parsed.data.birthday!==undefined,parsed.data.birthday?.month??null,parsed.data.birthday?.day??null,parsed.data.birthday?.year??null,parsed.data.timezone!==undefined,parsed.data.timezone||null,parsed.data.preferredLanguage!==undefined,parsed.data.preferredLanguage||null,parsed.data.firstName!==undefined,parsed.data.firstName||null,parsed.data.middleName!==undefined,parsed.data.middleName||null,parsed.data.lastName!==undefined,parsed.data.lastName||null,parsed.data.companyName!==undefined,parsed.data.companyName||null,parsed.data.jobTitle!==undefined,parsed.data.jobTitle||null,parsed.data.country!==undefined,parsed.data.country||null,parsed.data.province!==undefined,parsed.data.province||null,parsed.data.city!==undefined,parsed.data.city||null]);
    if(parsed.data.birthday!==undefined){await client.query("UPDATE task_rules SET enabled=false,updated_at=now() WHERE contact_id=$1 AND source='birthday'",[id]);await client.query("UPDATE tasks SET status='cancelled',last_error='contact_birthday_changed',updated_at=now() WHERE contact_id=$1 AND source='birthday' AND status IN ('planned','in_progress','waiting_approval','scheduled','overdue')",[id]);}
    await client.query("DELETE FROM contact_emails WHERE contact_id=$1",[id]);
    for(const [position,email] of parsed.data.emails.entries())await client.query("INSERT INTO contact_emails(contact_id,label,email,is_primary,position) VALUES($1,$2,$3,$4,$5)",[id,email.label,email.email,email.isPrimary,position]);
    await client.query("DELETE FROM contact_methods WHERE contact_id=$1",[id]);
    for(const [position,method] of parsed.data.methods.entries())await client.query("INSERT INTO contact_methods(contact_id,type,label,value,position) VALUES($1,$2,$3,$4,$5)",[id,method.type,method.label,method.value,position]);
    if(parsed.data.specialDates){await client.query("UPDATE task_rules SET enabled=false,updated_at=now() WHERE contact_id=$1 AND source='special_date'",[id]);await client.query("UPDATE tasks SET status='cancelled',last_error='contact_special_dates_changed',updated_at=now() WHERE contact_id=$1 AND source='special_date' AND status IN ('planned','in_progress','waiting_approval','scheduled','overdue')",[id]);const retainedDateIds:string[]=[];for(const date of parsed.data.specialDates){if(date.id){const saved=await client.query("UPDATE contact_special_dates SET kind=$3,label=$4,month=$5,day=$6,year=$7,lead_days=$8,updated_at=now() WHERE id=$1 AND contact_id=$2 RETURNING id",[date.id,id,date.kind,date.label,date.month,date.day,date.year??null,date.leadDays??null]);if(!saved.rowCount)throw Object.assign(new Error("invalid_contact_special_date"),{statusCode:400});retainedDateIds.push(String(saved.rows[0].id));}else{const saved=await client.query("INSERT INTO contact_special_dates(contact_id,kind,label,month,day,year,lead_days) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[id,date.kind,date.label,date.month,date.day,date.year??null,date.leadDays??null]);retainedDateIds.push(String(saved.rows[0].id));}}await client.query("DELETE FROM contact_special_dates WHERE contact_id=$1 AND NOT(id=ANY($2::uuid[]))",[id,retainedDateIds]);}
    const retainedAddressIds:string[]=[];
    await client.query("UPDATE contact_addresses SET is_default=false WHERE contact_id=$1 AND is_default",[id]);
    for(const address of parsed.data.addresses){const street1=address.street1??address.address;if(address.id){const saved=await client.query("UPDATE contact_addresses SET label=$3,recipient_name=$4,phone=$5,address=$6,is_default=$7,country_code=$8,province=$9,city=$10,street_line_1=$11,street_line_2=$12,postal_code=$13,updated_at=now() WHERE id=$1 AND contact_id=$2 RETURNING id",[address.id,id,address.label,address.recipientName||null,address.phone||null,street1,address.isDefault,address.countryCode??null,address.province??null,address.city??null,street1,address.street2??null,address.postalCode??null]);if(!saved.rowCount)throw Object.assign(new Error("invalid_contact_address"),{statusCode:400});retainedAddressIds.push(String(saved.rows[0].id));}else{const saved=await client.query("INSERT INTO contact_addresses(contact_id,label,recipient_name,phone,address,is_default,created_by,country_code,province,city,street_line_1,street_line_2,postal_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",[id,address.label,address.recipientName||null,address.phone||null,street1,address.isDefault,principal.id,address.countryCode??null,address.province??null,address.city??null,street1,address.street2??null,address.postalCode??null]);retainedAddressIds.push(String(saved.rows[0].id));}}
    await client.query("DELETE FROM contact_addresses WHERE contact_id=$1 AND NOT(id=ANY($2::uuid[]))",[id,retainedAddressIds]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.profile.update','contact',$2,$3)",[principal.id,id,JSON.stringify({alias:parsed.data.alias,phoneChanged,emailCount:parsed.data.emails.length,methodCount:parsed.data.methods.length,addressCount:parsed.data.addresses.length,hasNote:Boolean(parsed.data.note)})]);
    return true;
  });
  if(!updated)return reply.code(404).send({error:"not_found"});
  if(updated==="phone_locked")return reply.code(409).send({error:"phone_locked",message:"该联系人已有对应会话，WhatsApp 号码不可修改"});
  if(updated==="contact_exists")return reply.code(409).send({error:"contact_exists",message:"该 WhatsApp 号码已存在于当前账号的联系人中"});
  return contactProfileById(pool,id);
});

app.patch("/api/v1/contacts/bulk-update",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const body=(request.body??{}) as {contactIds?:unknown;country?:unknown;preferredLanguage?:unknown;timezone?:unknown};
  const ids=Array.isArray(body.contactIds)?body.contactIds.filter((id):id is string=>typeof id==="string"&&isPostgresUuid(id)):[];
  if(!ids.length)return reply.code(400).send({error:"contact_ids_required"});
  if(body.timezone!==undefined&&body.timezone!==null&&String(body.timezone)&&!isValidTimeZone(String(body.timezone)))return reply.code(400).send({error:"invalid_timezone",message:"请输入有效的 IANA 时区"});
  if(body.preferredLanguage!==undefined&&body.preferredLanguage!==null&&!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(String(body.preferredLanguage)))return reply.code(400).send({error:"invalid_language"});
  const fields={country:body.country===undefined?undefined:String(body.country??"").trim()||null,preferredLanguage:body.preferredLanguage===undefined?undefined:String(body.preferredLanguage??"").trim()||null,timezone:body.timezone===undefined?undefined:String(body.timezone??"").trim()||null};
  if(Object.values(fields).every(value=>value===undefined))return reply.code(400).send({error:"no_changes"});
  const updated=await transaction(async client=>{const found=await client.query("SELECT id,account_id FROM contacts WHERE id=ANY($1::uuid[]) AND entity_type='person'",[ids]);const allowed=found.rows.filter(row=>canAccessAccount(request.principal,row.account_id)).map(row=>String(row.id));if(!allowed.length)return 0;for(const id of allowed){await client.query("UPDATE contacts SET country=CASE WHEN $2::boolean THEN $3 ELSE country END,preferred_language=CASE WHEN $4::boolean THEN $5 ELSE preferred_language END,timezone=CASE WHEN $6::boolean THEN $7 ELSE timezone END,updated_at=now() WHERE id=$1",[id,fields.country!==undefined,fields.country,fields.preferredLanguage!==undefined,fields.preferredLanguage,fields.timezone!==undefined,fields.timezone]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.bulk_update','contact',$2,$3)",[request.principal!.id,id,JSON.stringify(fields)]);}return allowed.length;});
  return {updated};
});

app.post("/api/v1/contacts/create-group",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const body=(request.body??{}) as {contactIds?:unknown;subject?:unknown};
  const contactIds=Array.isArray(body.contactIds)?body.contactIds.filter((id):id is string=>typeof id==="string"&&isPostgresUuid(id)):[];
  const subject=String(body.subject??"").trim().slice(0,100);
  if(!subject)return reply.code(400).send({error:"group_subject_required",message:"请填写群名称"});
  if(!contactIds.length)return reply.code(400).send({error:"contact_ids_required"});
  const queued=await transaction(async client=>{const contacts=await client.query("SELECT co.id,co.account_id,co.provider_user_id,a.agent_id,a.transport,a.status,agent.capabilities FROM contacts co JOIN channel_accounts a ON a.id=co.account_id LEFT JOIN agents agent ON agent.id=a.agent_id WHERE co.id=ANY($1::uuid[]) AND co.entity_type='person'",[contactIds]);if(contacts.rowCount!==contactIds.length)return"contacts_not_found" as const;const accountId=String(contacts.rows[0].account_id);if(!canAccessAccount(request.principal,accountId))return"account_forbidden" as const;if(contacts.rows.some(row=>String(row.account_id)!==accountId))return"multiple_accounts" as const;const account=contacts.rows[0];if(account.transport!=="web"||!account.agent_id)return"agent_required" as const;if(!Array.isArray(account.capabilities)||!account.capabilities.includes("group_create_v1"))return"agent_upgrade_required" as const;const participantJids=[...new Set(contacts.rows.map(row=>String(row.provider_user_id)).filter(jid=>/^\d{7,15}@s\.whatsapp\.net$/.test(jid)))];if(participantJids.length!==contactIds.length)return"invalid_participants" as const;const command=await queueGroupCreateCommand(client,{accountId,subject,participantJids});await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'contact.group_create','account',$2,$3)",[request.principal!.id,accountId,JSON.stringify({subject,contactIds,participantCount:participantJids.length,commandId:command.commandId})]);return command;});
  if(queued==="contacts_not_found")return reply.code(404).send({error:queued});
  if(queued==="account_forbidden")return reply.code(403).send({error:queued});
  if(queued==="multiple_accounts")return reply.code(409).send({error:queued,message:"创建群的联系人必须属于同一个 WhatsApp 账号"});
  if(queued==="agent_required")return reply.code(409).send({error:queued,message:"仅已连接网页版 WhatsApp Agent 的账号支持创建群"});
  if(queued==="agent_upgrade_required")return reply.code(409).send({error:queued,message:"请先升级并重启 WhatsApp Agent，再创建群"});
  if(queued==="invalid_participants")return reply.code(400).send({error:queued});
  void dispatchPending(queued.agentId);
  return reply.code(202).send({commandId:queued.commandId});
});

app.get("/api/v1/contacts/create-group/:commandId",{preHandler:authenticate},async(request,reply)=>{
  const {commandId}=request.params as {commandId:string};
  if(!isPostgresUuid(commandId))return reply.code(404).send({error:"not_found"});
  const command=await pool.query("SELECT oc.id,oc.state,oc.attempt,oc.last_error,oc.completed_at,oc.created_at,oc.payload FROM outbound_commands oc WHERE oc.id=$1 AND oc.command='create_group'",[commandId]);
  if(!command.rowCount)return reply.code(404).send({error:"not_found"});
  const account=await pool.query("SELECT account_id FROM outbound_commands WHERE id=$1",[commandId]);
  if(!account.rowCount||!canAccessAccount(request.principal,account.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  return command.rows[0];
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
  const query=request.query as {q?:string;exact?:string;tag?:string;category?:string;brand?:string;currency?:string;limit?:string;offset?:string};
  const parsedCurrency=query.currency?currencySchema.safeParse(query.currency):null;if(parsedCurrency&&!parsedCurrency.success)return reply.code(400).send({error:"invalid_currency"});
  if(query.exact!==undefined&&!["true","false"].includes(query.exact))return reply.code(400).send({error:"invalid_exact_match"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??40)||40)),offset=Math.max(0,Number(query.offset??0)||0);
  const [result,tagOptions,categoryOptions,brandOptions]=await Promise.all([pool.query(`SELECT p.id,p.sku,p.name,p.description,p.category,p.brand,p.supplier_links,p.internal_note,p.default_unit_amount,p.weight_amount,p.weight_unit,p.shipping_class_id,sc.name shipping_class_name,p.currency,p.image_media_id,m.file_name image_name,COALESCE(gallery_list.images,'[]'::json) gallery_images,p.created_at,p.updated_at,COUNT(*) OVER()::int total_count,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(variant_list.variants,'[]'::json) variants
    FROM products p LEFT JOIN media m ON m.id=p.image_media_id LEFT JOIN shipping_classes sc ON sc.id=p.shipping_class_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',gm.id,'fileName',gm.file_name) ORDER BY pg.position) images FROM product_gallery_images pg JOIN media gm ON gm.id=pg.media_id WHERE pg.product_id=p.id) gallery_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount,'costAmount',tier.cost_amount,'profitMargin',tier.profit_margin) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',v.id,'attributes',v.attributes,'sku',v.sku,'imageMediaId',v.image_media_id,'imageName',vm.file_name,'priceTiers',COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount,'costAmount',t.cost_amount,'profitMargin',t.profit_margin) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json)) ORDER BY v.created_at,v.id) variants FROM product_variants v LEFT JOIN media vm ON vm.id=v.image_media_id WHERE v.product_id=p.id) variant_list ON true
    WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR ($4::boolean AND (lower(btrim(p.name))=lower($1) OR lower(btrim(p.sku))=lower($1))) OR (NOT $4::boolean AND (p.name ILIKE '%'||$1||'%' OR p.sku ILIKE '%'||$1||'%' OR p.description ILIKE '%'||$1||'%' OR p.category ILIKE '%'||$1||'%' OR p.brand ILIKE '%'||$1||'%' OR EXISTS(SELECT 1 FROM product_labels search_label WHERE search_label.product_id=p.id AND search_label.name ILIKE '%'||$1||'%')))) AND ($2::text IS NULL OR p.currency=$2) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM product_labels filter_label WHERE filter_label.product_id=p.id AND lower(filter_label.name)=lower($3))) AND ($5::text IS NULL OR lower(p.category)=lower($5)) AND ($6::text IS NULL OR lower(p.brand)=lower($6))
    ORDER BY p.updated_at DESC,p.id LIMIT $7 OFFSET $8`,[query.q?.trim()||null,parsedCurrency?.data??null,query.tag?.trim()||null,query.exact==="true",query.category?.trim()||null,query.brand?.trim()||null,limit+1,offset]),pool.query("SELECT DISTINCT label.name FROM product_labels label JOIN products p ON p.id=label.product_id WHERE p.deleted_at IS NULL ORDER BY label.name"),pool.query("SELECT DISTINCT category FROM products WHERE deleted_at IS NULL AND category<>'' ORDER BY category"),pool.query("SELECT DISTINCT brand FROM products WHERE deleted_at IS NULL AND brand<>'' ORDER BY brand")]);
  return{data:result.rows.slice(0,limit).map(mapProductRow),total:Number(result.rows[0]?.total_count??0),hasMore:result.rows.length>limit,nextOffset:result.rows.length>limit?offset+limit:null,tags:tagOptions.rows.map(row=>String(row.name)),categories:categoryOptions.rows.map(row=>String(row.category)),brands:brandOptions.rows.map(row=>String(row.brand))};
});

app.patch("/api/v1/product-labels",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=productLabelCatalogUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const principal=request.principal,{currentName,name,color}=parsed.data;
  const result=await transaction(async client=>{
    const affected=await client.query("SELECT product_id FROM product_labels WHERE lower(btrim(name))=lower($1) FOR UPDATE",[currentName]);
    if(!affected.rowCount)return null;
    const productIds=[...new Set(affected.rows.map(row=>String(row.product_id)))];
    if(currentName.toLocaleLowerCase()!==name.toLocaleLowerCase())await client.query("DELETE FROM product_labels WHERE product_id=ANY($1::uuid[]) AND lower(btrim(name))=lower($2) AND lower(btrim(name))<>lower($3)",[productIds,name,currentName]);
    const updated=await client.query("UPDATE product_labels SET name=$2,color=$3 WHERE lower(btrim(name))=lower($1) RETURNING id",[currentName,name,color]);
    await client.query("UPDATE products SET updated_at=now() WHERE id=ANY($1::uuid[])",[productIds]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product_label.update','product_label',NULL,$2)",[principal.id,JSON.stringify({currentName,name,color,productCount:productIds.length})]);
    return{updated:updated.rowCount,productCount:productIds.length,name,color};
  });
  if(!result)return reply.code(404).send({error:"not_found"});return result;
});

app.delete("/api/v1/product-labels",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=productLabelCatalogDeleteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const principal=request.principal,result=await transaction(async client=>{
    const removed=await client.query("DELETE FROM product_labels WHERE lower(btrim(name))=lower($1) RETURNING product_id",[parsed.data.name]);
    if(!removed.rowCount)return null;
    const productIds=[...new Set(removed.rows.map(row=>String(row.product_id)))];
    await client.query("UPDATE products SET updated_at=now() WHERE id=ANY($1::uuid[])",[productIds]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product_label.delete','product_label',NULL,$2)",[principal.id,JSON.stringify({name:parsed.data.name,productCount:productIds.length})]);
    return{deleted:removed.rowCount,productCount:productIds.length};
  });
  if(!result)return reply.code(404).send({error:"not_found"});return result;
});

app.post("/api/v1/products/query",{preHandler:authenticate},async(request,reply)=>{
  if(!hasScope(request.principal,"products:read"))return reply.code(403).send({error:"insufficient_scope",requiredScope:"products:read"});
  const parsed=productSkuQuerySchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const normalizedSkus=parsed.data.skus.map(sku=>sku.toLocaleLowerCase()),result=await pool.query(`SELECT p.id,p.sku,p.name,p.description,p.category,p.brand,p.supplier_links,p.internal_note,p.default_unit_amount,p.weight_amount,p.weight_unit,p.shipping_class_id,sc.name shipping_class_name,p.currency,p.image_media_id,m.file_name image_name,p.created_at,p.updated_at,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(variant_list.variants,'[]'::json) variants
    FROM products p LEFT JOIN media m ON m.id=p.image_media_id LEFT JOIN shipping_classes sc ON sc.id=p.shipping_class_id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount,'costAmount',tier.cost_amount,'profitMargin',tier.profit_margin) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',v.id,'attributes',v.attributes,'sku',v.sku,'imageMediaId',v.image_media_id,'priceTiers',COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount,'costAmount',t.cost_amount,'profitMargin',t.profit_margin) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json)) ORDER BY v.created_at,v.id) variants FROM product_variants v WHERE v.product_id=p.id) variant_list ON true
    WHERE p.deleted_at IS NULL AND lower(btrim(p.sku))=ANY($1::text[])
    ORDER BY array_position($1::text[],lower(btrim(p.sku)))`,[normalizedSkus]);
  const found=new Set(result.rows.map(row=>String(row.sku).trim().toLocaleLowerCase()));
  return{data:result.rows.map(mapProductRow),missingSkus:parsed.data.skus.filter(sku=>!found.has(sku.toLocaleLowerCase()))};
});

app.post("/api/v1/products/selection",{preHandler:authenticate},async(request,reply)=>{
  const body=request.body as {productIds?:unknown},ids=Array.isArray(body?.productIds)?body.productIds:[];if(ids.length<1||ids.length>MATERIAL_PRODUCT_LIMIT||ids.some(id=>typeof id!=="string"||!/^[0-9a-f-]{36}$/i.test(id))||new Set(ids).size!==ids.length)return reply.code(400).send({error:"invalid_request"});
  const result=await pool.query(`SELECT p.id,p.sku,p.name,p.description,p.category,p.brand,p.supplier_links,p.internal_note,p.default_unit_amount,p.currency,p.image_media_id,m.file_name image_name,p.created_at,p.updated_at,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(variant_list.variants,'[]'::json) variants FROM products p LEFT JOIN media m ON m.id=p.image_media_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount,'costAmount',tier.cost_amount,'profitMargin',tier.profit_margin) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',v.id,'attributes',v.attributes,'sku',v.sku,'imageMediaId',v.image_media_id,'priceTiers',COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount,'costAmount',t.cost_amount,'profitMargin',t.profit_margin) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json)) ORDER BY v.created_at,v.id) variants FROM product_variants v WHERE v.product_id=p.id) variant_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[ids]);
  if(result.rowCount!==ids.length)return reply.code(409).send({error:"product_unavailable"});return{data:result.rows.map(mapProductRow)};
});

app.post("/api/v1/products",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=productCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  try{const result=await transaction(async client=>{const duplicate=await client.query("SELECT id FROM products WHERE client_product_id=$1",[parsed.data.clientProductId]);if(duplicate.rowCount)return{product:await productById(client,duplicate.rows[0].id),deduplicated:true};const galleryMediaIds=parsed.data.galleryMediaIds??[],mediaIds=[...(parsed.data.variants??[]).flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]),...galleryMediaIds];if(parsed.data.imageMediaId)mediaIds.push(parsed.data.imageMediaId);if(mediaIds.length){const image=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds]);if(image.rowCount!==new Set(mediaIds).size)return null;}if(parsed.data.shippingClassId&&!await shippingClassExists(client,parsed.data.shippingClassId,true))throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});const coverImageId=galleryMediaIds[0]??parsed.data.imageMediaId??null,created=await client.query("INSERT INTO products(client_product_id,sku,name,description,category,brand,supplier_links,internal_note,default_unit_amount,currency,image_media_id,created_by,weight_amount,weight_unit,shipping_class_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id",[parsed.data.clientProductId,parsed.data.sku,parsed.data.name,parsed.data.description,parsed.data.category,parsed.data.brand,JSON.stringify(parsed.data.supplierLinks),parsed.data.internalNote,parsed.data.priceTiers[0].unitAmount,parsed.data.currency,coverImageId,principal.id,parsed.data.weightAmount??null,parsed.data.weightUnit??null,parsed.data.shippingClassId??null]);await replaceProductLabels(client,created.rows[0].id,parsed.data.tags);await replaceProductPriceTiers(client,created.rows[0].id,parsed.data.priceTiers);await replaceProductGallery(client,created.rows[0].id,galleryMediaIds.length?galleryMediaIds:coverImageId?[coverImageId]:[]);if(parsed.data.variants?.length)await replaceProductVariants(client,created.rows[0].id,parsed.data.variants);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.create','product',$2,$3)",[principal.id,created.rows[0].id,JSON.stringify({source:"library",sku:parsed.data.sku,tagCount:parsed.data.tags.length,tierCount:parsed.data.priceTiers.length,variantCount:parsed.data.variants?.length??0,galleryImageCount:galleryMediaIds.length,shippingClassId:parsed.data.shippingClassId??null})]);return{product:await productById(client,created.rows[0].id),deduplicated:false};});if(!result)return reply.code(400).send({error:"invalid_product_image"});return reply.code(result.deduplicated?200:201).send({...result.product,deduplicated:result.deduplicated});}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
});

app.post("/api/v1/products/bulk-import",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=productBulkImportSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const currencies=[...new Set(parsed.data.products.flatMap(product=>product.currency?[product.currency]:[]))],configured=await pool.query("SELECT code FROM currency_settings WHERE code=ANY($1::text[])",[currencies]),configuredCodes=new Set(configured.rows.map(row=>String(row.code))),invalidCurrencies=currencies.filter(code=>!configuredCodes.has(code));
  if(invalidCurrencies.length)return reply.code(400).send({error:"currency_not_configured",currencies:invalidCurrencies,message:`以下币种未在货币管理中启用：${invalidCurrencies.join("、")}`});
  try{const result=await transaction(async client=>{
    const normalizedSkus=parsed.data.products.map(product=>product.sku.trim().toLocaleLowerCase()),existing=await client.query("SELECT id,lower(btrim(sku)) normalized_sku FROM products WHERE deleted_at IS NULL AND lower(btrim(sku))=ANY($1::text[]) FOR UPDATE",[normalizedSkus]),existingBySku=new Map(existing.rows.map(row=>[String(row.normalized_sku),String(row.id)])),products=[],counts={created:0,updated:0};
    for(const product of parsed.data.products){
      const normalizedSku=product.sku.trim().toLocaleLowerCase(),existingId=existingBySku.get(normalizedSku);let productId:string,created=false;
      if(product.shippingClassId&&!await shippingClassExists(client,product.shippingClassId,true))throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});
      if(existingId){
        productId=existingId;
        const hasWeight=product.weightAmount!==undefined||product.weightUnit!==undefined,hasGallery=product.galleryMediaIds!==undefined,hasImage=product.imageMediaId!==undefined||hasGallery,hasShippingClass=product.shippingClassId!==undefined,hasSupplierLinks=product.supplierLinks!==undefined,hasInternalNote=product.internalNote!==undefined;
        const mediaIds=[...(product.galleryMediaIds??[]),...(product.variants??[]).flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]),...(product.imageMediaId?[product.imageMediaId]:[])];
        if(mediaIds.length){const image=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds]);if(image.rowCount!==new Set(mediaIds).size)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}
        await client.query("UPDATE products SET name=$2,description=CASE WHEN $3 THEN $4 ELSE description END,category=CASE WHEN $5 THEN $6 ELSE category END,brand=CASE WHEN $7 THEN $8 ELSE brand END,default_unit_amount=CASE WHEN $9 THEN $10 ELSE default_unit_amount END,currency=CASE WHEN $11 THEN $12 ELSE currency END,image_media_id=CASE WHEN $13 THEN $14 ELSE image_media_id END,weight_amount=CASE WHEN $15 THEN $16 ELSE weight_amount END,weight_unit=CASE WHEN $15 THEN $17 ELSE weight_unit END,shipping_class_id=CASE WHEN $18 THEN $19 ELSE shipping_class_id END,supplier_links=CASE WHEN $20 THEN $21::jsonb ELSE supplier_links END,internal_note=CASE WHEN $22 THEN $23 ELSE internal_note END,updated_at=now() WHERE id=$1",[productId,product.name,product.description!==undefined,product.description??null,product.category!==undefined,product.category??null,product.brand!==undefined,product.brand??null,product.priceTiers!==undefined,product.priceTiers?.[0].unitAmount??null,product.currency!==undefined,product.currency??null,hasImage,(product.galleryMediaIds?.[0]??product.imageMediaId)??null,hasWeight,product.weightAmount??null,product.weightUnit??null,hasShippingClass,product.shippingClassId??null,hasSupplierLinks,JSON.stringify(product.supplierLinks??[]),hasInternalNote,product.internalNote??null]);
        if(product.tags!==undefined)await replaceProductLabels(client,productId,product.tags);
        if(product.priceTiers!==undefined)await replaceProductPriceTiers(client,productId,product.priceTiers);
        if(hasGallery)await replaceProductGallery(client,productId,product.galleryMediaIds??[]);
        if(product.variants!==undefined)await replaceProductVariants(client,productId,product.variants);
      }
      else{
        if(!product.currency||!product.priceTiers)throw Object.assign(new Error("new_product_fields_required"),{statusCode:400,sku:product.sku});
        const mediaIds=[...(product.galleryMediaIds??[]),...(product.variants??[]).flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]),...(product.imageMediaId?[product.imageMediaId]:[])];if(mediaIds.length){const image=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds]);if(image.rowCount!==new Set(mediaIds).size)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}
        const upserted=await client.query(`INSERT INTO products(client_product_id,sku,name,description,category,brand,supplier_links,internal_note,default_unit_amount,currency,image_media_id,created_by,weight_amount,weight_unit,shipping_class_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (lower(btrim(sku))) WHERE deleted_at IS NULL DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,brand=EXCLUDED.brand,shipping_class_id=EXCLUDED.shipping_class_id,updated_at=now()
          RETURNING id,(xmax=0) inserted`,[product.clientProductId,product.sku,product.name,product.description??"",product.category??"",product.brand??"",JSON.stringify(product.supplierLinks??[]),product.internalNote??"",product.priceTiers[0].unitAmount,product.currency,(product.galleryMediaIds?.[0]??product.imageMediaId)??null,principal.id,product.weightAmount??null,product.weightUnit??null,product.shippingClassId??null]);
        productId=String(upserted.rows[0].id);created=Boolean(upserted.rows[0].inserted);
      }
      if(created){await replaceProductLabels(client,productId,product.tags??[]);await replaceProductPriceTiers(client,productId,product.priceTiers!);await replaceProductGallery(client,productId,product.galleryMediaIds??(product.imageMediaId?[product.imageMediaId]:[]));if(product.variants?.length)await replaceProductVariants(client,productId,product.variants);counts.created++;await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.create','product',$2,$3)",[principal.id,productId,JSON.stringify({source:"csv_import",sku:product.sku,tagCount:product.tags?.length??0,tierCount:product.priceTiers?.length??0,variantCount:product.variants?.length??0})]);}
      else{counts.updated++;await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.update','product',$2,$3)",[principal.id,productId,JSON.stringify({source:"csv_import",sku:product.sku,fields:Object.keys(product).filter(field=>!["clientProductId","sku"].includes(field))})]);}
      products.push(await productById(client,productId));
    }
    return{...counts,products};
  });return reply.code(result.updated?200:201).send(result);}catch(error){if((error as Error).message==="new_product_fields_required")return reply.code(400).send({error:"new_product_fields_required",sku:(error as {sku?:string}).sku,message:`SKU ${(error as {sku?:string}).sku??""} 不存在，请填写币种和价格以创建新产品`});if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
});

app.patch("/api/v1/products/bulk-update",{preHandler:authenticate},async(request,reply)=>{
  if(!hasScope(request.principal,"products:write"))return reply.code(403).send({error:"insufficient_scope",requiredScope:"products:write"});const principal=request.principal!,parsed=productBulkUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  try{const result=await transaction(async client=>{
    const normalizedSkus=parsed.data.products.map(product=>product.sku.toLocaleLowerCase()),found=await client.query("SELECT id,sku,lower(btrim(sku)) normalized_sku FROM products WHERE deleted_at IS NULL AND lower(btrim(sku))=ANY($1::text[]) FOR UPDATE",[normalizedSkus]),bySku=new Map(found.rows.map(row=>[String(row.normalized_sku),{id:String(row.id),sku:String(row.sku)}]));
    const missingSkus=parsed.data.products.filter(product=>!bySku.has(product.sku.toLocaleLowerCase())).map(product=>product.sku);if(missingSkus.length)throw Object.assign(new Error("product_unavailable"),{statusCode:409,missingSkus});
    const products=[];
    for(const update of parsed.data.products){const current=bySku.get(update.sku.toLocaleLowerCase())!,fields=Object.keys(update).filter(field=>field!=="sku");await client.query("UPDATE products SET name=CASE WHEN $2 THEN $3 ELSE name END,description=CASE WHEN $4 THEN $5 ELSE description END,category=CASE WHEN $6 THEN $7 ELSE category END,brand=CASE WHEN $8 THEN $9 ELSE brand END,updated_at=now() WHERE id=$1",[current.id,update.name!==undefined,update.name??null,update.description!==undefined,update.description??null,update.category!==undefined,update.category??null,update.brand!==undefined,update.brand??null]);if(update.tags!==undefined)await replaceProductLabels(client,current.id,update.tags);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'product.update','product',$3,$4)",[principal.kind,principal.id,current.id,JSON.stringify({source:"sku_bulk_update",sku:current.sku,fields})]);products.push(await productById(client,current.id));}
    return products;
  });return{updated:result.length,products:result};}catch(error){const status=(error as {statusCode?:number}).statusCode;if(status)return reply.code(status).send({error:(error as Error).message,missingSkus:(error as {missingSkus?:string[]}).missingSkus});throw error;}
});

app.patch("/api/v1/products/:id",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=productUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
  if(parsed.data.currency&&!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  try{const result=await transaction(async client=>{const found=await client.query("SELECT id FROM products WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",[id]);if(!found.rowCount)return undefined;const galleryMediaIds=parsed.data.galleryMediaIds??[],mediaIds=[...(parsed.data.variants??[]).flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]),...galleryMediaIds];if(parsed.data.imageMediaId)mediaIds.push(parsed.data.imageMediaId);if(mediaIds.length){const image=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND account_id IS NULL AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds]);if(image.rowCount!==new Set(mediaIds).size)return null;}if(parsed.data.shippingClassId&&!await shippingClassExists(client,parsed.data.shippingClassId,true))throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});const hasGallery=Object.prototype.hasOwnProperty.call(parsed.data,"galleryMediaIds"),hasImage=hasGallery||Object.prototype.hasOwnProperty.call(parsed.data,"imageMediaId"),coverImageId=hasGallery?(galleryMediaIds[0]??null):parsed.data.imageMediaId??null,hasWeight=Object.prototype.hasOwnProperty.call(parsed.data,"weightAmount")||Object.prototype.hasOwnProperty.call(parsed.data,"weightUnit"),hasShippingClass=Object.prototype.hasOwnProperty.call(parsed.data,"shippingClassId"),hasSupplierLinks=Object.prototype.hasOwnProperty.call(parsed.data,"supplierLinks"),hasInternalNote=Object.prototype.hasOwnProperty.call(parsed.data,"internalNote"),firstPrice=parsed.data.priceTiers?.[0].unitAmount;await client.query("UPDATE products SET sku=CASE WHEN $2 THEN $3 ELSE sku END,name=CASE WHEN $4 THEN $5 ELSE name END,description=CASE WHEN $6 THEN $7 ELSE description END,default_unit_amount=CASE WHEN $8 THEN $9 ELSE default_unit_amount END,currency=CASE WHEN $10 THEN $11 ELSE currency END,image_media_id=CASE WHEN $12 THEN $13 ELSE image_media_id END,weight_amount=CASE WHEN $14 THEN $15 ELSE weight_amount END,weight_unit=CASE WHEN $14 THEN $16 ELSE weight_unit END,category=CASE WHEN $17 THEN $18 ELSE category END,brand=CASE WHEN $19 THEN $20 ELSE brand END,shipping_class_id=CASE WHEN $21 THEN $22 ELSE shipping_class_id END,supplier_links=CASE WHEN $23 THEN $24::jsonb ELSE supplier_links END,internal_note=CASE WHEN $25 THEN $26 ELSE internal_note END,updated_at=now() WHERE id=$1",[id,parsed.data.sku!==undefined,parsed.data.sku??null,parsed.data.name!==undefined,parsed.data.name??null,parsed.data.description!==undefined,parsed.data.description??null,firstPrice!==undefined,firstPrice??null,parsed.data.currency!==undefined,parsed.data.currency??null,hasImage,coverImageId,hasWeight,parsed.data.weightAmount??null,parsed.data.weightUnit??null,parsed.data.category!==undefined,parsed.data.category??null,parsed.data.brand!==undefined,parsed.data.brand??null,hasShippingClass,parsed.data.shippingClassId??null,hasSupplierLinks,JSON.stringify(parsed.data.supplierLinks??[]),hasInternalNote,parsed.data.internalNote??null]);if(hasGallery)await replaceProductGallery(client,id,galleryMediaIds);if(parsed.data.tags)await replaceProductLabels(client,id,parsed.data.tags);if(parsed.data.priceTiers)await replaceProductPriceTiers(client,id,parsed.data.priceTiers);if(parsed.data.variants!==undefined)await replaceProductVariants(client,id,parsed.data.variants);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.update','product',$2,$3)",[principal.id,id,JSON.stringify({fields:Object.keys(parsed.data),variantCount:parsed.data.variants?.length??0,galleryImageCount:hasGallery?galleryMediaIds.length:undefined})]);return await productById(client,id);});if(result===undefined)return reply.code(404).send({error:"not_found"});if(result===null)return reply.code(400).send({error:"invalid_product_image"});return result;}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
});

app.patch("/api/v1/products/bulk-edit",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=productBulkEditSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",issues:parsed.error.issues});
  const {productIds,operation}=parsed.data;
  try{const products=await transaction(async client=>{const found=await client.query("SELECT id,name,sku FROM products WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL FOR UPDATE",[productIds]);if(found.rowCount!==productIds.length)throw Object.assign(new Error("product_unavailable"),{statusCode:409});
    if(operation.field==="price"){
      const factor=operation.mode==="percentIncrease"?1+operation.value/100:operation.mode==="percentDecrease"?1-operation.value/100:null;
      const tiers=await client.query("SELECT product_id,unit_amount FROM product_price_tiers WHERE product_id=ANY($1::uuid[]) FOR UPDATE",[productIds]);
      if(tiers.rows.some(row=>{const current=Number(row.unit_amount),next=operation.mode==="set"?operation.value:operation.mode==="increase"?current+operation.value:operation.mode==="decrease"?current-operation.value:current*(factor??1);return next<0||next>99_999_999.99;}))throw Object.assign(new Error("invalid_resulting_price"),{statusCode:400});
      await client.query(`UPDATE product_price_tiers SET unit_amount=round((CASE $2 WHEN 'set' THEN $3 WHEN 'increase' THEN unit_amount+$3 WHEN 'decrease' THEN unit_amount-$3 WHEN 'percentIncrease' THEN unit_amount*(1+$3/100) ELSE unit_amount*(1-$3/100) END)::numeric,2),cost_amount=NULL,profit_margin=NULL WHERE product_id=ANY($1::uuid[])`,[productIds,operation.mode,operation.value]);
      await client.query("UPDATE products p SET default_unit_amount=t.unit_amount,updated_at=now() FROM product_price_tiers t WHERE p.id=ANY($1::uuid[]) AND t.product_id=p.id AND t.min_quantity=1",[productIds]);
    }else if(operation.field==="tags"){
      if(operation.mode==="set")await client.query("DELETE FROM product_labels WHERE product_id=ANY($1::uuid[])",[productIds]);
      if(operation.mode==="remove")await client.query("DELETE FROM product_labels WHERE product_id=ANY($1::uuid[]) AND lower(name)=ANY($2::text[])",[productIds,operation.tags.map(tag=>tag.name.toLocaleLowerCase())]);
      else for(const productId of productIds)for(const tag of uniqueProductLabels(operation.tags))await client.query("INSERT INTO product_labels(product_id,name,color) VALUES($1,$2,$3) ON CONFLICT(product_id,lower(name)) DO UPDATE SET color=EXCLUDED.color",[productId,tag.name,tag.color]);
      await client.query("UPDATE products SET updated_at=now() WHERE id=ANY($1::uuid[])",[productIds]);
    }else if(operation.field==="category"){
      await client.query("UPDATE products SET category=$2,updated_at=now() WHERE id=ANY($1::uuid[])",[productIds,operation.value]);
    }else if(operation.field==="shippingClass"){
      if(operation.shippingClassId&&!await shippingClassExists(client,operation.shippingClassId,true))throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});
      await client.query("UPDATE products SET shipping_class_id=$2,updated_at=now() WHERE id=ANY($1::uuid[])",[productIds,operation.shippingClassId]);
    }else{
      const column=operation.field==="sku"?"sku":"name",maxLength=operation.field==="sku"?80:120,invalidResult=operation.field==="sku"?"invalid_resulting_sku":"invalid_resulting_title";
      const updates=found.rows.map(row=>{const current=String(row[column]);let next:string;if(operation.mode==="set")next=operation.value;else if(operation.mode==="prefix")next=operation.value+current;else if(operation.mode==="suffix")next=current+operation.value;else if("search" in operation)next=current.replaceAll(operation.search,operation.value);else throw new Error("invalid_text_operation");if(!next.trim()||next.length>maxLength)throw Object.assign(new Error(invalidResult),{statusCode:400});return{id:String(row.id),next};});
      if(operation.field==="sku"){
        const normalized=updates.map(item=>item.next.trim().toLocaleLowerCase());
        if(new Set(normalized).size!==normalized.length)throw Object.assign(new Error("sku_exists"),{statusCode:409});
        const conflicting=await client.query("SELECT id FROM products WHERE deleted_at IS NULL AND NOT(id=ANY($1::uuid[])) AND lower(btrim(sku))=ANY($2::text[]) LIMIT 1",[productIds,normalized]);
        if(conflicting.rowCount)throw Object.assign(new Error("sku_exists"),{statusCode:409});
        const temporaryPrefix=`__bulk_sku_${randomBytes(16).toString("hex")}_`;
        for(const [index,item] of updates.entries())await client.query("UPDATE products SET sku=$2 WHERE id=$1",[item.id,`${temporaryPrefix}${index}`]);
        for(const item of updates)await client.query("UPDATE products SET sku=$2,updated_at=now() WHERE id=$1",[item.id,item.next]);
      }else for(const item of updates)await client.query("UPDATE products SET name=$2,updated_at=now() WHERE id=$1",[item.id,item.next]);
    }
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.bulk_update','product',NULL,$2)",[principal.id,JSON.stringify({productIds,operation})]);return Promise.all(productIds.map(id=>productById(client,id)));});return{updated:products.length,products};
  }catch(error){const status=(error as {statusCode?:number}).statusCode;if(status)return reply.code(status).send({error:(error as Error).message});if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"sku_exists"});throw error;}
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

app.post("/api/v1/conversations/:id/materials/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const principal=request.principal,{id}=request.params as {id:string},parsed=materialSendSchema.safeParse(request.body);
  if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const input=parsed.data,contextResult=await pool.query("SELECT c.account_id,a.agent_id,co.provider_user_id FROM conversations c JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 AND c.account_id=$2",[id,input.accountId]);
  if(!contextResult.rowCount||!canAccessAccount(principal,input.accountId))return reply.code(404).send({error:"conversation_not_found"});
  const context=contextResult.rows[0],clientMessageIds=input.mode==="stitched"?[`${input.clientBatchId}:material:stitched`]:input.mediaIds.map((_,index)=>`${input.clientBatchId}:material:p:${index}`);
  const existing=await pool.query("SELECT id,client_message_id FROM messages WHERE account_id=$1 AND client_message_id=ANY($2::text[]) ORDER BY occurred_at,id",[input.accountId,clientMessageIds]);
  if(existing.rowCount){if(existing.rowCount!==clientMessageIds.length)return reply.code(409).send({error:"material_send_batch_conflict"});return reply.code(200).send({deduplicated:true,messageIds:existing.rows.map(row=>String(row.id))});}
  const selected=await pool.query("SELECT a.batch_id,a.media_id,a.page_index,m.object_key,m.file_name,m.mime_type,m.byte_size FROM material_assets a JOIN media m ON m.id=a.media_id WHERE a.batch_id=ANY($1::uuid[]) AND a.media_id=ANY($2::uuid[]) AND m.status='ready' AND m.mime_type IN ('image/png','image/jpeg','image/webp') ORDER BY array_position($1::uuid[],a.batch_id),a.page_index",[input.materialBatchIds,input.mediaIds]);
  const selectedBatchIds=[...new Set(selected.rows.map(row=>String(row.batch_id)))];
  if(selected.rowCount!==input.mediaIds.length||selectedBatchIds.length!==input.materialBatchIds.length)return reply.code(400).send({error:"invalid_material_selection",message:"所选图片必须来自指定的素材库"});

  let uploaded:{objectKey:string;bytes:Buffer;fileName:string;mimeType:"image/png"|"image/jpeg";sha256:string}|null=null,committed=false;
  try{
    if(input.mode==="stitched"){
      const images=await Promise.all(selected.rows.map(async row=>{const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));if(!object.Body)throw Object.assign(new Error("material_image_unavailable"),{statusCode:409});return Buffer.from(await object.Body.transformToByteArray());}));
      let stitched;try{stitched=await stitchMaterialImages(images,input.orientation);}catch(error){if((error as Error).message==="material_stitch_too_large")return reply.code(413).send({error:"material_stitch_too_large",message:"拼接图片过大，请减少选择数量"});throw error;}
      const sha256=createHash("sha256").update(stitched.bytes).digest("hex"),fileName=`material-${input.clientBatchId}.${stitched.extension}`,objectKey=`material-sends/${input.accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}.${stitched.extension}`;
      await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:stitched.bytes,ContentType:stitched.mimeType,Metadata:{sha256,source:"material-stitch",orientation:input.orientation}}));
      uploaded={objectKey,bytes:stitched.bytes,fileName,mimeType:stitched.mimeType,sha256};
    }
    const result=await transaction(async client=>{
      const duplicate=await client.query("SELECT id FROM messages WHERE account_id=$1 AND client_message_id=ANY($2::text[])",[input.accountId,clientMessageIds]);if(duplicate.rowCount)throw Object.assign(new Error("material_send_batch_conflict"),{statusCode:409});
      let stitchedMediaId:string|null=null;
      if(uploaded){const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[input.accountId,uploaded.objectKey,uploaded.fileName,uploaded.mimeType,uploaded.bytes.length,uploaded.sha256]);stitchedMediaId=String(media.rows[0].id);}
      const messageIds:string[]=[];
      const outgoing=input.mode==="stitched"?[{mediaId:stitchedMediaId!,fileName:uploaded!.fileName}]:selected.rows.map(row=>({mediaId:String(row.media_id),fileName:String(row.file_name)}));
      const baseTime=Date.now();
      for(const [index,item] of outgoing.entries()){
        const clientMessageId=clientMessageIds[index],caption=index===0?(input.caption?.trim()||null):null,translationSourceText=index===0?(input.translationSourceText?.trim()||null):null,occurredAt=new Date(baseTime+index).toISOString();
        const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,translation_source_text,translation_target_language,media_id,status,occurred_at) VALUES($1,$2,$3,$4,'out','image',$5,$6,$7,$8,'queued',$9) RETURNING id",[id,input.accountId,principal.id,clientMessageId,caption,translationSourceText,index===0?(input.translationTargetLanguage??null):null,item.mediaId,occurredAt]);
        await queueChannelCommand(client,{accountId:input.accountId,conversationId:id,messageId:message.rows[0].id,payload:{accountId:input.accountId,conversationId:id,clientMessageId,type:"image",...(caption?{text:caption}:{}),mediaId:item.mediaId,messageId:message.rows[0].id,toJid:context.provider_user_id}});
        messageIds.push(String(message.rows[0].id));
      }
      await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[id]);
      await pauseAgentForHuman(client,id);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'material.send','conversation',$2,$3)",[principal.id,id,JSON.stringify({clientBatchId:input.clientBatchId,materialBatchIds:input.materialBatchIds,mediaIds:selected.rows.map(row=>String(row.media_id)),mode:input.mode,orientation:input.orientation,captioned:Boolean(input.caption?.trim()),translatedCaption:Boolean(input.translationSourceText),messageIds})]);
      return{deduplicated:false,messageIds};
    });
    committed=true;if(context.agent_id)void dispatchPending(context.agent_id);return reply.code(202).send(result);
  }finally{if(uploaded&&!committed)await s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:uploaded.objectKey})).catch(()=>undefined);}
});

app.get("/api/v1/conversations/:id/materials/batches/:batchId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {id,batchId}=request.params as {id:string;batchId:string},parsed=materialSendBatchStatusSchema.safeParse({batchId,accountId:(request.query as {accountId?:string}).accountId});
  if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
  const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1 AND account_id=$2",[id,parsed.data.accountId]);
  if(!access.rowCount||!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(404).send({error:"conversation_not_found"});
  const messages=await pool.query("SELECT id,status,client_message_id FROM messages WHERE conversation_id=$1 AND account_id=$2 AND left(client_message_id,length($3)+10)=$3||':material:' ORDER BY occurred_at,id",[id,parsed.data.accountId,parsed.data.batchId]);
  if(!messages.rowCount)return reply.code(404).send({committed:false,status:"not_found",messageIds:[]});
  return{committed:true,status:messages.rows.every(row=>row.status==="sent")?"sent":messages.rows.some(row=>row.status==="failed")?"failed":"queued",messageIds:messages.rows.map(row=>String(row.id)),messages:messages.rows.map(row=>({id:String(row.id),status:String(row.status),clientMessageId:String(row.client_message_id)}))};
});

app.get("/api/v1/conversations/:id/details",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string};const conversation=await pool.query("SELECT account_id,customer_stage,contact_id FROM conversations WHERE id=$1",[id]);
  if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const userId=request.principal?.kind==="user"?request.principal.id:null;
  const [tags,notes,reminder,orders,addresses,contact]=await Promise.all([
    pool.query("SELECT t.id,t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[id]),
    pool.query("SELECT n.id,n.body,n.user_id,n.created_at,n.updated_at,u.display_name author_name FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.conversation_id=$1 ORDER BY n.created_at DESC LIMIT 50",[id]),
    userId?pool.query("SELECT id,remind_at,created_at,updated_at FROM reminders WHERE conversation_id=$1 AND user_id=$2 AND dismissed_at IS NULL",[id,userId]):Promise.resolve({rows:[]}),
    pool.query("SELECT o.id,o.display_order_number,o.order_number,o.amount,o.currency,o.weight_unit,o.description,o.internal_comment,o.status,o.send_format,o.translate_on_send,o.target_language,o.address_id,o.shipping_address_snapshot,o.payment_profile_id,o.payment_profile_snapshot,o.shipping_amount,o.shipping_template_id,o.shipping_quote_snapshot,o.tracking_carrier,o.tracking_number,o.tracking_url,o.paypal_tracking_synced_at,o.created_at,u.display_name created_by_name,COALESCE(m.status::text,o.status) message_status,COALESCE(item_list.items,'[]'::json) items,COALESCE(fee_list.fees,'[]'::json) fees,payment.payment_request FROM orders o LEFT JOIN users u ON u.id=o.created_by LEFT JOIN messages m ON m.id=o.summary_message_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',i.id,'name',i.product_name,'sku',i.product_sku,'quantity',i.quantity,'unitAmount',i.unit_amount,'weightAmount',i.weight_amount,'weightUnit',i.weight_unit,'shippingClassId',i.shipping_class_id,'shippingClassName',i.shipping_class_name,'imageMediaId',i.image_media_id,'imageName',media.file_name,'productId',i.product_id,'variantId',i.variant_id,'internalNote',i.internal_note_snapshot) ORDER BY i.position) items FROM order_items i LEFT JOIN media ON media.id=i.image_media_id WHERE i.order_id=o.id)item_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',f.id,'name',f.name,'amount',f.amount,'source',f.source) ORDER BY f.position) fees FROM order_fees f WHERE f.order_id=o.id)fee_list ON true LEFT JOIN LATERAL (SELECT json_build_object('id',pr.id,'invoiceId',pr.provider_request_id,'url',pr.payment_url,'status',pr.status,'amount',pr.amount,'currency',pr.currency,'environment',pr.environment,'createdAt',pr.created_at,'lastSyncedAt',pr.last_synced_at) payment_request FROM order_payment_requests pr WHERE pr.order_id=o.id AND pr.is_current ORDER BY pr.created_at DESC LIMIT 1)payment ON true WHERE o.conversation_id=$1 AND o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 20",[id]),
    pool.query("SELECT ca.id,ca.label,ca.recipient_name,ca.phone,ca.address,ca.country_code,ca.province,ca.city,COALESCE(ca.street_line_1,ca.address) street1,ca.street_line_2 street2,ca.postal_code,ca.is_default,ca.created_at,ca.updated_at FROM contact_addresses ca JOIN conversations c ON c.contact_id=ca.contact_id WHERE c.id=$1 ORDER BY ca.is_default DESC,ca.created_at,ca.id",[id]),
    contactProfileById(pool,conversation.rows[0].contact_id),
  ]);
  await attachInternalOrderItemCosts(orders.rows);
  const businessStatuses=await pool.query("SELECT id,business_status FROM orders WHERE conversation_id=$1 AND deleted_at IS NULL",[id]),businessStatusById=new Map(businessStatuses.rows.map(row=>[String(row.id),String(row.business_status)]));
  for(const order of orders.rows)order.business_status=businessStatusById.get(String(order.id))??"quotation";
  return{customerStage:conversation.rows[0].customer_stage,contact,tags:tags.rows,notes:notes.rows,reminder:reminder.rows[0]??null,orders:orders.rows,addresses:addresses.rows};
});

app.get("/api/v1/conversations/:id/addresses",{preHandler:authenticate},async(request,reply)=>{
  const {id}=request.params as {id:string};const conversation=await pool.query("SELECT c.account_id,c.contact_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(conversation.rows[0].entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});const result=await pool.query("SELECT id,label,recipient_name,phone,address,country_code,province,city,COALESCE(street_line_1,address) street1,street_line_2 street2,postal_code,is_default,created_at,updated_at FROM contact_addresses WHERE contact_id=$1 ORDER BY is_default DESC,created_at,id",[conversation.rows[0].contact_id]);return{data:result.rows};
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
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=reminderSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};const current=await pool.query("SELECT c.account_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);if(!current.rowCount||!canAccessAccount(request.principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(current.rows[0].entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});const saved=await pool.query("INSERT INTO reminders(conversation_id,user_id,remind_at) VALUES($1,$2,$3) ON CONFLICT(conversation_id,user_id) DO UPDATE SET remind_at=EXCLUDED.remind_at,dismissed_at=NULL,updated_at=now() RETURNING id,remind_at,created_at,updated_at",[id,request.principal.id,parsed.data.remindAt]);await auditCrm(request.principal.id,"reminder.set","conversation",id,{remindAt:parsed.data.remindAt.toISOString()});return saved.rows[0];
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
  const result=await pool.query(`SELECT o.id,o.display_order_number,o.order_number,o.conversation_id,c.account_id,a.display_name account_name,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) customer_name,co.phone_e164 customer_phone,o.amount,o.currency,o.weight_unit,o.description,o.internal_comment,o.status,o.business_status,o.send_format,o.translate_on_send,o.target_language,o.address_id,o.shipping_address_snapshot,o.payment_profile_id,o.payment_profile_snapshot,o.shipping_amount,o.shipping_template_id,o.shipping_quote_snapshot,o.tracking_carrier,o.tracking_number,o.tracking_url,o.paypal_tracking_synced_at,o.created_at,u.display_name created_by_name,COALESCE(m.status::text,o.status) message_status,COUNT(*) OVER()::int total_count,COALESCE(item_list.items,'[]'::json) items,COALESCE(fee_list.fees,'[]'::json) fees,payment.payment_request
    FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN users u ON u.id=o.created_by LEFT JOIN messages m ON m.id=o.summary_message_id
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',i.id,'name',i.product_name,'sku',i.product_sku,'quantity',i.quantity,'unitAmount',i.unit_amount,'weightAmount',i.weight_amount,'weightUnit',i.weight_unit,'shippingClassId',i.shipping_class_id,'shippingClassName',i.shipping_class_name,'imageMediaId',i.image_media_id,'imageName',media.file_name,'productId',i.product_id,'variantId',i.variant_id,'internalNote',i.internal_note_snapshot) ORDER BY i.position) items FROM order_items i LEFT JOIN media ON media.id=i.image_media_id WHERE i.order_id=o.id)item_list ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',f.id,'name',f.name,'amount',f.amount,'source',f.source) ORDER BY f.position) fees FROM order_fees f WHERE f.order_id=o.id)fee_list ON true
    LEFT JOIN LATERAL (SELECT json_build_object('id',pr.id,'invoiceId',pr.provider_request_id,'url',pr.payment_url,'status',pr.status,'amount',pr.amount,'currency',pr.currency,'environment',pr.environment,'createdAt',pr.created_at,'lastSyncedAt',pr.last_synced_at) payment_request FROM order_payment_requests pr WHERE pr.order_id=o.id AND pr.is_current ORDER BY pr.created_at DESC LIMIT 1)payment ON true
    WHERE o.deleted_at IS NULL AND ($1::uuid IS NULL OR c.account_id=$1) AND ($2::text IS NULL OR o.status=$2) AND ($3::text IS NULL OR o.display_order_number ILIKE '%'||$3||'%' OR co.alias ILIKE '%'||$3||'%' OR co.display_name ILIKE '%'||$3||'%' OR co.phone_e164 ILIKE '%'||$3||'%') AND ($4::date IS NULL OR o.created_at >= $4::date) AND ($5::date IS NULL OR o.created_at < $5::date + interval '1 day') AND ($6::timestamptz IS NULL OR (o.created_at,o.id)<($6::timestamptz,$7::uuid)) AND ($8::uuid[] IS NULL OR c.account_id=ANY($8))
    ORDER BY o.created_at DESC,o.id DESC LIMIT $9`,[query.accountId??null,query.status??null,query.q?.trim()||null,query.dateFrom??null,query.dateTo??null,cursorDate,cursorId,accountIds,limit+1]);
  await attachInternalOrderItemCosts(result.rows);
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
  const nextCodes=parsed.data.currencies.map(item=>item.code),inUse=await pool.query("SELECT currency,source FROM (SELECT DISTINCT currency,'product'::text source FROM products WHERE deleted_at IS NULL UNION ALL SELECT DISTINCT currency,'order'::text source FROM orders WHERE deleted_at IS NULL UNION ALL SELECT DISTINCT currency,'shipping_template'::text source FROM shipping_templates) used WHERE NOT(currency=ANY($1::text[])) LIMIT 1",[nextCodes]);
  if(inUse.rowCount)return reply.code(409).send({error:"currency_in_use",message:`${inUse.rows[0].currency} 仍被${inUse.rows[0].source==="product"?"产品":inUse.rows[0].source==="shipping_template"?"运费模板":"订单"}使用，无法删除`});
  await transaction(async client=>{await client.query("UPDATE currency_settings SET is_base=false");await client.query("DELETE FROM currency_settings WHERE NOT(code=ANY($1::text[]))",[nextCodes]);for(const [position,item] of parsed.data.currencies.entries())await client.query("INSERT INTO currency_settings(code,name,rate,is_base,position,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,rate=EXCLUDED.rate,is_base=EXCLUDED.is_base,position=EXCLUDED.position,updated_by=EXCLUDED.updated_by,updated_at=now()",[item.code,item.name,item.rate,item.code===parsed.data.baseCurrency,position,request.principal!.id]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'currency.settings.update','currency_settings','workspace',$2)",[request.principal!.id,JSON.stringify({baseCurrency:parsed.data.baseCurrency,currencies:parsed.data.currencies})]);});
  return{baseCurrency:parsed.data.baseCurrency,currencies:parsed.data.currencies};
});

app.post("/api/v1/admin/currencies/refresh-rates",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const parsed=currencySettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const nextCodes=parsed.data.currencies.map(item=>item.code),inUse=await pool.query("SELECT currency,source FROM (SELECT DISTINCT currency,'product'::text source FROM products WHERE deleted_at IS NULL UNION ALL SELECT DISTINCT currency,'order'::text source FROM orders WHERE deleted_at IS NULL UNION ALL SELECT DISTINCT currency,'shipping_template'::text source FROM shipping_templates) used WHERE NOT(currency=ANY($1::text[])) LIMIT 1",[nextCodes]);
  if(inUse.rowCount)return reply.code(409).send({error:"currency_in_use",message:`${inUse.rows[0].currency} 仍被${inUse.rows[0].source==="product"?"产品":inUse.rows[0].source==="shipping_template"?"运费模板":"订单"}使用，无法删除`});
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
  const context=await pool.query("SELECT o.id,o.display_order_number,o.amount,o.currency,o.description,o.shipping_amount,o.shipping_address_snapshot,o.payment_profile_id,o.payment_profile_snapshot,c.account_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) customer_name,co.phone_e164 customer_phone,COALESCE((SELECT timezone FROM order_settings WHERE singleton=true),'UTC') business_timezone FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN contacts co ON co.id=c.contact_id WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);if(!context.rowCount||!canAccessAccount(principal,context.rows[0].account_id))return reply.code(404).send({error:"not_found"});const order=context.rows[0],snapshot=order.payment_profile_snapshot as PaymentProfileSnapshot|null;
  if(snapshot&&snapshot.methodType!=="paypal")return reply.code(409).send({error:"paypal_profile_required",message:"该订单选择的不是 PayPal Profile"});
  const setting=order.payment_profile_id?await paypalProfileSetting(String(order.payment_profile_id)):await activePayPalSetting();if(!setting)return reply.code(409).send({error:"paypal_not_configured",message:"订单所选 PayPal Profile 未启用或当前环境凭据未配置"});
  const [items,fees]=await Promise.all([pool.query("SELECT item.product_name name,COALESCE(NULLIF(item.product_sku,''),NULLIF(product.sku,'')) sku,item.quantity,item.unit_amount FROM order_items item LEFT JOIN products product ON product.id=item.product_id WHERE item.order_id=$1 ORDER BY item.position",[orderId]),pool.query("SELECT name,amount FROM order_fees WHERE order_id=$1 ORDER BY position",[orderId])]),missingRequiredSku=/{{\s*sku\s*}}/.test(setting.itemNameTemplate)&&items.rows.some(item=>!String(item.sku??"").trim());
  if(regenerate&&missingRequiredSku)return reply.code(409).send({error:"payment_request_template_data_missing",message:"Items · Name 使用了 {{sku}}，但订单中有商品没有 SKU。请先编辑订单补充 SKU，再重新创建付款请求"});
  if(regenerate){try{const cancelled=await cancelCurrentPaymentRequest(orderId,principal.id);if(cancelled==="paid")return reply.code(409).send({error:"paid_order_locked",message:"已付款订单不能重新生成付款请求"});}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice cancellation failed before regeneration");return reply.code(502).send({error:"paypal_cancel_failed",message:"旧付款请求作废失败，未生成新链接，请稍后重试"});}}
  const record=await transaction(async client=>{await client.query("SELECT id FROM orders WHERE id=$1 FOR UPDATE",[orderId]);const current=await client.query("SELECT * FROM order_payment_requests WHERE order_id=$1 AND is_current FOR UPDATE",[orderId]);if(current.rowCount){const row=current.rows[0],sameProfile=String(row.payment_profile_id??"")===String(order.payment_profile_id??"");if(row.environment===setting.environment&&sameProfile&&row.status!=="CREATING")return{row,reused:true,create:false};if(row.environment===setting.environment&&sameProfile){const recent=Date.now()-new Date(row.created_at).getTime()<120_000;return{row,reused:true,create:!recent};}await client.query("UPDATE order_payment_requests SET is_current=false,updated_at=now() WHERE id=$1",[row.id]);}const inserted=await client.query("INSERT INTO order_payment_requests(order_id,environment,status,amount,currency,created_by,payment_profile_id,payment_profile_snapshot) VALUES($1,$2,'CREATING',$3,$4,$5,$6,$7::jsonb) RETURNING *",[orderId,setting.environment,order.amount,order.currency,principal.id,order.payment_profile_id??null,snapshot?JSON.stringify(snapshot):null]);return{row:inserted.rows[0],reused:false,create:true};});
  if(!record.create)return reply.code(record.row.status==="CREATING"?409:200).send(record.row.status==="CREATING"?{error:"payment_request_in_progress",message:"付款链接正在生成，请稍后重试"}:paymentRequestResponse(record.row));
  if(missingRequiredSku){await pool.query("UPDATE order_payment_requests SET status='FAILED',is_current=false,failure_reason='missing_order_item_sku',updated_at=now() WHERE id=$1",[record.row.id]);return reply.code(409).send({error:"payment_request_template_data_missing",message:"Items · Name 使用了 {{sku}}，但订单中有商品没有 SKU。请先编辑订单补充 SKU，再重新创建付款请求"});}
  try{const currency=String(order.currency),address=order.shipping_address_snapshot&&typeof order.shipping_address_snapshot==="object"?order.shipping_address_snapshot as Record<string,unknown>:{},total=Number(order.amount),globalContext:PayPalTemplateContext={orderNumber:String(order.display_order_number),currentDate:new Intl.DateTimeFormat("en-CA",{timeZone:String(order.business_timezone),year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),recipientName:String(address.recipientName??order.customer_name??""),address:String(address.address??""),phone:String(address.phone??order.customer_phone??""),orderNotes:String(order.description??""),orderTotal:`${currency} ${total.toFixed(2)}`,currency,customerName:String(order.customer_name??""),customerPhone:String(order.customer_phone??""),productNames:items.rows.map(item=>String(item.name)).join(", "),productQuantity:String(items.rows.reduce((sum,item)=>sum+Number(item.quantity),0))};const renderItem=(name:string,sku:string,quantity:number,unitAmount:number)=>({name:renderPayPalTemplate(setting.itemNameTemplate,{...globalContext,productName:name,sku,productQuantity:String(quantity),unitAmount:unitAmount.toFixed(2),lineTotal:(quantity*unitAmount).toFixed(2)}).slice(0,200)||name.slice(0,200),quantity,unitAmount});const invoiceItems=[...items.rows.map(item=>renderItem(String(item.name),String(item.sku??""),Number(item.quantity),Number(item.unit_amount))),...fees.rows.map(fee=>renderItem(String(fee.name),"",1,Number(fee.amount))),...(order.shipping_amount===null?[]:[renderItem("Shipping","",1,Number(order.shipping_amount))])];const client=new PayPalClient(setting),created=await client.createPayableInvoice({requestId:String(record.row.id),reference:renderPayPalTemplate(setting.referenceTemplate,globalContext).slice(0,120)||`Order #${order.display_order_number}`,currency,note:renderPayPalTemplate(setting.noteTemplate,globalContext).slice(0,4000)||undefined,items:invoiceItems});const saved=await pool.query("UPDATE order_payment_requests SET provider_request_id=$2,payment_url=$3,status=$4,last_synced_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[record.row.id,created.invoiceId,created.paymentUrl,created.status]);await auditCrm(principal.id,"payment_request.create","order",orderId,{paymentRequestId:record.row.id,paypalInvoiceId:created.invoiceId,environment:setting.environment,amount:Number(order.amount),currency:order.currency});return reply.code(201).send(paymentRequestResponse(saved.rows[0]));}
  catch(error){await pool.query("UPDATE order_payment_requests SET status='FAILED',is_current=false,failure_reason=$2,updated_at=now() WHERE id=$1",[record.row.id,error instanceof PayPalApiError?error.code:String(error)]);request.log.error({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice creation failed");return reply.code(502).send({error:"paypal_create_failed",message:paypalFailureMessage(error)});}
});

app.post("/api/v1/orders/:orderId/payment-request/refresh",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {orderId}=request.params as {orderId:string},context=await accessiblePaymentRequest(orderId,request.principal);if(!context)return reply.code(404).send({error:"not_found"});if(!context.request.provider_request_id)return reply.code(409).send({error:"payment_request_incomplete"});const setting=context.request.payment_profile_id?await paypalProfileSetting(context.request.payment_profile_id,context.request.environment,false):await activePayPalSetting(context.request.environment,false);if(!setting)return reply.code(409).send({error:"paypal_environment_not_configured",message:"当前 PayPal Profile 或环境已不可用"});
  try{const detail=await new PayPalClient(setting).getInvoice(context.request.provider_request_id),saved=await pool.query("UPDATE order_payment_requests SET status=$2,payment_url=COALESCE($3,payment_url),last_synced_at=now(),updated_at=now() WHERE id=$1 RETURNING *",[context.request.id,detail.status,detail.paymentUrl]);await auditCrm(request.principal.id,"payment_request.refresh","order",orderId,{paymentRequestId:context.request.id,status:detail.status});return paymentRequestResponse(saved.rows[0]);}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice refresh failed");return reply.code(502).send({error:"paypal_refresh_failed",message:paypalFailureMessage(error)});}
});

app.patch("/api/v1/orders/:orderId/tracking",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=orderTrackingSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const {orderId}=request.params as {orderId:string};
  try{
    await ensureOrderTrackingColumns();
    const access=await pool.query("SELECT c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);
    if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});
    const saved=await pool.query("UPDATE orders SET tracking_carrier=$2,tracking_number=$3,tracking_url=$4,paypal_tracking_synced_at=NULL,updated_at=now() WHERE id=$1 RETURNING tracking_carrier carrier,tracking_number trackingNumber,tracking_url trackingUrl,paypal_tracking_synced_at paypalTrackingSyncedAt",[orderId,parsed.data.carrier,parsed.data.trackingNumber,parsed.data.trackingUrl??null]);
    await auditCrm(request.principal.id,"order.tracking.update","order",orderId,{carrier:parsed.data.carrier,trackingNumber:parsed.data.trackingNumber});
    return saved.rows[0];
  }catch(error){request.log.error({orderId,trackingError:error instanceof Error?error.message:String(error)},"Order tracking update failed");return reply.code(503).send({error:"tracking_save_failed",message:trackingFailureMessage(error)});}
});

app.post("/api/v1/orders/:orderId/tracking/sync-paypal",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {orderId}=request.params as {orderId:string};
  let found;
  try{await ensureOrderTrackingColumns();found=await pool.query("SELECT o.id,o.tracking_carrier,o.tracking_number,o.payment_profile_snapshot,o.payment_profile_id,o.paypal_tracking_synced_at,c.account_id,pr.id payment_request_id,pr.provider_request_id,pr.environment,pr.payment_profile_id request_profile_id,pr.status FROM orders o JOIN conversations c ON c.id=o.conversation_id LEFT JOIN order_payment_requests pr ON pr.order_id=o.id AND pr.is_current WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);}catch(error){request.log.error({orderId,trackingError:error instanceof Error?error.message:String(error)},"Order tracking lookup failed");return reply.code(503).send({error:"tracking_schema_unavailable",message:trackingFailureMessage(error)});}
  if(!found.rowCount||!canAccessAccount(request.principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const row=found.rows[0],snapshot=row.payment_profile_snapshot as PaymentProfileSnapshot|null;
  if(!snapshot||snapshot.methodType!=="paypal")return reply.code(409).send({error:"paypal_profile_required",message:"只有 PayPal 付款方式的订单可以同步物流"});
  if(!row.tracking_carrier||!row.tracking_number)return reply.code(409).send({error:"tracking_required",message:"请先填写承运商和物流单号"});
  if(!row.provider_request_id)return reply.code(409).send({error:"payment_request_incomplete",message:"该订单没有可用的 PayPal 付款请求"});
  const setting=row.request_profile_id?await paypalProfileSetting(String(row.request_profile_id),String(row.environment),false):await activePayPalSetting(String(row.environment),false);if(!setting)return reply.code(409).send({error:"paypal_environment_not_configured",message:"当前 PayPal 环境未配置"});
  try{
    const client=new PayPalClient(setting),detail=await client.getInvoice(String(row.provider_request_id));
    if(!new Set(["PAID","MARKED_AS_PAID","PAID_EXTERNAL"]).has(detail.status.toUpperCase()))return reply.code(409).send({error:"paypal_payment_not_paid",message:`PayPal 当前状态为 ${detail.status}，只有已付款订单可以同步物流`});
    if(!detail.transactionId)return reply.code(409).send({error:"paypal_transaction_missing",message:"PayPal 未返回已付款交易号，暂时无法同步物流"});
    await client.addTracking({transactionId:detail.transactionId,carrier:String(row.tracking_carrier),trackingNumber:String(row.tracking_number)});
    const saved=await pool.query("UPDATE orders SET paypal_tracking_synced_at=now(),updated_at=now() WHERE id=$1 RETURNING paypal_tracking_synced_at",[orderId]);
    await auditCrm(request.principal.id,"order.tracking.sync_paypal","order",orderId,{transactionId:detail.transactionId,carrier:row.tracking_carrier,trackingNumber:row.tracking_number});
    return {syncedAt:saved.rows[0].paypal_tracking_synced_at,transactionId:detail.transactionId};
  }catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal tracking sync failed");return reply.code(502).send({error:"paypal_tracking_sync_failed",message:paypalFailureMessage(error)});}
});

app.post("/api/v1/orders/:orderId/payment-request/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=paymentSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {orderId}=request.params as {orderId:string},found=await pool.query("SELECT o.display_order_number,o.client_order_id,c.id conversation_id,c.account_id,a.agent_id,co.provider_user_id,pr.id payment_request_id,pr.payment_url,pr.status,pr.amount,pr.currency FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id JOIN order_payment_requests pr ON pr.order_id=o.id AND pr.is_current WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const row=found.rows[0];if(!row.payment_url)return reply.code(409).send({error:"payment_url_unavailable"});const clientMessageId=`${row.client_order_id}:paypal:${row.payment_request_id}:${parsed.data.clientSendId}`,text=`Payment request for Order #${row.display_order_number}\n${row.currency} ${Number(row.amount).toFixed(2)}\n${row.payment_url}`;
  const queued=await transaction(async client=>{const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[row.account_id,clientMessageId]);if(existing.rowCount)return{messageId:existing.rows[0].id,status:existing.rows[0].status,deduplicated:true};const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id,status",[row.conversation_id,row.account_id,principal.id,clientMessageId,text]);await queueOrderCommand(client,row,row.conversation_id,message.rows[0].id,clientMessageId,"text",text);await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[row.conversation_id]);await pauseAgentForHuman(client,row.conversation_id);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'payment_request.send','order',$2,$3)",[principal.id,orderId,JSON.stringify({paymentRequestId:row.payment_request_id,messageId:message.rows[0].id})]);return{messageId:message.rows[0].id,status:message.rows[0].status,deduplicated:false};});if(row.agent_id)void dispatchPending(row.agent_id);return reply.code(202).send(queued);
});

app.post("/api/v1/orders/:orderId/payment-send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=paymentSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const {orderId}=request.params as {orderId:string},found=await pool.query("SELECT o.display_order_number,o.client_order_id,o.amount,o.currency,o.payment_profile_snapshot,c.id conversation_id,c.account_id,a.agent_id,co.provider_user_id,pr.id payment_request_id,pr.payment_url FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN order_payment_requests pr ON pr.order_id=o.id AND pr.is_current WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);
  if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const row=found.rows[0],snapshot=row.payment_profile_snapshot as PaymentProfileSnapshot|null;if(!snapshot)return reply.code(409).send({error:"payment_profile_missing",message:"该订单尚未选择付款方式"});
  let detail=snapshot.instructions.replace(/{{\s*orderNumber\s*}}/g,String(row.display_order_number)).replace(/{{\s*amount\s*}}/g,Number(row.amount).toFixed(2)).replace(/{{\s*currency\s*}}/g,String(row.currency));
  if(snapshot.methodType==="paypal"){if(!row.payment_url)return reply.code(409).send({error:"payment_url_unavailable",message:"请先创建 PayPal 付款链接"});detail=String(row.payment_url);}
  const fieldLines=snapshot.publicFields.map(field=>`${field.label}: ${field.value}`),text=[`Payment instructions for Order #${row.display_order_number}`,`${row.currency} ${Number(row.amount).toFixed(2)}`,snapshot.summary,...fieldLines,detail].filter(Boolean).join("\n"),clientMessageId=`${row.client_order_id}:payment:${parsed.data.clientSendId}`;
  const queued=await transaction(async client=>{const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[row.account_id,clientMessageId]);if(existing.rowCount)return{messageId:existing.rows[0].id,status:existing.rows[0].status,deduplicated:true};const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) RETURNING id,status",[row.conversation_id,row.account_id,principal.id,clientMessageId,text]);await queueOrderCommand(client,row,row.conversation_id,message.rows[0].id,clientMessageId,"text",text);await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[row.conversation_id]);await pauseAgentForHuman(client,row.conversation_id);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'payment.send','order',$2,$3)",[principal.id,orderId,JSON.stringify({paymentProfileId:snapshot.profileId,paymentRequestId:row.payment_request_id??null,messageId:message.rows[0].id})]);return{messageId:message.rows[0].id,status:message.rows[0].status,deduplicated:false};});if(row.agent_id)void dispatchPending(row.agent_id);return reply.code(202).send(queued);
});

app.get("/api/v1/admin/order-templates",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT text_template,image_template,pdf_template,qt_template,sc_template,pi_template,ci_template,updated_at FROM order_settings WHERE singleton=true"),row=result.rows[0]??{};
  if(row.text_template&&!orderTemplateSchema.safeParse(row.text_template).success)request.log.error("Invalid stored text order template; using default");
  if(row.image_template&&!orderTemplateSchema.safeParse(row.image_template).success)request.log.error("Invalid stored image order template; using default");
  if(row.pdf_template&&!orderTemplateSchema.safeParse(row.pdf_template).success)request.log.error("Invalid stored PDF order template; using default");
  return{textTemplate:parseOrderTemplate(row.text_template??DEFAULT_TEXT_ORDER_TEMPLATE,"text"),imageTemplate:parseOrderTemplate(row.image_template??DEFAULT_IMAGE_ORDER_TEMPLATE,"image"),pdfTemplate:parseOrderTemplate(row.pdf_template??DEFAULT_PDF_ORDER_TEMPLATE,"pdf"),qtTemplate:parseOrderTemplate(row.qt_template??DEFAULT_QT_ORDER_TEMPLATE,"qt"),scTemplate:parseOrderTemplate(row.sc_template??DEFAULT_SC_ORDER_TEMPLATE,"sc"),piTemplate:parseOrderTemplate(row.pi_template??DEFAULT_PI_ORDER_TEMPLATE,"pi"),ciTemplate:parseOrderTemplate(row.ci_template??DEFAULT_CI_ORDER_TEMPLATE,"ci"),updatedAt:row.updated_at??null};
});

app.put("/api/v1/admin/order-templates/:format",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const {format}=request.params as {format:string};if(!["text","image","pdf","qt","sc","pi","ci"].includes(format))return reply.code(404).send({error:"not_found"});
  const parsed=orderTemplateUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const column=({text:"text_template",image:"image_template",pdf:"pdf_template",qt:"qt_template",sc:"sc_template",pi:"pi_template",ci:"ci_template"} as Record<string,string>)[format],saved=await pool.query(`UPDATE order_settings SET ${column}=$1::jsonb,updated_by=$2,updated_at=now() WHERE singleton=true RETURNING updated_at`,[JSON.stringify(parsed.data),request.principal.id]);
  await auditCrm(request.principal.id,"order.template.update","order_settings","workspace",{format,blockCount:parsed.data.blocks.length});
  return{format,template:parsed.data,updatedAt:saved.rows[0]?.updated_at??null};
});

app.get("/api/v1/admin/product-card-template",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const result=await pool.query("SELECT template,updated_at FROM product_card_settings WHERE singleton=true"),row=result.rows[0];
  return{template:parseProductCardTemplate(row?.template??DEFAULT_PRODUCT_CARD_TEMPLATE),updatedAt:row?.updated_at??null};
});

app.get("/api/v1/product-card-template",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const result=await pool.query("SELECT template FROM product_card_settings WHERE singleton=true");
  return{template:parseProductCardTemplate(result.rows[0]?.template??DEFAULT_PRODUCT_CARD_TEMPLATE)};
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
  const contextResult=await pool.query("SELECT c.account_id,c.contact_id,co.entity_type,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) customer_name,co.phone_e164 customer_phone,co.first_name contact_first_name,co.last_name contact_last_name,co.company_name contact_company_name,co.country contact_country,co.province contact_province,co.city contact_city,(SELECT email FROM contact_emails WHERE contact_id=co.id AND is_primary LIMIT 1) contact_email FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[conversationId]);if(!contextResult.rowCount||!canAccessAccount(principal,contextResult.rows[0].account_id))return reply.code(404).send({error:"not_found"});const context=contextResult.rows[0];if(context.entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});
  const [recipientResult,providerResult]=await Promise.all([pool.query("SELECT id,label,email,is_primary FROM contact_emails WHERE contact_id=$1 AND id=ANY($2::uuid[]) ORDER BY position,id",[context.contact_id,parsed.data.recipientEmailIds]),pool.query("SELECT provider,config,secret_encrypted FROM email_provider_settings WHERE enabled AND secret_encrypted IS NOT NULL LIMIT 1")]);
  if(recipientResult.rowCount!==parsed.data.recipientEmailIds.length)return reply.code(400).send({error:"invalid_recipient_email"});if(!providerResult.rowCount)return reply.code(409).send({error:"email_provider_not_configured",message:"管理员尚未启用邮件 Provider"});
  const recipients=recipientResult.rows.map(row=>({id:String(row.id),label:String(row.label??""),email:String(row.email),isPrimary:Boolean(row.is_primary)})),provider=providerResult.rows[0];let textContent="",contentHtml="",contentType:"order_text"|"order_image"|"order_pdf"|"product_cards",orderId:string|null=null,productIds:string[]|null=null;const attachments:Array<{mediaId:string;fileName:string;contentId:string;byteSize:number;mimeType:string}>=[];
  if(parsed.data.content.type==="order"){
    orderId=parsed.data.content.orderId;const orderResult=await pool.query("SELECT o.id,o.display_order_number,o.business_status,o.currency,o.description,o.shipping_address_snapshot,o.payment_profile_snapshot FROM orders o WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!orderResult.rowCount)return reply.code(404).send({error:"order_not_found"});const order=orderResult.rows[0];
    const [itemResult,feeResult,templateResult]=await Promise.all([pool.query("SELECT i.product_name name,i.product_sku sku,i.quantity,i.unit_amount,m.object_key FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id WHERE i.order_id=$1 ORDER BY i.position",[orderId]),pool.query("SELECT name,amount FROM (SELECT name,amount,position FROM order_fees WHERE order_id=$1 UNION ALL SELECT 'Shipping',shipping_amount,32767 FROM orders WHERE id=$1 AND shipping_amount IS NOT NULL) listed ORDER BY position",[orderId]),pool.query("SELECT text_template,image_template,pdf_template FROM order_settings WHERE singleton=true")]);const items:OrderSummaryItem[]=itemResult.rows.map(item=>({name:String(item.name),sku:String(item.sku??""),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)})),fees:OrderSummaryFee[]=feeResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)})),format=parsed.data.content.format,template=parseOrderTemplate(templateResult.rows[0]?.[format==="text"?"text_template":format==="pdf"?"pdf_template":"image_template"],format),templateContext={orderNumber:String(order.display_order_number),businessStatus:order.business_status,currency:String(order.currency),customerName:String(context.customer_name??""),customerPhone:String(context.customer_phone??""),description:String(order.description??""),items,fees,address:order.shipping_address_snapshot??null,paymentProfile:order.payment_profile_snapshot??null,contact:{firstName:context.contact_first_name,lastName:context.contact_last_name,companyName:context.contact_company_name,country:context.contact_country,province:context.contact_province,city:context.contact_city,email:context.contact_email}};let blocks=renderSemanticOrder(template,templateContext);
    if(parsed.data.content.translate){const setting=await activeTranslationSetting();if(!setting)return reply.code(409).send({error:"translation_not_configured"});try{blocks=parseTranslatedSemanticOrder(await translateText(setting,{text:serializeSemanticOrder(blocks),targetLanguage:parsed.data.content.targetLanguage!}),blocks);}catch(error){request.log.warn({orderId,error:String(error)},"Email order translation failed");return reply.code(502).send({error:"translation_failed"});}}
    textContent=blocks.map(block=>block.lines.join("\n")).join("\n\n");contentHtml=`<div style="margin-top:20px;border-top:1px solid #dce7e1;padding-top:16px">${blocks.map(block=>`<div style="padding:10px 0">${block.lines.map(line=>`<div>${escapeHtml(line)}</div>`).join("")}</div>`).join("")}</div>`;contentType=format==="text"?"order_text":format==="pdf"?"order_pdf":"order_image";
    if(format==="image"||format==="pdf"){const products=await Promise.all(itemResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));return object.Body?{name:String(item.name),image:Buffer.from(await object.Body.transformToByteArray())}:{name:String(item.name)};}));if(format==="image"){const png=await renderTemplateOrderImage(template,blocks,products),fileName=`order-${safeFileName(String(order.display_order_number))}.png`,stored=await storeEmailAttachment(context.account_id,fileName,png,"image/png","order");attachments.push({...stored,fileName,contentId:"order-image",mimeType:"image/png"});contentHtml=`<div style="margin-top:20px"><img alt="Order #${escapeHtml(String(order.display_order_number))}" src="cid:order-image" style="display:block;max-width:100%;height:auto"></div>`;}else{const pdf=await renderTemplateOrderPdf(template,blocks,products),fileName=`order-${safeFileName(String(order.display_order_number))}.pdf`,stored=await storeEmailAttachment(context.account_id,fileName,pdf,"application/pdf","order");attachments.push({...stored,fileName,contentId:"order-pdf",mimeType:"application/pdf"});contentHtml=`<p style="margin-top:20px">Order #${escapeHtml(String(order.display_order_number))} is attached as a PDF.</p>`;}}
  }else{
    const productContent=parsed.data.content,selectedProductIds=productContent.productIds;productIds=selectedProductIds;const productResult=await pool.query(`SELECT p.id,p.name,p.sku,p.currency,m.object_key,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(variant_list.variants,'[]'::json) variants FROM products p LEFT JOIN media m ON m.id=p.image_media_id AND m.status='ready' LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) price_tiers FROM product_price_tiers t WHERE t.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('attributes',v.attributes,'sku',v.sku,'objectKey',vm.object_key,'priceTiers',COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json)) ORDER BY v.created_at,v.id) variants FROM product_variants v LEFT JOIN media vm ON vm.id=v.image_media_id AND vm.status='ready' WHERE v.product_id=p.id) variant_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('name',l.name) ORDER BY lower(l.name)) tags FROM product_labels l WHERE l.product_id=p.id) label_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[selectedProductIds]);if(productResult.rowCount!==selectedProductIds.length)return reply.code(409).send({error:"product_unavailable"});
    const products:ProductCardRenderProduct[]=await Promise.all(productResult.rows.map(async row=>{const image=await loadProductCardImage(row.object_key),variants=await Promise.all((Array.isArray(row.variants)?row.variants:[]).map(async(variant:Record<string,unknown>)=>({attributes:variant.attributes&&typeof variant.attributes==="object"?variant.attributes as Record<string,string>:{},sku:String(variant.sku),priceTiers:Array.isArray(variant.priceTiers)?(variant.priceTiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[],image:await loadProductCardImage(variant.objectKey)})));return{name:String(row.name),sku:String(row.sku),currency:String(row.currency),priceTiers:Array.isArray(row.price_tiers)?row.price_tiers.map((tier:Record<string,unknown>)=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[],variants,tags:Array.isArray(row.tags)?row.tags.map((tag:Record<string,unknown>)=>({name:String(tag.name)})):[],image};}));const targetCurrency=String((request.body as Record<string,unknown>)?.targetCurrency??"USD").toUpperCase(),normalizedProducts=await convertProductCardPrices(products,targetCurrency),templateResult=await pool.query("SELECT template FROM product_card_settings WHERE singleton=true"),template=parseProductCardTemplate(templateResult.rows[0]?.template??DEFAULT_PRODUCT_CARD_TEMPLATE),pdfOutput=productContent.mode==="grid"&&productContent.gridOutputFormat==="pdf",pngs=pdfOutput?[]:productContent.mode==="combined"?[await renderProductCards(template,normalizedProducts,productContent.showPrice)]:productContent.mode==="grid"?await renderProductCardGridPages(template,normalizedProducts,productContent.showPrice,productContent.grid!.rows,productContent.grid!.columns):await Promise.all(normalizedProducts.map(product=>renderProductCards(template,[product],productContent.showPrice)));
    if(pngs.reduce((sum,png)=>sum+png.length,0)>15*1024*1024)return reply.code(413).send({error:"email_attachments_too_large",message:"邮件图片超过 15 MB，请减少产品数量或改用合并长图"});
    if(pdfOutput){const pdf=await renderProductCardGridPdf(template,normalizedProducts,productContent.showPrice,productContent.grid!.rows,productContent.grid!.columns),fileName=`product-grid-${selectedProductIds.length}.pdf`,stored=await storeEmailAttachment(context.account_id,fileName,pdf,"application/pdf","product-card");attachments.push({...stored,fileName,contentId:"product-card-pdf",mimeType:"application/pdf"});contentHtml=`<p style="margin-top:20px">Product cards are attached as a PDF.</p>`;}else{for(const [index,png] of pngs.entries()){const fileName=productContent.mode==="grid"?`product-grid-${index+1}-of-${pngs.length}.png`:productContent.mode==="combined"?`product-cards-${selectedProductIds.length}.png`:`product-${safeFileName(products[index].sku)}.png`,stored=await storeEmailAttachment(context.account_id,fileName,png,"image/png","product-card"),contentId=`product-card-${index}`;attachments.push({...stored,fileName,contentId,mimeType:"image/png"});}contentHtml=`<div style="margin-top:20px">${attachments.map((attachment,index)=>`<img alt="${escapeHtml(products[Math.min(index,products.length-1)].name)}" src="cid:${attachment.contentId}" style="display:block;max-width:100%;height:auto;margin:0 auto 18px">`).join("")}</div>`;}
    textContent=products.map(product=>`${product.name} (${product.sku})`).join("\n");contentType="product_cards";
  }
  if(attachments.reduce((sum,item)=>sum+item.byteSize,0)>15*1024*1024)return reply.code(413).send({error:"email_attachments_too_large",message:"邮件图片超过 15 MB，请减少产品数量或改用合并长图"});const textBody=[parsed.data.messageBody,textContent].filter(Boolean).join("\n\n"),htmlBody=emailShell(parsed.data.messageBody,contentHtml);
  const created=await transaction(async client=>{const inserted=await client.query("INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type,order_id,product_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(client_send_id) DO NOTHING RETURNING id,status",[parsed.data.clientSendId,conversationId,context.contact_id,principal.id,provider.provider,JSON.stringify(provider.config),provider.secret_encrypted,JSON.stringify(recipients),parsed.data.subject,parsed.data.messageBody,textBody,htmlBody,contentType,orderId,productIds?JSON.stringify(productIds):null]);if(!inserted.rowCount)return(await client.query("SELECT id,status FROM email_messages WHERE client_send_id=$1",[parsed.data.clientSendId])).rows[0];for(const [position,item] of attachments.entries())await client.query("INSERT INTO email_attachments(email_id,media_id,position,file_name,content_id,mime_type,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7)",[inserted.rows[0].id,item.mediaId,position,item.fileName,item.contentId,item.mimeType,item.byteSize]);await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[conversationId]);await pauseAgentForHuman(client,conversationId);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'email.queue','email_message',$2,$3)",[principal.id,inserted.rows[0].id,JSON.stringify({conversationId,contentType,recipientCount:recipients.length,attachmentCount:attachments.length})]);return inserted.rows[0];});return reply.code(202).send({emailId:created.id,status:created.status});
});

app.post("/api/v1/conversations/:id/product-cards/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,{id}=request.params as {id:string},parsed=productCardSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const contextResult=await pool.query("SELECT c.account_id,a.agent_id,co.provider_user_id FROM conversations c JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1 AND c.account_id=$2",[id,parsed.data.accountId]);if(!contextResult.rowCount||!canAccessAccount(principal,parsed.data.accountId))return reply.code(404).send({error:"conversation_not_found"});const context=contextResult.rows[0];
  const gridPageCount=parsed.data.mode==="grid"?Math.ceil(parsed.data.productIds.length/(parsed.data.grid!.rows*parsed.data.grid!.columns)):0,pdfOutput=parsed.data.mode==="grid"&&parsed.data.gridOutputFormat==="pdf";
  const clientMessageIds=parsed.data.mode==="individual"?parsed.data.productIds.map((_,index)=>`${parsed.data.clientBatchId}:p:${index}`):parsed.data.mode==="grid"&&!pdfOutput?Array.from({length:gridPageCount},(_,index)=>`${parsed.data.clientBatchId}:grid:${index}`):[`${parsed.data.clientBatchId}:${pdfOutput?"grid-pdf":parsed.data.mode}`];
  const existing=await pool.query("SELECT id,client_message_id FROM messages WHERE account_id=$1 AND client_message_id=ANY($2::text[]) ORDER BY occurred_at,id",[parsed.data.accountId,clientMessageIds]);if(existing.rowCount){if(existing.rowCount!==clientMessageIds.length)return reply.code(409).send({error:"product_card_batch_conflict"});return reply.code(200).send({deduplicated:true,messageIds:existing.rows.map(row=>String(row.id))});}
  const productsResult=await pool.query(`SELECT p.id,p.name,p.sku,p.currency,m.object_key,COALESCE((SELECT json_agg(gm.object_key ORDER BY pg.position) FROM product_gallery_images pg JOIN media gm ON gm.id=pg.media_id AND gm.status='ready' WHERE pg.product_id=p.id),'[]'::json) gallery_object_keys,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(variant_list.variants,'[]'::json) variants FROM products p LEFT JOIN media m ON m.id=p.image_media_id AND m.status='ready' LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) price_tiers FROM product_price_tiers t WHERE t.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('attributes',v.attributes,'sku',v.sku,'objectKey',vm.object_key,'priceTiers',COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json)) ORDER BY v.created_at,v.id) variants FROM product_variants v LEFT JOIN media vm ON vm.id=v.image_media_id AND vm.status='ready' WHERE v.product_id=p.id) variant_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('name',l.name) ORDER BY lower(l.name)) tags FROM product_labels l WHERE l.product_id=p.id) label_list ON true WHERE p.deleted_at IS NULL AND p.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],p.id)`,[parsed.data.productIds]);if(productsResult.rowCount!==parsed.data.productIds.length)return reply.code(409).send({error:"product_unavailable"});
  const translatedNames=new Map((parsed.data.translatedProductNames??[]).map(item=>[item.productId,item.name]));
  const products:ProductCardRenderProduct[]=await Promise.all(productsResult.rows.map(async row=>{const image=await loadProductCardImage(row.object_key),gallery=await Promise.all((Array.isArray(row.gallery_object_keys)?row.gallery_object_keys:[]).map(loadProductCardImage)),variants=await Promise.all((Array.isArray(row.variants)?row.variants:[]).map(async(variant:Record<string,unknown>)=>({attributes:variant.attributes&&typeof variant.attributes==="object"?variant.attributes as Record<string,string>:{},sku:String(variant.sku),priceTiers:Array.isArray(variant.priceTiers)?(variant.priceTiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})):[],image:await loadProductCardImage(variant.objectKey)})));return{name:translatedNames.get(String(row.id))??String(row.name),sku:String(row.sku),currency:String(row.currency),priceTiers:(row.price_tiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})),variants,tags:(row.tags as Array<Record<string,unknown>>).map(tag=>({name:String(tag.name)})),image,gallery:gallery.filter((item):item is Buffer=>Boolean(item))};}));
  const targetCurrency=String((request.body as Record<string,unknown>)?.targetCurrency??"USD").toUpperCase(),normalizedProducts=await convertProductCardPrices(products,targetCurrency);
  const templateResult=await pool.query("SELECT template FROM product_card_settings WHERE singleton=true"),storedTemplate=parseProductCardTemplate(templateResult.rows[0]?.template??DEFAULT_PRODUCT_CARD_TEMPLATE),template=parsed.data.translatedTemplate??storedTemplate,caption=parsed.data.caption===undefined?renderProductCardCaption(template,normalizedProducts):parsed.data.caption.trim(),translationSourceText=parsed.data.translationSourceText?.trim()||null;
  const aiContext={type:"product_card",version:1,mode:parsed.data.mode,grid:parsed.data.grid??null,gridOutputFormat:parsed.data.gridOutputFormat??"image",showPrice:parsed.data.showPrice,caption:caption||null,products:normalizedProducts.map(product=>({name:product.name,sku:product.sku,currency:product.currency,priceTiers:product.priceTiers,variants:(product.variants??[]).map(variant=>({attributes:variant.attributes,sku:variant.sku,priceTiers:variant.priceTiers})),tags:product.tags.map(tag=>tag.name),hasImage:Boolean(product.image),galleryImageCount:product.gallery?.length??0}))};
  const rendered=pdfOutput?[await renderProductCardGridPdf(template,normalizedProducts,parsed.data.showPrice,parsed.data.grid!.rows,parsed.data.grid!.columns)]:parsed.data.mode==="combined"?[await renderProductCards(template,normalizedProducts,parsed.data.showPrice)]:parsed.data.mode==="grid"?await renderProductCardGridPages(template,normalizedProducts,parsed.data.showPrice,parsed.data.grid!.rows,parsed.data.grid!.columns):await Promise.all(normalizedProducts.map(product=>renderProductCards(template,[product],parsed.data.showPrice)));
  const uploaded:Array<{objectKey:string;sha256:string;bytes:Buffer;fileName:string}>=[];
  try{for(const [index,bytes] of rendered.entries()){const mimeType=pdfOutput?"application/pdf":"image/png",extension=pdfOutput?"pdf":"png",sha256=createHash("sha256").update(bytes).digest("hex"),fileName=pdfOutput?`product-grid-${parsed.data.clientBatchId}.pdf`:parsed.data.mode==="grid"?`product-grid-${parsed.data.clientBatchId}-${index+1}-of-${rendered.length}.png`:parsed.data.mode==="combined"?`product-cards-${parsed.data.clientBatchId}.png`:`product-${products[index].sku}.png`,objectKey=`product-cards/${parsed.data.accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}.${extension}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mimeType,Metadata:{sha256,source:"product-card"}}));uploaded.push({objectKey,sha256,bytes,fileName});}
    const result=await transaction(async client=>{const duplicate=await client.query("SELECT id FROM messages WHERE account_id=$1 AND client_message_id=ANY($2::text[])",[parsed.data.accountId,clientMessageIds]);if(duplicate.rowCount)throw Object.assign(new Error("product_card_batch_conflict"),{statusCode:409});const messageIds:string[]=[];const baseTime=Date.now(),mimeType=pdfOutput?"application/pdf":"image/png",messageKind=pdfOutput?"document":"image",commandType=pdfOutput?"document":"image";for(const [index,item] of uploaded.entries()){const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[parsed.data.accountId,item.objectKey,item.fileName,mimeType,item.bytes.length,item.sha256]),clientMessageId=clientMessageIds[index],messageCaption=index===0?(caption||null):null,messageTranslationSource=index===0?translationSourceText:null,occurredAt=new Date(baseTime+index).toISOString();const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,translation_source_text,translation_target_language,media_id,status,occurred_at,provider_payload) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,'queued',$10,$11) RETURNING id",[id,parsed.data.accountId,principal.id,clientMessageId,messageKind,messageCaption,messageTranslationSource,messageTranslationSource?parsed.data.translationTargetLanguage??null:null,media.rows[0].id,occurredAt,index===0?JSON.stringify({aiContext}):null]);await queueChannelCommand(client,{accountId:parsed.data.accountId,conversationId:id,messageId:message.rows[0].id,payload:{accountId:parsed.data.accountId,conversationId:id,clientMessageId,type:commandType,...(messageCaption?{text:messageCaption}:{}),mediaId:media.rows[0].id,messageId:message.rows[0].id,toJid:context.provider_user_id}});messageIds.push(String(message.rows[0].id));}await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[id]);await pauseAgentForHuman(client,id);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product_card.send','conversation',$2,$3)",[principal.id,id,JSON.stringify({clientBatchId:parsed.data.clientBatchId,productIds:parsed.data.productIds,mode:parsed.data.mode,gridOutputFormat:parsed.data.gridOutputFormat??"image",showPrice:parsed.data.showPrice,captioned:Boolean(caption),translatedCaption:Boolean(translationSourceText),translatedProductNames:translatedNames.size,messageIds})]);return{deduplicated:false,messageIds};});if(context.agent_id)void dispatchPending(context.agent_id);return reply.code(202).send(result);
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
    const conversation=await client.query("SELECT c.account_id,c.contact_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(principal,conversation.rows[0].account_id))return null;if(conversation.rows[0].entity_type==="group")throw Object.assign(new Error("group_feature_unavailable"),{statusCode:409});
    const duplicate=await client.query("SELECT id,display_order_number,conversation_id,status FROM orders WHERE client_order_id=$1",[parsed.data.clientOrderId]);if(duplicate.rowCount){if(duplicate.rows[0].conversation_id!==id)throw Object.assign(new Error("client_order_id_conflict"),{statusCode:409});return{...duplicate.rows[0],deduplicated:true};}
    const clientProductIds=parsed.data.items.flatMap(item=>item.clientProductId?[item.clientProductId]:[]);if(new Set(clientProductIds).size!==clientProductIds.length)throw Object.assign(new Error("duplicate_client_product_id"),{statusCode:400});const mediaIds=parsed.data.items.flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]);if(new Set(mediaIds).size!==mediaIds.length)throw Object.assign(new Error("duplicate_product_image"),{statusCode:400});if(mediaIds.length){const media=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND (account_id=$2 OR account_id IS NULL) AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds,conversation.rows[0].account_id]);if(media.rowCount!==mediaIds.length)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}
    const shipping=await acceptedShipping(client,parsed.data,String(conversation.rows[0].contact_id)),paymentProfile=await resolvePaymentProfile(client,parsed.data.paymentProfileId),orderFees=orderFeesWithPayPalFee(parsed.data.fees,parsed.data.items,shipping.amount??0,paymentProfile),total=calculateOrderTotal(parsed.data.items,orderFees,shipping.amount??0),number=await allocateOrderNumber(client),orderAddress=await resolveOrderAddress(client,conversation.rows[0].contact_id,principal.id,parsed.data.addressId,parsed.data.newAddress);const order=await client.query("INSERT INTO orders(client_order_id,conversation_id,created_by,amount,currency,weight_unit,description,status,translate_on_send,target_language,display_order_number,sequence_date,daily_sequence,address_id,shipping_address_snapshot,payment_profile_id,payment_profile_snapshot,shipping_amount,shipping_template_id,shipping_quote_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19::jsonb) RETURNING id,display_order_number,status",[parsed.data.clientOrderId,id,principal.id,total,parsed.data.currency,parsed.data.weightUnit,parsed.data.description??null,parsed.data.translateOnSend,parsed.data.targetLanguage??null,number.displayOrderNumber,number.sequenceDate,number.dailySequence,orderAddress?.id??null,orderAddress?JSON.stringify(orderAddress.snapshot):null,paymentProfile?.profileId??null,paymentProfile?JSON.stringify(paymentProfile):null,shipping.amount,parsed.data.shippingTemplateId??null,shipping.snapshot?JSON.stringify(shipping.snapshot):null]);const orderRow=order.rows[0];
    await client.query("UPDATE orders SET internal_comment=$2 WHERE id=$1",[orderRow.id,parsed.data.internalComment??""]);
    const conversationTags=await client.query("SELECT t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[id]);for(const [position,item] of parsed.data.items.entries()){const productId=await resolveOrderProduct(client,item,String(orderRow.display_order_number),parsed.data.currency,principal.id,conversationTags.rows),shippingClass=await orderShippingClassSnapshot(client,item,productId);await client.query("INSERT INTO order_items(order_id,position,product_name,product_sku,quantity,unit_amount,weight_amount,weight_unit,image_media_id,product_id,variant_id,shipping_class_id,shipping_class_name,internal_note_snapshot) VALUES($1,$2,$3,COALESCE($4,(SELECT sku FROM products WHERE id=$11)),$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE((SELECT internal_note FROM products WHERE id=$11),''))",[orderRow.id,position,item.name,item.sku??null,item.quantity,item.unitAmount,item.weightAmount??null,item.weightUnit??null,item.imageMediaId??null,productId,item.variantId??null,shippingClass.shippingClassId,shippingClass.shippingClassName]);}
    for(const [position,fee] of orderFees.entries())await client.query("INSERT INTO order_fees(order_id,position,name,amount,source) VALUES($1,$2,$3,$4,$5)",[orderRow.id,position,fee.name,fee.amount,fee.source]);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.draft','order',$2,$3)",[principal.id,orderRow.id,JSON.stringify({conversationId:id,displayOrderNumber:orderRow.display_order_number,itemCount:parsed.data.items.length,feeCount:parsed.data.fees.length,translateOnSend:parsed.data.translateOnSend})]);return{id:orderRow.id,display_order_number:orderRow.display_order_number,status:orderRow.status,deduplicated:false};
  });
  if(!result)return reply.code(404).send({error:"not_found"});
  if(!result.deduplicated)await pool.query("SELECT relay_publish_conversation_change(c.id,c.account_id) FROM conversations c WHERE c.id=$1",[id]);
  return reply.code(201).send({orderId:result.id,orderNumber:String(result.display_order_number),status:result.status,deduplicated:result.deduplicated});
});

app.patch("/api/v1/conversations/:conversationId/orders/:orderId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=orderUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};
  if(!await isConfiguredCurrency(parsed.data.currency))return reply.code(400).send({error:"currency_not_configured",message:"该币种未在货币管理中启用"});
  const access=await pool.query("SELECT c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!access.rowCount||!canAccessAccount(principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});try{await resolvePaymentProfile(pool,parsed.data.paymentProfileId);}catch(error){return reply.code((error as {statusCode?:number}).statusCode??400).send({error:error instanceof Error?error.message:"payment_profile_unavailable"});}try{const cancellation=await cancelCurrentPaymentRequest(orderId,principal.id);if(cancellation==="paid")return reply.code(409).send({error:"paid_order_locked",message:"已付款订单不能修改商品、费用或金额"});}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice cancellation failed before order update");return reply.code(502).send({error:"paypal_cancel_failed",message:"旧付款请求作废失败，订单未修改，请稍后重试"});}
  const result=await transaction(async client=>{const found=await client.query("SELECT o.display_order_number,o.status,o.shipping_amount,o.shipping_template_id,o.shipping_quote_snapshot,c.account_id,c.contact_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL FOR UPDATE OF o",[orderId,conversationId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return null;const clientProductIds=parsed.data.items.flatMap(item=>item.clientProductId?[item.clientProductId]:[]);if(new Set(clientProductIds).size!==clientProductIds.length)throw Object.assign(new Error("duplicate_client_product_id"),{statusCode:400});const mediaIds=parsed.data.items.flatMap(item=>item.imageMediaId?[item.imageMediaId]:[]);if(new Set(mediaIds).size!==mediaIds.length)throw Object.assign(new Error("duplicate_product_image"),{statusCode:400});if(mediaIds.length){const media=await client.query("SELECT id FROM media WHERE id=ANY($1::uuid[]) AND (account_id=$2 OR account_id IS NULL) AND status='ready' AND mime_type IN ('image/png','image/jpeg')",[mediaIds,found.rows[0].account_id]);if(media.rowCount!==mediaIds.length)throw Object.assign(new Error("invalid_product_image"),{statusCode:400});}let shipping=await acceptedShipping(client,parsed.data,String(found.rows[0].contact_id));if(!parsed.data.acceptCalculatedShipping&&Number(found.rows[0].shipping_amount??0)===Number(shipping.amount??0)&&(found.rows[0].shipping_template_id??null)===(parsed.data.shippingTemplateId??null))shipping={...shipping,snapshot:found.rows[0].shipping_quote_snapshot};const paymentProfile=await resolvePaymentProfile(client,parsed.data.paymentProfileId),orderFees=orderFeesWithPayPalFee(parsed.data.fees,parsed.data.items,shipping.amount??0,paymentProfile),total=calculateOrderTotal(parsed.data.items,orderFees,shipping.amount??0);await client.query("UPDATE orders SET amount=$2,currency=$3,weight_unit=$4,description=$5,translate_on_send=$6,target_language=$7,payment_profile_id=$8,payment_profile_snapshot=$9::jsonb,shipping_amount=$10,shipping_template_id=$11,shipping_quote_snapshot=$12::jsonb WHERE id=$1",[orderId,total,parsed.data.currency,parsed.data.weightUnit,parsed.data.description??null,parsed.data.translateOnSend,parsed.data.targetLanguage??null,paymentProfile?.profileId??null,paymentProfile?JSON.stringify(paymentProfile):null,shipping.amount,parsed.data.shippingTemplateId??null,shipping.snapshot?JSON.stringify(shipping.snapshot):null]);await client.query("UPDATE orders SET internal_comment=$2 WHERE id=$1",[orderId,parsed.data.internalComment??""]);const conversationTags=await client.query("SELECT t.name,t.color FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.conversation_id=$1 ORDER BY lower(t.name)",[conversationId]);const productIds=[];for(const item of parsed.data.items)productIds.push(await resolveOrderProduct(client,item,String(found.rows[0].display_order_number),parsed.data.currency,principal.id,conversationTags.rows));await client.query("DELETE FROM order_items WHERE order_id=$1",[orderId]);await client.query("DELETE FROM order_fees WHERE order_id=$1",[orderId]);for(const [position,item] of parsed.data.items.entries()){const shippingClass=await orderShippingClassSnapshot(client,item,productIds[position]);await client.query("INSERT INTO order_items(order_id,position,product_name,product_sku,quantity,unit_amount,weight_amount,weight_unit,image_media_id,product_id,variant_id,shipping_class_id,shipping_class_name,internal_note_snapshot) VALUES($1,$2,$3,COALESCE($4,(SELECT sku FROM products WHERE id=$11)),$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE((SELECT internal_note FROM products WHERE id=$11),''))",[orderId,position,item.name,item.sku??null,item.quantity,item.unitAmount,item.weightAmount??null,item.weightUnit??null,item.imageMediaId??null,productIds[position],item.variantId??null,shippingClass.shippingClassId,shippingClass.shippingClassName]);}for(const [position,fee] of orderFees.entries())await client.query("INSERT INTO order_fees(order_id,position,name,amount,source) VALUES($1,$2,$3,$4,$5)",[orderId,position,fee.name,fee.amount,fee.source]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.update','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,itemCount:parsed.data.items.length,feeCount:parsed.data.fees.length,translateOnSend:parsed.data.translateOnSend,previouslySent:found.rows[0].status!=="draft",paymentProfileId:paymentProfile?.profileId??null,shippingTemplateId:paymentProfile?.profileId??null,acceptedShipping:parsed.data.acceptCalculatedShipping})]);return{orderNumber:String(found.rows[0].display_order_number)};});if(!result)return reply.code(404).send({error:"not_found"});return{orderId,orderNumber:result.orderNumber,status:"updated"};
});

app.patch("/api/v1/conversations/:conversationId/orders/:orderId/address",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal,parsed=orderAddressSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};const context=await pool.query("SELECT c.account_id,c.contact_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!context.rowCount||!canAccessAccount(principal,context.rows[0].account_id))return reply.code(404).send({error:"not_found"});const selected=await resolveOrderAddress(pool,context.rows[0].contact_id,principal.id,parsed.data.addressId??undefined,parsed.data.newAddress);await pool.query("UPDATE orders SET address_id=$2,shipping_address_snapshot=$3 WHERE id=$1",[orderId,selected?.id??null,selected?JSON.stringify(selected.snapshot):null]);return{addressId:selected?.id??null,address:selected?.snapshot??null};
});

app.patch("/api/v1/conversations/:conversationId/orders/:orderId/status",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const parsed=orderBusinessStatusUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const principal=request.principal,{conversationId,orderId}=request.params as {conversationId:string;orderId:string};
  const current=await pool.query("SELECT c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);
  if(!current.rowCount||!canAccessAccount(principal,current.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const updated=await pool.query("UPDATE orders SET business_status=$2 WHERE id=$1 RETURNING business_status",[orderId,parsed.data.businessStatus]);
  await auditCrm(principal.id,"order.status.update","order",orderId,{conversationId,businessStatus:parsed.data.businessStatus});
  await pool.query("SELECT relay_publish_conversation_change($1,$2)",[conversationId,current.rows[0].account_id]);
  return{orderId,businessStatus:updated.rows[0].business_status};
});

app.post("/api/v1/conversations/:conversationId/orders/:orderId/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const parsed=orderSendSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};
  const found=await pool.query("SELECT o.id,o.display_order_number,o.client_order_id,o.currency,o.description,o.status,o.business_status,o.send_format,o.translate_on_send,o.target_language,o.summary_message_id,o.shipping_address_snapshot,o.payment_profile_snapshot,c.account_id,a.agent_id,co.provider_user_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) customer_name,co.phone_e164 customer_phone,co.first_name contact_first_name,co.last_name contact_last_name,co.company_name contact_company_name,co.country contact_country,co.province contact_province,co.city contact_city,(SELECT email FROM contact_emails WHERE contact_id=co.id AND is_primary LIMIT 1) contact_email,m.status message_status FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN messages m ON m.id=o.summary_message_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});const order=found.rows[0],requestMessageId=parsed.data.clientSendId?`${order.client_order_id}:send:${parsed.data.clientSendId}`:`${order.client_order_id}:${parsed.data.format}`,shouldTranslate=parsed.data.translate??Boolean(order.translate_on_send),targetLanguage=parsed.data.targetLanguage??order.target_language;
  const [itemResult,feeResult,templateResult]=await Promise.all([pool.query("SELECT i.id,i.product_name name,i.product_sku sku,i.quantity,i.unit_amount,i.image_media_id,m.object_key,m.mime_type FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id WHERE i.order_id=$1 ORDER BY i.position",[orderId]),pool.query("SELECT name,amount FROM (SELECT name,amount,position FROM order_fees WHERE order_id=$1 UNION ALL SELECT 'Shipping',shipping_amount,32767 FROM orders WHERE id=$1 AND shipping_amount IS NOT NULL) listed ORDER BY position",[orderId]),pool.query("SELECT text_template,image_template,pdf_template FROM order_settings WHERE singleton=true")]);const items:OrderSummaryItem[]=itemResult.rows.map(item=>({name:String(item.name),sku:String(item.sku??""),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)})),fees:OrderSummaryFee[]=feeResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)}));
  const format=parsed.data.format as OrderTemplateFormat,rawTemplate=templateResult.rows[0]?.[format==="text"?"text_template":format==="pdf"?"pdf_template":"image_template"],template=parseOrderTemplate(rawTemplate,format),context={orderNumber:String(order.display_order_number),businessStatus:order.business_status,currency:String(order.currency),customerName:String(order.customer_name??""),customerPhone:String(order.customer_phone??""),description:String(order.description??""),items,fees,address:order.shipping_address_snapshot??null,paymentProfile:order.payment_profile_snapshot??null,contact:{firstName:order.contact_first_name,lastName:order.contact_last_name,companyName:order.contact_company_name,country:order.contact_country,province:order.contact_province,city:order.contact_city,email:order.contact_email}};
  if(rawTemplate&&!orderTemplateSchema.safeParse(rawTemplate).success)request.log.error({format},"Invalid stored order template; using default");
  const sourceBlocks=renderSemanticOrder(template,context),sourceText=renderTextOrder(template,sourceBlocks);let renderedBlocks=sourceBlocks,outgoingText=sourceText;
  if(shouldTranslate){if(!targetLanguage)return reply.code(400).send({error:"target_language_required",message:"请选择订单翻译的目标语言"});const setting=await activeTranslationSetting();if(!setting)return reply.code(409).send({error:"translation_not_configured",message:"AI 翻译服务尚未配置，订单未发送"});try{const translated=await translateText(setting,{text:serializeSemanticOrder(sourceBlocks),targetLanguage});renderedBlocks=parseTranslatedSemanticOrder(translated,sourceBlocks);outgoingText=renderTextOrder(template,renderedBlocks);}catch(error){request.log.error({orderId,error:String(error)},"Order translation failed");return reply.code(502).send({error:"translation_failed",message:"订单翻译失败，订单尚未发送"});}}
  let renderedMediaId:string|null=null;
  if(parsed.data.format==="image"||parsed.data.format==="pdf"){
    try{const products=await Promise.all(itemResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));if(!object.Body)return{name:String(item.name)};return{name:String(item.name),image:Buffer.from(await object.Body.transformToByteArray())};}));
      const isPdf=parsed.data.format==="pdf",bytes=isPdf?await renderTemplateOrderPdf(template,renderedBlocks,products):await renderTemplateOrderImage(template,renderedBlocks,products),mimeType=isPdf?"application/pdf":"image/png",extension=isPdf?"pdf":"png",sha256=createHash("sha256").update(bytes).digest("hex"),objectKey=`orders/${order.account_id}/${orderId}/${sha256}.${extension}`,fileName=`order-${safeFileName(String(order.display_order_number))}.${extension}`;
      await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mimeType,Metadata:{sha256,orderId}}));
      const media=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(object_key) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,status='ready' RETURNING id",[order.account_id,objectKey,fileName,mimeType,bytes.length,sha256]);renderedMediaId=media.rows[0].id;
    }catch(error){request.log.error({orderId,format:parsed.data.format,error:String(error)},"Order document generation failed");return reply.code(502).send({error:"order_document_failed",message:"订单文件生成失败，草稿仍保留且尚未发送"});}
  }
  const queued=await transaction(async client=>{const locked=await client.query("SELECT deleted_at FROM orders WHERE id=$1 FOR UPDATE",[orderId]);if(!locked.rowCount||locked.rows[0].deleted_at)return null;const existing=await client.query("SELECT id FROM messages WHERE account_id=$1 AND client_message_id=$2",[order.account_id,requestMessageId]);if(existing.rowCount)return{messageId:existing.rows[0].id,format:parsed.data.format,deduplicated:true};const kind=parsed.data.format==="image"?"image":parsed.data.format==="pdf"?"document":"text",caption=parsed.data.format==="text"?outgoingText:`Order #${String(order.display_order_number)}`;const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,translation_source_text,translation_target_language,media_id,status,occurred_at) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,'queued',now()) RETURNING id,status",[conversationId,order.account_id,principal.id,requestMessageId,kind,caption,parsed.data.format==="text"&&shouldTranslate?sourceText:null,parsed.data.format==="text"&&shouldTranslate?targetLanguage:null,renderedMediaId]);await queueOrderCommand(client,order,conversationId,message.rows[0].id,requestMessageId,kind,caption,renderedMediaId??undefined);
    await client.query("UPDATE orders SET status='queued',send_format=$2,summary_message_id=$3,rendered_media_id=$4,translated_text=$5,sent_at=now() WHERE id=$1",[orderId,parsed.data.format,message.rows[0].id,renderedMediaId,shouldTranslate?outgoingText:null]);await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[conversationId]);await pauseAgentForHuman(client,conversationId);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.send','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,resend:order.status!=="draft",format:parsed.data.format,translated:shouldTranslate,targetLanguage:shouldTranslate?targetLanguage:null,productImageCount:itemResult.rows.filter(item=>item.image_media_id).length})]);return{messageId:message.rows[0].id,format:parsed.data.format,deduplicated:false};});
  if(!queued)return reply.code(404).send({error:"not_found"});if(order.agent_id)void dispatchPending(order.agent_id);return reply.code(202).send({orderId,orderNumber:String(order.display_order_number),messageId:queued.messageId,status:"queued",format:queued.format,deduplicated:queued.deduplicated});
});

app.get("/api/v1/orders/:orderId/documents/:document",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const {orderId,document}=request.params as {orderId:string;document:string};
  if(!["qt","sc","pi","ci"].includes(document))return reply.code(404).send({error:"not_found"});
  const found=await pool.query("SELECT o.id,o.display_order_number,o.business_status,o.currency,o.description,o.shipping_address_snapshot,o.payment_profile_snapshot,c.account_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) customer_name,co.phone_e164 customer_phone,co.first_name contact_first_name,co.last_name contact_last_name,co.company_name contact_company_name,co.country contact_country,co.province contact_province,co.city contact_city,(SELECT email FROM contact_emails WHERE contact_id=co.id AND is_primary LIMIT 1) contact_email FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN contacts co ON co.id=c.contact_id WHERE o.id=$1 AND o.deleted_at IS NULL",[orderId]);
  if(!found.rowCount||!canAccessAccount(request.principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const [itemsResult,feesResult,settingsResult]=await Promise.all([
    pool.query("SELECT i.product_name name,i.product_sku sku,i.quantity,i.unit_amount,m.object_key FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id WHERE i.order_id=$1 ORDER BY i.position",[orderId]),
    pool.query("SELECT name,amount FROM (SELECT name,amount,position FROM order_fees WHERE order_id=$1 UNION ALL SELECT 'Shipping',shipping_amount,32767 FROM orders WHERE id=$1 AND shipping_amount IS NOT NULL) listed ORDER BY position",[orderId]),
    pool.query("SELECT qt_template,sc_template,pi_template,ci_template FROM order_settings WHERE singleton=true"),
  ]);
  const row=found.rows[0],items:OrderSummaryItem[]=itemsResult.rows.map(item=>({name:String(item.name),sku:String(item.sku??""),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)})),fees:OrderSummaryFee[]=feesResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)}));
  const defaults={qt:DEFAULT_QT_ORDER_TEMPLATE,sc:DEFAULT_SC_ORDER_TEMPLATE,pi:DEFAULT_PI_ORDER_TEMPLATE,ci:DEFAULT_CI_ORDER_TEMPLATE},raw=settingsResult.rows[0]?.[`${document}_template`],template=parseOrderTemplate(raw??defaults[document as keyof typeof defaults],document as OrderTemplateFormat),context={orderNumber:String(row.display_order_number),businessStatus:String(row.business_status??"quotation") as Parameters<typeof renderSemanticOrder>[1]["businessStatus"],currency:String(row.currency),customerName:String(row.customer_name??""),customerPhone:String(row.customer_phone??""),description:String(row.description??""),items,fees,address:row.shipping_address_snapshot??null,paymentProfile:row.payment_profile_snapshot??null,contact:{firstName:row.contact_first_name,lastName:row.contact_last_name,companyName:row.contact_company_name,country:row.contact_country,province:row.contact_province,city:row.contact_city,email:row.contact_email}};
  try{
    const products=await Promise.all(itemsResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:String(item.object_key)}));return{name:String(item.name),image:object.Body?Buffer.from(await object.Body.transformToByteArray()):undefined};}));
    const bytes=await renderTemplateOrderPdf(template,renderSemanticOrder(template,context),products),fileName=`${document.toUpperCase()}-${safeFileName(String(row.display_order_number))}.pdf`;
    return reply.header("Content-Type","application/pdf").header("Content-Disposition",`attachment; filename="${fileName}"`).send(bytes);
  }catch(error){request.log.error({orderId,document,error:String(error)},"Order document download failed");return reply.code(502).send({error:"order_document_failed",message:"订单单据生成失败"});}
});

app.post("/api/v1/conversations/:conversationId/orders/:orderId/documents/:document/send",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const principal=request.principal,{conversationId,orderId,document}=request.params as {conversationId:string;orderId:string;document:string},clientSendId=(request.body as {clientSendId?:unknown}|null)?.clientSendId;
  if(!["qt","sc","pi","ci"].includes(document)||typeof clientSendId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientSendId))return reply.code(400).send({error:"invalid_request"});
  const found=await pool.query("SELECT o.id,o.display_order_number,o.client_order_id,o.business_status,o.currency,o.description,o.shipping_address_snapshot,o.payment_profile_snapshot,c.account_id,a.agent_id,co.provider_user_id,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,co.provider_user_id) customer_name,co.phone_e164 customer_phone FROM orders o JOIN conversations c ON c.id=o.conversation_id JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);
  if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const [itemsResult,feesResult,settingsResult]=await Promise.all([
    pool.query("SELECT i.product_name name,i.product_sku sku,i.quantity,i.unit_amount,m.object_key FROM order_items i LEFT JOIN media m ON m.id=i.image_media_id WHERE i.order_id=$1 ORDER BY i.position",[orderId]),
    pool.query("SELECT name,amount FROM (SELECT name,amount,position FROM order_fees WHERE order_id=$1 UNION ALL SELECT 'Shipping',shipping_amount,32767 FROM orders WHERE id=$1 AND shipping_amount IS NOT NULL) listed ORDER BY position",[orderId]),
    pool.query("SELECT qt_template,sc_template,pi_template,ci_template FROM order_settings WHERE singleton=true"),
  ]);
  const order=found.rows[0],items:OrderSummaryItem[]=itemsResult.rows.map(item=>({name:String(item.name),sku:String(item.sku??""),quantity:Number(item.quantity),unitAmount:Number(item.unit_amount)})),fees:OrderSummaryFee[]=feesResult.rows.map(fee=>({name:String(fee.name),amount:Number(fee.amount)}));
  const defaults={qt:DEFAULT_QT_ORDER_TEMPLATE,sc:DEFAULT_SC_ORDER_TEMPLATE,pi:DEFAULT_PI_ORDER_TEMPLATE,ci:DEFAULT_CI_ORDER_TEMPLATE},raw=settingsResult.rows[0]?.[`${document}_template`],template=parseOrderTemplate(raw??defaults[document as keyof typeof defaults],document as OrderTemplateFormat),context={orderNumber:String(order.display_order_number),businessStatus:String(order.business_status??"quotation") as Parameters<typeof renderSemanticOrder>[1]["businessStatus"],currency:String(order.currency),customerName:String(order.customer_name??""),customerPhone:String(order.customer_phone??""),description:String(order.description??""),items,fees,address:order.shipping_address_snapshot??null,paymentProfile:order.payment_profile_snapshot??null};
  try{
    const products=await Promise.all(itemsResult.rows.map(async item=>{if(!item.object_key)return{name:String(item.name)};const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:String(item.object_key)}));return{name:String(item.name),image:object.Body?Buffer.from(await object.Body.transformToByteArray()):undefined};}));
    const bytes=await renderTemplateOrderPdf(template,renderSemanticOrder(template,context),products),fileName=`${document.toUpperCase()}-${safeFileName(String(order.display_order_number))}.pdf`,sha256=createHash("sha256").update(bytes).digest("hex"),objectKey=`order-documents/${order.account_id}/${orderId}/${document}/${sha256}.pdf`,clientMessageId=`${order.client_order_id}:document:${document}:${clientSendId}`;
    await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:"application/pdf",Metadata:{sha256,orderId,document}}));
    const queued=await transaction(async client=>{const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[order.account_id,clientMessageId]);if(existing.rowCount)return{messageId:String(existing.rows[0].id),status:String(existing.rows[0].status),deduplicated:true};const media=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,'application/pdf',$4,$5) ON CONFLICT(object_key) DO UPDATE SET file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,byte_size=EXCLUDED.byte_size,sha256=EXCLUDED.sha256,status='ready' RETURNING id",[order.account_id,objectKey,fileName,bytes.length,sha256]);const caption=`${document.toUpperCase()} · Order #${order.display_order_number}`,message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,media_id,status,occurred_at) VALUES($1,$2,$3,$4,'out','document',$5,$6,'queued',now()) RETURNING id,status",[conversationId,order.account_id,principal.id,clientMessageId,caption,media.rows[0].id]);await queueOrderCommand(client,order,conversationId,message.rows[0].id,clientMessageId,"document",caption,String(media.rows[0].id));await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[conversationId]);await pauseAgentForHuman(client,conversationId);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.document.send','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,document,messageId:message.rows[0].id})]);return{messageId:String(message.rows[0].id),status:String(message.rows[0].status),deduplicated:false};});
    if(order.agent_id)void dispatchPending(order.agent_id);return reply.code(202).send({orderId,document,messageId:queued.messageId,status:queued.status,deduplicated:queued.deduplicated});
  }catch(error){request.log.error({orderId,document,error:String(error)},"Order document send failed");return reply.code(502).send({error:"order_document_failed",message:"订单单据生成或发送失败"});}
});

app.delete("/api/v1/conversations/:conversationId/orders/:orderId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const principal=request.principal;const {conversationId,orderId}=request.params as {conversationId:string;orderId:string};const access=await pool.query("SELECT c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL",[orderId,conversationId]);if(!access.rowCount||!canAccessAccount(principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});try{const cancellation=await cancelCurrentPaymentRequest(orderId,principal.id);if(cancellation==="paid")return reply.code(409).send({error:"paid_order_locked",message:"已付款订单不能删除"});}catch(error){request.log.warn({orderId,paypalError:error instanceof PayPalApiError?error.code:String(error)},"PayPal invoice cancellation failed before order delete");return reply.code(502).send({error:"paypal_cancel_failed",message:"付款请求作废失败，订单未删除，请稍后重试"});}const deleted=await transaction(async client=>{const found=await client.query("SELECT o.status,c.account_id FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE o.id=$1 AND o.conversation_id=$2 AND o.deleted_at IS NULL FOR UPDATE",[orderId,conversationId]);if(!found.rowCount||!canAccessAccount(principal,found.rows[0].account_id))return false;await client.query("UPDATE orders SET deleted_at=now() WHERE id=$1",[orderId]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'order.delete','order',$2,$3)",[principal.id,orderId,JSON.stringify({conversationId,wasSent:found.rows[0].status!=="draft"})]);return true;});if(!deleted)return reply.code(404).send({error:"not_found"});await pool.query("SELECT relay_publish_conversation_change($1,$2)",[conversationId,access.rows[0].account_id]);return reply.code(204).send();
});

app.post("/api/v1/conversations", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const principal=request.principal;
  const parsed=newConversationSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const result=await transaction(async client=>{
    const account=await client.query("SELECT id,agent_id,status,transport FROM channel_accounts WHERE id=$1 AND platform='whatsapp' AND (transport='cloud' OR agent_id IS NOT NULL)",[parsed.data.accountId]);if(!account.rowCount)return null;
    const existing=await client.query("SELECT m.id message_id,m.status,c.id conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.account_id=$1 AND m.client_message_id=$2",[parsed.data.accountId,parsed.data.clientMessageId]);
    if(existing.rowCount)return {conversationId:existing.rows[0].conversation_id,messageId:existing.rows[0].message_id,status:existing.rows[0].status,deduplicated:true,agentId:account.rows[0].agent_id};
    const phone=`+${parsed.data.phone}`,waJid=`${parsed.data.phone}@s.whatsapp.net`,displayName=parsed.data.displayName||phone;
    const contact=await client.query("INSERT INTO contacts(account_id,provider_user_id,phone_e164,display_name,alias) VALUES($1,$2,$3,$4,CASE WHEN $5 THEN $4 ELSE NULL END) ON CONFLICT(account_id,provider_user_id) DO UPDATE SET phone_e164=EXCLUDED.phone_e164,display_name=CASE WHEN $5 THEN EXCLUDED.display_name ELSE COALESCE(contacts.display_name,EXCLUDED.display_name) END,alias=CASE WHEN $5 THEN EXCLUDED.alias ELSE contacts.alias END RETURNING id",[parsed.data.accountId,waJid,phone,displayName,Boolean(parsed.data.displayName)]);
    const conversation=await client.query("INSERT INTO conversations(account_id,contact_id,status) VALUES($1,$2,'open') ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL RETURNING id",[parsed.data.accountId,contact.rows[0].id]);
    if(!parsed.data.message&&!parsed.data.firstMessage){await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.create','conversation',$2,$3)",[principal.id,conversation.rows[0].id,JSON.stringify({contactId:contact.rows[0].id,phone})]);return {conversationId:conversation.rows[0].id,messageId:null,status:null,deduplicated:false,agentId:account.rows[0].agent_id};}
    const first=parsed.data.message??{type:"text" as const,text:parsed.data.firstMessage!};
    if(account.rows[0].transport==="cloud"&&first.type!=="template")throw Object.assign(new Error("template_required"),{code:"template_required",statusCode:409,serviceWindowExpiresAt:null});
    const template=first.type==="template"?first.template:null,text=first.type==="text"?first.text:`[Template] ${template!.name} (${template!.language})`;
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at,provider_payload) VALUES($1,$2,$3,$4,'out',$5,$6,'queued',now(),$7) RETURNING id,status",[conversation.rows[0].id,parsed.data.accountId,principal.id,parsed.data.clientMessageId,first.type,text,template?JSON.stringify(template):null]);
    await pauseAgentForHuman(client,conversation.rows[0].id);
    const queued=await queueChannelCommand(client,{accountId:parsed.data.accountId,conversationId:conversation.rows[0].id,messageId:message.rows[0].id,payload:{accountId:parsed.data.accountId,conversationId:conversation.rows[0].id,clientMessageId:parsed.data.clientMessageId,type:first.type,text,template:template??undefined,messageId:message.rows[0].id,toJid:waJid}});
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.initiate','conversation',$2,$3)",[principal.id,conversation.rows[0].id,JSON.stringify({contactId:contact.rows[0].id,messageId:message.rows[0].id,commandId:queued.commandId,phone})]);
    return {conversationId:conversation.rows[0].id,messageId:message.rows[0].id,status:message.rows[0].status,deduplicated:false,agentId:queued.agentId};
  });
  if(!result)return reply.code(404).send({error:"account_not_found"});if(result.agentId)void dispatchPending(result.agentId);return reply.code(202).send(result);
});

app.get("/api/v1/conversations/:id/messages", { preHandler:authenticate }, async (request, reply) => {
  const { id } = request.params as {id:string}; const query = request.query as { before?:string; cursor?:string; limit?:string };
  const conversation = await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);
  if (!conversation.rowCount || !canAccessAccount(request.principal,conversation.rows[0].account_id)) return reply.code(404).send({error:"not_found"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??50)));
  let cursor:{occurredAt:string;id:string}|null=null;
  if(query.cursor){
    try{
      const decoded=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")) as {occurredAt?:string;id?:string};
      if(!decoded.occurredAt||Number.isNaN(Date.parse(decoded.occurredAt))||!decoded.id||!isPostgresUuid(decoded.id))throw new Error("invalid");
      cursor={occurredAt:new Date(decoded.occurredAt).toISOString(),id:decoded.id};
    }catch{return reply.code(400).send({error:"invalid_message_cursor"});}
  }else if(query.before){
    const before=new Date(query.before);
    if(Number.isNaN(before.getTime()))return reply.code(400).send({error:"invalid_message_cursor"});
    cursor={occurredAt:before.toISOString(),id:"ffffffff-ffff-ffff-ffff-ffffffffffff"};
  }
  const principalUserId=request.principal?.kind==="user"?request.principal.id:null;
  const [result,failed]=await Promise.all([
    pool.query("SELECT msg.id,msg.direction,msg.kind,msg.text_content,msg.translation_source_text,msg.translation_target_language,msg.status,msg.failure_code,msg.failure_message,msg.provider_message_id,msg.provider_payload->'adReferral' ad_referral,msg.sender_provider_user_id sender_jid,msg.sender_display_name sender_name,msg.media_id,msg.quoted_message_id,msg.occurred_at,account.platform,mp.page_id,media.file_name,media.mime_type,media.byte_size,quoted.direction quoted_direction,quoted.kind quoted_kind,quoted.text_content quoted_text_content,quoted.sender_provider_user_id quoted_sender_jid,quoted.sender_display_name quoted_sender_name,quoted_media.id quoted_media_id,quoted_media.file_name quoted_file_name,quoted_media.mime_type quoted_mime_type,preference.agent_language cached_translation_language,translation.translated_text cached_translation_text,translation.source_language cached_translation_source_language,transcription.transcript_text cached_transcription_text,command.id command_id,command.state command_state,command.attempt command_attempt,command.last_error command_last_error,command.available_at command_available_at,command.claimed_at command_claimed_at,command.created_at command_created_at,account.status account_status,agent.status agent_status,agent.last_seen_at agent_last_seen_at,COALESCE(comment_list.comments,'[]'::json) comments FROM messages msg LEFT JOIN media ON media.id=msg.media_id LEFT JOIN messages quoted ON quoted.id=msg.quoted_message_id LEFT JOIN media quoted_media ON quoted_media.id=quoted.media_id LEFT JOIN conversation_translation_preferences preference ON preference.conversation_id=msg.conversation_id AND preference.user_id=$5::uuid LEFT JOIN message_translations translation ON translation.message_id=msg.id AND translation.target_language=preference.agent_language LEFT JOIN message_transcriptions transcription ON transcription.message_id=msg.id LEFT JOIN channel_accounts account ON account.id=msg.account_id LEFT JOIN messenger_page_accounts mp ON mp.account_id=account.id LEFT JOIN agents agent ON agent.id=account.agent_id LEFT JOIN LATERAL (SELECT oc.id,oc.state,oc.attempt,oc.last_error,oc.available_at,oc.claimed_at,oc.created_at FROM outbound_commands oc WHERE oc.message_id=msg.id ORDER BY oc.sequence DESC LIMIT 1) command ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',mc.id,'body',mc.body,'user_id',mc.user_id,'author_name',u.display_name,'created_at',mc.created_at,'updated_at',mc.updated_at,'score',COALESCE(votes.score,0),'viewer_vote',COALESCE(votes.viewer_vote,0)) ORDER BY mc.created_at,mc.id) comments FROM message_comments mc LEFT JOIN users u ON u.id=mc.user_id LEFT JOIN LATERAL (SELECT SUM(value)::int score,MAX(value) FILTER (WHERE user_id=$5::uuid)::int viewer_vote FROM message_comment_votes WHERE comment_id=mc.id) votes ON true WHERE mc.message_id=msg.id) comment_list ON true WHERE msg.conversation_id=$1 AND ($2::timestamptz IS NULL OR msg.occurred_at<$2 OR (msg.occurred_at=$2 AND msg.id<$3::uuid)) ORDER BY msg.occurred_at DESC,msg.id DESC LIMIT $4",[id,cursor?.occurredAt??null,cursor?.id??null,limit,principalUserId]),
    pool.query("SELECT count(*)::int count FROM messages WHERE conversation_id=$1 AND direction='out' AND status IN ('failed','uncertain')",[id]),
  ]);
  const oldest=result.rows[result.rows.length-1];
  const nextCursor=result.rows.length===limit&&oldest?Buffer.from(JSON.stringify({occurredAt:new Date(oldest.occurred_at).toISOString(),id:oldest.id}),"utf8").toString("base64url"):null;
  return {data:result.rows.reverse(),nextCursor,failedCount:Number(failed.rows[0]?.count??0)};
});

app.post("/api/v1/conversations/:conversationId/messages/:messageId/comments",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=messageCommentSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,messageId}=request.params as {conversationId:string;messageId:string};
  const message=await pool.query("SELECT m.id,c.account_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND m.conversation_id=$2",[messageId,conversationId]);if(!message.rowCount||!canAccessAccount(request.principal,message.rows[0].account_id))return reply.code(404).send({error:"not_found"});
  const created=await pool.query("INSERT INTO message_comments(message_id,user_id,body) VALUES($1,$2,$3) RETURNING id,body,user_id,created_at,updated_at",[messageId,request.principal.id,parsed.data.body]);await auditCrm(request.principal.id,"message_comment.create","message_comment",created.rows[0].id,{conversationId,messageId});return reply.code(201).send({...created.rows[0],author_name:null,score:0,viewer_vote:0});
});

app.patch("/api/v1/conversations/:conversationId/messages/:messageId/comments/:commentId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=messageCommentSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,messageId,commentId}=request.params as {conversationId:string;messageId:string;commentId:string};
  const comment=await pool.query("SELECT mc.user_id,c.account_id FROM message_comments mc JOIN messages m ON m.id=mc.message_id JOIN conversations c ON c.id=m.conversation_id WHERE mc.id=$1 AND mc.message_id=$2 AND m.conversation_id=$3",[commentId,messageId,conversationId]);if(!comment.rowCount||!canAccessAccount(request.principal,comment.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(!canManageSharedRecord(request.principal.role,comment.rows[0].user_id,request.principal.id))return reply.code(403).send({error:"comment_owner_required"});
  const updated=await pool.query("UPDATE message_comments SET body=$2,updated_at=now() WHERE id=$1 RETURNING id,body,user_id,created_at,updated_at",[commentId,parsed.data.body]);await auditCrm(request.principal.id,"message_comment.update","message_comment",commentId,{conversationId,messageId});return updated.rows[0];
});

app.delete("/api/v1/conversations/:conversationId/messages/:messageId/comments/:commentId",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {conversationId,messageId,commentId}=request.params as {conversationId:string;messageId:string;commentId:string};const comment=await pool.query("SELECT mc.user_id,c.account_id FROM message_comments mc JOIN messages m ON m.id=mc.message_id JOIN conversations c ON c.id=m.conversation_id WHERE mc.id=$1 AND mc.message_id=$2 AND m.conversation_id=$3",[commentId,messageId,conversationId]);if(!comment.rowCount||!canAccessAccount(request.principal,comment.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(!canManageSharedRecord(request.principal.role,comment.rows[0].user_id,request.principal.id))return reply.code(403).send({error:"comment_owner_required"});await pool.query("DELETE FROM message_comments WHERE id=$1",[commentId]);await auditCrm(request.principal.id,"message_comment.delete","message_comment",commentId,{conversationId,messageId});return reply.code(204).send();
});

app.put("/api/v1/conversations/:conversationId/messages/:messageId/comments/:commentId/vote",{preHandler:authenticate},async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const parsed=messageCommentVoteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {conversationId,messageId,commentId}=request.params as {conversationId:string;messageId:string;commentId:string};const comment=await pool.query("SELECT c.account_id FROM message_comments mc JOIN messages m ON m.id=mc.message_id JOIN conversations c ON c.id=m.conversation_id WHERE mc.id=$1 AND mc.message_id=$2 AND m.conversation_id=$3",[commentId,messageId,conversationId]);if(!comment.rowCount||!canAccessAccount(request.principal,comment.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("INSERT INTO message_comment_votes(comment_id,user_id,value) VALUES($1,$2,$3) ON CONFLICT(comment_id,user_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[commentId,request.principal.id,parsed.data.value]);const votes=await pool.query("SELECT COALESCE(SUM(value),0)::int score,COALESCE(MAX(value) FILTER (WHERE user_id=$2),0)::int viewer_vote FROM message_comment_votes WHERE comment_id=$1",[commentId,request.principal.id]);return votes.rows[0];
});

app.post("/api/v1/messages", { preHandler:authenticate }, async (request, reply) => {
  const parsed=messageSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const result=await transaction(async(client)=>{
    const conversation=await client.query("SELECT c.id,c.account_id,a.agent_id,a.status,a.transport,a.platform,agent.protocol_version agent_protocol_version,agent.capabilities,co.provider_user_id,co.entity_type,wg.active group_active FROM conversations c JOIN channel_accounts a ON a.id=c.account_id LEFT JOIN agents agent ON agent.id=a.agent_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN whatsapp_groups wg ON wg.contact_id=co.id WHERE c.id=$1 AND c.account_id=$2",[parsed.data.conversationId,parsed.data.accountId]);
    if(!conversation.rowCount) return null;
    if(conversation.rows[0].entity_type==="group"){
      if(conversation.rows[0].transport!=="web"||!Array.isArray(conversation.rows[0].capabilities)||!conversation.rows[0].capabilities.includes("group_chat_v1"))throw Object.assign(new Error("agent_upgrade_required"),{statusCode:409});
      if(!conversation.rows[0].group_active)throw Object.assign(new Error("group_inactive"),{statusCode:409});
      if(parsed.data.type==="template")throw Object.assign(new Error("group_template_unsupported"),{statusCode:409});
    }
    if(parsed.data.mediaId){const media=await client.query("SELECT id FROM media WHERE id=$1 AND (account_id=$2 OR account_id IS NULL) AND status='ready'",[parsed.data.mediaId,parsed.data.accountId]);if(!media.rowCount)throw Object.assign(new Error("media_not_found"),{statusCode:404});}
    const existing=await client.query("SELECT id,status FROM messages WHERE account_id=$1 AND client_message_id=$2",[parsed.data.accountId,parsed.data.clientMessageId]); if(existing.rowCount)return {messageId:existing.rows[0].id,status:existing.rows[0].status,deduplicated:true,agentId:conversation.rows[0].agent_id};
    const quoted=parsed.data.quotedMessageId?await client.query("SELECT id,provider_message_id,direction,kind,text_content,sender_provider_user_id FROM messages WHERE id=$1 AND account_id=$2 AND conversation_id=$3",[parsed.data.quotedMessageId,parsed.data.accountId,parsed.data.conversationId]):null;
    if(parsed.data.quotedMessageId&&(!quoted?.rowCount||!quoted.rows[0].provider_message_id))throw Object.assign(new Error("quoted_message_not_found"),{statusCode:404});
    if(parsed.data.quotedMessageId&&conversation.rows[0].transport==="web"&&Number(conversation.rows[0].agent_protocol_version)!==2)throw Object.assign(new Error("agent_upgrade_required"),{statusCode:409});
    const templateText=parsed.data.type==="template"?`[Template] ${parsed.data.template!.name} (${parsed.data.template!.language})`:parsed.data.text??null;
    const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,translation_source_text,translation_target_language,media_id,quoted_message_id,status,occurred_at,provider_payload) VALUES($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,$10,'queued',now(),$11) RETURNING id,status",[parsed.data.conversationId,parsed.data.accountId,request.principal?.kind==='user'?request.principal.id:null,parsed.data.clientMessageId,parsed.data.type,templateText,parsed.data.translationSourceText??null,parsed.data.translationTargetLanguage??null,parsed.data.mediaId??null,parsed.data.quotedMessageId??null,parsed.data.template?JSON.stringify(parsed.data.template):null]);
    await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[parsed.data.conversationId]);
    if(request.principal?.kind==='user')await pauseAgentForHuman(client,parsed.data.conversationId);
    const outboundMessage={...parsed.data};delete outboundMessage.translationSourceText;delete outboundMessage.translationTargetLanguage;delete outboundMessage.quotedMessageId;
    if(quoted?.rowCount){const row=quoted.rows[0];Object.assign(outboundMessage,{quotedProviderMessageId:String(row.provider_message_id),quotedWhatsappMessageId:conversation.rows[0].platform==="whatsapp"?String(row.provider_message_id):undefined,quotedParticipantJid:row.sender_provider_user_id?String(row.sender_provider_user_id):undefined,quotedDirection:row.direction as "in"|"out",quotedText:String(row.text_content??`[${row.kind??"message"}]`)});}
    const queued=await queueChannelCommand(client,{accountId:parsed.data.accountId,conversationId:parsed.data.conversationId,messageId:message.rows[0].id,payload:{...outboundMessage,messageId:message.rows[0].id,toJid:conversation.rows[0].provider_user_id,destinationId:conversation.rows[0].provider_user_id} as Parameters<typeof queueChannelCommand>[1]["payload"]});
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'message.queue','message',$3,$4)",[request.principal?.kind,request.principal?.id,message.rows[0].id,JSON.stringify({commandId:queued.commandId})]);
    return {messageId:message.rows[0].id,status:"queued",deduplicated:false,agentId:queued.agentId};
  });
  if(!result)return reply.code(404).send({error:"conversation_not_found"});
  if(result.agentId)void dispatchPending(result.agentId); return reply.code(202).send(result);
});

app.post("/api/v1/messages/:id/retry", { preHandler:authenticate }, async (request, reply) => {
  const {id}=request.params as {id:string};
  const parsed=messageRetrySchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const result=await transaction(async client=>{
    const original=await client.query(
      `SELECT m.*,c.id conversation_id,c.account_id,a.agent_id,agent.capabilities,co.provider_user_id,co.entity_type,wg.active group_active,oc.payload command_payload
         FROM messages m
         JOIN conversations c ON c.id=m.conversation_id
         JOIN channel_accounts a ON a.id=c.account_id
         LEFT JOIN agents agent ON agent.id=a.agent_id
         JOIN contacts co ON co.id=c.contact_id
         LEFT JOIN whatsapp_groups wg ON wg.contact_id=co.id
         LEFT JOIN LATERAL (
           SELECT payload FROM outbound_commands WHERE message_id=m.id AND command='send_message' ORDER BY sequence DESC LIMIT 1
         ) oc ON true
        WHERE m.id=$1
        FOR UPDATE OF m`,
      [id],
    );
    if(!original.rowCount||!canAccessAccount(request.principal,original.rows[0].account_id))return null;
    const row=original.rows[0];
    if(row.entity_type==="group"&&(!Array.isArray(row.capabilities)||!row.capabilities.includes("group_chat_v1")))throw Object.assign(new Error("agent_upgrade_required"),{statusCode:409});
    if(row.entity_type==="group"&&!row.group_active)throw Object.assign(new Error("group_inactive"),{statusCode:409});
    const commandPayload=row.command_payload as Record<string,unknown>|null;
    if(commandPayload?.retryRequestId===parsed.data.clientMessageId)return{messageId:id,status:String(row.status),deduplicated:true,agentId:row.agent_id};
    if(row.direction!=="out"||!["failed","uncertain"].includes(String(row.status)))throw Object.assign(new Error("message_not_retryable"),{statusCode:409});
    if(!commandPayload)throw Object.assign(new Error("original_command_not_found"),{statusCode:409});
    const payload={...commandPayload,retryRequestId:parsed.data.clientMessageId,messageId:id,conversationId:String(row.conversation_id),accountId:String(row.account_id),toJid:String(row.provider_user_id)};
    const queued=await queueChannelCommand(client,{accountId:String(row.account_id),conversationId:String(row.conversation_id),messageId:id,payload:payload as unknown as Parameters<typeof queueChannelCommand>[1]["payload"]});
    await client.query("UPDATE messages SET status='queued',failure_code=NULL,failure_message=NULL,provider_message_id=NULL WHERE id=$1",[id]);
    await client.query("UPDATE conversations SET status='open',closed_at=NULL WHERE id=$1",[row.conversation_id]);
    if(request.principal?.kind==="user")await pauseAgentForHuman(client,row.conversation_id);
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'message.retry','message',$3,$4)",[request.principal?.kind,request.principal?.id,id,JSON.stringify({commandId:queued.commandId,originalStatus:row.status,reusedMessage:true})]);
    return{messageId:id,status:"queued",deduplicated:false,agentId:queued.agentId};
  });
  if(!result)return reply.code(404).send({error:"not_found"});
  if(result.agentId)void dispatchPending(result.agentId);
  return reply.code(202).send(result);
});

app.delete("/api/v1/conversations/:id/messages/failed", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
  const principal=request.principal;
  const {id}=request.params as {id:string};
  const result=await transaction(async client=>{
    const conversation=await client.query("SELECT id,account_id FROM conversations WHERE id=$1 FOR UPDATE",[id]);
    if(!conversation.rowCount||!canAccessAccount(principal,conversation.rows[0].account_id))return null;
    const deleted=await client.query("DELETE FROM messages WHERE conversation_id=$1 AND direction='out' AND status IN ('failed','uncertain') RETURNING id",[id]);
    const messageIds=deleted.rows.map(row=>String(row.id));
    if(messageIds.length){
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'message.clear_failed','conversation',$2,$3)",[principal.id,id,JSON.stringify({deletedCount:messageIds.length,messageIds})]);
    }
    return{deletedCount:messageIds.length};
  });
  return result?reply.send(result):reply.code(404).send({error:"not_found"});
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
    let context:Parameters<typeof translateText>[1]["context"];
    if(parsed.data.conversationId){
      const access=await pool.query("SELECT c.account_id,co.country,co.preferred_language FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[parsed.data.conversationId]);
      if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"conversation_not_found"});
      const recent=await pool.query("SELECT direction,text_content FROM messages WHERE conversation_id=$1 AND text_content IS NOT NULL AND btrim(text_content)<>'' ORDER BY occurred_at DESC,id DESC LIMIT 12",[parsed.data.conversationId]);
      context={customerCountry:access.rows[0].country??undefined,customerPreferredLanguage:access.rows[0].preferred_language??undefined,conversation:recent.rows.reverse().map(row=>({direction:String(row.direction)==="in"?"in":"out",text:String(row.text_content)}))};
    }
    const translatedText=await translateText(setting,{text:parsed.data.text,targetLanguage:parsed.data.targetLanguage,context});
    return{translatedText,targetLanguage:parsed.data.targetLanguage,provider:setting.provider,model:setting.model};
  }catch(error){request.log.error({provider:setting.provider,error:String(error)},"Translation preview failed");return reply.code(502).send({error:"translation_failed",message:"AI 翻译失败，请检查 Provider 配置或稍后重试"});}
});

app.post("/api/v1/translations/product-names/preview", {preHandler:authenticate}, async(request,reply)=>{
  const parsed=productNameTranslationPreviewSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const setting=await activeTranslationSetting();if(!setting)return reply.code(503).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  try{
    const translatedNames=await translateProductNames(setting,parsed.data);
    return{translatedNames,targetLanguage:parsed.data.targetLanguage,provider:setting.provider,model:setting.model};
  }catch(error){
    request.log.error({error:String(error)},"Product name translation preview failed");
    return reply.code(502).send({error:"translation_failed",message:"产品名称翻译失败，请稍后重试"});
  }
});

app.post("/api/v1/translations/messages", {preHandler:authenticate}, async(request,reply)=>{
  const parsed=messageTranslationsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const found=await pool.query("SELECT m.id,m.account_id,m.conversation_id,m.direction,m.kind,m.text_content,m.media_id,media.object_key,media.file_name,media.mime_type,media.byte_size,co.country customer_country,co.preferred_language customer_preferred_language,mt.translated_text,mt.source_language,transcription.transcript_text,transcription.source_language transcription_source_language FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts co ON co.id=c.contact_id LEFT JOIN media ON media.id=m.media_id LEFT JOIN message_translations mt ON mt.message_id=m.id AND mt.target_language=$2 LEFT JOIN message_transcriptions transcription ON transcription.message_id=m.id WHERE m.id=ANY($1::uuid[])",[parsed.data.messageIds,parsed.data.targetLanguage]);
  if(found.rowCount!==new Set(parsed.data.messageIds).size||found.rows.some(row=>!canAccessAccount(request.principal,row.account_id)))return reply.code(404).send({error:"message_not_found"});
  const requestedSourceLanguage=parsed.data.sourceLanguage;
  const languageMatches=(cached:unknown)=>!requestedSourceLanguage||String(cached??"").toLowerCase()===requestedSourceLanguage.toLowerCase();
  const hasCurrentTranslation=(row:Record<string,unknown>)=>Boolean(row.translated_text)&&languageMatches(row.source_language);
  const hasCurrentTranscription=(row:Record<string,unknown>)=>Boolean(row.transcript_text)&&languageMatches(row.transcription_source_language);
  const hasWrittenText=(row:Record<string,unknown>)=>["text","image","video","document"].includes(String(row.kind))&&Boolean(String(row.text_content??"").trim());
  const eligible=found.rows.filter(row=>row.direction==="in"&&(hasWrittenText(row)||(row.kind==="audio"&&row.media_id&&row.object_key&&(hasCurrentTranslation(row)||parsed.data.generateAudio))));
  const conversationIds=[...new Set(eligible.map(row=>String(row.conversation_id)))];
  const recentByConversation=new Map<string,Array<{direction:"in"|"out";text:string}>>();
  await Promise.all(conversationIds.map(async conversationId=>{
    const recent=await pool.query("SELECT direction,text_content FROM messages WHERE conversation_id=$1 AND text_content IS NOT NULL AND btrim(text_content)<>'' ORDER BY occurred_at DESC,id DESC LIMIT 12",[conversationId]);
    recentByConversation.set(conversationId,recent.rows.reverse().map(item=>({direction:String(item.direction)==="in"?"in":"out",text:String(item.text_content)})));
  }));
  const translationSetting=eligible.some(row=>!hasCurrentTranslation(row))?await activeTranslationSetting():null;
  const transcriptionSetting=eligible.some(row=>row.kind==="audio"&&!hasCurrentTranscription(row))?await activeTranscriptionSetting():null;
  if(eligible.some(row=>!hasCurrentTranslation(row))&&!translationSetting)return reply.code(503).send({error:"translation_not_configured",message:"管理员尚未启用 AI 翻译 Provider"});
  if(eligible.some(row=>row.kind==="audio"&&!hasCurrentTranscription(row))&&!transcriptionSetting)return reply.code(503).send({error:"transcription_not_configured",message:"管理员尚未启用语音转写 Provider"});
  const generated=await mapWithConcurrency(eligible.filter(row=>!hasCurrentTranslation(row)),3,row=>singleFlight(messageTranslationFlights,`${row.id}:${parsed.data.targetLanguage}:${requestedSourceLanguage??"auto"}`,async()=>{
    try{
      let sourceText=String(row.text_content??"").trim();
      if(row.kind==="audio"){
        sourceText=hasCurrentTranscription(row)?String(row.transcript_text??"").trim():"";
        if(!sourceText){
          sourceText=await singleFlight(transcriptionFlights,`${row.id}:${requestedSourceLanguage??"auto"}`,async()=>{
            if(Number(row.byte_size)>25*1024*1024)throw new Error("audio_too_large");
            const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:row.object_key}));
            if(!object.Body)throw new Error("audio_body_missing");
            const bytes=Buffer.from(await object.Body.transformToByteArray());
            const audio=await normalizeTranscriptionAudio({bytes,fileName:row.file_name??`voice-${row.id}.ogg`,mimeType:row.mime_type??"audio/ogg"});
            const transcript=await transcribeAudio(transcriptionSetting!,{...audio,sourceLanguage:requestedSourceLanguage});
            await pool.query("INSERT INTO message_transcriptions(message_id,transcript_text,source_language,provider,model) VALUES($1,$2,$3,$4,$5) ON CONFLICT(message_id) DO UPDATE SET transcript_text=EXCLUDED.transcript_text,source_language=EXCLUDED.source_language,provider=EXCLUDED.provider,model=EXCLUDED.model,created_at=now()",[row.id,transcript,requestedSourceLanguage??null,transcriptionSetting!.provider,transcriptionSetting!.transcriptionModel]);
            return transcript;
          });
        }
      }
      const detected=await translateTextWithDetection(translationSetting!,{text:sourceText,targetLanguage:parsed.data.targetLanguage,sourceLanguage:requestedSourceLanguage,context:{customerCountry:row.customer_country??undefined,customerPreferredLanguage:row.customer_preferred_language??undefined,conversation:recentByConversation.get(String(row.conversation_id))}});
      await pool.query("INSERT INTO message_translations(message_id,target_language,translated_text,source_language,provider,model) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id,target_language) DO UPDATE SET translated_text=EXCLUDED.translated_text,source_language=EXCLUDED.source_language,provider=EXCLUDED.provider,model=EXCLUDED.model,created_at=now()",[row.id,parsed.data.targetLanguage,detected.translatedText,detected.sourceLanguage,translationSetting!.provider,translationSetting!.model]);
      return{id:row.id,translatedText:detected.translatedText,sourceText,sourceLanguage:detected.sourceLanguage};
    }catch(error){const failure=translationFailure(error);request.log.error({messageId:row.id,provider:translationSetting?.provider,error:String(error),failure:failure.error},"Incoming message translation failed");return{id:row.id,...failure};}
  }));
  const generatedById=new Map(generated.map(item=>[item.id,item]));
  return{data:parsed.data.messageIds.map(messageId=>{const row=found.rows.find(item=>item.id===messageId);const isWritten=Boolean(row&&hasWrittenText(row));const isAudio=row?.kind==="audio"&&row.media_id&&row.object_key;if(!row||row.direction!=="in"||(!isWritten&&!isAudio)||(isAudio&&!hasCurrentTranslation(row)&&!parsed.data.generateAudio))return{messageId,status:"skipped"};const item=generatedById.get(messageId);if(item?.error)return{messageId,status:"failed",error:item.error,message:item.message};return{messageId,status:"translated",translatedText:hasCurrentTranslation(row)?row.translated_text:item?.translatedText,sourceLanguage:hasCurrentTranslation(row)?row.source_language:item?.sourceLanguage,...(isAudio?{sourceText:hasCurrentTranscription(row)?row.transcript_text:item?.sourceText}:{})};})};
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
  const current=await pool.query("SELECT api_key_encrypted,transcription_model FROM translation_provider_settings WHERE provider=$1",[provider]);const encrypted=parsed.data.apiKey?encryptAtRest(parsed.data.apiKey,config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;const legacyTranscriptionModel=parsed.data.transcriptionModel??current.rows[0]?.transcription_model??"gpt-4o-mini-transcribe";if(parsed.data.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required",message:"启用 Provider 前必须填写 API Key"});
  await transaction(async client=>{if(parsed.data.enabled)await client.query("UPDATE translation_provider_settings SET enabled=false,updated_at=now() WHERE enabled=true AND provider<>$1",[provider]);await client.query("INSERT INTO translation_provider_settings(provider,enabled,api_key_encrypted,base_url,model,transcription_model,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,transcription_model=EXCLUDED.transcription_model,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,encrypted,parsed.data.baseUrl,parsed.data.model,legacyTranscriptionModel,actorId]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'translation_provider.update','translation_provider',$2,$3)",[actorId,provider,JSON.stringify({enabled:parsed.data.enabled,baseUrl:parsed.data.baseUrl,model:parsed.data.model,keyChanged:Boolean(parsed.data.apiKey)})]);});
  return{provider,enabled:parsed.data.enabled,keyConfigured:Boolean(encrypted),baseUrl:parsed.data.baseUrl,model:parsed.data.model};
});

app.get("/api/v1/admin/transcription-providers", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  reply.header("cache-control","no-store");
  const result=await pool.query("SELECT provider,enabled,api_key_encrypted,base_url,model,updated_at FROM transcription_provider_settings");
  const rows=new Map(result.rows.map(row=>[row.provider,row]));
  return{data:TRANSLATION_PROVIDERS.map(provider=>{const row=rows.get(provider);return{provider,enabled:Boolean(row?.enabled),keyConfigured:Boolean(row?.api_key_encrypted),apiKey:row?.api_key_encrypted?decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY):"",baseUrl:row?.base_url??translationProviderDefaults(provider).baseUrl,model:row?.model??(provider==="openai"?"gpt-4o-mini-transcribe":""),updatedAt:row?.updated_at??null};})};
});

app.put("/api/v1/admin/transcription-providers/:provider", {preHandler:authenticate}, async(request,reply)=>{
  if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
  const {provider}=request.params as {provider:string};
  if(!TRANSLATION_PROVIDERS.includes(provider as TranslationProvider))return reply.code(404).send({error:"provider_not_found"});
  const parsed=transcriptionProviderSettingsSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  const actorId=request.principal.id;
  const current=await pool.query("SELECT api_key_encrypted FROM transcription_provider_settings WHERE provider=$1",[provider]);
  const encrypted=parsed.data.apiKey?encryptAtRest(parsed.data.apiKey,config.DATA_ENCRYPTION_KEY):current.rows[0]?.api_key_encrypted??null;
  if(parsed.data.enabled&&!encrypted)return reply.code(400).send({error:"api_key_required",message:"启用 Provider 前必须填写 API Key"});
  await transaction(async client=>{
    if(parsed.data.enabled)await client.query("UPDATE transcription_provider_settings SET enabled=false,updated_at=now() WHERE enabled=true AND provider<>$1",[provider]);
    await client.query("INSERT INTO transcription_provider_settings(provider,enabled,api_key_encrypted,base_url,model,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,api_key_encrypted=EXCLUDED.api_key_encrypted,base_url=EXCLUDED.base_url,model=EXCLUDED.model,updated_by=EXCLUDED.updated_by,updated_at=now()",[provider,parsed.data.enabled,encrypted,parsed.data.baseUrl,parsed.data.model,actorId]);
  });
  return{provider,enabled:parsed.data.enabled,keyConfigured:Boolean(encrypted),baseUrl:parsed.data.baseUrl,model:parsed.data.model};
});

app.post("/api/v1/text-to-speech", {preHandler:authenticate}, async(request,reply)=>{
  const parsed=textToSpeechSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
  if(!canAccessAccount(request.principal,parsed.data.accountId))return reply.code(403).send({error:"account_forbidden"});
  const account=await pool.query("SELECT id FROM channel_accounts WHERE id=$1",[parsed.data.accountId]);if(!account.rowCount)return reply.code(404).send({error:"account_not_found"});
  const configured=await pool.query("SELECT provider,api_key_encrypted,base_url,model,voice FROM tts_provider_settings WHERE enabled=true LIMIT 1");if(!configured.rowCount||!configured.rows[0].api_key_encrypted)return reply.code(503).send({error:"tts_not_configured",message:"管理员尚未启用文字转语音 Provider"});
  const setting=configured.rows[0];let generated:Awaited<ReturnType<typeof generateSpeech>>;
  try{generated=await generateSpeech({provider:setting.provider as TtsProvider,apiKey:decryptAtRest(setting.api_key_encrypted,config.DATA_ENCRYPTION_KEY),baseUrl:setting.base_url,model:setting.model,voice:setting.voice},parsed.data);}catch(error){request.log.error({provider:setting.provider,error:String(error)},"Text-to-speech provider request failed");return reply.code(502).send({error:"tts_generation_failed",message:ttsProviderFailureMessage(error)});}
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
  const query=request.query as {accountId?:string;q?:string;kind?:string;limit?:string;offset?:string};if(!query.accountId)return reply.code(400).send({error:"account_required"});if(!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const limit=Math.min(100,Math.max(1,Number(query.limit??60))),offset=Math.max(0,Number(query.offset??0)),keyword=query.q?.trim()||null,kind=["image","video","audio","document"].includes(query.kind??"")?query.kind!:"all";
  const where="(m.account_id=$1 OR m.account_id IS NULL) AND m.status='ready' AND ($2::text IS NULL OR m.file_name ILIKE '%'||$2||'%') AND ($3::text='all' OR $3='image' AND m.mime_type LIKE 'image/%' OR $3='video' AND m.mime_type LIKE 'video/%' OR $3='audio' AND m.mime_type LIKE 'audio/%' OR $3='document' AND m.mime_type NOT LIKE 'image/%' AND m.mime_type NOT LIKE 'video/%' AND m.mime_type NOT LIKE 'audio/%')";
  const [result,count]=await Promise.all([pool.query(`SELECT m.id,m.file_name,m.mime_type,m.byte_size,m.sha256,m.created_at,((SELECT COUNT(*) FROM messages msg WHERE msg.media_id=m.id)+(SELECT COUNT(*) FROM order_items item WHERE item.image_media_id=m.id)+(SELECT COUNT(*) FROM orders o WHERE o.rendered_media_id=m.id)+(SELECT COUNT(*) FROM products p WHERE p.image_media_id=m.id)+(SELECT COUNT(*) FROM email_attachments e WHERE e.media_id=m.id)+(SELECT COUNT(*) FROM material_assets a WHERE a.media_id=m.id)+(SELECT COUNT(*) FROM collage_templates t WHERE t.deleted_at IS NULL AND (t.template->'canvas'->>'backgroundMediaId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.template->'layers') layer WHERE layer->>'mediaId'=m.id::text))))::int usage_count FROM media m WHERE ${where} ORDER BY m.created_at DESC,m.id DESC LIMIT $4 OFFSET $5`,[query.accountId,keyword,kind,limit,offset]),pool.query(`SELECT COUNT(*)::int total FROM media m WHERE ${where}`,[query.accountId,keyword,kind])]);return{data:result.rows,total:Number(count.rows[0]?.total??0),limit,offset};
});

app.get("/api/v1/media/:id", {preHandler:authenticate}, async(request,reply)=>{
  const {id}=request.params as {id:string},{preview}=request.query as {preview?:string};const found=await pool.query("SELECT id,account_id,object_key,file_name,mime_type,sha256 FROM media WHERE id=$1 AND status='ready'",[id]);
  if(!found.rowCount)return reply.code(404).send({error:"not_found"});let item=found.rows[0];if(item.account_id&&!canAccessAccount(request.principal,item.account_id))return reply.code(403).send({error:"account_forbidden"});
  if(String(item.mime_type).startsWith("video/")&&!isBrowserCompatibleVideo(String(item.mime_type)))try{item=await ensureStoredVideoIsBrowserCompatible(String(item.id),item);}catch(error){request.log.warn({error,mediaId:id},"stored video normalization failed");}
  const wantsPreview=preview==="1"&&String(item.mime_type).startsWith("image/"),etag=strongEtag(`${String(item.sha256)}${wantsPreview?"-preview-768-webp-v1":""}`);reply.header("content-type",wantsPreview?"image/webp":item.mime_type).header("content-disposition",`${String(item.mime_type).startsWith("image/")||String(item.mime_type).startsWith("video/")||String(item.mime_type).startsWith("audio/")?"inline":"attachment"}; filename*=UTF-8''${encodeURIComponent(wantsPreview?"preview.webp":item.file_name??"attachment")}`).header("cache-control",IMMUTABLE_PRIVATE_CACHE_CONTROL).header("etag",etag);
  if(ifNoneMatchMatches(request.headers["if-none-match"],etag))return reply.code(304).send();
  if(wantsPreview)return reply.send(await materializeMediaPreview(String(item.sha256),String(item.object_key)));
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));return reply.send(object.Body);
});

async function materializeMediaPreview(sha256:string,objectKey:string):Promise<Buffer>{
  const cached=mediaPreviewCache.get(sha256);if(cached)return cached;
  const running=mediaPreviewJobs.get(sha256);if(running)return running;
  const job=(async()=>{const source=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey}));if(!source.Body)throw new Error("media_source_missing");const {default:sharp}=await import("sharp"),preview=await sharp(Buffer.from(await source.Body.transformToByteArray())).resize({width:768,withoutEnlargement:true,fit:"inside"}).webp({quality:78,effort:3}).toBuffer();if(mediaPreviewCache.size>=100){const oldest=mediaPreviewCache.keys().next().value;if(oldest)mediaPreviewCache.delete(oldest);}mediaPreviewCache.set(sha256,preview);return preview;})();
  mediaPreviewJobs.set(sha256,job);
  try{return await job;}finally{if(mediaPreviewJobs.get(sha256)===job)mediaPreviewJobs.delete(sha256);}
}

async function ensureStoredVideoIsBrowserCompatible(mediaId:string,item:{object_key:string;file_name:string;mime_type:string;sha256:string}):Promise<{object_key:string;file_name:string;mime_type:string;sha256:string}>{
  const running=videoNormalizationJobs.get(mediaId);if(running)return running;
  const job=(async()=>{
    const source=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key}));if(!source.Body)throw new Error("video_source_missing");
    const normalized=await normalizeBrowserVideo({bytes:Buffer.from(await source.Body.transformToByteArray()),fileName:item.file_name??"video",mimeType:item.mime_type});
    const sha256=createHash("sha256").update(normalized.bytes).digest("hex"),objectKey=`normalized/${new Date().toISOString().slice(0,10)}/${mediaId}/${sha256}.mp4`;
    await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:normalized.bytes,ContentType:normalized.mimeType,Metadata:{sha256,source:"browser-video-normalizer"}}));
    const updated=await pool.query("UPDATE media SET object_key=$2,file_name=$3,mime_type=$4,byte_size=$5,sha256=$6 WHERE id=$1 AND object_key=$7 RETURNING object_key,file_name,mime_type,sha256",[mediaId,objectKey,normalized.fileName,normalized.mimeType,normalized.bytes.length,sha256,item.object_key]);
    if(updated.rowCount){void s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:item.object_key})).catch(()=>undefined);return updated.rows[0];}
    void s3.send(new DeleteObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey})).catch(()=>undefined);
    const current=await pool.query("SELECT object_key,file_name,mime_type,sha256 FROM media WHERE id=$1 AND status='ready'",[mediaId]);if(!current.rowCount)throw new Error("video_media_missing");return current.rows[0];
  })();
  videoNormalizationJobs.set(mediaId,job);
  try{return await job;}finally{if(videoNormalizationJobs.get(mediaId)===job)videoNormalizationJobs.delete(mediaId);}
}

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

app.get("/api/v1/accounts/:id/agent-settings",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});const result=await pool.query("SELECT account_id,enabled,persona,reply_language,reply_suggestion_instructions,timezone,business_days,business_start::text,business_end::text,confidence_threshold,followup_enabled,followup_delays_hours,default_conversation_mode,updated_at FROM account_agent_settings WHERE account_id=$1",[id]);const assigned=await pool.query("SELECT knowledge_base_id FROM account_knowledge_bases WHERE account_id=$1",[id]);return{...(result.rows[0]??{account_id:id,enabled:false,persona:'You are a helpful, concise customer service agent.',reply_language:'auto',reply_suggestion_instructions:'',timezone:'UTC',business_days:[1,2,3,4,5],business_start:'09:00',business_end:'18:00',confidence_threshold:.8,followup_enabled:true,followup_delays_hours:[24,72],default_conversation_mode:'human_paused'}),knowledgeBaseIds:assigned.rows.map(row=>row.knowledge_base_id)};});

app.put("/api/v1/accounts/:id/agent-settings",{preHandler:authenticate},async(request,reply)=>{if(!["admin","supervisor"].includes(request.principal?.role??""))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});const body=(request.body??{}) as Record<string,unknown>;const days=Array.isArray(body.businessDays)?body.businessDays.map(Number):[1,2,3,4,5],delays=Array.isArray(body.followupDelaysHours)?body.followupDelaysHours.map(Number):[24,72],threshold=Number(body.confidenceThreshold??.8),modeResult=body.defaultConversationMode===undefined?null:conversationAgentModeSchema.safeParse(body.defaultConversationMode);if(!days.every(day=>Number.isInteger(day)&&day>=0&&day<=6)||delays.length>5||!delays.every((value,index)=>Number.isInteger(value)&&value>0&&(index===0||value>delays[index-1]))||threshold<0||threshold>1||(modeResult&&!modeResult.success))return reply.code(400).send({error:"invalid_request"});
  const knowledgeBaseIds=Array.isArray(body.knowledgeBaseIds)?body.knowledgeBaseIds.map(String):[],defaultConversationMode=modeResult?.success?modeResult.data:null,replySuggestionInstructions=String(body.suggestionInstructions??"").trim().slice(0,4000);await transaction(async client=>{await client.query("INSERT INTO account_agent_settings(account_id,enabled,persona,reply_language,reply_suggestion_instructions,timezone,business_days,business_start,business_end,confidence_threshold,followup_enabled,followup_delays_hours,default_conversation_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'human_paused')) ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,persona=EXCLUDED.persona,reply_language=EXCLUDED.reply_language,reply_suggestion_instructions=EXCLUDED.reply_suggestion_instructions,timezone=EXCLUDED.timezone,business_days=EXCLUDED.business_days,business_start=EXCLUDED.business_start,business_end=EXCLUDED.business_end,confidence_threshold=EXCLUDED.confidence_threshold,followup_enabled=EXCLUDED.followup_enabled,followup_delays_hours=EXCLUDED.followup_delays_hours,default_conversation_mode=COALESCE($13,account_agent_settings.default_conversation_mode),updated_at=now()",[id,Boolean(body.enabled),String(body.persona??"").slice(0,5000)||"You are a helpful, concise customer service agent.",String(body.replyLanguage??"auto").slice(0,35),replySuggestionInstructions,String(body.timezone??"UTC").slice(0,100),days,String(body.businessStart??"09:00"),String(body.businessEnd??"18:00"),threshold,body.followupEnabled!==false,delays,defaultConversationMode]);await client.query("DELETE FROM account_knowledge_bases WHERE account_id=$1",[id]);if(knowledgeBaseIds.length)await client.query("INSERT INTO account_knowledge_bases(account_id,knowledge_base_id) SELECT $1,id FROM knowledge_bases WHERE id=ANY($2::uuid[])",[id,knowledgeBaseIds]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'agent.account_settings.update','whatsapp_account',$2,$3)",[request.principal!.id,id,JSON.stringify({enabled:Boolean(body.enabled),defaultConversationMode,replySuggestionInstructions,knowledgeBaseIds})]);});return reply.code(204).send();});

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

app.get("/api/v1/conversations/:id/agent",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const conversation=await pool.query("SELECT c.account_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(conversation.rows[0].entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});const [state,draft,runs]=await Promise.all([pool.query("SELECT COALESCE(st.mode,'human_paused') mode,st.pause_reason,COALESCE(st.followup_count,0) followup_count,COALESCE(s.enabled,false) account_enabled FROM conversations c LEFT JOIN conversation_agent_state st ON st.conversation_id=c.id LEFT JOIN account_agent_settings s ON s.account_id=c.account_id WHERE c.id=$1",[id]),pool.query("SELECT id,text_content,reply_zh,reason,citations,created_at FROM ai_drafts WHERE conversation_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[id]),pool.query("SELECT id,kind,decision,confidence,citations,status,error,created_at,completed_at FROM agent_runs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20",[id])]);return{...state.rows[0],draft:draft.rows[0]??null,runs:runs.rows};});
app.post("/api/v1/conversations/:id/reply-suggestion",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {previousReply?:string};const conversation=await pool.query("SELECT c.account_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(conversation.rows[0].entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});const suggestion=await generateSalesReplySuggestion(id,String(body.previousReply??"").slice(0,8_000));return reply.send(suggestion);});
app.put("/api/v1/conversations/:id/agent",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {mode?:string};if(!["cautious","full","human_paused"].includes(body.mode??""))return reply.code(400).send({error:"invalid_mode"});const conversation=await pool.query("SELECT c.account_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});if(conversation.rows[0].entity_type==="group")return reply.code(409).send({error:"group_feature_unavailable"});await transaction(async client=>{await client.query("SELECT id FROM conversations WHERE id=$1 FOR UPDATE",[id]);await client.query("INSERT INTO conversation_agent_state(conversation_id,mode,pause_reason) VALUES($1,$2,$3) ON CONFLICT(conversation_id) DO UPDATE SET mode=EXCLUDED.mode,pause_reason=EXCLUDED.pause_reason,updated_at=now()",[id,body.mode,body.mode==="human_paused"?"manual_pause":null]);if(body.mode==="full")await client.query("UPDATE ai_drafts SET status='dismissed',resolved_at=now(),resolved_by=$2 WHERE conversation_id=$1 AND status='pending'",[id,request.principal!.id]);if(body.mode==="human_paused")await client.query("UPDATE agent_jobs SET state='cancelled',completed_at=now(),last_error='manual_pause' WHERE conversation_id=$1 AND state='pending' AND kind IN ('reply','followup')",[id]);});return{mode:body.mode};});
app.get("/api/v1/conversations/:id/memory",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const conversation=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!conversation.rowCount||!canAccessAccount(request.principal,conversation.rows[0].account_id))return reply.code(404).send({error:"not_found"});const [memory,facts,rebuild]=await Promise.all([pool.query("SELECT summary,source_message_id,updated_at FROM conversation_memories WHERE conversation_id=$1",[id]),pool.query("SELECT f.id,f.fact_key,f.fact_value,f.confidence,f.source_message_id,f.updated_at,m.text_content source_text FROM customer_memory_facts f LEFT JOIN messages m ON m.id=f.source_message_id WHERE f.conversation_id=$1 ORDER BY f.updated_at DESC",[id]),pool.query("SELECT id,state,last_error,created_at,completed_at FROM agent_jobs WHERE conversation_id=$1 AND kind='refresh_memory' ORDER BY created_at DESC LIMIT 1",[id])]);return{summary:memory.rows[0]?.summary??"",updatedAt:memory.rows[0]?.updated_at??null,facts:facts.rows,rebuild:rebuild.rows[0]??null};});
app.get("/api/v1/conversations/:id/memory/rebuild/:jobId",{preHandler:authenticate},async(request,reply)=>{const {id,jobId}=request.params as {id:string;jobId:string};const result=await pool.query("SELECT j.id,j.state,j.last_error,j.created_at,j.completed_at,c.account_id FROM agent_jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=$1 AND j.conversation_id=$2 AND j.kind='refresh_memory'",[jobId,id]);if(!result.rowCount||!canAccessAccount(request.principal,result.rows[0].account_id))return reply.code(404).send({error:"not_found"});const row=result.rows[0];return{id:row.id,state:row.state,last_error:row.last_error,created_at:row.created_at,completed_at:row.completed_at};});
app.patch("/api/v1/conversations/:id/memory/facts/:factId",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id,factId}=request.params as {id:string;factId:string};const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});const body=(request.body??{}) as {key?:string;value?:string};if(!body.key?.trim()||!body.value?.trim())return reply.code(400).send({error:"invalid_request"});const result=await pool.query("UPDATE customer_memory_facts SET fact_key=$3,fact_value=$4,confidence=1,updated_at=now() WHERE id=$1 AND conversation_id=$2 RETURNING *",[factId,id,body.key.trim().slice(0,120),body.value.trim().slice(0,1000)]);return result.rowCount?result.rows[0]:reply.code(404).send({error:"not_found"});});
app.delete("/api/v1/conversations/:id/memory/facts/:factId",{preHandler:authenticate},async(request,reply)=>{const {id,factId}=request.params as {id:string;factId:string};const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("DELETE FROM customer_memory_facts WHERE id=$1 AND conversation_id=$2",[factId,id]);return reply.code(204).send();});
app.post("/api/v1/conversations/:id/memory/rebuild",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const access=await pool.query("SELECT account_id FROM conversations WHERE id=$1",[id]);if(!access.rowCount||!canAccessAccount(request.principal,access.rows[0].account_id))return reply.code(404).send({error:"not_found"});const job=await transaction(async client=>{await client.query("SELECT id FROM conversations WHERE id=$1 FOR UPDATE",[id]);const active=await client.query("SELECT id,state FROM agent_jobs WHERE conversation_id=$1 AND kind='refresh_memory' AND state IN ('pending','processing') ORDER BY created_at DESC LIMIT 1",[id]);if(active.rowCount)return active.rows[0];const created=await client.query("INSERT INTO agent_jobs(conversation_id,kind,payload) VALUES($1,'refresh_memory',$2) RETURNING id,state",[id,JSON.stringify({memoryOnly:true})]);return created.rows[0];});return reply.code(202).send({id:job.id,status:job.state});});
app.post("/api/v1/ai-drafts/:id/send",{preHandler:authenticate},async(request,reply)=>{if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});const {id}=request.params as {id:string};const body=(request.body??{}) as {text?:string};const result=await transaction(async client=>{const draft=await client.query("SELECT d.id,d.conversation_id,d.text_content,c.account_id,a.agent_id,co.provider_user_id FROM ai_drafts d JOIN conversations c ON c.id=d.conversation_id JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id WHERE d.id=$1 AND d.status='pending' FOR UPDATE",[id]);if(!draft.rowCount||!canAccessAccount(request.principal,draft.rows[0].account_id))return null;const row=draft.rows[0],text=body.text?.trim()||row.text_content,clientMessageId=`draft-${id}`;const message=await client.query("INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,$4,'out','text',$5,'queued',now()) ON CONFLICT(account_id,client_message_id) DO UPDATE SET text_content=messages.text_content RETURNING id",[row.conversation_id,row.account_id,request.principal!.id,clientMessageId,text]);const existing=await client.query("SELECT 1 FROM outbound_commands WHERE message_id=$1",[message.rows[0].id]);let agentId:string|null=row.agent_id;if(!existing.rowCount){const queued=await queueChannelCommand(client,{accountId:row.account_id,conversationId:row.conversation_id,messageId:message.rows[0].id,payload:{accountId:row.account_id,conversationId:row.conversation_id,clientMessageId,type:"text",text,messageId:message.rows[0].id,toJid:row.provider_user_id}});agentId=queued.agentId;}await client.query("UPDATE ai_drafts SET status='sent',resolved_at=now(),resolved_by=$2 WHERE id=$1",[id,request.principal!.id]);await pauseAgentForHuman(client,row.conversation_id);return{messageId:message.rows[0].id,agentId};});if(!result)return reply.code(404).send({error:"not_found"});if(result.agentId)void dispatchPending(result.agentId);return reply.code(202).send(result);});
app.post("/api/v1/ai-drafts/:id/dismiss",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const draft=await pool.query("SELECT c.account_id FROM ai_drafts d JOIN conversations c ON c.id=d.conversation_id WHERE d.id=$1",[id]);if(!draft.rowCount||!canAccessAccount(request.principal,draft.rows[0].account_id))return reply.code(404).send({error:"not_found"});await pool.query("UPDATE ai_drafts SET status='dismissed',resolved_at=now(),resolved_by=$2 WHERE id=$1 AND status='pending'",[id,request.principal?.id]);return reply.code(204).send();});

app.post("/api/v1/media", { preHandler:authenticate }, async (request,reply) => {
  const query=request.query as {accountId?:string};if(!query.accountId)return reply.code(400).send({error:"account_required"});if(!canAccessAccount(request.principal,query.accountId))return reply.code(403).send({error:"account_forbidden"});
  const file=await request.file(); if(!file)return reply.code(400).send({error:"file_required"});
  const allowed=new Set(["image/jpeg","image/png","image/webp","video/mp4","audio/ogg","audio/mpeg","application/pdf","application/zip","text/plain","text/csv","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation"]); if(!allowed.has(file.mimetype))return reply.code(415).send({error:"unsupported_media_type"});
  const sourceBytes=await file.toBuffer();let normalized={bytes:sourceBytes,fileName:file.filename,mimeType:file.mimetype};if(file.mimetype.startsWith("video/"))try{normalized=await normalizeBrowserVideo(normalized);}catch(error){request.log.warn({error},"uploaded video normalization failed");}const sha256=createHash("sha256").update(normalized.bytes).digest("hex");const existing=await pool.query("SELECT id,file_name,mime_type,byte_size,sha256 FROM media WHERE account_id=$1 AND sha256=$2 AND status='ready' ORDER BY created_at DESC LIMIT 1",[query.accountId,sha256]);if(existing.rowCount)return reply.code(200).send({mediaId:existing.rows[0].id,fileName:existing.rows[0].file_name,mimeType:existing.rows[0].mime_type,size:Number(existing.rows[0].byte_size),sha256,deduplicated:true}); const id=randomBytes(16).toString("hex"); const objectKey=`uploads/${query.accountId}/${new Date().toISOString().slice(0,10)}/${id}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:normalized.bytes,ContentType:normalized.mimeType,Metadata:{sha256}}));
  const media=await transaction(async client=>{const created=await client.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[query.accountId,objectKey,normalized.fileName,normalized.mimeType,normalized.bytes.length,sha256]);await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES($1,$2,'media.upload','media',$3,$4)",[request.principal?.kind,request.principal?.id,created.rows[0].id,JSON.stringify({accountId:query.accountId,fileName:normalized.fileName,mimeType:normalized.mimeType,byteSize:normalized.bytes.length,sha256})]);return created;}); return reply.code(201).send({mediaId:media.rows[0].id,fileName:normalized.fileName,mimeType:normalized.mimeType,size:normalized.bytes.length,sha256});
});

app.setErrorHandler((error,_request,reply)=>{app.log.error(error);void reply.code((error as {statusCode?:number}).statusCode??500).send({error:"internal_error",message:config.NODE_ENV==="production"?"服务暂时不可用":error instanceof Error?error.message:String(error)});});

await registerAgentHub(app);

async function activeTranslationSetting():Promise<TranslationProviderSetting|null>{
  const result=await pool.query("SELECT provider,api_key_encrypted,base_url,model FROM translation_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1");
  if(!result.rowCount)return null;const row=result.rows[0];
  return{provider:row.provider as TranslationProvider,apiKey:decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY),baseUrl:row.base_url,model:row.model};
}

async function activeTranscriptionSetting():Promise<TranscriptionProviderSetting|null>{
  const result=await pool.query("SELECT provider,api_key_encrypted,base_url,model FROM transcription_provider_settings WHERE enabled=true AND api_key_encrypted IS NOT NULL LIMIT 1");
  if(!result.rowCount)return null;const row=result.rows[0];
  return{provider:row.provider as TranslationProvider,apiKey:decryptAtRest(row.api_key_encrypted,config.DATA_ENCRYPTION_KEY),baseUrl:row.base_url,model:"",transcriptionModel:row.model};
}

async function mapWithConcurrency<T,R>(items:T[],limit:number,work:(item:T)=>Promise<R>):Promise<R[]>{
  const results=new Array<R>(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const index=cursor++;results[index]=await work(items[index]);}}));
  return results;
}

type ProductLabelInput={name:string;color:string};
type OrderProductInput={name:string;sku?:string;quantity:number;unitAmount:number;weightAmount?:number|null;weightUnit?:"g"|"kg"|"lbs"|"oz"|null;shippingClassId?:string|null;imageMediaId?:string;productId?:string;variantId?:string;clientProductId?:string};
type CustomerAddressInput={label:string;recipientName?:string;phone?:string;address:string;countryCode?:string;province?:string;city?:string;street1?:string;street2?:string;postalCode?:string};

function mapContactRow(row:Record<string,unknown>){
  const emails=Array.isArray(row.emails)?row.emails as Array<{id:string;label:string;email:string;isPrimary:boolean}>:[],methods=Array.isArray(row.methods)?row.methods as Array<{id:string;type:string;label:string;value:string}>:[],addresses=Array.isArray(row.addresses)?row.addresses:[],specialDates=Array.isArray(row.special_dates)?row.special_dates:[];
  const zone=resolveContactTimeZone(String(row.phone_e164??""),row.timezone?String(row.timezone):null);
  return{id:String(row.id),accountId:String(row.account_id),accountName:String(row.account_name??""),platform:String(row.platform??"whatsapp"),transport:String(row.transport??"web"),providerUserId:String(row.provider_user_id??""),alias:String(row.alias??""),contactName:String(row.contact_name??""),firstName:String(row.first_name??""),middleName:String(row.middle_name??""),lastName:String(row.last_name??""),companyName:String(row.company_name??""),jobTitle:String(row.job_title??""),country:String(row.country??""),province:String(row.province??""),city:String(row.city??""),name:String(row.alias||row.contact_name||row.phone_e164||row.provider_user_id||"未知联系人"),phone:String(row.phone_e164??""),avatarUrl:row.avatar_url?`/api/v1/contacts/${row.id}/avatar`:null,note:String(row.note??""),timezone:row.timezone?String(row.timezone):null,preferredLanguage:row.preferred_language?String(row.preferred_language):null,effectiveTimezone:zone.timeZone,timezoneSource:zone.source,inferredCountry:zone.country,birthday:row.birthday_month?{month:Number(row.birthday_month),day:Number(row.birthday_day),year:row.birthday_year?Number(row.birthday_year):null}:null,specialDates,emails,primaryEmail:primaryContactEmail(emails),methods,addresses,conversationId:row.conversation_id?String(row.conversation_id):null,hasConversation:Boolean(row.conversation_id),lastMessageAt:row.last_message_at?String(row.last_message_at):null,blockedAt:row.whatsapp_blocked_at?String(row.whatsapp_blocked_at):null,updatedAt:String(row.updated_at??"")};
}

async function contactProfileById(db:typeof pool|PoolClient,id:string){
  const [contact,emails,methods,addresses,specialDates]=await Promise.all([
    db.query("SELECT co.id,co.account_id,a.display_name account_name,a.platform,a.transport,co.provider_user_id,co.alias,co.display_name contact_name,co.first_name,co.middle_name,co.last_name,co.company_name,co.job_title,co.country,co.province,co.city,co.phone_e164,co.avatar_url,co.note,co.timezone,co.preferred_language,co.birthday_month,co.birthday_day,co.birthday_year,co.whatsapp_blocked_at,co.updated_at,c.id conversation_id,c.last_message_at FROM contacts co JOIN channel_accounts a ON a.id=co.account_id LEFT JOIN conversations c ON c.contact_id=co.id WHERE co.id=$1 AND co.entity_type='person'",[id]),
    db.query("SELECT id,label,email,is_primary \"isPrimary\" FROM contact_emails WHERE contact_id=$1 ORDER BY position,id",[id]),
    db.query("SELECT id,type,label,value FROM contact_methods WHERE contact_id=$1 ORDER BY position,id",[id]),
    db.query("SELECT id,label,recipient_name \"recipientName\",phone,address,country_code \"countryCode\",province,city,COALESCE(street_line_1,address) \"street1\",street_line_2 \"street2\",postal_code \"postalCode\",is_default \"isDefault\" FROM contact_addresses WHERE contact_id=$1 ORDER BY is_default DESC,created_at,id",[id]),
    db.query("SELECT id,kind,label,month,day,year,lead_days \"leadDays\" FROM contact_special_dates WHERE contact_id=$1 ORDER BY month,day,id",[id]),
  ]);
  return contact.rowCount?mapContactRow({...contact.rows[0],emails:emails.rows,methods:methods.rows,addresses:addresses.rows,special_dates:specialDates.rows}):null;
}

async function resolveOrderAddress(client:{query:(text:string,values?:unknown[])=>Promise<{rowCount:number|null;rows:Array<Record<string,unknown>>}>},contactId:string,actorId:string,addressId?:string|null,newAddress?:CustomerAddressInput){
  if(addressId){const found=await client.query("SELECT id,label,recipient_name,phone,address,country_code,province,city,COALESCE(street_line_1,address) street1,street_line_2 street2,postal_code FROM contact_addresses WHERE id=$1 AND contact_id=$2",[addressId,contactId]);if(!found.rowCount)throw Object.assign(new Error("invalid_customer_address"),{statusCode:400});const row=found.rows[0];return{id:String(row.id),snapshot:{label:String(row.label),recipientName:String(row.recipient_name??""),phone:String(row.phone??""),address:String(row.address),countryCode:row.country_code?String(row.country_code):null,province:row.province?String(row.province):null,city:row.city?String(row.city):null,street1:String(row.street1??row.address),street2:row.street2?String(row.street2):null,postalCode:row.postal_code?String(row.postal_code):null}};}
  if(!newAddress)return null;
  const street1=newAddress.street1??newAddress.address,created=await client.query("INSERT INTO contact_addresses(contact_id,label,recipient_name,phone,address,is_default,created_by,country_code,province,city,street_line_1,street_line_2,postal_code) VALUES($1,$2,$3,$4,$5,NOT EXISTS(SELECT 1 FROM contact_addresses WHERE contact_id=$1),$6,$7,$8,$9,$10,$11,$12) RETURNING id,label,recipient_name,phone,address,country_code,province,city,street_line_1,street_line_2,postal_code",[contactId,newAddress.label,newAddress.recipientName??null,newAddress.phone??null,street1,actorId,newAddress.countryCode??null,newAddress.province??null,newAddress.city??null,street1,newAddress.street2??null,newAddress.postalCode??null]);const row=created.rows[0];return{id:String(row.id),snapshot:{label:String(row.label),recipientName:String(row.recipient_name??""),phone:String(row.phone??""),address:String(row.address),countryCode:row.country_code?String(row.country_code):null,province:row.province?String(row.province):null,city:row.city?String(row.city):null,street1:String(row.street_line_1??row.address),street2:row.street_line_2?String(row.street_line_2):null,postalCode:row.postal_code?String(row.postal_code):null}};
}

function mapProductTier(tier:Record<string,unknown>){return{minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount),...(tier.costAmount===null||tier.costAmount===undefined?{}:{costAmount:Number(tier.costAmount)}),...(tier.profitMargin===null||tier.profitMargin===undefined?{}:{profitMargin:Number(tier.profitMargin)})};}
function mapProductRow(row:Record<string,unknown>){const tiers=Array.isArray(row.price_tiers)?(row.price_tiers as Array<Record<string,unknown>>).map(mapProductTier):[],variants=Array.isArray(row.variants)?(row.variants as Array<Record<string,unknown>>).map(variant=>({...variant,id:String(variant.id),sku:String(variant.sku),attributes:variant.attributes&&typeof variant.attributes==="object"?variant.attributes:{},imageMediaId:variant.imageMediaId?String(variant.imageMediaId):null,priceTiers:Array.isArray(variant.priceTiers)?(variant.priceTiers as Array<Record<string,unknown>>).map(mapProductTier):[]})):[],galleryImages=Array.isArray(row.gallery_images)?(row.gallery_images as Array<Record<string,unknown>>).map(image=>({id:String(image.id),fileName:String(image.fileName??"")})):[];return{id:String(row.id),sku:String(row.sku),name:String(row.name),description:String(row.description??""),category:String(row.category??""),brand:String(row.brand??""),supplierLinks:Array.isArray(row.supplier_links)?row.supplier_links:[],internalNote:String(row.internal_note??""),defaultUnitAmount:tiers[0]?.unitAmount??Number(row.default_unit_amount),priceTiers:tiers,currency:String(row.currency),weightAmount:row.weight_amount===null||row.weight_amount===undefined?null:Number(row.weight_amount),weightUnit:row.weight_unit?String(row.weight_unit):null,shippingClassId:row.shipping_class_id?String(row.shipping_class_id):null,shippingClass:row.shipping_class_name?String(row.shipping_class_name):null,imageMediaId:row.image_media_id?String(row.image_media_id):null,imageName:String(row.image_name??""),galleryImages,tags:Array.isArray(row.tags)?row.tags:[],variants,createdAt:String(row.created_at),updatedAt:String(row.updated_at)};}

async function productById(client:PoolClient,id:string){const result=await client.query(`SELECT p.id,p.sku,p.name,p.description,p.category,p.brand,p.supplier_links,p.internal_note,p.default_unit_amount,p.weight_amount,p.weight_unit,p.shipping_class_id,sc.name shipping_class_name,p.currency,p.image_media_id,m.file_name image_name,p.created_at,p.updated_at,COALESCE(gallery_list.images,'[]'::json) gallery_images,COALESCE(label_list.tags,'[]'::json) tags,COALESCE(price_list.price_tiers,'[]'::json) price_tiers,COALESCE(variant_list.variants,'[]'::json) variants FROM products p LEFT JOIN media m ON m.id=p.image_media_id LEFT JOIN shipping_classes sc ON sc.id=p.shipping_class_id LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',gm.id,'fileName',gm.file_name) ORDER BY pg.position) images FROM product_gallery_images pg JOIN media gm ON gm.id=pg.media_id WHERE pg.product_id=p.id) gallery_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',label.id,'name',label.name,'color',label.color) ORDER BY lower(label.name)) tags FROM product_labels label WHERE label.product_id=p.id) label_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('minQuantity',tier.min_quantity,'unitAmount',tier.unit_amount,'costAmount',tier.cost_amount,'profitMargin',tier.profit_margin) ORDER BY tier.min_quantity) price_tiers FROM product_price_tiers tier WHERE tier.product_id=p.id) price_list ON true LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id',v.id,'attributes',v.attributes,'sku',v.sku,'imageMediaId',v.image_media_id,'priceTiers',COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount,'costAmount',t.cost_amount,'profitMargin',t.profit_margin) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json)) ORDER BY v.created_at,v.id) variants FROM product_variants v WHERE v.product_id=p.id) variant_list ON true WHERE p.id=$1`,[id]);return result.rowCount?mapProductRow(result.rows[0]):null;}

async function shippingClassExists(client:PoolClient,id:string,enabledOnly=false){const result=await client.query(`SELECT 1 FROM shipping_classes WHERE id=$1 ${enabledOnly?"AND enabled":""}`,[id]);return Boolean(result.rowCount);}

async function orderShippingClassSnapshot(client:PoolClient,item:OrderProductInput,productId:string|null){
  if(productId){const product=await client.query("SELECT p.shipping_class_id,c.name shipping_class_name FROM products p LEFT JOIN shipping_classes c ON c.id=p.shipping_class_id WHERE p.id=$1",[productId]);return{shippingClassId:product.rows[0]?.shipping_class_id??null,shippingClassName:product.rows[0]?.shipping_class_name??null};}
  if(!item.shippingClassId)return{shippingClassId:null,shippingClassName:null};
  const selected=await client.query("SELECT id,name FROM shipping_classes WHERE id=$1 AND enabled",[item.shippingClassId]);
  if(!selected.rowCount)throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});
  return{shippingClassId:selected.rows[0].id,shippingClassName:selected.rows[0].name};
}

async function acceptedShipping(client:PoolClient,data:{currency:string;items:OrderProductInput[];shippingAmount?:number|null;shippingTemplateId?:string|null;acceptCalculatedShipping:boolean;addressId?:string|null;newAddress?:CustomerAddressInput},contactId:string){
  if(!data.acceptCalculatedShipping)return{amount:data.shippingAmount??null,snapshot:null};
  const items=[];
  for(const item of data.items){
    const shippingClass=await orderShippingClassSnapshot(client,item,item.productId??null);
    items.push({name:item.name,quantity:item.quantity,weightAmount:item.weightAmount,weightUnit:item.weightUnit,shippingClassId:shippingClass.shippingClassId,shippingClassName:shippingClass.shippingClassName});
  }
  let destination:{countryCode?:string|null;province?:string|null}|undefined;
  if(data.newAddress)destination={countryCode:data.newAddress.countryCode??null,province:data.newAddress.province??null};
  else if(data.addressId){const address=await client.query("SELECT country_code,province FROM contact_addresses WHERE id=$1 AND contact_id=$2",[data.addressId,contactId]);if(!address.rowCount)throw Object.assign(new Error("invalid_customer_address"),{statusCode:400});destination={countryCode:address.rows[0].country_code?String(address.rows[0].country_code):null,province:address.rows[0].province?String(address.rows[0].province):null};}
  const quote=await calculateShippingQuote(client,{templateId:data.shippingTemplateId!,currency:data.currency,destination,items},{enabledOnly:true});
  return{amount:quote.amount,snapshot:quote};
}

function uniqueProductLabels(labels:ProductLabelInput[]){const seen=new Set<string>();return labels.filter(label=>{const key=label.name.trim().toLocaleLowerCase();if(!key||seen.has(key))return false;seen.add(key);return true;}).map(label=>({name:label.name.trim(),color:label.color}));}

async function replaceProductLabels(client:PoolClient,productId:string,labels:ProductLabelInput[]){await client.query("DELETE FROM product_labels WHERE product_id=$1",[productId]);for(const label of uniqueProductLabels(labels))await client.query("INSERT INTO product_labels(product_id,name,color) VALUES($1,$2,$3)",[productId,label.name,label.color]);}
type ProductTierInput={minQuantity:number;unitAmount:number;costAmount?:number;profitMargin?:number};
async function replaceProductPriceTiers(client:PoolClient,productId:string,tiers:ProductTierInput[]){await client.query("DELETE FROM product_price_tiers WHERE product_id=$1",[productId]);for(const tier of tiers)await client.query("INSERT INTO product_price_tiers(product_id,min_quantity,unit_amount,cost_amount,profit_margin) VALUES($1,$2,$3,$4,$5)",[productId,tier.minQuantity,tier.unitAmount,tier.costAmount??null,tier.profitMargin??null]);}
async function replaceProductGallery(client:PoolClient,productId:string,mediaIds:string[]){await client.query("DELETE FROM product_gallery_images WHERE product_id=$1",[productId]);for(const [position,mediaId] of mediaIds.entries())await client.query("INSERT INTO product_gallery_images(product_id,media_id,position) VALUES($1,$2,$3)",[productId,mediaId,position]);}
async function replaceProductVariants(client:PoolClient,productId:string,variants:Array<{id?:string;attributes:Record<string,string>;sku:string;priceTiers:ProductTierInput[];imageMediaId?:string|null}>){const skus=variants.map(item=>item.sku.trim().toLocaleLowerCase());if(new Set(skus).size!==skus.length)throw Object.assign(new Error("sku_exists"),{statusCode:409});const conflict=await client.query("SELECT 1 FROM products WHERE deleted_at IS NULL AND lower(btrim(sku))=ANY($1::text[]) UNION ALL SELECT 1 FROM product_variants WHERE product_id<>$2 AND lower(btrim(sku))=ANY($1::text[]) LIMIT 1",[skus,productId]);if(conflict.rowCount)throw Object.assign(new Error("sku_exists"),{statusCode:409});await client.query("DELETE FROM product_variants WHERE product_id=$1",[productId]);for(const variant of variants){const created=await client.query("INSERT INTO product_variants(product_id,attributes,sku,default_unit_amount,image_media_id) VALUES($1,$2::jsonb,$3,$4,$5) RETURNING id",[productId,JSON.stringify(variant.attributes),variant.sku,variant.priceTiers[0].unitAmount,variant.imageMediaId??null]);for(const tier of variant.priceTiers)await client.query("INSERT INTO product_variant_price_tiers(variant_id,min_quantity,unit_amount,cost_amount,profit_margin) VALUES($1,$2,$3,$4,$5)",[created.rows[0].id,tier.minQuantity,tier.unitAmount,tier.costAmount??null,tier.profitMargin??null]);}}

async function resolveOrderProduct(client:PoolClient,item:OrderProductInput,orderNumber:string,currency:string,actorId:string,conversationLabels:ProductLabelInput[]):Promise<string|null>{
  if(item.productId){const selected=await client.query("SELECT id,(SELECT COUNT(*) FROM product_variants v WHERE v.product_id=products.id) variant_count FROM products WHERE id=$1 AND deleted_at IS NULL",[item.productId]);if(!selected.rowCount)throw Object.assign(new Error("invalid_order_product"),{statusCode:400});if(Number(selected.rows[0].variant_count)>0&&!item.variantId)throw Object.assign(new Error("variant_required"),{statusCode:400});if(item.variantId){const variant=await client.query("SELECT v.sku,v.image_media_id,v.attributes,COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json) price_tiers FROM product_variants v WHERE v.id=$1 AND v.product_id=$2",[item.variantId,item.productId]);if(!variant.rowCount)throw Object.assign(new Error("invalid_product_variant"),{statusCode:400});const row=variant.rows[0],tiers=(row.price_tiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)}));const attrs=row.attributes as Record<string,string>,suffix=Object.entries(attrs).map(([key,value])=>`${key}: ${value}`).join(" / ");item.sku=String(row.sku);item.name=suffix?`${item.name} (${suffix})`:item.name;item.unitAmount=[...tiers].reverse().find(tier=>item.quantity>=tier.minQuantity)?.unitAmount??tiers[0]?.unitAmount??item.unitAmount;if(row.image_media_id)item.imageMediaId=String(row.image_media_id);}return selected.rows[0].id;}
  if(!item.clientProductId)return null;
  const existing=await client.query("SELECT id,currency FROM products WHERE client_product_id=$1",[item.clientProductId]);if(existing.rowCount){if(existing.rows[0].currency!==currency)throw Object.assign(new Error("product_currency_mismatch"),{statusCode:400});return existing.rows[0].id;}
  const duplicateSku=await client.query("SELECT id FROM products WHERE deleted_at IS NULL AND lower(btrim(sku))=lower(btrim($1))",[item.sku]);if(duplicateSku.rowCount)throw Object.assign(new Error("sku_exists"),{statusCode:409});
  if(item.shippingClassId&&!await shippingClassExists(client,item.shippingClassId,true))throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});
  const created=await client.query("INSERT INTO products(client_product_id,sku,name,default_unit_amount,currency,image_media_id,created_by,weight_amount,weight_unit,shipping_class_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",[item.clientProductId,item.sku,item.name,item.unitAmount,currency,item.imageMediaId??null,actorId,item.weightAmount??null,item.weightUnit??null,item.shippingClassId??null]);await replaceProductPriceTiers(client,created.rows[0].id,[{minQuantity:1,unitAmount:item.unitAmount}]);
  const labels=[{name:`订单 #${orderNumber}`,color:"#E8EEF7"},...conversationLabels];await replaceProductLabels(client,created.rows[0].id,labels);
  await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'product.create','product',$2,$3)",[actorId,created.rows[0].id,JSON.stringify({source:"order",orderNumber,tagCount:uniqueProductLabels(labels).length})]);return created.rows[0].id;
}

async function orderVariantSnapshot(client:PoolClient,item:OrderProductInput):Promise<OrderProductInput>{
  if(!item.variantId||!item.productId)return item;
  const result=await client.query("SELECT v.sku,v.image_media_id,v.attributes,COALESCE((SELECT json_agg(json_build_object('minQuantity',t.min_quantity,'unitAmount',t.unit_amount) ORDER BY t.min_quantity) FROM product_variant_price_tiers t WHERE t.variant_id=v.id),'[]'::json) price_tiers FROM product_variants v WHERE v.id=$1 AND v.product_id=$2",[item.variantId,item.productId]);
  if(!result.rowCount)throw Object.assign(new Error("invalid_product_variant"),{statusCode:400});
  const row=result.rows[0],tiers=(row.price_tiers as Array<Record<string,unknown>>).map(tier=>({minQuantity:Number(tier.minQuantity),unitAmount:Number(tier.unitAmount)})),attributes=row.attributes as Record<string,string>;
  const label=Object.entries(attributes).map(([key,value])=>`${key}: ${value}`).join(" / ");
  const unitAmount=[...tiers].reverse().find(tier=>item.quantity>=tier.minQuantity)?.unitAmount??tiers[0]?.unitAmount??item.unitAmount;
  return {...item,name:label?`${item.name} (${label})`:item.name,sku:String(row.sku),unitAmount,imageMediaId:row.image_media_id?String(row.image_media_id):item.imageMediaId};
}

async function attachInternalOrderItemCosts(orders:Array<Record<string,unknown>>):Promise<void>{
  const items=orders.flatMap(order=>Array.isArray(order.items)?order.items as Array<Record<string,unknown>>:[]),ids=items.map(item=>String(item.id)).filter(Boolean);
  if(!ids.length)return;
  const result=await pool.query(`SELECT i.id,COALESCE(vt.cost_amount,pt.cost_amount) cost_amount,p.currency cost_currency FROM order_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN LATERAL (SELECT cost_amount FROM product_variant_price_tiers WHERE variant_id=i.variant_id AND min_quantity<=i.quantity ORDER BY min_quantity DESC LIMIT 1) vt ON true LEFT JOIN LATERAL (SELECT cost_amount FROM product_price_tiers WHERE product_id=i.product_id AND min_quantity<=i.quantity ORDER BY min_quantity DESC LIMIT 1) pt ON true WHERE i.id=ANY($1::uuid[])`,[ids]);
  const costs=new Map(result.rows.map(row=>[String(row.id),{costAmount:row.cost_amount===null?null:Number(row.cost_amount),costCurrency:row.cost_currency===null?null:String(row.cost_currency)}]));
  for(const item of items){const cost=costs.get(String(item.id));item.costAmount=cost?.costAmount??null;item.costCurrency=cost?.costCurrency??null;}
}

function safeFileName(value:string):string{return value.replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,100)||"order";}
async function loadProductCardImage(objectKey:unknown):Promise<Buffer|undefined>{if(typeof objectKey!=="string"||!objectKey)return undefined;const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey}));return object.Body?Buffer.from(await object.Body.transformToByteArray()):undefined;}
async function convertProductCardPrices(products:ProductCardRenderProduct[],targetCurrency:string):Promise<ProductCardRenderProduct[]>{const target=targetCurrency.trim().toUpperCase();const codes=[...new Set(products.map(product=>product.currency.toUpperCase()).concat(target))];const result=await pool.query("SELECT code,rate FROM currency_settings WHERE code=ANY($1::text[])",[codes]);const rates=new Map(result.rows.map(row=>[String(row.code).toUpperCase(),Number(row.rate)]));const targetRate=rates.get(target);if(!targetRate||!Number.isFinite(targetRate))throw Object.assign(new Error("currency_not_configured"),{statusCode:400});return products.map(product=>{const source=product.currency.toUpperCase(),sourceRate=rates.get(source);if(!sourceRate||!Number.isFinite(sourceRate))throw Object.assign(new Error("currency_not_configured"),{statusCode:400});const convert=(amount:number)=>source===target?amount:amount/sourceRate*targetRate;return {...product,currency:target,priceTiers:product.priceTiers.map(tier=>({...tier,unitAmount:convert(tier.unitAmount)})),variants:product.variants?.map(variant=>({...variant,priceTiers:variant.priceTiers.map(tier=>({...tier,unitAmount:convert(tier.unitAmount)}))}))};});}
async function storeEmailAttachment(accountId:string,fileName:string,bytes:Buffer,mimeType:string,source:string):Promise<{mediaId:string;byteSize:number}>{const sha256=createHash("sha256").update(bytes).digest("hex"),extension=mimeType==="application/pdf"?"pdf":"png",objectKey=`email/${accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}.${extension}`;await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mimeType,Metadata:{sha256,source}}));const media=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[accountId,objectKey,fileName,mimeType,bytes.length,sha256]);return{mediaId:String(media.rows[0].id),byteSize:bytes.length};}

async function auditCrm(actorId:string,action:string,targetType:string,targetId:string,metadata:unknown):Promise<void>{
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,$2,$3,$4,$5)",[actorId,action,targetType,targetId,JSON.stringify(metadata)]);
}

async function queueOrderCommand(client:import("pg").PoolClient,conversation:{account_id:string;agent_id:string;provider_user_id:string},conversationId:string,messageId:string,clientMessageId:string,type:"text"|"image"|"document",text:string,mediaId?:string):Promise<void>{
  await queueChannelCommand(client,{accountId:conversation.account_id,conversationId,messageId,payload:{accountId:conversation.account_id,conversationId,clientMessageId,type,text,...(mediaId?{mediaId}:{}),messageId,toJid:conversation.provider_user_id}});
}

type PayPalSetting={environment:PayPalEnvironment;clientId:string;clientSecret:string;referenceTemplate:string;noteTemplate:string;itemNameTemplate:string};
async function activePayPalSetting(requiredEnvironment?:string,requireEnabled=true):Promise<PayPalSetting|null>{const result=await pool.query("SELECT enabled,environment,sandbox_client_id_encrypted,sandbox_client_secret_encrypted,live_client_id_encrypted,live_client_secret_encrypted,reference_template,note_template,item_name_template FROM paypal_settings WHERE singleton=true"),row=result.rows[0];if(!row||requireEnabled&&!row.enabled)return null;const environment=(requiredEnvironment??row.environment) as PayPalEnvironment;if(environment!=="sandbox"&&environment!=="live")return null;const clientIdEncrypted=environment==="sandbox"?row.sandbox_client_id_encrypted:row.live_client_id_encrypted,clientSecretEncrypted=environment==="sandbox"?row.sandbox_client_secret_encrypted:row.live_client_secret_encrypted;if(!clientIdEncrypted||!clientSecretEncrypted)return null;return{environment,clientId:decryptAtRest(clientIdEncrypted,config.DATA_ENCRYPTION_KEY),clientSecret:decryptAtRest(clientSecretEncrypted,config.DATA_ENCRYPTION_KEY),referenceTemplate:String(row.reference_template??DEFAULT_PAYPAL_REFERENCE_TEMPLATE),noteTemplate:String(row.note_template??DEFAULT_PAYPAL_NOTE_TEMPLATE),itemNameTemplate:String(row.item_name_template??DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE)};}

function paymentRequestResponse(row:Record<string,unknown>):Record<string,unknown>{return{id:String(row.id),invoiceId:row.provider_request_id?String(row.provider_request_id):null,url:row.payment_url?String(row.payment_url):null,status:String(row.status),amount:Number(row.amount),currency:String(row.currency),environment:String(row.environment),createdAt:row.created_at,lastSyncedAt:row.last_synced_at??null};}

async function accessiblePaymentRequest(orderId:string,principal:Principal):Promise<{request:{id:string;provider_request_id:string|null;environment:string;payment_profile_id:string|null}}|null>{const result=await pool.query("SELECT pr.id,pr.provider_request_id,pr.environment,pr.payment_profile_id,c.account_id FROM order_payment_requests pr JOIN orders o ON o.id=pr.order_id JOIN conversations c ON c.id=o.conversation_id WHERE pr.order_id=$1 AND pr.is_current AND o.deleted_at IS NULL",[orderId]);if(!result.rowCount||!canAccessAccount(principal,result.rows[0].account_id))return null;return{request:{id:String(result.rows[0].id),provider_request_id:result.rows[0].provider_request_id?String(result.rows[0].provider_request_id):null,environment:String(result.rows[0].environment),payment_profile_id:result.rows[0].payment_profile_id?String(result.rows[0].payment_profile_id):null}};}

const PAID_PAYPAL_STATUSES=new Set(["PAID","MARKED_AS_PAID","PAID_EXTERNAL","PARTIALLY_PAID","PAYMENT_PENDING"]);
async function cancelCurrentPaymentRequest(orderId:string,actorId:string):Promise<"none"|"cancelled"|"paid">{const result=await pool.query("SELECT * FROM order_payment_requests WHERE order_id=$1 AND is_current ORDER BY created_at DESC LIMIT 1",[orderId]);if(!result.rowCount)return"none";const row=result.rows[0],status=String(row.status).toUpperCase();if(PAID_PAYPAL_STATUSES.has(status))return"paid";if(row.provider_request_id){const setting=row.payment_profile_id?await paypalProfileSetting(String(row.payment_profile_id),String(row.environment),false):await activePayPalSetting(String(row.environment),false);if(!setting)throw new PayPalApiError(409,"paypal_environment_not_configured","PayPal Profile environment is not configured");await new PayPalClient(setting).cancelInvoice(String(row.provider_request_id),status);}await pool.query("UPDATE order_payment_requests SET status='CANCELLED',is_current=false,cancelled_at=now(),updated_at=now() WHERE id=$1",[row.id]);await auditCrm(actorId,"payment_request.cancel","order",orderId,{paymentRequestId:row.id,paypalInvoiceId:row.provider_request_id??null,paymentProfileId:row.payment_profile_id??null});return"cancelled";}

function paypalFailureMessage(error:unknown):string{if(error instanceof PayPalApiError){if(error.status===401||error.status===403)return"PayPal 鉴权失败，请管理员检查凭据和环境";if(error.status===422||error.status===400)return`PayPal 拒绝了该订单：${error.message}`;if(error.status===429)return"PayPal 请求过于频繁，请稍后重试";}return"PayPal 服务暂时不可用，请稍后重试";}
function trackingFailureMessage(error:unknown):string{const code=(error as {code?:unknown})?.code;if(code==="42703"||code==="42P01")return"物流功能正在初始化，请稍后重试；若持续出现，请重启 API 服务以完成数据库升级";if(code==="23514")return"物流信息不完整，请同时填写承运商和物流单号";return"物流信息暂时无法保存，请稍后重试";}
let orderTrackingColumnsReady:Promise<void>|null=null;
function ensureOrderTrackingColumns():Promise<void>{if(!orderTrackingColumnsReady)orderTrackingColumnsReady=ensureOrderTrackingColumnsOnce().catch(error=>{orderTrackingColumnsReady=null;throw error;});return orderTrackingColumnsReady;}
async function ensureOrderTrackingColumnsOnce():Promise<void>{await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_carrier text");await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number text");await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url text");await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS paypal_tracking_synced_at timestamptz");await pool.query("ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_tracking_complete_check");await pool.query("ALTER TABLE orders ADD CONSTRAINT orders_tracking_complete_check CHECK ((tracking_carrier IS NULL AND tracking_number IS NULL AND tracking_url IS NULL) OR (tracking_carrier IS NOT NULL AND tracking_number IS NOT NULL))");}

const transcriptionFlights=new Map<string,Promise<string>>();
const messageTranslationFlights=new Map<string,Promise<{id:string;translatedText?:string;sourceText?:string;sourceLanguage?:string;error?:string;message?:string}>>();
async function singleFlight<T>(flights:Map<string,Promise<T>>,key:string,work:()=>Promise<T>):Promise<T>{
  const current=flights.get(key);if(current)return current;
  const pending=work().finally(()=>flights.delete(key));flights.set(key,pending);return pending;
}

function translationFailure(error:unknown):{error:string;message:string}{
  const detail=String(error);
  if(detail.includes("audio_conversion_"))return{error:"audio_conversion_failed",message:"语音格式转换失败，请稍后重试"};
  if(detail.includes("transcription_provider_invalid_endpoint"))return{error:"transcription_endpoint_invalid",message:"语音转写 Provider 地址无效，请检查配置"};
  if(detail.includes("transcription_provider_missing_api_key"))return{error:"transcription_auth_failed",message:"语音转写 Provider 未配置 API Key，请联系管理员"};
  if(detail.includes("transcription_provider_missing_model"))return{error:"transcription_rejected",message:"语音转写模型未配置，请联系管理员"};
  if(/transcription_provider_http_(401|403)/.test(detail))return{error:"transcription_auth_failed",message:"语音转写 Provider 鉴权失败，请联系管理员"};
  if(detail.includes("transcription_provider_http_404"))return{error:"transcription_endpoint_missing",message:"当前 Provider 不支持语音转写接口"};
  if(detail.includes("transcription_provider_http_429"))return{error:"transcription_rate_limited",message:"语音转写请求过于频繁，请稍后重试"};
  if(detail.includes("unsupported audio format"))return{error:"transcription_format_unsupported",message:"语音文件格式无法识别，请重试或联系管理员"};
  if(detail.includes("transcription_provider_http_400"))return{error:"transcription_rejected",message:"转写 Provider 拒绝了音频，请检查转写模型配置"};
  if(detail.includes("transcription_provider_"))return{error:"transcription_failed",message:"语音转写失败，请检查 Provider 配置"};
  return{error:"translation_failed",message:"译文生成失败，请稍后重试"};
}

async function ensureTranslationTables():Promise<void>{
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS translation_source_text text");
  await pool.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS translation_target_language text");
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
  await pool.query(`CREATE TABLE IF NOT EXISTS transcription_provider_settings (
    provider text PRIMARY KEY CHECK (provider IN ('openai','openai_compatible')),
    enabled boolean NOT NULL DEFAULT false,
    api_key_encrypted text,
    base_url text NOT NULL,
    model text NOT NULL DEFAULT '',
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS transcription_provider_one_enabled_idx ON transcription_provider_settings ((enabled)) WHERE enabled");
  await pool.query(`CREATE TABLE IF NOT EXISTS message_translations (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    target_language text NOT NULL,
    translated_text text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id,target_language)
  )`);
  await pool.query("ALTER TABLE message_translations ADD COLUMN IF NOT EXISTS source_language text");
  await pool.query(`CREATE TABLE IF NOT EXISTS message_transcriptions (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    transcript_text text NOT NULL,
    source_language text,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query("ALTER TABLE message_transcriptions ADD COLUMN IF NOT EXISTS source_language text");
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
  const removed=await pool.query("DELETE FROM channel_accounts WHERE id=ANY($1::uuid[]) RETURNING id",[["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002"]]);
  if(removed.rowCount)await pool.query("INSERT INTO audit_log(actor_type,action,target_type,metadata) VALUES('system','legacy_demo.remove','whatsapp_account',$1)",[JSON.stringify({accountIds:removed.rows.map(row=>row.id)})]);
}

await removeLegacyDemoData();
await ensureAdmin();
await app.listen({port:config.PORT,host:"0.0.0.0"});
