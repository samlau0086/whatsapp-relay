import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate} from "./auth.js";
import {pool,transaction} from "./db.js";
import {config} from "./config.js";
import {decryptAtRest,encryptAtRest} from "./security.js";
import {emailProviderSettingsSchema,emailProviderTestSchema} from "./schemas.js";
import {sendProviderTest,verifySmtp,type EmailProviderConfig} from "./email.js";

const uuid=z.string().uuid();
export function registerEmailProviderRoutes(app:FastifyInstance){
  app.get("/api/v1/admin/email-providers",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const result=await pool.query("SELECT id,name,provider,enabled,is_default,config,secret_encrypted,updated_at FROM email_provider_instances ORDER BY created_at,id");
    const bindings=await pool.query("SELECT account_id,provider_id FROM account_email_providers");
    return {data:result.rows.map(row=>({id:row.id,name:row.name,provider:row.provider,enabled:row.enabled,isDefault:row.is_default,configured:Boolean(row.secret_encrypted),fromName:row.config.fromName??"",fromEmail:row.config.fromEmail??"",replyTo:row.config.replyTo??"",host:row.config.host??"",port:row.config.port??587,tls:row.config.tls??"starttls",username:row.config.username??"",updatedAt:row.updated_at})),bindings:bindings.rows};
  });
  app.put("/api/v1/admin/email-providers/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string},parsed=emailProviderSettingsSchema.safeParse(request.body);
    if(!uuid.safeParse(id).success||!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const value=parsed.data;
    if(value.isDefault&&!value.enabled)return reply.code(400).send({error:"default_provider_must_be_enabled"});
    if(value.provider==="smtp"&&(!value.host||!value.port||!value.tls))return reply.code(400).send({error:"smtp_settings_required"});
    const cfg:EmailProviderConfig={fromName:value.fromName,fromEmail:value.fromEmail,replyTo:value.replyTo||undefined,...(value.provider==="smtp"?{host:value.host,port:value.port,tls:value.tls,username:value.username||undefined}:{})};
    const saved=await transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(103032)");
      // 读取现有密钥与写入共用锁，避免并发保存覆盖刚轮换的密钥或变更实例类型。
      const current=await client.query("SELECT provider,secret_encrypted FROM email_provider_instances WHERE id=$1",[id]);
      if(current.rowCount&&current.rows[0].provider!==value.provider)return {status:409,error:"provider_type_immutable"};
      const secret=value.secret?encryptAtRest(value.secret,config.DATA_ENCRYPTION_KEY):current.rows[0]?.secret_encrypted??null;
      if(value.enabled&&!secret)return {status:400,error:"provider_secret_required"};
      if(value.provider==="smtp"&&value.enabled)try{await verifySmtp(cfg,decryptAtRest(secret,config.DATA_ENCRYPTION_KEY));}catch(error){return {status:400,error:"smtp_verification_failed",message:String(error)};}
      if(value.isDefault)await client.query("UPDATE email_provider_instances SET is_default=false,updated_at=now() WHERE is_default");
      await client.query(`INSERT INTO email_provider_instances(id,name,provider,enabled,is_default,config,secret_encrypted,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,enabled=EXCLUDED.enabled,is_default=EXCLUDED.is_default,config=EXCLUDED.config,secret_encrypted=EXCLUDED.secret_encrypted,updated_by=EXCLUDED.updated_by,updated_at=now()`,[id,value.name,value.provider,value.enabled,value.isDefault,JSON.stringify(cfg),secret,request.principal!.id]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'email.provider.update','email_provider',$2,$3)",[request.principal!.id,id,JSON.stringify({name:value.name,provider:value.provider,enabled:value.enabled,isDefault:value.isDefault})]);
      return {id};
    });
    return saved.error?reply.code(saved.status!).send({error:saved.error,...(saved.message?{message:saved.message}:{})}):saved;
  });
  app.post("/api/v1/admin/email-providers/:id/test",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string},parsed=emailProviderTestSchema.safeParse(request.body);
    if(!uuid.safeParse(id).success||!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const found=await pool.query("SELECT provider,config,secret_encrypted FROM email_provider_instances WHERE id=$1 AND secret_encrypted IS NOT NULL",[id]);
    if(!found.rowCount)return reply.code(409).send({error:"provider_not_configured"});
    const row=found.rows[0];
    try{return {accepted:true,messageId:await sendProviderTest(row.provider,row.config,decryptAtRest(row.secret_encrypted,config.DATA_ENCRYPTION_KEY),parsed.data.recipientEmail)};}catch(error){return reply.code(502).send({error:"email_test_failed",message:String(error)});}
  });
  app.put("/api/v1/admin/email-provider-bindings/:accountId",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {accountId}=request.params as {accountId:string},parsed=z.object({providerId:uuid.nullable()}).safeParse(request.body);
    if(!uuid.safeParse(accountId).success||!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const saved=await transaction(async client=>{
      if(!(await client.query("SELECT id FROM channel_accounts WHERE id=$1 FOR UPDATE",[accountId])).rowCount)return false;
      const id=parsed.data.providerId;
      if(id){
        if(!(await client.query("SELECT id FROM email_provider_instances WHERE id=$1 AND enabled AND secret_encrypted IS NOT NULL FOR SHARE",[id])).rowCount)return false;
        await client.query("INSERT INTO account_email_providers(account_id,provider_id) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,updated_at=now()",[accountId,id]);
      }else await client.query("DELETE FROM account_email_providers WHERE account_id=$1",[accountId]);
      await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'email.provider.bind','account',$2,$3)",[request.principal!.id,accountId,JSON.stringify({providerId:id})]);
      return true;
    });
    return saved?{saved:true}:reply.code(409).send({error:"channel_or_provider_unavailable"});
  });
}
