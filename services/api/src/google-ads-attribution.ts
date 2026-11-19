import type {PoolClient} from "pg";
import {z} from "zod";
import {canAccessAccount,type Principal} from "./auth.js";

type Database=Pick<PoolClient,"query">;
export const adsEvents=["qualify_lead","close_convert_lead","purchase"] as const;
export const adsConsentSchema=z.object({consent:z.enum(["unset","granted","denied"]),updatedAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const clickId=z.string().min(1).max(512).regex(/^[A-Za-z0-9_.~-]+$/);
export const adsCaptureSchema=adsConsentSchema.extend({gclid:clickId.optional(),gbraid:clickId.optional(),wbraid:clickId.optional(),capturedAt:z.number().int().positive().optional()}).strict();
export const adsError=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});

export function adsIdentifiers(input:z.infer<typeof adsCaptureSchema>,now=Date.now()):Record<string,string>{
  if(input.consent==="denied"||!input.capturedAt||input.capturedAt>now+60_000||now-input.capturedAt>90*86400_000)return {};
  return Object.fromEntries(["gclid","gbraid","wbraid"].flatMap(key=>input[key as "gclid"]?[[key,input[key as "gclid"]!]]:[]));
}

export async function captureAdsAttribution(db:Database,visitorId:string,accountId:string,input?:z.infer<typeof adsCaptureSchema>){
  const data=input&&input.updatedAt<=Date.now()+60_000?input:{consent:"unset" as const,updatedAt:0};
  const identifiers=adsIdentifiers(data);
  await db.query(`INSERT INTO google_ads_attributions(visitor_id,account_id,identifiers,captured_at,consent,consent_revision)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(visitor_id) DO NOTHING`,
  [visitorId,accountId,JSON.stringify(identifiers),Object.keys(identifiers).length?new Date(data.capturedAt!):null,data.consent,data.updatedAt]);
}

export async function saveAdsConsent(db:Database,visitorId:string,input:z.infer<typeof adsConsentSchema>){
  if(input.updatedAt>Date.now()+60_000)throw adsError(400,"invalid_ads_consent_time");
  // 与 Worker 的归因行锁串行化，旧标签页不能用较早的同意状态覆盖撤回。
  await db.query(`WITH changed AS (
    UPDATE google_ads_attributions SET consent=$2,consent_revision=$3,
      identifiers=CASE WHEN $2='denied' THEN '{}'::jsonb ELSE identifiers END
    WHERE visitor_id=$1 AND (consent_revision<$3 OR (consent_revision=$3 AND $2='denied')) RETURNING id)
    UPDATE google_ads_conversion_events SET delivery_state='skipped_consent',last_error='consent_withdrawn',identifiers='{}'::jsonb
    WHERE attribution_id IN (SELECT id FROM changed) AND $2='denied' AND delivery_state='queued'`,[visitorId,input.consent,input.updatedAt]);
}

export async function adsConversation(db:Database,rootId:string,targetId:string,principal:Principal,write=false){
  const found=await db.query(`SELECT c.id,c.account_id,c.contact_id,c.origin_mode,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id
    WHERE c.id=$2 AND c.id IN (SELECT relay_conversation_members($1))${write?" FOR UPDATE OF c":""}`,[rootId,targetId]);
  const row=found.rows[0];
  if(!row||row.entity_type==="group"||!canAccessAccount(principal,row.account_id)||!["livechat","email"].includes(row.origin_mode))throw adsError(404,"ads_conversation_not_found");
  if(write)await adsWritePermission(db,principal,row.account_id);
  return row;
}
export async function adsWritePermission(db:Database,principal:Principal,accountId:string){
  if(!canAccessAccount(principal,accountId))throw adsError(404,"ads_source_not_found");
  if(principal.role!=="admin"&&!(await db.query("SELECT 1 FROM account_permissions WHERE account_id=$1 AND user_id=$2 AND can_read AND can_send",[accountId,principal.id])).rowCount)throw adsError(403,"ads_send_forbidden");
}

