import {createHash,createHmac,randomBytes,timingSafeEqual} from "node:crypto";
import {GetObjectCommand,PutObjectCommand,S3Client} from "@aws-sdk/client-s3";
import type {FastifyInstance,FastifyReply} from "fastify";
import {z} from "zod";
import {authenticate} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {createWebhookEvent} from "./agent-hub.js";
import {decryptAtRest,encryptAtRest,hashSecret} from "./security.js";

const graphBase=`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}`;
const s3=new S3Client({region:config.S3_REGION,endpoint:config.S3_ENDPOINT,forcePathStyle:true,credentials:{accessKeyId:config.S3_ACCESS_KEY,secretAccessKey:config.S3_SECRET_KEY}});
const pageSchema=z.object({
  displayName:z.string().trim().min(2).max(80),
  pageId:z.string().trim().regex(/^\d+$/),
  pageAccessToken:z.string().trim().min(20).max(4096),
  appSecret:z.string().trim().min(16).max(512),
  enabled:z.boolean().default(true),
});
const pageUpdateSchema=pageSchema.partial().refine(value=>Object.keys(value).length>0);

type PageSetting={
  account_id:string;page_id:string;page_access_token_encrypted:string;app_secret_encrypted:string;
  enabled:boolean;display_name:string;status:string;
};

export class MessengerApiError extends Error{
  constructor(readonly status:number,readonly code:string,readonly detail:string){super(detail);}
}

async function graphRequest<T>(path:string,token:string,init:RequestInit={}):Promise<T>{
  const response=await fetch(path.startsWith("http")?path:`${graphBase}/${path.replace(/^\//,"")}`,{
    ...init,
    headers:{authorization:`Bearer ${token}`,accept:"application/json",...init.headers},
    signal:init.signal??AbortSignal.timeout(30_000),
  });
  const body=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok){
    const error=(body.error??{}) as Record<string,unknown>;
    throw new MessengerApiError(response.status,String(error.code??response.status),String(error.message??`Messenger Graph API HTTP ${response.status}`));
  }
  return body as T;
}

export async function verifyMessengerPage(input:{pageId:string;pageAccessToken:string}):Promise<{id:string;name?:string;picture?:unknown}>{
  const page=await graphRequest<{id?:string;name?:string;picture?:unknown}>(`${input.pageId}?fields=id,name,picture`,input.pageAccessToken);
  if(page.id!==input.pageId)throw new MessengerApiError(400,"page_mismatch","Page access token does not belong to the configured Page");
  return{id:page.id,name:page.name,picture:page.picture};
}

