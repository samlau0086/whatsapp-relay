import {createHash,randomBytes} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {decryptAtRest,encryptAtRest} from "./security.js";

const callback=()=>new URL("/api/v1/google-ads/callback",config.PUBLIC_API_URL).toString();
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export async function adsTokenRequest(fields:Record<string,string>){
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",redirect:"error",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:config.GOOGLE_ADS_CLIENT_ID,client_secret:config.GOOGLE_ADS_CLIENT_SECRET,redirect_uri:callback(),...fields}),signal:AbortSignal.timeout(10000)});
  const body=await response.json() as {access_token?:string;refresh_token?:string;scope?:string};
  if(!response.ok||!body.access_token)throw new Error("ads_authorization_failed");
  return {...body,access_token:body.access_token};
}
const accountId=z.string().regex(/^\d{10}$/),actionId=z.string().regex(/^\d{1,30}$/);
export const adsSettingsSchema=z.object({enabled:z.boolean(),customerId:accountId.or(z.literal("")),loginCustomerId:accountId.or(z.literal("")),qualifyLeadAction:actionId.or(z.literal("")),closeConvertLeadAction:actionId.or(z.literal("")),purchaseAction:actionId.or(z.literal("")),revision:z.number().int().nonnegative()}).strict().refine(v=>!v.enabled||Boolean(v.customerId&&(v.qualifyLeadAction||v.closeConvertLeadAction||v.purchaseAction)));

