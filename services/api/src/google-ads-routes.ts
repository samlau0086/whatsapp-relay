import type {FastifyInstance,FastifyReply} from "fastify";
import {z} from "zod";
import {authenticate,canAccessAccount} from "./auth.js";
import {pool,transaction} from "./db.js";
import {adsConversation,adsError,adsEvents,adsWritePermission,attributionForConversation,queueAdsConversion} from "./google-ads-attribution.js";
import {conversionSchema,paidOrder} from "./livechat-analytics.js";

const paramsSchema=z.object({id:z.string().uuid()});
const querySchema=z.object({targetConversationId:z.string().uuid().optional()});
function parse<T>(schema:z.ZodType<T>,value:unknown):T{
  const result=schema.safeParse(value);
  if(!result.success)throw adsError(400,"invalid_ads_request");
  return result.data;
}
const adsRouteOptions={preHandler:authenticate,errorHandler(error:Error & {statusCode?:number},_request:unknown,reply:FastifyReply){
  const messages:Record<string,string>={invalid_ads_request:"归因请求格式无效，请检查会话 ID 和事件参数",ads_conversation_not_found:"会话不存在或无访问权限",ads_source_not_found:"广告来源不存在或无访问权限",ads_send_forbidden:"没有来源渠道的发送权限",email_conversation_required:"仅独立 Email 会话需要关联广告来源",livechat_attribution_required:"所选来源不是有效的 LiveChat 归因会话",email_attribution_already_locked:"Email 已关联其他广告来源，不能换绑",use_livechat_conversion_endpoint:"请通过 LiveChat 转化入口记录",purchase_paid_order_required:"请选择当前客户的有效已付款订单",purchase_order_invalid:"订单金额、商品或币种无效",client_event_id_conflict:"提交标识与已有事件不一致，请刷新后核对记录"};
  const message=messages[error.message];
  if(message)return reply.code(error.statusCode??400).send({error:error.message,message});
  return reply.send(error);
}};

