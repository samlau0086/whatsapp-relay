import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { authenticate } from "./auth.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { PayPalApiError, PayPalClient, clearPayPalTokenCache, type PayPalEnvironment } from "./paypal.js";
import {
  paymentMethodCreateSchema,
  paymentMethodUpdateSchema,
  paymentProfileCreateSchema,
  paymentProfileUpdateSchema,
} from "./schemas.js";
import { decryptAtRest, encryptAtRest } from "./security.js";
import {
  DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE,
  DEFAULT_PAYPAL_NOTE_TEMPLATE,
  DEFAULT_PAYPAL_REFERENCE_TEMPLATE,
  validatePayPalTemplate,
} from "./paypal-template.js";

export type PaymentPublicField={label:string;value:string};
export type PaymentProfileSnapshot={
  methodId:string;methodType:string;methodName:string;
  profileId:string;profileName:string;environment:PayPalEnvironment|null;
  summary:string;publicFields:PaymentPublicField[];instructions:string;
  paypalFeeRatePercent:number;paypalFixedFee:number;
};
export type PayPalProfileSetting={
  profileId:string;environment:PayPalEnvironment;clientId:string;clientSecret:string;
  referenceTemplate:string;noteTemplate:string;itemNameTemplate:string;
};
type Queryable=Pick<Pool|PoolClient,"query">;

const PROFILE_SELECT=`SELECT
  p.id,p.method_id,p.name,p.enabled,p.public_fields,p.instructions,p.environment,
  p.sandbox_client_id_encrypted,p.sandbox_client_secret_encrypted,
  p.live_client_id_encrypted,p.live_client_secret_encrypted,
  p.reference_template,p.note_template,p.item_name_template,p.paypal_fee_rate_percent,p.paypal_fixed_fee,p.created_at,p.updated_at,p.deleted_at,
  m.type method_type,m.name method_name,m.enabled method_enabled,m.sort_order,m.deleted_at method_deleted_at
FROM payment_profiles p JOIN payment_methods m ON m.id=p.method_id`;

function fields(value:unknown):PaymentPublicField[]{
  return Array.isArray(value)?value.filter((item):item is PaymentPublicField=>Boolean(item)&&typeof item==="object"&&typeof (item as PaymentPublicField).label==="string"&&typeof (item as PaymentPublicField).value==="string"):[];
}

export function paymentProfileSnapshot(row:Record<string,unknown>):PaymentProfileSnapshot{
  const methodName=String(row.method_name),profileName=String(row.name);
  return{
    methodId:String(row.method_id),methodType:String(row.method_type),methodName,
    profileId:String(row.id),profileName,
    environment:row.method_type==="paypal"&&(row.environment==="sandbox"||row.environment==="live")?row.environment:null,
    summary:`${methodName} · ${profileName}`,
    publicFields:fields(row.public_fields),
    instructions:String(row.instructions??""),
    paypalFeeRatePercent:row.method_type==="paypal"?Number(row.paypal_fee_rate_percent??0):0,
    paypalFixedFee:row.method_type==="paypal"?Number(row.paypal_fixed_fee??0):0,
  };
}

function profileResponse(row:Record<string,unknown>,admin=false):Record<string,unknown>{
  const snapshot=paymentProfileSnapshot(row);
  return{
    ...snapshot,id:snapshot.profileId,name:snapshot.profileName,enabled:Boolean(row.enabled),
    ...(admin?{
      sandboxClientIdConfigured:Boolean(row.sandbox_client_id_encrypted),
      sandboxClientSecretConfigured:Boolean(row.sandbox_client_secret_encrypted),
      liveClientIdConfigured:Boolean(row.live_client_id_encrypted),
      liveClientSecretConfigured:Boolean(row.live_client_secret_encrypted),
      referenceTemplate:String(row.reference_template??DEFAULT_PAYPAL_REFERENCE_TEMPLATE),
      noteTemplate:String(row.note_template??DEFAULT_PAYPAL_NOTE_TEMPLATE),
      itemNameTemplate:String(row.item_name_template??DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE),
      paypalFeeRatePercent:Number(row.paypal_fee_rate_percent??0),
      paypalFixedFee:Number(row.paypal_fixed_fee??0),
      createdAt:row.created_at,updatedAt:row.updated_at,
    }:{}),
  };
}

