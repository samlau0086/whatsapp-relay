import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { authenticate } from "./auth.js";
import { pool, transaction } from "./db.js";
import { shippingClassCreateSchema, shippingClassUpdateSchema, shippingQuoteSchema, shippingTemplateCreateSchema, shippingTemplateUpdateSchema } from "./schemas.js";
import { calculateShipping, convertShippingCurrency, type ShippingRule, type ShippingRuleEntry } from "./shipping.js";

type DbRow=Record<string,unknown>;
type Queryable={query:(text:string,values?:unknown[])=>Promise<{rows:DbRow[];rowCount:number|null}>};
type QuoteInput={templateId:string;currency:string;items:Array<{name:string;quantity:number;weightAmount?:number|null;weightUnit?:"g"|"kg"|"lbs"|"oz"|null;shippingClassId?:string|null;shippingClassName?:string|null}>};
type RuleInput=
  |{shippingClassId:string|null;mode:"quantity";firstItemPrice:number;additionalItemPrice:number}
  |{shippingClassId:string|null;mode:"weight";firstWeight:number;additionalWeight:number;weightUnit:"g"|"kg"|"lbs"|"oz";firstWeightPrice:number;additionalWeightPrice:number};

function mapRule(row:DbRow):ShippingRule{
  return row.calculation_mode==="weight"
    ?{mode:"weight",firstWeight:Number(row.first_weight),additionalWeight:Number(row.additional_weight),weightUnit:String(row.weight_unit) as "g"|"kg"|"lbs"|"oz",firstWeightPrice:Number(row.first_weight_price),additionalWeightPrice:Number(row.additional_weight_price)}
    :{mode:"quantity",firstItemPrice:Number(row.first_item_price),additionalItemPrice:Number(row.additional_item_price)};
}

function mapTemplate(row:DbRow,rules:DbRow[]){
  return{id:String(row.id),name:String(row.name),currency:String(row.currency),enabled:Boolean(row.enabled),isDefault:Boolean(row.is_default),version:Number(row.version),rules:rules.filter(rule=>rule.template_id===row.id).map(rule=>({shippingClassId:rule.shipping_class_id?String(rule.shipping_class_id):null,shippingClassName:rule.shipping_class_name?String(rule.shipping_class_name):null,...mapRule(rule)})),createdAt:row.created_at,updatedAt:row.updated_at};
}

async function listTemplates(db:Queryable,enabledOnly:boolean){
  const [templates,rules]=await Promise.all([
    db.query(`SELECT id,name,currency,enabled,is_default,version,created_at,updated_at FROM shipping_templates ${enabledOnly?"WHERE enabled":""} ORDER BY is_default DESC,lower(name),id`),
    db.query(`SELECT r.*,c.name shipping_class_name FROM shipping_template_rules r LEFT JOIN shipping_classes c ON c.id=r.shipping_class_id ORDER BY r.shipping_class_id NULLS FIRST,c.name`),
  ]);
  return templates.rows.map(row=>mapTemplate(row,rules.rows));
}

