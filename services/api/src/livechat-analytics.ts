import type {PoolClient} from "pg";
import {createHash} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate,canAccessAccount,type Principal} from "./auth.js";
import {pool,transaction} from "./db.js";
import {config} from "./config.js";
import {decryptAtRest} from "./security.js";

export const analyticsSchema=z.object({consent:z.enum(["granted","denied","unset"]),updatedAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),measurementId:z.string().max(40).regex(/^G-[A-Z0-9]+$/).optional(),clientId:z.string().regex(/^[0-9]{1,20}\.[0-9]{1,20}$/).optional()}).strict().refine(v=>v.consent==="granted"?Boolean(v.measurementId):!v.measurementId&&!v.clientId);
export type AnalyticsContext=z.infer<typeof analyticsSchema>;
const reservedEvents=new Set(["generate_lead","ad_activeview","ad_click","ad_exposure","ad_impression","ad_query","ad_reward","adunit_exposure","app_clear_data","app_exception","app_install","app_remove","app_store_refund","app_update","app_upgrade","click","error","file_download","first_open","first_visit","form_start","form_submit","in_app_purchase","notification_dismiss","notification_foreground","notification_open","notification_receive","os_update","page_view","scroll","session_start","user_engagement","video_complete","video_progress","video_start","view_search_results"]);
export function validConversionEventName(name:string):boolean{return /^[a-z][a-z0-9_]{0,39}$/.test(name)&&!reservedEvents.has(name)&&!name.startsWith("ga_")&&!name.startsWith("google_")&&!name.startsWith("firebase_");}
export const conversionSchema=z.object({clientEventId:z.string().uuid(),targetConversationId:z.string().uuid().optional(),eventName:z.string().refine(validConversionEventName),orderId:z.string().uuid().optional(),value:z.number().finite().nonnegative().max(1e12).optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional()}).strict().superRefine((v,ctx)=>{
  if(v.eventName==="purchase"?(!v.orderId||v.value!==undefined||v.currency!==undefined):Boolean(v.orderId))ctx.addIssue({code:"custom",message:"purchase 必须选择订单，金额与币种由订单读取"});
  if((v.value===undefined)!==(v.currency===undefined))ctx.addIssue({code:"custom",message:"金额与币种必须同时填写"});
});
const fail=(statusCode:number,message:string)=>Object.assign(new Error(message),{statusCode});
const publicEventColumns="id,conversation_id,event_name,source,order_id,event_params,delivery_state,attempts,last_error,created_at";
const paidOrder=`o.business_status <> 'cancelled' AND (
  EXISTS(SELECT 1 FROM order_payment_requests pr WHERE pr.order_id=o.id AND pr.environment='live'
    AND pr.amount=o.amount AND pr.currency=o.currency AND pr.status IN ('PAID','MARKED_AS_PAID','PAID_EXTERNAL'))
  OR ((o.business_status='paid' OR (o.business_status IN ('processing','shipped','completed') AND EXISTS(
    SELECT 1 FROM audit_log payment WHERE payment.action='order.status.update' AND payment.target_type='order'
      AND payment.target_id=o.id::text AND payment.metadata->>'businessStatus'='paid')))
    AND NOT EXISTS(SELECT 1 FROM order_payment_requests pr WHERE pr.order_id=o.id)))`;
function configFingerprint(measurementId:string,encryptedSecret:string){return createHash("sha256").update(measurementId).update(":").update(encryptedSecret).digest("hex");}

export async function saveVisitorAnalytics(client:Pick<PoolClient,"query">,visitorId:string,measurementId:string|null,context:AnalyticsContext):Promise<boolean>{
  if(context.updatedAt>Date.now()+60_000||(context.consent==="granted"&&context.measurementId!==measurementId))return false;
  await client.query(`WITH changed AS (
    UPDATE livechat_visitors SET analytics_consent=$2,analytics_client_id=$3,analytics_measurement_id=$4,analytics_revision=$5
    WHERE id=$1 AND (analytics_revision<$5 OR (analytics_revision=$5 AND $2<>'granted'))
    RETURNING account_id,contact_id)
    UPDATE livechat_conversion_events e SET delivery_state=CASE WHEN $2='granted' THEN 'skipped_client_id' ELSE 'skipped_consent' END,
      last_error=CASE WHEN $2='granted' THEN 'analytics_context_changed' ELSE 'consent_withdrawn' END,ga4_client_id=NULL
    FROM changed WHERE e.account_id=changed.account_id AND e.contact_id=changed.contact_id
      AND e.delivery_state='queued' AND ($2<>'granted' OR e.ga4_client_id IS DISTINCT FROM $3 OR e.ga4_measurement_id IS DISTINCT FROM $4)`,
  [visitorId,context.consent,context.clientId??null,context.measurementId??null,context.updatedAt]);
  return true;
}