export async function resolvePaymentProfile(client:Queryable,profileId:string|null|undefined):Promise<PaymentProfileSnapshot|null>{
  if(!profileId){
    const any=await client.query("SELECT 1 FROM payment_profiles p JOIN payment_methods m ON m.id=p.method_id WHERE p.enabled AND m.enabled AND p.deleted_at IS NULL AND m.deleted_at IS NULL LIMIT 1");
    if(any.rowCount)throw Object.assign(new Error("payment_profile_required"),{statusCode:400});
    return null;
  }
  const result=await client.query(`${PROFILE_SELECT} WHERE p.id=$1 AND p.enabled AND m.enabled AND p.deleted_at IS NULL AND m.deleted_at IS NULL`,[profileId]);
  if(!result.rowCount)throw Object.assign(new Error("payment_profile_unavailable"),{statusCode:400});
  return paymentProfileSnapshot(result.rows[0]);
}

export async function paypalProfileSetting(profileId:string,requiredEnvironment?:string,requireEnabled=true):Promise<PayPalProfileSetting|null>{
  const result=await pool.query(`${PROFILE_SELECT} WHERE p.id=$1`,[profileId]),row=result.rows[0];
  if(!row||row.method_type!=="paypal"||requireEnabled&&(!row.enabled||!row.method_enabled||row.deleted_at||row.method_deleted_at))return null;
  const environment=(requiredEnvironment??row.environment) as PayPalEnvironment;
  if(environment!=="sandbox"&&environment!=="live")return null;
  const id=environment==="sandbox"?row.sandbox_client_id_encrypted:row.live_client_id_encrypted;
  const secret=environment==="sandbox"?row.sandbox_client_secret_encrypted:row.live_client_secret_encrypted;
  if(!id||!secret)return null;
  return{
    profileId:String(row.id),environment,
    clientId:decryptAtRest(String(id),config.DATA_ENCRYPTION_KEY),
    clientSecret:decryptAtRest(String(secret),config.DATA_ENCRYPTION_KEY),
    referenceTemplate:String(row.reference_template??DEFAULT_PAYPAL_REFERENCE_TEMPLATE),
    noteTemplate:String(row.note_template??DEFAULT_PAYPAL_NOTE_TEMPLATE),
    itemNameTemplate:String(row.item_name_template??DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE),
  };
}

async function audit(actorId:string,action:string,targetType:string,targetId:string,metadata:Record<string,unknown>={}):Promise<void>{
  await pool.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,$2,$3,$4,$5)",[actorId,action,targetType,targetId,JSON.stringify(metadata)]);
}

