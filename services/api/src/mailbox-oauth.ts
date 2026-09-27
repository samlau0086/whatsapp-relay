import {createHash,randomBytes} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate,canAccessAccount} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {decryptAtRest,encryptAtRest} from "./security.js";

const scope="offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send";
const base="https://login.microsoftonline.com/consumers/oauth2/v2.0";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const callback=()=>new URL("/api/v1/mailboxes/microsoft/callback",config.PUBLIC_API_URL).toString();
export function microsoftAuthorizationUrl(state:string,verifier:string,address:string):string{
  const url=new URL(`${base}/authorize`);
  url.search=new URLSearchParams({client_id:config.MICROSOFT_MAIL_CLIENT_ID,response_type:"code",redirect_uri:callback(),scope,state,login_hint:address,prompt:"select_account",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}).toString();
  return url.toString();
}
async function tokenRequest(fields:Record<string,string>):Promise<{access_token:string;refresh_token?:string}>{
  const response=await fetch(`${base}/token`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:config.MICROSOFT_MAIL_CLIENT_ID,client_secret:config.MICROSOFT_MAIL_CLIENT_SECRET,scope,...fields}),signal:AbortSignal.timeout(30000)});
  const body=await response.json().catch(()=>({})) as {access_token?:string;refresh_token?:string;error?:string;error_description?:string};
  if(!response.ok||!body.access_token){
    const reason=body.error_description||body.error||`http_${response.status}`;
    throw new Error(`microsoft_authorization_failed:${reason.slice(0,240)}`);
  }
  return body as {access_token:string;refresh_token?:string};
}
export async function microsoftMailboxToken(id:string):Promise<string>{
  // Serialize refresh-token rotation between the IMAP and SMTP workers.
  return transaction(async client=>{
    const result=await client.query("SELECT oauth_refresh_encrypted FROM account_email_mailboxes WHERE id=$1 AND enabled AND auth_type='microsoft' FOR UPDATE",[id]);
    if(!result.rows[0]?.oauth_refresh_encrypted)throw new Error("microsoft_mailbox_authorization_required");
    const tokens=await tokenRequest({grant_type:"refresh_token",refresh_token:decryptAtRest(result.rows[0].oauth_refresh_encrypted,config.DATA_ENCRYPTION_KEY)});
    if(tokens.refresh_token)await client.query("UPDATE account_email_mailboxes SET oauth_refresh_encrypted=$2 WHERE id=$1",[id,encryptAtRest(tokens.refresh_token,config.DATA_ENCRYPTION_KEY)]);
    return tokens.access_token;
  });
}
export function registerMailboxOAuth(app:FastifyInstance):void{
  app.post("/api/v1/admin/mailboxes/microsoft/authorize",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user"||request.principal.role!=="admin")return reply.code(403).send({error:"admin_required"});
    if(!config.MICROSOFT_MAIL_CLIENT_ID||!config.MICROSOFT_MAIL_CLIENT_SECRET)return reply.code(409).send({error:"microsoft_oauth_not_configured",message:"请先配置 Microsoft 应用 Client ID 和 Client Secret"});
    const parsed=z.object({accountId:z.string().uuid(),address:z.string().trim().toLowerCase().email().max(254)}).safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const {accountId,address}=parsed.data;
    if(!canAccessAccount(request.principal,accountId))return reply.code(403).send({error:"account_forbidden"});
    const account=await pool.query("SELECT 1 FROM channel_accounts WHERE id=$1 AND platform='whatsapp'",[accountId]);
    if(!account.rowCount)return reply.code(404).send({error:"account_not_found"});
    const state=randomBytes(32).toString("base64url"),verifier=randomBytes(48).toString("base64url");
    await pool.query("DELETE FROM mailbox_oauth_states WHERE expires_at<now()");
    await pool.query("INSERT INTO mailbox_oauth_states(state_hash,user_id,account_id,address,verifier_encrypted) VALUES($1,$2,$3,$4,$5)",[hash(state),request.principal.id,accountId,address,encryptAtRest(verifier,config.DATA_ENCRYPTION_KEY)]);
    return {url:microsoftAuthorizationUrl(state,verifier,address)};
  });
  app.get("/api/v1/mailboxes/microsoft/callback",async(request,reply)=>{
    reply.header("cache-control","no-store").header("referrer-policy","no-referrer");
    const parsed=z.object({state:z.string().min(32).max(128),code:z.string().max(8192).optional(),error:z.string().optional()}).safeParse(request.query);
    if(!parsed.success)return reply.code(400).send("授权状态无效，请重新发起授权。");
    const claimed=await pool.query("DELETE FROM mailbox_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING *",[hash(parsed.data.state)]);
    if(!claimed.rowCount)return reply.code(400).send("授权已过期或已使用，请重新发起授权。");
    if(parsed.data.error||!parsed.data.code)return reply.code(400).send("Microsoft 授权已取消。");
    const row=claimed.rows[0];
    try{
      const tokens=await tokenRequest({grant_type:"authorization_code",code:parsed.data.code,redirect_uri:callback(),code_verifier:decryptAtRest(row.verifier_encrypted,config.DATA_ENCRYPTION_KEY)});
      if(!tokens.refresh_token)throw new Error("missing_refresh_token");
      // Confirm the authorized identity owns the requested mailbox before saving it.
      const {ImapFlow}=await import("imapflow");
      const imap=new ImapFlow({host:"outlook.office365.com",port:993,secure:true,auth:{user:row.address,accessToken:tokens.access_token},logger:false});
      let uidValidity:string,lastUid:number;
      try{await imap.connect();const box=await imap.mailboxOpen("INBOX",{readOnly:true});uidValidity=String(box.uidValidity);lastUid=Math.max(0,Number(box.uidNext)-1);}finally{await imap.logout().catch(()=>{});}
      await transaction(async client=>{
        const user=await client.query("SELECT role FROM users WHERE id=$1",[row.user_id]);
        if(user.rows[0]?.role!=="admin")throw new Error("authorization_revoked");
        const existing=await client.query("SELECT id,account_id FROM account_email_mailboxes WHERE lower(address)=lower($1) FOR UPDATE",[row.address]);
        if(existing.rowCount&&existing.rows[0].account_id!==row.account_id)throw new Error("mailbox_account_conflict");
        const secret=encryptAtRest(tokens.refresh_token!,config.DATA_ENCRYPTION_KEY);
        if(existing.rowCount)await client.query("UPDATE account_email_mailboxes SET auth_type='microsoft',oauth_refresh_encrypted=$2,is_primary=is_primary AND NOT EXISTS(SELECT 1 FROM account_email_mailboxes other WHERE other.account_id=$3 AND other.id<>$1 AND other.is_primary AND other.enabled),enabled=true,last_error=NULL,imap_host='outlook.office365.com',imap_port=993,imap_username=address,smtp_host='smtp-mail.outlook.com',smtp_port=587,smtp_tls='starttls',smtp_username=address,next_sync_at=now(),updated_at=now() WHERE id=$1",[existing.rows[0].id,secret,row.account_id]);
        else await client.query("INSERT INTO account_email_mailboxes(account_id,address,imap_host,imap_port,imap_username,imap_secret_encrypted,smtp_host,smtp_port,smtp_username,smtp_secret_encrypted,smtp_tls,auth_type,oauth_refresh_encrypted,uid_validity,last_uid) VALUES($1,$2,'outlook.office365.com',993,$2,'','smtp-mail.outlook.com',587,$2,'','starttls','microsoft',$3,$4,$5)",[row.account_id,row.address,secret,uidValidity,lastUid]);
        await client.query("DELETE FROM mailbox_oauth_states WHERE state_hash=$1",[row.state_hash]);
      });
      return reply.send("Microsoft 邮箱授权成功，可以关闭此页面并刷新邮箱设置。");
    }catch(error){
      const detail=error instanceof Error?error.message:"unknown_error";
      request.log.error({err:detail,address:row.address,accountId:row.account_id},"Microsoft mailbox OAuth callback failed");
      const message=detail.startsWith("microsoft_authorization_failed:")
        ? "Microsoft 授权码交换失败，请检查 Client Secret、回调地址和应用账户类型配置。"
        : /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|imap|mailboxOpen|authentication/i.test(detail)
          ? "Microsoft 授权成功但 IMAP 登录失败，请确认已开启 IMAP、邮箱地址与授权账号一致。"
          : "Microsoft 邮箱授权失败，请确认邮箱地址一致、已开启 IMAP，并重新授权。";
      return reply.code(400).send(message);
    }
  });
}