export async function calculateShippingQuote(db:Queryable,input:QuoteInput,{enabledOnly=true}:{enabledOnly?:boolean}={}){
  const templateResult=await db.query(`SELECT id,name,currency,enabled,is_default,version FROM shipping_templates WHERE id=$1 ${enabledOnly?"AND enabled":""}`,[input.templateId]);
  if(!templateResult.rowCount)throw Object.assign(new Error("shipping_template_unavailable"),{statusCode:409});
  const template=templateResult.rows[0],rulesResult=await db.query("SELECT r.*,c.name shipping_class_name FROM shipping_template_rules r LEFT JOIN shipping_classes c ON c.id=r.shipping_class_id WHERE r.template_id=$1 ORDER BY r.shipping_class_id NULLS FIRST",[input.templateId]);
  const defaultRow=rulesResult.rows.find(row=>row.shipping_class_id===null);
  if(!defaultRow)throw Object.assign(new Error("shipping_default_rule_missing"),{statusCode:409});
  const classIds=[...new Set(input.items.flatMap(item=>item.shippingClassId?[item.shippingClassId]:[]))];
  const classes=classIds.length?await db.query("SELECT id,name FROM shipping_classes WHERE id=ANY($1::uuid[])",[classIds]):{rows:[],rowCount:0};
  if(classes.rows.length!==classIds.length)throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});
  const classNames=new Map(classes.rows.map(row=>[String(row.id),String(row.name)]));
  const overrides:ShippingRuleEntry[]=rulesResult.rows.filter(row=>row.shipping_class_id!==null).map(row=>({shippingClassId:String(row.shipping_class_id),shippingClassName:String(row.shipping_class_name??""),rule:mapRule(row)}));
  const calculated=calculateShipping(input.items.map(item=>({...item,shippingClassName:item.shippingClassId?classNames.get(item.shippingClassId)??item.shippingClassName:null})),mapRule(defaultRow),overrides);
  if(!calculated.ok)throw Object.assign(new Error("shipping_weight_missing"),{statusCode:422,missingWeightItems:calculated.missingWeightItems});
  const rates=await db.query("SELECT code,rate FROM currency_settings WHERE code=ANY($1::text[])",[[String(template.currency),input.currency]]);
  const rateMap=new Map(rates.rows.map(row=>[String(row.code),Number(row.rate)])),fromRate=rateMap.get(String(template.currency)),toRate=rateMap.get(input.currency);
  if(!fromRate||!toRate)throw Object.assign(new Error("shipping_currency_unavailable"),{statusCode:409});
  const metadata=await db.query("SELECT source,rate_date,updated_at FROM currency_rate_metadata WHERE singleton=true"),amount=convertShippingCurrency(calculated.amount,fromRate,toRate),conversionRate=toRate/fromRate;
  return{
    template:{id:String(template.id),name:String(template.name),version:Number(template.version),currency:String(template.currency)},
    currency:input.currency,
    templateAmount:calculated.amount,
    amount,
    breakdown:calculated.breakdown.map(item=>({...item,orderAmount:convertShippingCurrency(item.amount,fromRate,toRate)})),
    exchange:{rate:conversionRate,source:metadata.rows[0]?.source??null,rateDate:metadata.rows[0]?.rate_date??null,rateUpdatedAt:metadata.rows[0]?.updated_at??null},
    calculatedAt:new Date().toISOString(),
  };
}

async function replaceRules(client:PoolClient,templateId:string,rules:RuleInput[]){
  const classIds=rules.flatMap(rule=>rule.shippingClassId?[rule.shippingClassId]:[]);
  if(classIds.length){
    const found=await client.query("SELECT id FROM shipping_classes WHERE id=ANY($1::uuid[])",[classIds]);
    if(found.rowCount!==classIds.length)throw Object.assign(new Error("shipping_class_unavailable"),{statusCode:409});
  }
  await client.query("DELETE FROM shipping_template_rules WHERE template_id=$1",[templateId]);
  for(const rule of rules){
    if(rule.mode==="quantity")await client.query("INSERT INTO shipping_template_rules(template_id,shipping_class_id,calculation_mode,first_item_price,additional_item_price) VALUES($1,$2,'quantity',$3,$4)",[templateId,rule.shippingClassId,rule.firstItemPrice,rule.additionalItemPrice]);
    else await client.query("INSERT INTO shipping_template_rules(template_id,shipping_class_id,calculation_mode,first_weight,additional_weight,weight_unit,first_weight_price,additional_weight_price) VALUES($1,$2,'weight',$3,$4,$5,$6,$7)",[templateId,rule.shippingClassId,rule.firstWeight,rule.additionalWeight,rule.weightUnit,rule.firstWeightPrice,rule.additionalWeightPrice]);
  }
}

async function ensureEnabledDefault(client:PoolClient){
  const enabled=await client.query("SELECT COUNT(*)::int count,COUNT(*) FILTER(WHERE is_default)::int defaults FROM shipping_templates WHERE enabled");
  if(Number(enabled.rows[0].count)>0&&Number(enabled.rows[0].defaults)!==1)throw Object.assign(new Error("shipping_default_template_required"),{statusCode:409});
}

