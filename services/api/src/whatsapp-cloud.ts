import {createHash,createHmac,randomBytes,timingSafeEqual} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {S3Client,GetObjectCommand,PutObjectCommand} from "@aws-sdk/client-s3";
import {z} from "zod";
import {authenticate,canAccessAccount} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {decryptAtRest,encryptAtRest,hashSecret} from "./security.js";
import {ingestNormalizedMessage,updateNormalizedMessageStatus} from "./agent-hub.js";

const graphBase=`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}`;
const s3=new S3Client({region:config.S3_REGION,endpoint:config.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});
const cloudAccountSchema=z.object({
  displayName:z.string().trim().min(2).max(80),
  wabaId:z.string().trim().regex(/^\d+$/),
  phoneNumberId:z.string().trim().regex(/^\d+$/),
  accessToken:z.string().trim().min(20).max(4096),
  appSecret:z.string().trim().min(16).max(512),
  enabled:z.boolean().default(true),
});
const cloudAccountUpdateSchema=cloudAccountSchema.partial().refine(value=>Object.keys(value).length>0);

type CloudSetting={
  account_id:string;waba_id:string;phone_number_id:string;access_token_encrypted:string;app_secret_encrypted:string;
  enabled:boolean;display_name:string;phone_e164:string|null;status:string;
};

export class MetaApiError extends Error{
  constructor(readonly status:number,readonly code:string,readonly detail:string){super(detail);}
}

async function graphRequest<T>(url:string,token:string,init:RequestInit={}):Promise<T>{
  const response=await fetch(url.startsWith("http")?url:`${graphBase}/${url.replace(/^\//,"")}`,{
    ...init,
    headers:{authorization:`Bearer ${token}`,accept:"application/json",...init.headers},
    signal:init.signal??AbortSignal.timeout(30_000),
  });
  const body=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok){
    const error=(body.error??{}) as Record<string,unknown>;
    throw new MetaApiError(response.status,String(error.code??response.status),String(error.message??`Meta Graph API HTTP ${response.status}`));
  }
  return body as T;
}

export async function verifyCloudCredentials(input:{phoneNumberId:string;accessToken:string;wabaId?:string}):Promise<{display_phone_number?:string;verified_name?:string;whatsapp_business_account?:{id?:string}}>{
  const profile=await graphRequest<{display_phone_number?:string;verified_name?:string;whatsapp_business_account?:{id?:string}}>(`${input.phoneNumberId}?fields=display_phone_number,verified_name,whatsapp_business_account`,input.accessToken);
  if(input.wabaId){
    await graphRequest(`${input.wabaId}?fields=id,name`,input.accessToken);
    if(profile.whatsapp_business_account?.id&&profile.whatsapp_business_account.id!==input.wabaId)throw new MetaApiError(400,"waba_mismatch","Phone Number ID does not belong to the configured WABA");
  }
  return profile;
}

export async function syncCloudTemplates(accountId:string):Promise<number>{
  const result=await pool.query("SELECT waba_id,access_token_encrypted FROM whatsapp_cloud_accounts WHERE account_id=$1",[accountId]);
  if(!result.rowCount)throw new Error("cloud_account_not_found");
  const token=decryptAtRest(result.rows[0].access_token_encrypted,config.DATA_ENCRYPTION_KEY);
  let url=`${result.rows[0].waba_id}/message_templates?fields=id,name,language,status,category,components&limit=250`;
  const templates:Array<Record<string,unknown>>=[];
  for(let page=0;page<20&&url;page++){
    const response=await graphRequest<{data?:Array<Record<string,unknown>>;paging?:{next?:string}}>(url,token);
    templates.push(...(response.data??[]));url=response.paging?.next??"";
  }
  await transaction(async client=>{
    for(const item of templates)await client.query(
      `INSERT INTO whatsapp_message_templates(account_id,name,language,status,category,components,provider_template_id,synced_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT(account_id,name,language) DO UPDATE SET status=EXCLUDED.status,category=EXCLUDED.category,components=EXCLUDED.components,provider_template_id=EXCLUDED.provider_template_id,synced_at=now()`,
      [accountId,item.name,item.language,item.status,item.category??null,JSON.stringify(item.components??[]),item.id??null],
    );
    if(templates.length)await client.query("DELETE FROM whatsapp_message_templates WHERE account_id=$1 AND synced_at<now()-interval '1 minute'",[accountId]);
    await client.query("UPDATE whatsapp_cloud_accounts SET last_template_sync_at=now(),updated_at=now() WHERE account_id=$1",[accountId]);
  });
  return templates.length;
}