export async function attributionForConversation(db:Database,conversationId:string,principal:Principal,write=false){
  const found=await db.query(`SELECT a.*,v.contact_id,source.id source_conversation_id,ch.enabled,ch.archived_at
    FROM conversations c
    LEFT JOIN livechat_visitors native ON c.origin_mode='livechat' AND native.account_id=c.account_id AND native.contact_id=c.contact_id
    LEFT JOIN google_ads_email_links link ON c.origin_mode='email' AND link.conversation_id=c.id
    JOIN google_ads_attributions a ON a.visitor_id=native.id OR a.id=link.attribution_id
    JOIN livechat_visitors v ON v.id=a.visitor_id
    JOIN conversations source ON source.account_id=v.account_id AND source.contact_id=v.contact_id AND source.origin_mode='livechat'
    JOIN livechat_channels ch ON ch.account_id=a.account_id
    WHERE c.id=$1${write?" FOR UPDATE OF a FOR SHARE OF ch":""}`,[conversationId]);
  const row=found.rows[0];
  if(row&&!canAccessAccount(principal,row.account_id))throw adsError(404,"ads_source_not_found");
  if(row&&write)await adsWritePermission(db,principal,row.account_id);
  return row;
}

export function adsDestination(settings:Record<string,string>){
  return {operatingAccount:{accountType:"GOOGLE_ADS",accountId:settings.customer_id},
    ...(settings.login_customer_id?{loginAccount:{accountType:"GOOGLE_ADS",accountId:settings.login_customer_id}}:{}),productDestinationId:settings.action};
}

export async function queueAdsConversion(db:Database,input:{id?:string;conversationId:string;accountId:string;actorId:string;clientEventId:string;eventName:string;orderId?:string;params:Record<string,unknown>;principal:Principal}){
  if(!adsEvents.includes(input.eventName as typeof adsEvents[number]))return {deliveryState:"skipped_event"};
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,113))",[input.accountId+input.clientEventId]);
  const previous=(await db.query("SELECT * FROM google_ads_conversion_events WHERE account_id=$1 AND client_event_id=$2",[input.accountId,input.clientEventId])).rows[0];
  if(previous){
    if(previous.conversation_id!==input.conversationId||previous.actor_user_id!==input.actorId||previous.event_name!==input.eventName||(previous.order_id??null)!==(input.orderId??null)||(previous.event_params.value??null)!==(input.params.value??null)||(previous.event_params.currency??null)!==(input.params.currency??null))throw adsError(409,"client_event_id_conflict");
    return {id:previous.id,deliveryState:previous.delivery_state,deduplicated:true};
  }
  const a=await attributionForConversation(db,input.conversationId,input.principal,true);
  // 所有入口在同一归因上串行化，避免 LiveChat/Email 并发标记重复回传。
  if(a)await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,112))",[a.id]);
  const duplicate=await db.query(`SELECT id,delivery_state FROM google_ads_conversion_events
    WHERE (account_id=$1 AND client_event_id=$2) OR ($3::uuid IS NOT NULL AND attribution_id=$3 AND event_name=$4 AND $4<>'purchase')
      OR ($5::uuid IS NOT NULL AND order_id=$5 AND event_name='purchase') LIMIT 1`,[input.accountId,input.clientEventId,a?.id??null,input.eventName,input.orderId??null]);
  if(duplicate.rowCount)return {id:duplicate.rows[0].id,deliveryState:duplicate.rows[0].delivery_state,deduplicated:true};
  const settings=a?(await db.query("SELECT s.*,c.refresh_token_encrypted,c.revision connection_revision FROM google_ads_channel_settings s CROSS JOIN google_ads_connection c WHERE s.account_id=$1",[a.account_id])).rows[0]:undefined;
  const action=settings?.[input.eventName+"_action"];
  const state=a?.consent==="denied"?"skipped_consent":!a||!Object.keys(a.identifiers).length?"skipped_attribution":!a.enabled||a.archived_at||!settings?.enabled||!settings.refresh_token_encrypted||!action?"skipped_config":"queued";
  const result=await db.query(`INSERT INTO google_ads_conversion_events(id,conversation_id,account_id,attribution_id,actor_user_id,client_event_id,event_name,order_id,event_params,identifiers,destination,consent,config_revision,connection_revision,delivery_state)
    VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
  [input.id??null,input.conversationId,input.accountId,a?.id??null,input.actorId,input.clientEventId,input.eventName,input.orderId??null,JSON.stringify(input.params),JSON.stringify(state==="queued"?a.identifiers:{}),JSON.stringify(settings?adsDestination({...settings,action}):{}),a?.consent??"unset",settings?.revision??null,settings?.connection_revision??null,state]);
  return {id:result.rows[0].id,deliveryState:state,deduplicated:false};
}