export function validMessengerSignature(raw:Buffer,header:string,secret:string):boolean{
  if(!header.startsWith("sha256="))return false;
  const expected=Buffer.from(header.slice(7),"hex");
  if(!expected.length)return false;
  const actual=createHmac("sha256",secret).update(raw).digest();
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export async function registerMessengerRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/v1/admin/messenger/pages",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const result=await pool.query(`SELECT a.id,a.display_name,a.status,p.page_id,p.enabled,p.credentials_verified_at,p.webhook_verified_at,p.last_webhook_at
      FROM channel_accounts a JOIN messenger_page_accounts p ON p.account_id=a.id
      WHERE a.platform='messenger' ORDER BY a.display_name`);
    return{data:result.rows.map(row=>({...row,platform:"messenger",credentialsStatus:row.credentials_verified_at?"verified":"unverified",webhookStatus:row.webhook_verified_at?"verified":"pending",pageAccessTokenConfigured:true,appSecretConfigured:true}))};
  });

  app.post("/api/v1/admin/messenger/pages",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=pageSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    let profile:{id:string;name?:string};
    try{profile=await verifyMessengerPage(parsed.data);}catch(error){return messengerCredentialFailure(reply,error);}
    const verifyToken=`rdm_${randomBytes(32).toString("base64url")}`;
    try{
      const id=await transaction(async client=>{
        const account=await client.query(`INSERT INTO channel_accounts(display_name,status,transport,platform,last_connected_at)
          VALUES($1,$2,'cloud','messenger',now()) RETURNING id`,[parsed.data.displayName||profile.name,parsed.data.enabled?"online":"offline"]);
        await client.query(`INSERT INTO messenger_page_accounts(account_id,page_id,page_access_token_encrypted,app_secret_encrypted,verify_token_hash,enabled,credentials_verified_at)
          VALUES($1,$2,$3,$4,$5,$6,now())`,[account.rows[0].id,parsed.data.pageId,encryptAtRest(parsed.data.pageAccessToken,config.DATA_ENCRYPTION_KEY),encryptAtRest(parsed.data.appSecret,config.DATA_ENCRYPTION_KEY),hashSecret(verifyToken),parsed.data.enabled]);
        await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'messenger_page.create','channel_account',$2,$3)",[request.principal!.id,account.rows[0].id,JSON.stringify({pageId:parsed.data.pageId})]);
        return String(account.rows[0].id);
      });
      return reply.code(201).send({id,verifyToken,webhookPath:"/api/v1/meta/messenger/webhook"});
    }catch(error){
      if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"page_already_exists"});
      throw error;
    }
  });

  app.patch("/api/v1/admin/messenger/pages/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=pageUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {id}=request.params as {id:string};
    const current=await pageSetting(id);if(!current)return reply.code(404).send({error:"not_found"});
    const token=parsed.data.pageAccessToken??decryptAtRest(current.page_access_token_encrypted,config.DATA_ENCRYPTION_KEY),pageId=parsed.data.pageId??current.page_id;
    try{await verifyMessengerPage({pageId,pageAccessToken:token});}catch(error){return messengerCredentialFailure(reply,error);}
    const enabled=parsed.data.enabled??current.enabled;
    await transaction(async client=>{
      await client.query("UPDATE channel_accounts SET display_name=$2,status=CASE WHEN $3 THEN 'online'::wa_account_status ELSE 'offline'::wa_account_status END,status_reason=CASE WHEN $3 THEN NULL ELSE 'messenger_disabled' END WHERE id=$1",[id,parsed.data.displayName??current.display_name,enabled]);
      await client.query(`UPDATE messenger_page_accounts SET page_id=$2,page_access_token_encrypted=$3,app_secret_encrypted=$4,enabled=$5,credentials_verified_at=now(),updated_at=now() WHERE account_id=$1`,[
        id,pageId,encryptAtRest(token,config.DATA_ENCRYPTION_KEY),parsed.data.appSecret?encryptAtRest(parsed.data.appSecret,config.DATA_ENCRYPTION_KEY):current.app_secret_encrypted,enabled,
      ]);
    });
    return{ok:true};
  });

  app.post("/api/v1/admin/messenger/pages/:id/test",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string},row=await pageSetting(id);if(!row)return reply.code(404).send({error:"not_found"});
    try{
      const profile=await verifyMessengerPage({pageId:row.page_id,pageAccessToken:decryptAtRest(row.page_access_token_encrypted,config.DATA_ENCRYPTION_KEY)});
      await pool.query("UPDATE messenger_page_accounts SET credentials_verified_at=now(),updated_at=now() WHERE account_id=$1",[id]);
      return{ok:true,profile};
    }catch(error){return messengerCredentialFailure(reply,error);}
  });

  app.post("/api/v1/admin/messenger/pages/:id/verify-token/reset",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string},token=`rdm_${randomBytes(32).toString("base64url")}`;
    const result=await pool.query("UPDATE messenger_page_accounts SET verify_token_hash=$2,webhook_verified_at=NULL,updated_at=now() WHERE account_id=$1 RETURNING account_id",[id,hashSecret(token)]);
    return result.rowCount?{verifyToken:token}:reply.code(404).send({error:"not_found"});
  });

  await app.register(async webhook=>{
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser("application/json",{parseAs:"buffer"},(request,body,done)=>{
      try{(request as typeof request&{rawBody:Buffer}).rawBody=body as Buffer;done(null,JSON.parse((body as Buffer).toString("utf8")));}catch(error){done(error as Error,undefined);}
    });
    webhook.get("/api/v1/meta/messenger/webhook",async(request,reply)=>{
      const query=request.query as Record<string,string|undefined>;
      if(query["hub.mode"]!=="subscribe"||!query["hub.verify_token"])return reply.code(403).send("Forbidden");
      const found=await pool.query("UPDATE messenger_page_accounts SET webhook_verified_at=now(),updated_at=now() WHERE verify_token_hash=$1 AND enabled RETURNING account_id",[hashSecret(query["hub.verify_token"])]);
      if(!found.rowCount)return reply.code(403).send("Forbidden");
      return reply.type("text/plain").send(query["hub.challenge"]??"");
    });
    webhook.post("/api/v1/meta/messenger/webhook",async(request,reply)=>{
      const raw=(request as typeof request&{rawBody?:Buffer}).rawBody??Buffer.from(JSON.stringify(request.body??{}));
      const body=request.body as Record<string,unknown>,entries=Array.isArray(body.entry)?body.entry as Array<Record<string,unknown>>:[];
      const pageIds=[...new Set(entries.map(entry=>String(entry.id??"")).filter(Boolean))];
      if(body.object!=="page"||!pageIds.length)return{received:true,ignored:true};
      const pages=await pool.query("SELECT * FROM messenger_page_accounts WHERE page_id=ANY($1::text[]) AND enabled",[pageIds]);
      const byPage=new Map(pages.rows.map(row=>[String(row.page_id),row]));
      const signature=String(request.headers["x-hub-signature-256"]??"");
      let accepted=0,signatureValid=false;
      for(const entry of entries){
        const page=byPage.get(String(entry.id??""));if(!page)continue;
        const secret=decryptAtRest(page.app_secret_encrypted,config.DATA_ENCRYPTION_KEY);
        if(!validMessengerSignature(raw,signature,secret))continue;
        signatureValid=true;
        const payloadHash=createHash("sha256").update(JSON.stringify(entry)).digest("hex");
        const inserted=await pool.query("INSERT INTO messenger_webhook_events(account_id,page_id,payload_hash,payload) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,payload_hash) DO NOTHING RETURNING id",[page.account_id,page.page_id,payloadHash,JSON.stringify(entry)]);
        if(inserted.rowCount)accepted++;
        await pool.query("UPDATE messenger_page_accounts SET last_webhook_at=now(),updated_at=now() WHERE account_id=$1",[page.account_id]);
      }
      if(!signatureValid&&pages.rowCount)return reply.code(401).send({error:"invalid_signature"});
      return{received:true,accepted};
    });
  });
}

function messengerCredentialFailure(reply:FastifyReply,error:unknown){
  return reply.code(400).send({error:"messenger_credentials_invalid",message:error instanceof Error?error.message:String(error)});
}

async function pageSetting(accountId:string):Promise<PageSetting|null>{
  const result=await pool.query("SELECT p.*,a.display_name,a.status FROM messenger_page_accounts p JOIN channel_accounts a ON a.id=p.account_id WHERE p.account_id=$1 AND a.platform='messenger'",[accountId]);
  return result.rows[0]??null;
}

export async function processOneMessengerWebhook():Promise<boolean>{
  const event=await transaction(async client=>{
    const found=await client.query("SELECT * FROM messenger_webhook_events WHERE state IN ('pending','retry') AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
    if(!found.rowCount)return null;
    await client.query("UPDATE messenger_webhook_events SET state='processing',attempt=attempt+1,claimed_at=now() WHERE id=$1",[found.rows[0].id]);
    return found.rows[0] as {id:number;account_id:string;payload:Record<string,unknown>;attempt:number};
  });
  if(!event)return false;
  try{
    await processMessengerEntry(event.account_id,event.payload);
    await pool.query("UPDATE messenger_webhook_events SET state='completed',completed_at=now(),last_error=NULL WHERE id=$1",[event.id]);
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,1000),attempt=event.attempt+1;
    if(attempt>=8)await pool.query("UPDATE messenger_webhook_events SET state='failed',completed_at=now(),last_error=$2 WHERE id=$1",[event.id,message]);
    else await pool.query("UPDATE messenger_webhook_events SET state='retry',available_at=now()+($2||' seconds')::interval,last_error=$3 WHERE id=$1",[event.id,String(Math.min(300,2**attempt)),message]);
  }
  return true;
}

async function processMessengerEntry(accountId:string,entry:Record<string,unknown>):Promise<void>{
  const setting=await pageSetting(accountId);if(!setting||!setting.enabled)return;
  const token=decryptAtRest(setting.page_access_token_encrypted,config.DATA_ENCRYPTION_KEY);
  for(const rawEvent of Array.isArray(entry.messaging)?entry.messaging as Array<Record<string,unknown>>:[]){
    const message=rawEvent.message as Record<string,unknown>|undefined;
    if(message){
      const isEcho=Boolean(message.is_echo),sender=(rawEvent.sender??{}) as Record<string,unknown>,recipient=(rawEvent.recipient??{}) as Record<string,unknown>;
      const userId=String(isEcho?recipient.id:sender.id),mid=String(message.mid??"");
      if(!userId||!mid)continue;
      await ingestMessengerMessage({accountId,userId,message,event:rawEvent,token,direction:isEcho?"out":"in"});
      continue;
    }
    const delivery=rawEvent.delivery as Record<string,unknown>|undefined;
    if(delivery){
      const mids=Array.isArray(delivery.mids)?delivery.mids.map(String):[];
      if(mids.length)await transaction(async client=>{
        const changed=await client.query("UPDATE messages SET status='delivered' WHERE account_id=$1 AND provider_message_id=ANY($2::text[]) AND direction='out' AND status IN ('sent','dispatching','queued') RETURNING id,conversation_id,provider_message_id",[accountId,mids]);
        for(const row of changed.rows){
          await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,'delivered',now()) ON CONFLICT DO NOTHING",[row.id]);
          await createWebhookEvent(client,"message.status_changed",row.id,{platform:"messenger",accountId,conversationId:row.conversation_id,providerMessageId:row.provider_message_id,status:"delivered"});
        }
      });
      continue;
    }
    const read=rawEvent.read as Record<string,unknown>|undefined;
    if(read){
      const sender=(rawEvent.sender??{}) as Record<string,unknown>,userId=String(sender.id??""),watermark=Number(read.watermark);
      if(userId&&Number.isFinite(watermark))await markMessengerRead(accountId,userId,watermark);
    }
  }
}

async function ingestMessengerMessage(input:{accountId:string;userId:string;message:Record<string,unknown>;event:Record<string,unknown>;token:string;direction:"in"|"out"}):Promise<void>{
  const existing=await pool.query("SELECT id FROM messages WHERE account_id=$1 AND provider_message_id=$2",[input.accountId,String(input.message.mid)]);
  if(existing.rowCount)return;
  const contact=await ensureMessengerContact(input.accountId,input.userId,input.token);
  const occurredAt=new Date(Number(input.event.timestamp)||Date.now()).toISOString();
  const normalized=await normalizeMessengerContent(input.accountId,input.message,input.token);
  await transaction(async client=>{
    const conversation=await client.query(`INSERT INTO conversations(account_id,contact_id,unread_count,service_window_expires_at)
      VALUES($1,$2,CASE WHEN $3='in' THEN 1 ELSE 0 END,CASE WHEN $3='in' THEN $4::timestamptz+interval '24 hours' END)
      ON CONFLICT(account_id,contact_id) DO UPDATE SET unread_count=conversations.unread_count+CASE WHEN $3='in' THEN 1 ELSE 0 END,status='open',
      service_window_expires_at=CASE WHEN $3='in' THEN GREATEST(conversations.service_window_expires_at,EXCLUDED.service_window_expires_at) ELSE conversations.service_window_expires_at END
      RETURNING id`,[input.accountId,contact,input.direction,occurredAt]);
    const inserted=await client.query(`INSERT INTO messages(conversation_id,account_id,sender_contact_id,provider_message_id,direction,kind,text_content,media_id,status,occurred_at,provider_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(account_id,provider_message_id) DO NOTHING RETURNING id`,[
      conversation.rows[0].id,input.accountId,input.direction==="in"?contact:null,String(input.message.mid),input.direction,normalized.kind,normalized.text,normalized.mediaId,input.direction==="in"?"received":"sent",occurredAt,JSON.stringify(input.message),
    ]);
    if(inserted.rowCount)await createWebhookEvent(client,input.direction==="in"?"message.received":"message.sent",inserted.rows[0].id,{platform:"messenger",accountId:input.accountId,providerMessageId:String(input.message.mid),conversationId:conversation.rows[0].id,direction:input.direction,kind:normalized.kind,text:normalized.text});
  });
}

async function ensureMessengerContact(accountId:string,userId:string,token:string):Promise<string>{
  const existing=await pool.query("SELECT id,display_name FROM contacts WHERE account_id=$1 AND provider_user_id=$2",[accountId,userId]);
  let name=existing.rows[0]?.display_name?String(existing.rows[0].display_name):"";
  let avatarUrl:string|null=null;
  if(!name)try{
    const profile=await graphRequest<{name?:string;profile_pic?:string}>(`${userId}?fields=name,profile_pic`,token);
    name=profile.name??"";
    if(profile.profile_pic)avatarUrl=await storeMessengerAvatar(accountId,userId,profile.profile_pic).catch(()=>null);
  }catch{}
  const result=await pool.query(`INSERT INTO contacts(account_id,provider_user_id,display_name,avatar_url,last_seen_at)
    VALUES($1,$2,$3,$4,now()) ON CONFLICT(account_id,provider_user_id) DO UPDATE SET display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),contacts.display_name),
    avatar_url=COALESCE(EXCLUDED.avatar_url,contacts.avatar_url),last_seen_at=now(),updated_at=now() RETURNING id`,[accountId,userId,name||`Facebook ${userId}`,avatarUrl]);
  return String(result.rows[0].id);
}

async function storeMessengerAvatar(accountId:string,userId:string,url:string):Promise<string>{
  const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error(`messenger_avatar_http_${response.status}`);
  const source=Buffer.from(await response.arrayBuffer());
  if(source.length>5*1024*1024)throw new Error("messenger_avatar_too_large");
  const avatar=await import("sharp").then(({default:sharp})=>sharp(source).rotate().resize(512,512,{fit:"cover",withoutEnlargement:true}).webp({quality:86}).toBuffer());
  const objectKey=`contact-avatars/${accountId}/messenger-${userId}/${randomBytes(16).toString("hex")}.webp`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:avatar,ContentType:"image/webp"}));
  return objectKey;
}

async function normalizeMessengerContent(accountId:string,message:Record<string,unknown>,token:string):Promise<{kind:string;text:string|null;mediaId:string|null}>{
  const text=typeof message.text==="string"?message.text:null,attachments=Array.isArray(message.attachments)?message.attachments as Array<Record<string,unknown>>:[];
  if(!attachments.length)return{kind:"text",text:text??"",mediaId:null};
  const attachment=attachments[0],type=String(attachment.type??"file"),payload=(attachment.payload??{}) as Record<string,unknown>,url=String(payload.url??"");
  const kind=type==="image"?"image":type==="video"?"video":type==="audio"?"audio":"document";
  if(!url)return{kind,text:text??`[${type}]`,mediaId:null};
  const response=await fetch(url,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(90_000)});
  if(!response.ok)throw new MessengerApiError(response.status,"attachment_download_failed",`Messenger attachment download HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer()),mime=response.headers.get("content-type")??"application/octet-stream",sha256=createHash("sha256").update(bytes).digest("hex");
  const fileName=`messenger-${String(message.mid??randomBytes(8).toString("hex"))}.${extensionForMime(mime,kind)}`,objectKey=`inbound/${accountId}/${new Date().toISOString().slice(0,10)}/${randomBytes(16).toString("hex")}`;
  await s3.send(new PutObjectCommand({Bucket:config.S3_BUCKET,Key:objectKey,Body:bytes,ContentType:mime,Metadata:{sha256,provider:"messenger"}}));
  const created=await pool.query("INSERT INTO media(account_id,object_key,file_name,mime_type,byte_size,sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[accountId,objectKey,fileName,mime,bytes.length,sha256]);
  return{kind,text,mediaId:String(created.rows[0].id)};
}