export async function registerWhatsAppCloudRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/v1/admin/whatsapp-cloud/accounts",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const result=await pool.query(`SELECT a.id,a.display_name,a.phone_e164,a.status,a.status_reason,a.last_event_at,c.waba_id,c.phone_number_id,c.enabled,c.credentials_verified_at,c.webhook_verified_at,c.last_template_sync_at,c.last_webhook_at
      FROM whatsapp_accounts a JOIN whatsapp_cloud_accounts c ON c.account_id=a.id WHERE a.transport='cloud' ORDER BY a.display_name`);
    return{data:result.rows.map(row=>({...row,transport:"cloud",credentialsStatus:row.credentials_verified_at?"verified":"unverified",webhookStatus:row.webhook_verified_at?"verified":"pending",accessTokenConfigured:true,appSecretConfigured:true}))};
  });

  app.post("/api/v1/admin/whatsapp-cloud/accounts",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=cloudAccountSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    let profile:{display_phone_number?:string;verified_name?:string};
    try{profile=await verifyCloudCredentials(parsed.data);}catch(error){return metaCredentialFailure(reply,error);}
    const verifyToken=`rdw_${randomBytes(32).toString("base64url")}`;
    const created=await transaction(async client=>{
      const account=await client.query("INSERT INTO whatsapp_accounts(display_name,phone_e164,wa_jid,status,transport,last_connected_at) VALUES($1,$2,$3,$4,'cloud',now()) RETURNING id",[parsed.data.displayName,normalizeE164(profile.display_phone_number),normalizeE164(profile.display_phone_number)?`${normalizeE164(profile.display_phone_number)!.slice(1)}@s.whatsapp.net`:null,parsed.data.enabled?"online":"offline"]);
      await client.query(`INSERT INTO whatsapp_cloud_accounts(account_id,waba_id,phone_number_id,access_token_encrypted,app_secret_encrypted,verify_token_hash,enabled,credentials_verified_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now())`,[account.rows[0].id,parsed.data.wabaId,parsed.data.phoneNumberId,encryptAtRest(parsed.data.accessToken,config.DATA_ENCRYPTION_KEY),encryptAtRest(parsed.data.appSecret,config.DATA_ENCRYPTION_KEY),hashSecret(verifyToken),parsed.data.enabled]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'cloud_account.create','whatsapp_account',$2,$3)",[request.principal!.id,account.rows[0].id,JSON.stringify({wabaId:parsed.data.wabaId,phoneNumberId:parsed.data.phoneNumberId})]);
      return String(account.rows[0].id);
    });
    try{await syncCloudTemplates(created);}catch(error){request.log.warn({accountId:created,error:String(error)},"initial template sync failed");}
    return reply.code(201).send({id:created,verifyToken,webhookPath:"/api/v1/meta/whatsapp/webhook"});
  });

  app.patch("/api/v1/admin/whatsapp-cloud/accounts/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=cloudAccountUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {id}=request.params as {id:string};
    const current=await pool.query("SELECT c.*,a.display_name FROM whatsapp_cloud_accounts c JOIN whatsapp_accounts a ON a.id=c.account_id WHERE c.account_id=$1",[id]);
    if(!current.rowCount)return reply.code(404).send({error:"not_found"});
    const row=current.rows[0],accessToken=parsed.data.accessToken??decryptAtRest(row.access_token_encrypted,config.DATA_ENCRYPTION_KEY),phoneNumberId=parsed.data.phoneNumberId??row.phone_number_id;
    let profile:{display_phone_number?:string;verified_name?:string};
    try{profile=await verifyCloudCredentials({phoneNumberId,accessToken,wabaId:parsed.data.wabaId??row.waba_id});}catch(error){return metaCredentialFailure(reply,error);}
    await transaction(async client=>{
      await client.query("UPDATE whatsapp_accounts SET display_name=$2,phone_e164=$3,wa_jid=$4,status=CASE WHEN $5 THEN 'online'::wa_account_status ELSE 'offline'::wa_account_status END,status_reason=CASE WHEN $5 THEN NULL ELSE 'cloud_disabled' END,last_connected_at=CASE WHEN $5 THEN now() ELSE last_connected_at END WHERE id=$1",[id,parsed.data.displayName??row.display_name,normalizeE164(profile.display_phone_number),normalizeE164(profile.display_phone_number)?`${normalizeE164(profile.display_phone_number)!.slice(1)}@s.whatsapp.net`:null,parsed.data.enabled??row.enabled]);
      await client.query(`UPDATE whatsapp_cloud_accounts SET waba_id=$2,phone_number_id=$3,access_token_encrypted=$4,app_secret_encrypted=$5,enabled=$6,credentials_verified_at=now(),updated_at=now() WHERE account_id=$1`,[id,parsed.data.wabaId??row.waba_id,phoneNumberId,encryptAtRest(accessToken,config.DATA_ENCRYPTION_KEY),parsed.data.appSecret?encryptAtRest(parsed.data.appSecret,config.DATA_ENCRYPTION_KEY):row.app_secret_encrypted,parsed.data.enabled??row.enabled]);
    });
    return{ok:true};
  });

  app.post("/api/v1/admin/whatsapp-cloud/accounts/:id/test",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};const row=await cloudSetting(id);if(!row)return reply.code(404).send({error:"not_found"});
    try{const profile=await verifyCloudCredentials({phoneNumberId:row.phone_number_id,accessToken:decryptAtRest(row.access_token_encrypted,config.DATA_ENCRYPTION_KEY)});await pool.query("UPDATE whatsapp_cloud_accounts SET credentials_verified_at=now() WHERE account_id=$1",[id]);return{ok:true,profile};}catch(error){return metaCredentialFailure(reply,error);}
  });
  app.post("/api/v1/admin/whatsapp-cloud/accounts/:id/templates/sync",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};try{return{count:await syncCloudTemplates(id)};}catch(error){return reply.code(502).send({error:"template_sync_failed",message:error instanceof Error?error.message:String(error)});}
  });
  app.post("/api/v1/admin/whatsapp-cloud/accounts/:id/verify-token/reset",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const token=`rdw_${randomBytes(32).toString("base64url")}`,{id}=request.params as {id:string};
    const result=await pool.query("UPDATE whatsapp_cloud_accounts SET verify_token_hash=$2,webhook_verified_at=NULL,updated_at=now() WHERE account_id=$1 RETURNING account_id",[id,hashSecret(token)]);
    return result.rowCount?{verifyToken:token}:reply.code(404).send({error:"not_found"});
  });
  app.get("/api/v1/accounts/:id/templates",{preHandler:authenticate},async(request,reply)=>{
    const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(403).send({error:"account_forbidden"});
    const result=await pool.query("SELECT name,language,status,category,components FROM whatsapp_message_templates WHERE account_id=$1 AND status='APPROVED' ORDER BY name,language",[id]);
    return{data:result.rows};
  });

  await app.register(async webhook=>{
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser("application/json",{parseAs:"buffer"},(request,body,done)=>{
      try{(request as typeof request&{rawBody:Buffer}).rawBody=body as Buffer;done(null,JSON.parse((body as Buffer).toString("utf8")));}catch(error){done(error as Error,undefined);}
    });
    webhook.get("/api/v1/meta/whatsapp/webhook",async(request,reply)=>{
      const query=request.query as Record<string,string|undefined>;
      if(query["hub.mode"]!=="subscribe"||!query["hub.verify_token"])return reply.code(403).send("Forbidden");
      const found=await pool.query("UPDATE whatsapp_cloud_accounts SET webhook_verified_at=now(),updated_at=now() WHERE verify_token_hash=$1 RETURNING account_id",[hashSecret(query["hub.verify_token"])]);
      if(!found.rowCount)return reply.code(403).send("Forbidden");
      return reply.type("text/plain").send(query["hub.challenge"]??"");
    });
    webhook.post("/api/v1/meta/whatsapp/webhook",async(request,reply)=>{
      const raw=(request as typeof request&{rawBody?:Buffer}).rawBody??Buffer.from(JSON.stringify(request.body??{}));
      const body=request.body as Record<string,unknown>,phoneNumberId=webhookPhoneNumberId(body);
      if(!phoneNumberId)return reply.code(200).send({received:true,ignored:true});
      const found=await pool.query("SELECT account_id,app_secret_encrypted FROM whatsapp_cloud_accounts WHERE phone_number_id=$1 AND enabled",[phoneNumberId]);
      if(!found.rowCount)return reply.code(200).send({received:true,ignored:true});
      const signature=String(request.headers["x-hub-signature-256"]??""),secret=decryptAtRest(found.rows[0].app_secret_encrypted,config.DATA_ENCRYPTION_KEY);
      if(!validMetaSignature(raw,signature,secret))return reply.code(401).send({error:"invalid_signature"});
      const payloadHash=createHash("sha256").update(raw).digest("hex");
      await pool.query("INSERT INTO whatsapp_cloud_webhook_events(account_id,payload_hash,payload) VALUES($1,$2,$3) ON CONFLICT(payload_hash) DO NOTHING",[found.rows[0].account_id,payloadHash,JSON.stringify(body)]);
      await pool.query("UPDATE whatsapp_cloud_accounts SET last_webhook_at=now(),updated_at=now() WHERE account_id=$1",[found.rows[0].account_id]);
      return{received:true};
    });
  });
}

function metaCredentialFailure(reply:import("fastify").FastifyReply,error:unknown){
  const message=error instanceof Error?error.message:String(error);
  return reply.code(400).send({error:"cloud_credentials_invalid",message});
}
function normalizeE164(value:unknown):string|null{const digits=String(value??"").replace(/\D/g,"");return /^\d{7,15}$/.test(digits)?`+${digits}`:null;}
export function webhookPhoneNumberId(body:Record<string,unknown>):string{
  const entries=Array.isArray(body.entry)?body.entry as Array<Record<string,unknown>>:[];
  for(const entry of entries)for(const change of Array.isArray(entry.changes)?entry.changes as Array<Record<string,unknown>>:[]){
    const value=(change.value??{}) as Record<string,unknown>,metadata=(value.metadata??{}) as Record<string,unknown>;
    if(metadata.phone_number_id)return String(metadata.phone_number_id);
  }
  return"";
}
export function validMetaSignature(raw:Buffer,header:string,secret:string):boolean{
  if(!header.startsWith("sha256="))return false;
  const actual=createHmac("sha256",secret).update(raw).digest(),expected=Buffer.from(header.slice(7),"hex");
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
async function cloudSetting(accountId:string):Promise<CloudSetting|null>{
  const result=await pool.query("SELECT c.*,a.display_name,a.phone_e164,a.status FROM whatsapp_cloud_accounts c JOIN whatsapp_accounts a ON a.id=c.account_id WHERE c.account_id=$1 AND a.transport='cloud'",[accountId]);
  return result.rows[0]??null;
}

export async function processOneCloudWebhook():Promise<boolean>{
  const event=await transaction(async client=>{
    const found=await client.query("SELECT * FROM whatsapp_cloud_webhook_events WHERE state IN ('pending','retry') AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
    if(!found.rowCount)return null;
    await client.query("UPDATE whatsapp_cloud_webhook_events SET state='processing',attempt=attempt+1,claimed_at=now() WHERE id=$1",[found.rows[0].id]);
    return found.rows[0] as {id:number;account_id:string;payload:Record<string,unknown>;attempt:number};
  });
  if(!event)return false;
  try{
    await processCloudPayload(event.account_id,event.payload);
    await pool.query("UPDATE whatsapp_cloud_webhook_events SET state='completed',completed_at=now(),last_error=NULL WHERE id=$1",[event.id]);
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,1000),attempt=event.attempt+1;
    if(attempt>=8)await pool.query("UPDATE whatsapp_cloud_webhook_events SET state='failed',completed_at=now(),last_error=$2 WHERE id=$1",[event.id,message]);
    else await pool.query("UPDATE whatsapp_cloud_webhook_events SET state='retry',available_at=now()+($2||' seconds')::interval,last_error=$3 WHERE id=$1",[event.id,String(Math.min(300,2**attempt)),message]);
  }
  return true;
}

async function processCloudPayload(accountId:string,payload:Record<string,unknown>):Promise<void>{
  const setting=await cloudSetting(accountId);if(!setting)return;
  const token=decryptAtRest(setting.access_token_encrypted,config.DATA_ENCRYPTION_KEY);
  const entries=Array.isArray(payload.entry)?payload.entry as Array<Record<string,unknown>>:[];
  for(const entry of entries)for(const change of Array.isArray(entry.changes)?entry.changes as Array<Record<string,unknown>>:[]){
    const value=(change.value??{}) as Record<string,unknown>,contacts=Array.isArray(value.contacts)?value.contacts as Array<Record<string,unknown>>:[],contactName=((contacts[0]?.profile??{}) as Record<string,unknown>).name;
    for(const message of Array.isArray(value.messages)?value.messages as Array<Record<string,unknown>>:[]){
      const normalized=await normalizeCloudMessage(accountId,message,contactName,token);
      if(normalized)await transaction(client=>ingestNormalizedMessage(client,normalized,{transport:"cloud"}));
    }
    for(const status of Array.isArray(value.statuses)?value.statuses as Array<Record<string,unknown>>:[]){
      const errors=Array.isArray(status.errors)?status.errors as Array<Record<string,unknown>>:[],state=String(status.status);
      await transaction(client=>updateNormalizedMessageStatus(client,{accountId,whatsappMessageId:String(status.id),status:state==="failed"?"failed":state,at:unixIso(status.timestamp),failureCode:errors[0]?.code?String(errors[0].code):null,failureMessage:errors[0]?.title?String(errors[0].title):errors[0]?.message?String(errors[0].message):null}));
    }
  }
}

async function normalizeCloudMessage(accountId:string,message:Record<string,unknown>,senderName:unknown,token:string):Promise<Record<string,unknown>|null>{
  const type=String(message.type??""),from=String(message.from??"").replace(/\D/g,"");
  if(!/^\d{7,15}$/.test(from)||!message.id)return null;
  const base={eventId:`cloud-message:${accountId}:${message.id}`,accountId,whatsappMessageId:String(message.id),chatJid:`${from}@s.whatsapp.net`,senderJid:`${from}@s.whatsapp.net`,senderName:String(senderName??`+${from}`),direction:"in",occurredAt:unixIso(message.timestamp)};
  if(type==="text")return{...base,kind:"text",text:String(((message.text??{}) as Record<string,unknown>).body??"")};
  if(!["image","video","audio","document"].includes(type))return null;
  const mediaInfo=(message[type]??{}) as Record<string,unknown>,mediaId=String(mediaInfo.id??"");
  if(!mediaId)return null;
  const media=await downloadInboundCloudMedia(accountId,mediaId,token,String(mediaInfo.filename??`${message.id}.${type}`));
  return{...base,kind:type,text:String(mediaInfo.caption??""),media};
}

async function downloadInboundCloudMedia(accountId:string,providerMediaId:string,token:string,fileName:string){
  const info=await graphRequest<{url:string;mime_type?:string;sha256?:string;file_size?:number}>(providerMediaId,token);
  const response=await fetch(info.url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60_000)});
  if(!response.ok)throw new MetaApiError(response.status,String(response.status),"Cloud media download failed");
  const bytes=Buffer.from(await response.arrayBuffer()),sha256=info.sha256??createHash("sha256").update(bytes).digest("hex"),mime=info.mime_type??response.headers.get("content-type")??"application/octet-stream";
  const objectKey=`inbound/${accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mime,Metadata:{sha256,provider:"meta"}}));
  const created=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[accountId,objectKey,fileName,mime,bytes.length,sha256]);
  return{uploadId:String(created.rows[0].id),mimeType:mime,fileName,size:bytes.length,sha256};
}