export function registerGoogleAdsConnection(app:FastifyInstance){
  app.get("/api/v1/admin/google-ads",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const connection=(await pool.query("SELECT refresh_token_encrypted IS NOT NULL connected FROM google_ads_connection")).rows[0];
    const settings=await pool.query(`SELECT ch.account_id id,a.display_name,COALESCE(s.enabled,false) enabled,COALESCE(s.customer_id,'') "customerId",COALESCE(s.login_customer_id,'') "loginCustomerId",
      COALESCE(s.qualify_lead_action,'') "qualifyLeadAction",COALESCE(s.close_convert_lead_action,'') "closeConvertLeadAction",COALESCE(s.purchase_action,'') "purchaseAction",COALESCE(s.revision,0)::int revision
      FROM livechat_channels ch JOIN channel_accounts a ON a.id=ch.account_id LEFT JOIN google_ads_channel_settings s ON s.account_id=ch.account_id WHERE ch.archived_at IS NULL ORDER BY a.display_name`);
    return reply.header("cache-control","no-store").send({connected:Boolean(connection?.connected),oauthConfigured:Boolean(config.GOOGLE_ADS_CLIENT_ID&&config.GOOGLE_ADS_CLIENT_SECRET),data:settings.rows});
  });
  app.put("/api/v1/admin/google-ads/channels/:id",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const parsed=adsSettingsSchema.safeParse(request.body),params=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!parsed.success||!params.success)return reply.code(400).send({error:"invalid_ads_settings",message:"检查十位客户 ID、数字转化动作 ID 和启用配置"});
    const data=parsed.data;
    const saved=await transaction(async db=>{
      if(!(await db.query("SELECT 1 FROM livechat_channels WHERE account_id=$1 AND archived_at IS NULL FOR UPDATE",[params.data.id])).rowCount)return false;
      const old=(await db.query("SELECT revision FROM google_ads_channel_settings WHERE account_id=$1",[params.data.id])).rows[0];
      if(Number(old?.revision??0)!==data.revision)return false;
      await db.query(`INSERT INTO google_ads_channel_settings(account_id,enabled,customer_id,login_customer_id,qualify_lead_action,close_convert_lead_action,purchase_action)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id) DO UPDATE SET enabled=$2,customer_id=$3,login_customer_id=$4,qualify_lead_action=$5,close_convert_lead_action=$6,purchase_action=$7,revision=google_ads_channel_settings.revision+1`,[params.data.id,data.enabled,data.customerId,data.loginCustomerId,data.qualifyLeadAction,data.closeConvertLeadAction,data.purchaseAction]);
      await db.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'google_ads.settings','account',$2,$3)",[request.principal!.id,params.data.id,JSON.stringify(data)]);
      return true;
    });
    return saved?{saved:true}:reply.code(409).send({error:"ads_settings_conflict",message:"配置已变更或渠道已归档，请刷新后重试"});
  });
  app.post("/api/v1/admin/google-ads/authorize",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    if(!config.GOOGLE_ADS_CLIENT_ID||!config.GOOGLE_ADS_CLIENT_SECRET)return reply.code(409).send({error:"ads_oauth_not_configured"});
    const state=randomBytes(32).toString("base64url"),verifier=randomBytes(48).toString("base64url");
    await pool.query("DELETE FROM google_ads_oauth_states WHERE expires_at<now()");
    await pool.query("INSERT INTO google_ads_oauth_states(state_hash,user_id,verifier_encrypted,connection_revision) SELECT $1,$2,$3,revision FROM google_ads_connection",[hash(state),request.principal.id,encryptAtRest(verifier,config.DATA_ENCRYPTION_KEY)]);
    const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search=new URLSearchParams({client_id:config.GOOGLE_ADS_CLIENT_ID,redirect_uri:callback(),response_type:"code",scope:"https://www.googleapis.com/auth/datamanager",access_type:"offline",prompt:"consent select_account",state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}).toString();
    return {url:url.toString()};
  });
  app.delete("/api/v1/admin/google-ads/connection",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    await transaction(async db=>{
      await db.query("UPDATE google_ads_connection SET refresh_token_encrypted=NULL,revision=revision+1");
      await db.query("DELETE FROM google_ads_oauth_states");
      await db.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'google_ads.disconnect','integration','google_ads','{}')",[request.principal!.id]);
    });
    return {disconnected:true};
  });
  app.get("/api/v1/google-ads/callback",async(request,reply)=>{
    reply.header("cache-control","no-store").header("referrer-policy","no-referrer");
    const parsed=z.object({state:z.string().min(32).max(128),code:z.string().max(8192).optional(),error:z.string().max(256).optional()}).safeParse(request.query);
    if(!parsed.success)return reply.code(400).send("授权状态无效。");
    const row=(await pool.query("DELETE FROM google_ads_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING *",[hash(parsed.data.state)])).rows[0];
    if(!row||!parsed.data.code||parsed.data.error)return reply.code(400).send("授权已过期、取消或已使用，请重新发起。");
    try{
      const tokens=await adsTokenRequest({grant_type:"authorization_code",code:parsed.data.code,code_verifier:decryptAtRest(row.verifier_encrypted,config.DATA_ENCRYPTION_KEY)});
      if(!tokens.refresh_token||!tokens.scope?.split(" ").includes("https://www.googleapis.com/auth/datamanager"))throw new Error("ads_scope_required");
      await transaction(async db=>{
        const connection=(await db.query("SELECT revision FROM google_ads_connection FOR UPDATE")).rows[0];
        if(String(connection.revision)!==String(row.connection_revision))throw new Error("authorization_superseded");
        const user=await db.query("SELECT role FROM users WHERE id=$1 FOR SHARE",[row.user_id]);
        if(user.rows[0]?.role!=="admin")throw new Error("admin_required");
        await db.query("UPDATE google_ads_connection SET refresh_token_encrypted=$1,revision=revision+1",[encryptAtRest(tokens.refresh_token!,config.DATA_ENCRYPTION_KEY)]);
        await db.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'google_ads.connect','integration','google_ads','{}')",[row.user_id]);
      });
      return reply.type("text/html; charset=utf-8").send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Google Ads 授权成功</title><p>Google Ads 授权成功，请关闭此页并刷新设置。渠道仍需单独启用。</p></html>');
    }catch{return reply.code(400).send("Google Ads 授权失败，请检查 Data Manager API、OAuth 权限与回调配置。");}
  });
}