function extensionForMime(mime:string,kind:string):string{
  const known:Record<string,string>={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","video/mp4":"mp4","audio/mpeg":"mp3","audio/ogg":"ogg","application/pdf":"pdf"};
  return known[mime]??(kind==="document"?"bin":kind);
}

async function markMessengerRead(accountId:string,userId:string,watermark:number):Promise<void>{
  await transaction(async client=>{
    const conversation=await client.query("SELECT c.id FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.account_id=$1 AND co.provider_user_id=$2",[accountId,userId]);
    if(!conversation.rowCount)return;
    const changed=await client.query("UPDATE messages SET status='read' WHERE conversation_id=$1 AND direction='out' AND occurred_at<=to_timestamp($2/1000.0) AND status IN ('sent','delivered') RETURNING id,provider_message_id",[conversation.rows[0].id,watermark]);
    for(const row of changed.rows){
      await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,'read',now()) ON CONFLICT DO NOTHING",[row.id]);
      await createWebhookEvent(client,"message.status_changed",row.id,{platform:"messenger",accountId,conversationId:conversation.rows[0].id,providerMessageId:row.provider_message_id,status:"read"});
    }
  });
}

export async function processOneMessengerOutbound():Promise<boolean>{
  const command=await transaction(async client=>{
    const found=await client.query(`SELECT oc.*,p.page_id,p.page_access_token_encrypted,p.enabled,a.status
      FROM outbound_commands oc JOIN channel_accounts a ON a.id=oc.account_id JOIN messenger_page_accounts p ON p.account_id=a.id
      WHERE a.platform='messenger' AND oc.state='pending' AND oc.available_at<=now() ORDER BY oc.sequence FOR UPDATE OF oc SKIP LOCKED LIMIT 1`);
    if(!found.rowCount)return null;
    await client.query("UPDATE outbound_commands SET state='dispatched',attempt=attempt+1,claimed_at=now(),last_error=NULL WHERE id=$1",[found.rows[0].id]);
    if(found.rows[0].message_id)await client.query("UPDATE messages SET status='dispatching' WHERE id=$1",[found.rows[0].message_id]);
    return found.rows[0] as Record<string,unknown>;
  });
  if(!command)return false;
  const payload=command.payload as Record<string,unknown>;
  try{
    if(!command.enabled||command.status!=="online")throw new MessengerApiError(409,"messenger_page_offline","Messenger Page is disabled");
    const token=decryptAtRest(String(command.page_access_token_encrypted),config.DATA_ENCRYPTION_KEY),pageId=String(command.page_id);
    const body=await messengerOutboundBody(payload,token,pageId);
    const response=await graphRequest<{message_id?:string}>(`${pageId}/messages`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    if(!response.message_id)throw new MessengerApiError(502,"missing_message_id","Messenger did not return a message ID");
    await transaction(async client=>{
      await client.query("UPDATE outbound_commands SET state='completed',completed_at=now(),last_error=NULL WHERE id=$1",[command.id]);
      if(command.message_id){
        await client.query("UPDATE messages SET status='sent',provider_message_id=$2,failure_code=NULL,failure_message=NULL WHERE id=$1",[command.message_id,response.message_id]);
        await client.query("INSERT INTO message_receipts(message_id,status,occurred_at) VALUES($1,'sent',now()) ON CONFLICT DO NOTHING",[command.message_id]);
        await createWebhookEvent(client,"message.status_changed",String(command.message_id),{platform:"messenger",accountId:String(command.account_id),conversationId:String(payload.conversationId??""),providerMessageId:response.message_id,status:"sent"});
      }
    });
  }catch(error){
    const message=(error instanceof Error?error.message:String(error)).slice(0,1000),meta=error instanceof MessengerApiError?error:null;
    if(meta?.status===429){
      const delay=Math.min(300,2**Math.min(Number(command.attempt??1),8));
      await pool.query("UPDATE outbound_commands SET state='pending',available_at=now()+($2||' seconds')::interval,claimed_at=NULL,last_error=$3 WHERE id=$1",[command.id,String(delay),message]);
      if(command.message_id)await pool.query("UPDATE messages SET status='queued' WHERE id=$1",[command.message_id]);
    }else{
      const uncertain=!meta||meta.status>=500,state=uncertain?"uncertain":"failed";
      await pool.query("UPDATE outbound_commands SET state=$2,completed_at=now(),last_error=$3 WHERE id=$1",[command.id,state,message]);
      if(command.message_id)await pool.query("UPDATE messages SET status=$2,failure_code=$3,failure_message=$4 WHERE id=$1",[command.message_id,state,meta?.code??"messenger_send_uncertain",message]);
    }
  }
  return true;
}

export async function messengerOutboundBody(payload:Record<string,unknown>,token:string,pageId:string):Promise<Record<string,unknown>>{
  const recipient=String(payload.destinationId??payload.toJid??""),type=String(payload.type??"text");
  if(!recipient)throw new MessengerApiError(400,"destination_required","Missing Messenger recipient ID");
  const replyMid=String(payload.quotedProviderMessageId??payload.quotedWhatsappMessageId??"");
  let message:Record<string,unknown>;
  if(type==="text")message={text:String(payload.text??"")};
  else{
    if(!["image","video","audio","document"].includes(type))throw new MessengerApiError(400,"unsupported_message_type",`Unsupported Messenger message type: ${type}`);
    const attachmentId=await uploadMessengerAttachment(String(payload.mediaId??""),token,pageId,type);
    message={attachment:{type:type==="document"?"file":type,payload:{attachment_id:attachmentId}}};
  }
  if(replyMid)message.reply_to={mid:replyMid};
  return{recipient:{id:recipient},messaging_type:"RESPONSE",message};
}

async function uploadMessengerAttachment(mediaId:string,token:string,pageId:string,type:string):Promise<string>{
  const found=await pool.query("SELECT object_key,file_name,mime_type FROM media WHERE id=$1 AND status='ready'",[mediaId]);
  if(!found.rowCount)throw new MessengerApiError(404,"media_not_found","RelayDesk media not found");
  const object=await s3.send(new GetObjectCommand({Bucket:config.S3_BUCKET,Key:found.rows[0].object_key})),bytes=Buffer.from(await object.Body!.transformToByteArray());
  const form=new FormData();
  form.append("message",JSON.stringify({attachment:{type:type==="document"?"file":type,payload:{is_reusable:true}}}));
  form.append("filedata",new Blob([bytes],{type:found.rows[0].mime_type}),found.rows[0].file_name??"attachment");
  const response=await graphRequest<{attachment_id?:string}>(`${pageId}/message_attachments`,token,{method:"POST",body:form,signal:AbortSignal.timeout(90_000)});
  if(!response.attachment_id)throw new MessengerApiError(502,"attachment_upload_failed","Messenger did not return an attachment ID");
  return response.attachment_id;
}