export async function registerPaymentMethodRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/v1/payment-profiles",{preHandler:authenticate},async()=>{
    const result=await pool.query(`${PROFILE_SELECT} WHERE p.enabled AND m.enabled AND p.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY m.sort_order,m.created_at,p.created_at,p.id`);
    return{data:result.rows.map(row=>profileResponse(row))};
  });

  app.get("/api/v1/admin/payment-methods",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const [methods,profiles]=await Promise.all([
      pool.query("SELECT id,type,name,enabled,sort_order,created_at,updated_at FROM payment_methods WHERE deleted_at IS NULL ORDER BY sort_order,created_at,id"),
      pool.query(`${PROFILE_SELECT} WHERE p.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY m.sort_order,m.created_at,p.created_at,p.id`),
    ]);
    return{data:methods.rows.map(method=>({
      id:String(method.id),type:String(method.type),name:String(method.name),enabled:Boolean(method.enabled),
      sortOrder:Number(method.sort_order),createdAt:method.created_at,updatedAt:method.updated_at,
      profiles:profiles.rows.filter(profile=>profile.method_id===method.id).map(profile=>profileResponse(profile,true)),
    }))};
  });

  app.post("/api/v1/admin/payment-methods",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=paymentMethodCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const saved=await pool.query("INSERT INTO payment_methods(type,name,enabled,sort_order,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING id,type,name,enabled,sort_order,created_at,updated_at",[parsed.data.type,parsed.data.name,parsed.data.enabled,parsed.data.sortOrder,request.principal.id]);
    await audit(request.principal.id,"payment_method.create","payment_method",saved.rows[0].id,{type:parsed.data.type});
    return reply.code(201).send({...saved.rows[0],sortOrder:Number(saved.rows[0].sort_order),profiles:[]});
  });

  app.patch("/api/v1/admin/payment-methods/:methodId",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=paymentMethodUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {methodId}=request.params as {methodId:string};
    if(parsed.data.type){const count=await pool.query("SELECT 1 FROM payment_profiles WHERE method_id=$1 AND deleted_at IS NULL LIMIT 1",[methodId]);if(count.rowCount)return reply.code(409).send({error:"method_type_locked"});}
    const saved=await pool.query("UPDATE payment_methods SET type=COALESCE($2,type),name=COALESCE($3,name),enabled=COALESCE($4,enabled),sort_order=COALESCE($5,sort_order),updated_by=$6,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id,type,name,enabled,sort_order,created_at,updated_at",[methodId,parsed.data.type??null,parsed.data.name??null,parsed.data.enabled??null,parsed.data.sortOrder??null,request.principal.id]);
    if(!saved.rowCount)return reply.code(404).send({error:"not_found"});await audit(request.principal.id,"payment_method.update","payment_method",methodId,parsed.data);return{...saved.rows[0],sortOrder:Number(saved.rows[0].sort_order)};
  });

  app.delete("/api/v1/admin/payment-methods/:methodId",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {methodId}=request.params as {methodId:string};
    const saved=await pool.query("UPDATE payment_methods SET enabled=false,deleted_at=now(),updated_by=$2,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id",[methodId,request.principal.id]);if(!saved.rowCount)return reply.code(404).send({error:"not_found"});
    await pool.query("UPDATE payment_profiles SET enabled=false,deleted_at=COALESCE(deleted_at,now()),updated_by=$2,updated_at=now() WHERE method_id=$1",[methodId,request.principal.id]);await audit(request.principal.id,"payment_method.delete","payment_method",methodId);return reply.code(204).send();
  });

  app.post("/api/v1/admin/payment-methods/:methodId/profiles",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const parsed=paymentProfileCreateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {methodId}=request.params as {methodId:string},method=await pool.query("SELECT type FROM payment_methods WHERE id=$1 AND deleted_at IS NULL",[methodId]);if(!method.rowCount)return reply.code(404).send({error:"not_found"});
    const validated=await validateAndPrepareProfile(method.rows[0].type,parsed.data,undefined,reply);if(!validated)return;
    const saved=await pool.query(`INSERT INTO payment_profiles(method_id,name,enabled,public_fields,instructions,environment,sandbox_client_id_encrypted,sandbox_client_secret_encrypted,live_client_id_encrypted,live_client_secret_encrypted,reference_template,note_template,item_name_template,paypal_fee_rate_percent,paypal_fixed_fee,created_by,updated_by)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,[methodId,parsed.data.name,parsed.data.enabled,JSON.stringify(parsed.data.publicFields),parsed.data.instructions,validated.environment,validated.sandboxId,validated.sandboxSecret,validated.liveId,validated.liveSecret,parsed.data.referenceTemplate,parsed.data.noteTemplate,parsed.data.itemNameTemplate,method.rows[0].type==="paypal"?parsed.data.paypalFeeRatePercent:0,method.rows[0].type==="paypal"?parsed.data.paypalFixedFee:0,request.principal.id]);
    clearPayPalTokenCache();await audit(request.principal.id,"payment_profile.create","payment_profile",saved.rows[0].id,{methodId,type:method.rows[0].type});return reply.code(201).send(profileResponse({...saved.rows[0],method_id:methodId,method_type:method.rows[0].type,method_name:""},true));
  });

  app.patch("/api/v1/admin/payment-methods/:methodId/profiles/:profileId",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const parsed=paymentProfileUpdateSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {methodId,profileId}=request.params as {methodId:string;profileId:string},current=await pool.query(`${PROFILE_SELECT} WHERE p.id=$1 AND p.method_id=$2 AND p.deleted_at IS NULL AND m.deleted_at IS NULL`,[profileId,methodId]);if(!current.rowCount)return reply.code(404).send({error:"not_found"});
    const row=current.rows[0],merged={name:parsed.data.name??row.name,enabled:parsed.data.enabled??row.enabled,publicFields:parsed.data.publicFields??fields(row.public_fields),instructions:parsed.data.instructions??row.instructions,environment:parsed.data.environment??row.environment,referenceTemplate:parsed.data.referenceTemplate??row.reference_template,noteTemplate:parsed.data.noteTemplate??row.note_template,itemNameTemplate:parsed.data.itemNameTemplate??row.item_name_template,paypalFeeRatePercent:parsed.data.paypalFeeRatePercent??Number(row.paypal_fee_rate_percent??0),paypalFixedFee:parsed.data.paypalFixedFee??Number(row.paypal_fixed_fee??0),...parsed.data};
    const validated=await validateAndPrepareProfile(row.method_type,merged,row,reply);if(!validated)return;
    const saved=await pool.query(`UPDATE payment_profiles SET name=$3,enabled=$4,public_fields=$5::jsonb,instructions=$6,environment=$7,sandbox_client_id_encrypted=$8,sandbox_client_secret_encrypted=$9,live_client_id_encrypted=$10,live_client_secret_encrypted=$11,reference_template=$12,note_template=$13,item_name_template=$14,paypal_fee_rate_percent=$15,paypal_fixed_fee=$16,updated_by=$17,updated_at=now() WHERE id=$1 AND method_id=$2 RETURNING *`,[profileId,methodId,merged.name,merged.enabled,JSON.stringify(merged.publicFields),merged.instructions,validated.environment,validated.sandboxId,validated.sandboxSecret,validated.liveId,validated.liveSecret,merged.referenceTemplate,merged.noteTemplate,merged.itemNameTemplate,row.method_type==="paypal"?merged.paypalFeeRatePercent:0,row.method_type==="paypal"?merged.paypalFixedFee:0,request.principal.id]);
    clearPayPalTokenCache();await audit(request.principal.id,"payment_profile.update","payment_profile",profileId,{methodId,credentialsChanged:Boolean(parsed.data.sandboxClientId||parsed.data.sandboxClientSecret||parsed.data.liveClientId||parsed.data.liveClientSecret)});return profileResponse({...saved.rows[0],method_type:row.method_type,method_name:row.method_name},true);
  });

  app.delete("/api/v1/admin/payment-methods/:methodId/profiles/:profileId",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});const {methodId,profileId}=request.params as {methodId:string;profileId:string};
    const saved=await pool.query("UPDATE payment_profiles SET enabled=false,deleted_at=now(),updated_by=$3,updated_at=now() WHERE id=$1 AND method_id=$2 AND deleted_at IS NULL RETURNING id",[profileId,methodId,request.principal.id]);if(!saved.rowCount)return reply.code(404).send({error:"not_found"});
    await audit(request.principal.id,"payment_profile.delete","payment_profile",profileId,{methodId});return reply.code(204).send();
  });
}

async function validateAndPrepareProfile(type:string,data:Record<string,unknown>,current:Record<string,unknown>|undefined,reply:FastifyReply):Promise<{environment:PayPalEnvironment|null;sandboxId:string|null;sandboxSecret:string|null;liveId:string|null;liveSecret:string|null}|null>{
  if(type!=="paypal")return{environment:null,sandboxId:null,sandboxSecret:null,liveId:null,liveSecret:null};
  for(const [field,template,scope] of [["referenceTemplate",String(data.referenceTemplate??DEFAULT_PAYPAL_REFERENCE_TEMPLATE),"global"],["noteTemplate",String(data.noteTemplate??DEFAULT_PAYPAL_NOTE_TEMPLATE),"global"],["itemNameTemplate",String(data.itemNameTemplate??DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE),"item"]] as const){const error=validatePayPalTemplate(template,scope);if(error){reply.code(400).send({error:"invalid_template",field,message:error});return null;}}
  const environment=(data.environment??current?.environment??"sandbox") as PayPalEnvironment;
  const encrypted=(value:unknown,existing:unknown)=>typeof value==="string"&&value?encryptAtRest(value,config.DATA_ENCRYPTION_KEY):existing?String(existing):null;
  const prepared={environment,sandboxId:encrypted(data.sandboxClientId,current?.sandbox_client_id_encrypted),sandboxSecret:encrypted(data.sandboxClientSecret,current?.sandbox_client_secret_encrypted),liveId:encrypted(data.liveClientId,current?.live_client_id_encrypted),liveSecret:encrypted(data.liveClientSecret,current?.live_client_secret_encrypted)};
  if(data.enabled){
    const id=environment==="sandbox"?prepared.sandboxId:prepared.liveId,secret=environment==="sandbox"?prepared.sandboxSecret:prepared.liveSecret;
    if(!id||!secret){reply.code(400).send({error:"paypal_credentials_required",message:`PayPal ${environment==="sandbox"?"Sandbox":"Live"} 凭据不能为空`});return null;}
    try{await new PayPalClient({environment,clientId:decryptAtRest(id,config.DATA_ENCRYPTION_KEY),clientSecret:decryptAtRest(secret,config.DATA_ENCRYPTION_KEY)}).verify();}
    catch(error){reply.code(400).send({error:"paypal_credentials_invalid",message:error instanceof PayPalApiError?error.message:"PayPal 凭据验证失败"});return null;}
  }
  return prepared;
}