function unixIso(value:unknown):string{const seconds=Number(value);return new Date(Number.isFinite(seconds)?seconds*1000:Date.now()).toISOString();}

export async function processOneCloudOutbound():Promise<boolean>{
  const command=await transaction(async client=>{
    const found=await client.query(`SELECT oc.*,c.phone_number_id,c.access_token_encrypted,c.enabled,a.status
      FROM outbound_commands oc JOIN whatsapp_accounts a ON a.id=oc.account_id JOIN whatsapp_cloud_accounts c ON c.account_id=a.id
      WHERE a.transport='cloud' AND oc.state='pending' AND oc.available_at<=now() ORDER BY oc.sequence FOR UPDATE OF oc SKIP LOCKED LIMIT 1`);
    if(!found.rowCount)return null;
    await client.query("UPDATE outbound_commands SET state='dispatched',attempt=attempt+1,claimed_at=now(),last_error=NULL WHERE id=$1",[found.rows[0].id]);
    if(found.rows[0].message_id)await client.query("UPDATE messages SET status='dispatching' WHERE id=$1",[found.rows[0].message_id]);
    return found.rows[0] as Record<string,unknown>;
  });
  if(!command)return false;
  const payload=command.payload as Record<string,unknown>;
  try{
    if(!command.enabled||command.status!=="online")throw new MetaApiError(409,"cloud_account_offline","Cloud API account is disabled");
    const token=decryptAtRest(String(command.access_token_encrypted),config.DATA_ENCRYPTION_KEY);
    const body=await cloudOutboundBody(payload,token,String(command.phone_number_id));
    const response=await graphRequest<{messages?:Array<{id?:string}>}>(`${command.phone_number_id}/messages`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const wamid=response.messages?.[0]?.id;if(!wamid)throw new MetaApiError(502,"missing_wamid","Meta did not return a message ID");
    await transaction(async client=>{
      await client.query("UPDATE outbound_commands SET state='completed',completed_at=now(),last_error=NULL WHERE id=$1",[command.id]);
      if(command.message_id){
        await client.query("UPDATE messages SET status='sent',whatsapp_message_id=$2,failure_code=NULL,failure_message=NULL WHERE id=$1",[command.message_id,wamid]);
        await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,'sent',now()) ON CONFLICT DO NOTHING",[command.message_id]);
      }
    });
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,1000),meta=error instanceof MetaApiError?error:null;
    if(meta?.status===429){
      const delay=Math.min(300,2**Math.min(Number(command.attempt??1),8));
      await pool.query("UPDATE outbound_commands SET state='pending',available_at=now()+($2||' seconds')::interval,claimed_at=NULL,last_error=$3 WHERE id=$1",[command.id,String(delay),message]);
      if(command.message_id)await pool.query("UPDATE messages SET status='queued' WHERE id=$1",[command.message_id]);
    }else{
      const uncertain=!meta||meta.status>=500,state=uncertain?"uncertain":"failed";
      await pool.query("UPDATE outbound_commands SET state=$2,completed_at=now(),last_error=$3 WHERE id=$1",[command.id,state,message]);
      if(command.message_id)await pool.query("UPDATE messages SET status=$2,failure_code=$3,failure_message=$4 WHERE id=$1",[command.message_id,state,meta?.code??"cloud_send_uncertain",message]);
    }
  }
  return true;
}