// 首聊只交给宿主 GTM 发送，避免浏览器和 Measurement Protocol 重复计算线索。
export async function recordLivechatLead(client:PoolClient,input:{accountId:string;conversationId:string;contactId:string;visitorId:string;messageId:string;clientMessageId:string}):Promise<void>{
  await client.query(`INSERT INTO livechat_conversion_events(id,account_id,conversation_id,contact_id,client_event_id,source,event_name,delivery_state,event_params)
    VALUES($5,$1,$2,$3,$4,'automatic','generate_lead','browser_managed','{"lead_source":"livechat"}')`,[input.accountId,input.conversationId,input.contactId,input.clientMessageId,input.messageId]);
  await client.query("UPDATE livechat_visitors SET lead_message_id=$2 WHERE id=$1",[input.visitorId,input.messageId]);
}

async function conversionTarget(client:Pick<PoolClient,"query">,rootId:string,targetId:string,principal:Principal,write=false){
  const found=await client.query(`SELECT cv.id,cv.account_id,cv.contact_id,root.account_id root_account_id,v.analytics_consent,
    CASE WHEN v.analytics_measurement_id=channel.ga4_measurement_id THEN v.analytics_client_id END analytics_client_id,
    channel.ga4_measurement_id,channel.ga4_api_secret_encrypted,channel.enabled,channel.archived_at
    FROM conversations root JOIN conversations cv ON cv.id=$2
    JOIN livechat_channels channel ON channel.account_id=cv.account_id
    JOIN livechat_visitors v ON v.account_id=cv.account_id AND v.contact_id=cv.contact_id
    WHERE root.id=$1 AND cv.id IN (SELECT relay_conversation_members(root.id)) AND cv.origin_mode='livechat'${write?" FOR SHARE OF channel,v FOR UPDATE OF cv":""}`,[rootId,targetId]);
  const row=found.rows[0];if(!row||!canAccessAccount(principal,row.account_id)||!canAccessAccount(principal,row.root_account_id))throw fail(404,"conversion_target_not_found");
  if(write&&(!row.enabled||row.archived_at))throw fail(409,"livechat_channel_disabled");
  if(principal.role!=="admin"){
    const permission=await client.query("SELECT 1 FROM account_permissions WHERE account_id=$1 AND user_id=$2 AND can_read AND can_send",[row.account_id,principal.id]);
    row.can_record=Boolean(permission.rowCount)&&row.enabled&&!row.archived_at;
    if(write&&!row.can_record)throw fail(403,"account_send_forbidden");
  }else row.can_record=row.enabled&&!row.archived_at;
  return row;
}

export async function registerLivechatAnalyticsRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/v1/conversations/:id/livechat-conversions",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const params=z.object({id:z.string().uuid()}).safeParse(request.params),query=z.object({targetConversationId:z.string().uuid().optional()}).safeParse(request.query);
    if(!params.success||!query.success)return reply.code(400).send({error:"invalid_request"});
    const targetId=query.data.targetConversationId??params.data.id;
    const row=await conversionTarget(pool,params.data.id,targetId,request.principal).catch(error=>{if(error instanceof Error&&error.message==="conversion_target_not_found")return null;throw error;});
    if(!row)return reply.code(404).send({error:"conversion_target_not_found",message:"访客不存在或无权访问"});
    const [events,orders]=await Promise.all([
      pool.query(`SELECT ${publicEventColumns} FROM livechat_conversion_events WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[targetId]),
      pool.query(`SELECT o.id,o.display_order_number,o.amount,o.currency,EXISTS(SELECT 1 FROM livechat_conversion_events e WHERE e.order_id=o.id AND e.event_name='purchase') recorded
        FROM orders o JOIN conversations cv ON cv.id=o.conversation_id WHERE cv.account_id=$1 AND cv.contact_id=$2 AND o.deleted_at IS NULL
        AND (${paidOrder}) ORDER BY o.created_at DESC LIMIT 100`,[row.account_id,row.contact_id]),
    ]);
    return reply.header("cache-control","no-store").send({data:events.rows,orders:orders.rows,canRecord:row.can_record,analytics:{consent:row.analytics_consent,clientIdAvailable:Boolean(row.analytics_client_id),configured:Boolean(row.ga4_measurement_id&&row.ga4_api_secret_encrypted)}});
  });
  app.post("/api/v1/conversations/:id/livechat-conversions",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const principal=request.principal,params=z.object({id:z.string().uuid()}).safeParse(request.params),parsed=conversionSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:"invalid_conversion",message:"请检查事件名称、订单以及金额和币种"});
    const data=parsed.data,rootId=params.data.id,targetId=data.targetConversationId??rootId;
    try{
      const result=await transaction(async client=>{
        const row=await conversionTarget(client,rootId,targetId,principal,true);
        const old=await client.query(`SELECT ${publicEventColumns},actor_user_id FROM livechat_conversion_events WHERE account_id=$1 AND client_event_id=$2`,[row.account_id,data.clientEventId]);
        if(old.rowCount){
          const e=old.rows[0];if(e.conversation_id!==targetId||e.actor_user_id!==principal.id||e.event_name!==data.eventName||(e.order_id??null)!==(data.orderId??null)||(data.eventName!=="purchase"&&((e.event_params.value??null)!==(data.value??null)||(e.event_params.currency??null)!==(data.currency??null))))throw fail(409,"client_event_id_conflict");
          return {id:e.id,deduplicated:true,deliveryState:e.delivery_state};
        }
        const eventParams:Record<string,unknown>={lead_source:"livechat"};
        if(data.eventName==="purchase"){
          const found=await client.query(`SELECT o.id,o.amount,o.currency,o.shipping_amount,(${paidOrder}) paid
            FROM orders o JOIN conversations cv ON cv.id=o.conversation_id WHERE o.id=$1 AND cv.account_id=$2 AND cv.contact_id=$3 AND o.deleted_at IS NULL FOR UPDATE OF o`,[data.orderId,row.account_id,row.contact_id]);
          const order=found.rows[0];if(!order||!order.paid)throw fail(409,"purchase_paid_order_required");
          if((await client.query("SELECT 1 FROM livechat_conversion_events WHERE event_name='purchase' AND order_id=$1",[data.orderId])).rowCount)throw fail(409,"purchase_already_recorded");
          const items=await client.query("SELECT id,product_id,quantity,unit_amount FROM order_items WHERE order_id=$1 ORDER BY position LIMIT 201",[data.orderId]);
          if(!items.rowCount||items.rows.length>200||!Number.isFinite(Number(order.amount))||Number(order.amount)<=0||!/^[A-Z]{3}$/.test(order.currency))throw fail(409,"purchase_order_invalid");
          // 内部 ID 和固定标签避免将手填订单号、商品名中可能包含的个人资料发给 GA4。
          const products=items.rows.map(item=>({item_id:String(item.product_id??item.id),item_name:item.product_id?"Catalog item":"Custom item",quantity:Number(item.quantity),price:Number(item.unit_amount)}));
          const value=Math.round(products.reduce((total,item)=>total+item.quantity*item.price,0)*100)/100;
          Object.assign(eventParams,{transaction_id:String(order.id),value,currency:String(order.currency),items:products,...(order.shipping_amount!==null?{shipping:Number(order.shipping_amount)}:{})});
        }else if(data.value!==undefined){eventParams.value=data.value;eventParams.currency=data.currency;}
        const state=row.analytics_consent!=="granted"?"skipped_consent":!row.ga4_measurement_id||!row.ga4_api_secret_encrypted?"skipped_config":!row.analytics_client_id?"skipped_client_id":"queued";
        const inserted=await client.query(`INSERT INTO livechat_conversion_events(account_id,conversation_id,contact_id,actor_user_id,client_event_id,source,event_name,order_id,event_params,analytics_consent,ga4_client_id,delivery_state,ga4_measurement_id,ga4_config_fingerprint)
          VALUES($1,$2,$3,$4,$5,'agent',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[row.account_id,targetId,row.contact_id,principal.id,data.clientEventId,data.eventName,data.orderId??null,JSON.stringify(eventParams),row.analytics_consent,state==="queued"?row.analytics_client_id:null,state,state==="queued"?row.ga4_measurement_id:null,state==="queued"?configFingerprint(row.ga4_measurement_id,row.ga4_api_secret_encrypted):null]);
        if(data.eventName==="purchase")await client.query("UPDATE conversations SET customer_stage='won' WHERE id=$1",[targetId]);
        await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'livechat.conversion','conversation',$2,$3)",[principal.id,targetId,JSON.stringify({eventId:inserted.rows[0].id,eventName:data.eventName,orderId:data.orderId??null,deliveryState:state})]);
        await client.query("SELECT relay_publish_conversation_change($1,$2)",[targetId,row.account_id]);
        return {id:inserted.rows[0].id,deduplicated:false,deliveryState:state};
      });
      return reply.code(201).send(result);
    }catch(error){
      const code=error instanceof Error?error.message:"";
      const messages:Record<string,string>={purchase_paid_order_required:"只能选择此客户已付款的订单",purchase_already_recorded:"该订单已记录 purchase，不能重复记录",purchase_order_invalid:"订单缺少有效商品或金额",client_event_id_conflict:"请求内容与原请求不一致，请重新操作",livechat_channel_disabled:"渠道已停用，不能记录新事件",account_send_forbidden:"没有该渠道的操作权限",conversion_target_not_found:"访客不存在或无权访问"};
      if(messages[code])return reply.code((error as {statusCode?:number}).statusCode??409).send({error:code,message:messages[code]});
      if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"conversion_conflict",message:"事件或订单已记录，请刷新后查看"});
      throw error;
    }
  });
}