export async function registerShippingRoutes(app:FastifyInstance){
  app.get("/api/v1/shipping-classes",{preHandler:authenticate},async()=>({data:(await pool.query("SELECT id,name,enabled,created_at,updated_at FROM shipping_classes WHERE enabled ORDER BY lower(name),id")).rows.map(row=>({id:String(row.id),name:String(row.name),enabled:Boolean(row.enabled),createdAt:row.created_at,updatedAt:row.updated_at}))}));
  app.get("/api/v1/admin/shipping-classes",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    return{data:(await pool.query("SELECT id,name,enabled,created_at,updated_at FROM shipping_classes ORDER BY enabled DESC,lower(name),id")).rows.map(row=>({id:String(row.id),name:String(row.name),enabled:Boolean(row.enabled),createdAt:row.created_at,updatedAt:row.updated_at}))};
  });
  app.post("/api/v1/admin/shipping-classes",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=shippingClassCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    try{const result=await pool.query("INSERT INTO shipping_classes(name,enabled,created_by,updated_by) VALUES($1,$2,$3,$3) RETURNING id,name,enabled,created_at,updated_at",[parsed.data.name,parsed.data.enabled,request.principal.id]);return reply.code(201).send(result.rows[0]);}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"shipping_class_name_exists"});throw error;}
  });
  app.patch("/api/v1/admin/shipping-classes/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=shippingClassUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
    try{const result=await pool.query("UPDATE shipping_classes SET name=COALESCE($2,name),enabled=COALESCE($3,enabled),updated_by=$4,updated_at=now() WHERE id=$1 RETURNING id,name,enabled,created_at,updated_at",[id,parsed.data.name??null,parsed.data.enabled??null,request.principal.id]);if(!result.rowCount)return reply.code(404).send({error:"not_found"});return result.rows[0];}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"shipping_class_name_exists"});throw error;}
  });
  app.get("/api/v1/shipping-templates",{preHandler:authenticate},async()=>({data:await listTemplates(pool,true)}));
  app.get("/api/v1/admin/shipping-templates",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});return{data:await listTemplates(pool,false)};
  });
  app.post("/api/v1/admin/shipping-templates",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=shippingTemplateCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    try{const created=await transaction(async client=>{const existing=await client.query("SELECT COUNT(*)::int count FROM shipping_templates"),first=Number(existing.rows[0].count)===0,isDefault=parsed.data.isDefault||first,enabled=first?true:parsed.data.enabled;if(isDefault)await client.query("UPDATE shipping_templates SET is_default=false,version=version+1,updated_at=now() WHERE is_default");const result=await client.query("INSERT INTO shipping_templates(name,currency,enabled,is_default,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING id",[parsed.data.name,parsed.data.currency,enabled,isDefault,request.principal!.id]);await replaceRules(client,result.rows[0].id,parsed.data.rules);await ensureEnabledDefault(client);return result.rows[0].id;});return reply.code(201).send((await listTemplates(pool,false)).find(item=>item.id===created));}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"shipping_template_conflict"});throw error;}
  });
  app.put("/api/v1/admin/shipping-templates/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=shippingTemplateUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});const {id}=request.params as {id:string};
    try{await transaction(async client=>{const found=await client.query("SELECT id FROM shipping_templates WHERE id=$1 FOR UPDATE",[id]);if(!found.rowCount)throw Object.assign(new Error("not_found"),{statusCode:404});if(parsed.data.isDefault)await client.query("UPDATE shipping_templates SET is_default=false,version=version+1,updated_at=now() WHERE is_default AND id<>$1",[id]);await client.query("UPDATE shipping_templates SET name=$2,currency=$3,enabled=$4,is_default=$5,version=version+1,updated_by=$6,updated_at=now() WHERE id=$1",[id,parsed.data.name,parsed.data.currency,parsed.data.enabled,parsed.data.isDefault,request.principal!.id]);await replaceRules(client,id,parsed.data.rules);await ensureEnabledDefault(client);});return (await listTemplates(pool,false)).find(item=>item.id===id);}catch(error){if((error as {code?:string}).code==="23505")return reply.code(409).send({error:"shipping_template_conflict"});throw error;}
  });
  app.delete("/api/v1/admin/shipping-templates/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {id}=request.params as {id:string};
    await transaction(async client=>{const found=await client.query("SELECT is_default FROM shipping_templates WHERE id=$1 FOR UPDATE",[id]);if(!found.rowCount)throw Object.assign(new Error("not_found"),{statusCode:404});if(found.rows[0].is_default)throw Object.assign(new Error("shipping_default_template_delete_forbidden"),{statusCode:409});await client.query("DELETE FROM shipping_templates WHERE id=$1",[id]);await ensureEnabledDefault(client);});return reply.code(204).send();
  });
  app.post("/api/v1/shipping/quotes",{preHandler:authenticate},async(request,reply)=>{
    const parsed=shippingQuoteSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    try{return await calculateShippingQuote(pool,parsed.data);}catch(error){if((error as Error).message==="shipping_weight_missing")return reply.code(422).send({error:"shipping_weight_missing",missingWeightItems:(error as {missingWeightItems?:unknown}).missingWeightItems});throw error;}
  });
}