export function registerGoogleAdsRoutes(app:FastifyInstance){
  app.get("/api/v1/conversations/:id/ads-conversions",adsRouteOptions,async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const p=parse(paramsSchema,request.params),q=parse(querySchema,request.query),target=q.targetConversationId??p.id;
    const row=await adsConversation(pool,p.id,target,request.principal);
    const a=await attributionForConversation(pool,target,request.principal);
    let canRecord=true;
    try{await adsWritePermission(pool,request.principal,row.account_id);if(a)await adsWritePermission(pool,request.principal,a.account_id);}catch{canRecord=false;}
    const events=await pool.query("SELECT id,event_name,order_id,delivery_state,last_error,created_at FROM google_ads_conversion_events WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",[target]);
    const orders=await pool.query(`SELECT o.id,o.display_order_number,o.amount,o.currency,EXISTS(SELECT 1 FROM google_ads_conversion_events e WHERE e.order_id=o.id AND e.event_name='purchase') recorded
      FROM orders o JOIN conversations c ON c.id=o.conversation_id WHERE c.account_id=$1 AND c.contact_id=$2 AND o.deleted_at IS NULL AND (${paidOrder}) ORDER BY o.created_at DESC LIMIT 100`,[row.account_id,row.contact_id]);
    // 邮箱仅用于建议；返回前仍逐一校验来源渠道权限，不自动建立关联。
    const candidates=row.origin_mode==="email"?await pool.query(`SELECT DISTINCT source.id,a.account_id,co.display_name,a.locked_at FROM google_ads_attributions a
      JOIN livechat_visitors v ON v.id=a.visitor_id JOIN contacts co ON co.id=v.contact_id
      JOIN conversations source ON source.account_id=v.account_id AND source.contact_id=v.contact_id AND source.origin_mode='livechat'
      JOIN contact_emails se ON se.contact_id=v.contact_id JOIN contact_emails te ON lower(btrim(te.email))=lower(btrim(se.email))
      WHERE te.contact_id=$1 ORDER BY a.locked_at DESC LIMIT 100`,[row.contact_id]):{rows:[]};
    return reply.header("cache-control","no-store").send({data:events.rows,orders:orders.rows,canRecord,mode:row.origin_mode,
      attribution:a?{sourceConversationId:a.source_conversation_id,consent:a.consent,available:Boolean(Object.keys(a.identifiers).length),lockedAt:a.locked_at}:null,
      candidates:candidates.rows.filter(c=>canAccessAccount(request.principal,c.account_id)).map(c=>({id:c.id,name:c.display_name,lockedAt:c.locked_at}))});
  });
  app.put("/api/v1/conversations/:id/ads-attribution",adsRouteOptions,async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const principal=request.principal,p=parse(paramsSchema,request.params);
    const data=parse(z.object({targetConversationId:z.string().uuid().optional(),sourceConversationId:z.string().uuid()}).strict(),request.body);
    await transaction(async db=>{
      const target=data.targetConversationId??p.id;
      const row=await adsConversation(db,p.id,target,principal,true);
      if(row.origin_mode!=="email")throw adsError(409,"email_conversation_required");
      await adsConversation(db,data.sourceConversationId,data.sourceConversationId,principal,true);
      const a=await attributionForConversation(db,data.sourceConversationId,principal,true);
      if(!a||a.source_conversation_id!==data.sourceConversationId)throw adsError(404,"livechat_attribution_required");
      const old=(await db.query("SELECT attribution_id FROM google_ads_email_links WHERE conversation_id=$1",[target])).rows[0];
      if(old&&old.attribution_id!==a.id)throw adsError(409,"email_attribution_already_locked");
      await db.query("INSERT INTO google_ads_email_links(conversation_id,attribution_id,actor_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[target,a.id,principal.id]);
      await db.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'google_ads.email_link','conversation',$2,$3)",[principal.id,target,JSON.stringify({sourceConversationId:data.sourceConversationId})]);
    });
    return {saved:true};
  });
  app.post("/api/v1/conversations/:id/ads-conversions",adsRouteOptions,async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const principal=request.principal,p=parse(paramsSchema,request.params),data=parse(conversionSchema,request.body);
    if(!adsEvents.includes(data.eventName as typeof adsEvents[number]))return reply.code(400).send({error:"unsupported_ads_event"});
    const result=await transaction(async db=>{
      const target=data.targetConversationId??p.id,row=await adsConversation(db,p.id,target,principal,true);
      if(row.origin_mode!=="email")throw adsError(409,"use_livechat_conversion_endpoint");
      const eventParams:Record<string,unknown>={};
      if(data.eventName==="purchase"){
        const order=(await db.query(`SELECT o.*,(${paidOrder}) paid FROM orders o JOIN conversations c ON c.id=o.conversation_id
          WHERE o.id=$1 AND c.account_id=$2 AND c.contact_id=$3 AND o.deleted_at IS NULL FOR UPDATE OF o`,[data.orderId,row.account_id,row.contact_id])).rows[0];
        if(!order?.paid)throw adsError(409,"purchase_paid_order_required");
        const items=await db.query("SELECT quantity,unit_amount FROM order_items WHERE order_id=$1 ORDER BY position LIMIT 201",[data.orderId]);
        const value=Math.round(items.rows.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.unit_amount),0)*100)/100;
        if(!items.rowCount||items.rows.length>200||!Number.isFinite(value)||value<0||Number(order.amount)<=0||!/^[A-Z]{3}$/.test(order.currency))throw adsError(409,"purchase_order_invalid");
        Object.assign(eventParams,{value,currency:order.currency});
      }else if(data.value!==undefined)Object.assign(eventParams,{value:data.value,currency:data.currency});
      const result=await queueAdsConversion(db,{conversationId:target,accountId:row.account_id,actorId:principal.id,clientEventId:data.clientEventId,eventName:data.eventName,orderId:data.orderId,params:eventParams,principal});
      if(data.eventName==="purchase")await db.query("UPDATE conversations SET customer_stage='won' WHERE id=$1",[target]);
      await db.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'google_ads.conversion','conversation',$2,$3)",[principal.id,target,JSON.stringify({eventName:data.eventName,eventId:result.id})]);
      await db.query("SELECT relay_publish_conversation_change($1,$2)",[target,row.account_id]);
      return result;
    });
    return reply.code(201).send(result);
  });
}