type ConversionJob={id:string;event_name:string;event_params:Record<string,unknown>;ga4_client_id:string;ga4_measurement_id:string;ga4_api_secret_encrypted:string;created_at:Date|string};
export function ga4ConversionBody(job:ConversionJob){
  return {client_id:job.ga4_client_id,timestamp_micros:new Date(job.created_at).getTime()*1000,consent:{ad_user_data:"DENIED",ad_personalization:"DENIED"},events:[{name:job.event_name,params:{...job.event_params,event_id:job.id}}]};
}

export async function processOneLivechatConversion():Promise<boolean>{
  // 发送前先持久化认领；进程中断时结果不确定，不能自动重发成交。
  await pool.query("UPDATE livechat_conversion_events SET delivery_state='uncertain',last_error='worker_interrupted',ga4_client_id=NULL WHERE delivery_state='sending' AND available_at<=now()");
  const claimed=await pool.query(`WITH next AS (
    SELECT id FROM livechat_conversion_events WHERE delivery_state='queued' AND available_at<=now()
    ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE livechat_conversion_events e SET delivery_state='sending',available_at=now()+interval '2 minutes'
    FROM next WHERE e.id=next.id RETURNING e.id`);
  const id=claimed.rows[0]?.id;if(!id)return false;
  const finish=async(state:string,error:string|null,attempts=0)=>{
    await pool.query("UPDATE livechat_conversion_events SET delivery_state=$2,last_error=$3,attempts=$4,ga4_client_id=NULL WHERE id=$1 AND delivery_state='sending'",[id,state,error,attempts]);
  };
  const found=await pool.query(`SELECT e.*,v.analytics_consent current_consent,v.analytics_client_id current_client_id,v.analytics_measurement_id current_visitor_measurement_id,
    channel.ga4_measurement_id current_measurement_id,channel.ga4_api_secret_encrypted,channel.enabled,channel.archived_at
    FROM livechat_conversion_events e JOIN livechat_channels channel ON channel.account_id=e.account_id
    LEFT JOIN livechat_visitors v ON v.account_id=e.account_id AND v.contact_id=e.contact_id
    WHERE e.id=$1 AND e.delivery_state='sending'`,[id]);
  const row=found.rows[0];if(!row)return true;
  if(row.current_consent!=="granted")await finish("skipped_consent","consent_withdrawn");
  else if(!row.enabled||row.archived_at||!row.ga4_api_secret_encrypted||row.ga4_measurement_id!==row.current_measurement_id||row.ga4_config_fingerprint!==configFingerprint(row.current_measurement_id,row.ga4_api_secret_encrypted))await finish("skipped_config","channel_config_changed");
  else if(!row.ga4_client_id||row.ga4_client_id!==row.current_client_id||row.current_visitor_measurement_id!==row.ga4_measurement_id)await finish("skipped_client_id","analytics_context_changed");
  else if(Date.now()-new Date(row.created_at).getTime()>71*3600000)await finish("failed","event_expired");
  else{
    const job=row as ConversionJob;
    let secret:string;
    try{secret=decryptAtRest(job.ga4_api_secret_encrypted,config.DATA_ENCRYPTION_KEY);}
    catch{await finish("failed","credentials_unavailable");return true;}
    const url=new URL("https://www.google-analytics.com/mp/collect");
    url.searchParams.set("measurement_id",job.ga4_measurement_id);url.searchParams.set("api_secret",secret);
    let response:Response;
    try{response=await fetch(url,{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(ga4ConversionBody(job)),signal:AbortSignal.timeout(10000)});}
    catch{await finish("uncertain","ga4_network_result_unknown",1);return true;}
    await finish(response.ok?"sent":response.status>=500?"uncertain":"failed",response.ok?null:`HTTP_${response.status}`,1);
  }
  return true;
}
