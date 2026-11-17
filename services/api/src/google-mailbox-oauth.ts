import {createHash,randomBytes} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate,canAccessAccount} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {decryptAtRest,encryptAtRest} from "./security.js";

const authorizeEndpoint="https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint="https://oauth2.googleapis.com/token";
const gmailApi="https://gmail.googleapis.com/gmail/v1/users/me";
const callback=()=>new URL("/api/v1/mailboxes/google/callback",config.PUBLIC_API_URL).toString();
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const successPage=()=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Google 邮箱授权成功</title></head><body><p>Google 邮箱授权成功，可以关闭此页面并刷新邮箱设置。</p><script>window.setTimeout(()=>window.close(),500)</script></body></html>`;

type GoogleTokens={access_token:string;refresh_token?:string;expires_in?:number};
async function tokenRequest(fields:Record<string,string>):Promise<GoogleTokens>{
  const response=await fetch(tokenEndpoint,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:config.GOOGLE_MAIL_CLIENT_ID,client_secret:config.GOOGLE_MAIL_CLIENT_SECRET,redirect_uri:callback(),...fields}),signal:AbortSignal.timeout(30000)});
  const body=await response.json().catch(()=>({})) as GoogleTokens&{error?:string;error_description?:string};
  if(!response.ok||!body.access_token)throw new Error(`google_authorization_failed:${body.error||`http_${response.status}`}:${(body.error_description||"").slice(0,200)}`);
  return body;
}
export async function gmailRequestWithToken<T>(accessToken:string,path:string):Promise<T>{
  const response=await fetch(`${gmailApi}${path}`,{headers:{authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`gmail_api_http_${response.status}`);
  return await response.json() as T;
}

export async function googleMailboxToken(id:string):Promise<string>{
  return transaction(async client=>{
    const result=await client.query("SELECT oauth_refresh_encrypted FROM account_email_mailboxes WHERE id=$1 AND enabled AND auth_type='google' FOR UPDATE",[id]);
    if(!result.rows[0]?.oauth_refresh_encrypted)throw new Error("google_mailbox_authorization_required");
    const tokens=await tokenRequest({grant_type:"refresh_token",refresh_token:decryptAtRest(result.rows[0].oauth_refresh_encrypted,config.DATA_ENCRYPTION_KEY)});
    if(tokens.refresh_token)await client.query("UPDATE account_email_mailboxes SET oauth_refresh_encrypted=$2 WHERE id=$1",[id,encryptAtRest(tokens.refresh_token,config.DATA_ENCRYPTION_KEY)]);
    return tokens.access_token;
  });
}

export async function gmailApiRequest<T>(id:string,path:string):Promise<T>{return gmailRequestWithToken<T>(await googleMailboxToken(id),path);}

export function registerGoogleMailboxOAuth(app:FastifyInstance):void{
  app.post("/api/v1/admin/mailboxes/google/authorize",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    if(!config.GOOGLE_MAIL_CLIENT_ID||!config.GOOGLE_MAIL_CLIENT_SECRET)return reply.code(409).send({error:"google_oauth_not_configured",message:"请先配置 Google OAuth Client ID 和 Client Secret"});
    const parsed=z.object({accountId:z.string().uuid(),address:z.string().trim().toLowerCase().email().max(254)}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const {accountId,address}=parsed.data;
    if(!canAccessAccount(request.principal,accountId))return reply.code(403).send({error:"account_forbidden"});
    const account=await pool.query("SELECT 1 FROM channel_accounts WHERE id=$1 AND platform IN ('whatsapp','livechat')",[accountId]);
    if(!account.rowCount)return reply.code(404).send({error:"account_not_found"});
    const state=randomBytes(32).toString("base64url"),verifier=randomBytes(48).toString("base64url");
    await pool.query("DELETE FROM mailbox_oauth_states WHERE expires_at<now()");
    await pool.query("INSERT INTO mailbox_oauth_states(state_hash,user_id,account_id,address,verifier_encrypted) VALUES($1,$2,$3,$4,$5)",[hash(state),request.principal.id,accountId,address,encryptAtRest(verifier,config.DATA_ENCRYPTION_KEY)]);
    const url=new URL(authorizeEndpoint);
    url.search=new URLSearchParams({client_id:config.GOOGLE_MAIL_CLIENT_ID,redirect_uri:callback(),response_type:"code",scope:"https://www.googleapis.com/auth/gmail.readonly",access_type:"offline",prompt:"consent select_account",login_hint:address,state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}).toString();
    return {url:url.toString()};
  });

  app.get("/api/v1/mailboxes/google/callback",async(request,reply)=>{
    reply.header("cache-control","no-store").header("referrer-policy","no-referrer");
    const parsed=z.object({state:z.string().min(32).max(128),code:z.string().max(8192).optional(),error:z.string().optional()}).safeParse(request.query);
    if(!parsed.success)return reply.code(400).send("授权状态无效，请重新发起授权。");
    const claimed=await pool.query("DELETE FROM mailbox_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING *",[hash(parsed.data.state)]);
    if(!claimed.rowCount)return reply.code(400).send("授权已过期或已使用，请重新发起授权。");
    if(parsed.data.error||!parsed.data.code)return reply.code(400).send("Google 授权已取消。");
    const row=claimed.rows[0];
    try{
      const tokens=await tokenRequest({grant_type:"authorization_code",code:parsed.data.code,code_verifier:decryptAtRest(row.verifier_encrypted,config.DATA_ENCRYPTION_KEY)});
      if(!tokens.refresh_token)throw new Error("missing_refresh_token");
      const profile=await gmailRequestWithToken<{emailAddress:string;historyId:string}>(tokens.access_token,"/profile");
      if(profile.emailAddress.toLowerCase()!==String(row.address).toLowerCase())throw new Error("google_mailbox_identity_mismatch");
      await gmailRequestWithToken(tokens.access_token,"/labels");
      await transaction(async client=>{
        const user=await client.query("SELECT role FROM users WHERE id=$1",[row.user_id]);
        if(user.rows[0]?.role!=="admin")throw new Error("authorization_revoked");
        const existing=await client.query("SELECT id,account_id FROM account_email_mailboxes WHERE lower(address)=lower($1) FOR UPDATE",[row.address]);
        if(existing.rowCount&&existing.rows[0].account_id!==row.account_id)throw new Error("mailbox_account_conflict");
        const refresh=encryptAtRest(tokens.refresh_token!,config.DATA_ENCRYPTION_KEY);
        if(existing.rowCount){
          await client.query("UPDATE account_email_mailboxes SET auth_type='google',oauth_refresh_encrypted=$2,gmail_history_id=$3,imap_secret_encrypted='',smtp_secret_encrypted='',is_primary=is_primary AND NOT EXISTS(SELECT 1 FROM account_email_mailboxes other WHERE other.account_id=$4 AND other.id<>$1 AND other.is_primary AND other.enabled),last_error=NULL,next_sync_at=now(),updated_at=now() WHERE id=$1",[existing.rows[0].id,refresh,profile.historyId,row.account_id]);
          await client.query("DELETE FROM gmail_inbound_receipts WHERE mailbox_id=$1",[existing.rows[0].id]);
        }else{
          await client.query("INSERT INTO account_email_mailboxes(account_id,address,display_name,imap_host,imap_port,imap_username,imap_secret_encrypted,smtp_host,smtp_port,smtp_username,smtp_secret_encrypted,smtp_tls,auth_type,oauth_refresh_encrypted,gmail_history_id) VALUES($1,$2,'','',993,$2,'','',465,$2,'','tls','google',$3,$4)",[row.account_id,row.address,refresh,profile.historyId]);
        }
        await client.query("DELETE FROM mailbox_oauth_states WHERE state_hash=$1",[row.state_hash]);
      });
      return reply.type("text/html; charset=utf-8").send(successPage());
    }catch(error){
      const detail=error instanceof Error?error.message:"unknown_error";
      request.log.error({err:detail,address:row.address,accountId:row.account_id},"Google mailbox OAuth callback failed");
      const message=detail==="google_mailbox_identity_mismatch"?"授权的 Google 账号与填写的邮箱地址不一致。":"Google 邮箱授权失败，请确认 OAuth 回调地址、Gmail API 和只读权限配置正确后重试。";
      return reply.code(400).send(message);
    }
  });

  app.get("/api/v1/admin/mailboxes/:id/google/labels",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};
    const mailbox=await pool.query("SELECT id,account_id,auth_type FROM account_email_mailboxes WHERE id=$1",[id]);
    if(!mailbox.rowCount)return reply.code(404).send({error:"not_found"});
    if(!canAccessAccount(request.principal,mailbox.rows[0].account_id))return reply.code(403).send({error:"account_forbidden"});
    if(mailbox.rows[0].auth_type!=="google")return reply.code(409).send({error:"google_mailbox_required"});
    try{return await gmailApiRequest<{labels?:Array<{id:string;name:string;type:string}>}>(id,"/labels");}
    catch{return reply.code(502).send({error:"gmail_labels_unavailable",message:"无法读取 Gmail 标签，请重新授权后重试"});}
  });

  app.put("/api/v1/admin/mailboxes/:id/google/label",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.role!=="admin")return reply.code(403).send({error:"admin_required"});
    const {id}=request.params as {id:string};
    const parsed=z.object({labelId:z.string().trim().min(1).max(255)}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const mailbox=await pool.query("SELECT id,account_id,auth_type FROM account_email_mailboxes WHERE id=$1",[id]);
    if(!mailbox.rowCount)return reply.code(404).send({error:"not_found"});
    if(!canAccessAccount(request.principal,mailbox.rows[0].account_id))return reply.code(403).send({error:"account_forbidden"});
    if(mailbox.rows[0].auth_type!=="google")return reply.code(409).send({error:"google_mailbox_required"});
    let labels:{labels?:Array<{id:string;name:string}>};
    try{labels=await gmailApiRequest(id,"/labels");}catch{return reply.code(502).send({error:"gmail_labels_unavailable"});}
    const label=labels.labels?.find(item=>item.id===parsed.data.labelId);
    if(!label)return reply.code(400).send({error:"gmail_label_not_found"});
    let profile:{historyId:string};
    try{profile=await gmailApiRequest(id,"/profile");}catch{return reply.code(502).send({error:"gmail_profile_unavailable"});}
    await pool.query("UPDATE account_email_mailboxes SET gmail_label_id=$2,gmail_history_id=$3,last_error=NULL,next_sync_at=now(),updated_at=now() WHERE id=$1",[id,label.id,profile.historyId]);
    return {id,labelId:label.id,labelName:label.name};
  });
}