export async function cloudOutboundBody(payload:Record<string,unknown>,token:string,phoneNumberId:string):Promise<Record<string,unknown>>{
  const to=String(payload.toJid??"").split("@")[0].replace(/\D/g,""),type=String(payload.type??"text");
  if(!to)throw new MetaApiError(400,"destination_required","Missing destination phone number");
  if(type==="template"){
    const template=payload.template as Record<string,unknown>|undefined;
    if(!template?.name||!template.language)throw new MetaApiError(400,"template_invalid","Template name and language are required");
    const components:Array<Record<string,unknown>>=[];
    for(const component of Array.isArray(template.components)?template.components as Array<Record<string,unknown>>:[]){
      const parameters:Array<Record<string,unknown>>=[];
      for(const parameter of Array.isArray(component.parameters)?component.parameters as Array<Record<string,unknown>>:[]){
        const parameterType=String(parameter.type??"text");
        if(parameterType==="text")parameters.push({type:"text",text:String(parameter.text??"")});
        else if(["image","video","document"].includes(parameterType)){
          const providerMediaId=await uploadOutboundCloudMedia(String(parameter.mediaId??""),token,phoneNumberId);
          parameters.push({type:parameterType,[parameterType]:{id:providerMediaId}});
        }
      }
      components.push({type:component.type,...(component.sub_type?{sub_type:component.sub_type}:{}),...(component.index!==undefined?{index:String(component.index)}:{}),parameters});
    }
    return{messaging_product:"whatsapp",recipient_type:"individual",to,type:"template",template:{name:template.name,language:{code:template.language},components}};
  }
  if(type==="text")return{messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{preview_url:true,body:String(payload.text??"")}};
  if(!["image","video","audio","document"].includes(type))throw new MetaApiError(400,"unsupported_message_type",`Unsupported Cloud message type: ${type}`);
  const mediaId=String(payload.mediaId??"");if(!mediaId)throw new MetaApiError(400,"media_required","Missing RelayDesk media ID");
  const providerMediaId=await uploadOutboundCloudMedia(mediaId,token,phoneNumberId);
  const media:Record<string,unknown>={id:providerMediaId};
  if(payload.text&&type!=="audio")media.caption=String(payload.text);
  return{messaging_product:"whatsapp",recipient_type:"individual",to,type,[type]:media};
}

async function uploadOutboundCloudMedia(mediaId:string,token:string,phoneNumberId:string):Promise<string>{
  const found=await pool.query("SELECT object_key,file_name,mime_type FROM media WHERE id=$1 AND status='ready'",[mediaId]);
  if(!found.rowCount)throw new MetaApiError(404,"media_not_found","RelayDesk media not found");
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:found.rows[0].object_key})),bytes=Buffer.from(await object.Body!.transformToByteArray());
  const form=new FormData();form.append("messaging_product","whatsapp");form.append("type",found.rows[0].mime_type);form.append("file",new Blob([bytes],{type:found.rows[0].mime_type}),found.rows[0].file_name??"attachment");
  const response=await graphRequest<{id?:string}>(`${phoneNumberId}/media`,token,{method:"POST",body:form,signal:AbortSignal.timeout(90_000)});
  if(!response.id)throw new MetaApiError(502,"media_upload_failed","Meta did not return a media ID");
  return response.id;
}

let lastTemplateSync=0;
export async function syncDueCloudTemplates():Promise<boolean>{
  if(Date.now()-lastTemplateSync<6*60*60_000)return false;lastTemplateSync=Date.now();
  const accounts=await pool.query("SELECT account_id FROM whatsapp_cloud_accounts WHERE enabled AND (last_template_sync_at IS NULL OR last_template_sync_at<now()-interval '6 hours')");
  for(const row of accounts.rows)try{await syncCloudTemplates(String(row.account_id));}catch{}
  return Boolean(accounts.rowCount);
}
