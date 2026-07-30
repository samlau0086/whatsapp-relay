import {randomBytes} from "node:crypto";
import type {FastifyInstance,FastifyReply} from "fastify";
import {z} from "zod";
import {authenticate} from "./auth.js";
import {config} from "./config.js";
import {pool,transaction} from "./db.js";
import {decryptAtRest,encryptAtRest,hashSecret} from "./security.js";

const graphBase=`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}`;
const subscriptionFields=["messages","message_deliveries","message_reads"] as const;
const settingsSchema=z.object({
  appId:z.string().trim().regex(/^\d+$/),
  configurationId:z.string().trim().regex(/^\d+$/),
  appSecret:z.string().trim().min(16).max(512).optional(),
  enabled:z.boolean().default(true),
});
const connectSchema=z.object({pageIds:z.array(z.string().regex(/^\d+$/)).min(1).max(100)});

type OAuthSettingsRow={
  app_id:string;app_secret_encrypted:string;configuration_id:string;
  verify_token_hash:string;enabled:boolean;updated_at:string;
};
type CandidateRow={page_id:string;page_name:string;page_access_token_encrypted:string;tasks:unknown};
type MetaPageList={data?:Array<{id?:string;name?:string;access_token?:string;tasks?:string[]}>;paging?:{next?:string}};

class MetaOAuthError extends Error{
  constructor(readonly status:number,readonly code:string,detail:string){super(detail);}
}

async function metaRequest<T>(path:string,token?:string,init:RequestInit={}):Promise<T>{
  const url=path.startsWith("http")?path:`${graphBase}/${path.replace(/^\//,"")}`;
  const response=await fetch(url,{
    ...init,
    headers:{accept:"application/json",...(token?{authorization:`Bearer ${token}`}:{}) ,...init.headers},
    signal:init.signal??AbortSignal.timeout(30_000),
  });
  const body=await response.json().catch(()=>({})) as Record<string,unknown>;
  if(!response.ok){
    const error=(body.error??{}) as Record<string,unknown>;
    throw new MetaOAuthError(response.status,String(error.code??response.status),String(error.message??`Meta Graph API HTTP ${response.status}`));
  }
  return body as T;
}

function callbackUrl():string{
  return new URL("/api/v1/meta/messenger/oauth/callback",config.PUBLIC_API_URL).toString();
}

function frontendOrigin():string{
  return new URL(config.CORS_ORIGIN.split(",")[0].trim()).origin;
}

export function messengerOAuthAuthorizationUrl(input:{appId:string;configurationId:string;state:string}):string{
  const url=new URL(`https://www.facebook.com/${config.META_GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id",input.appId);
  url.searchParams.set("redirect_uri",callbackUrl());
  url.searchParams.set("state",input.state);
  url.searchParams.set("response_type","code");
  url.searchParams.set("config_id",input.configurationId);
  url.searchParams.set("override_default_response_type","true");
  return url.toString();
}

export function messengerOAuthCallbackHtml(payload:{sessionId?:string;error?:string}):string{
  const target=frontendOrigin();
  const message=JSON.stringify({type:"relaydesk:messenger-oauth",...payload}).replace(/</g,"\\u003c");
  const fallback=new URL("/settings",target);
  if(payload.sessionId)fallback.searchParams.set("messengerOauth",payload.sessionId);
  if(payload.error)fallback.searchParams.set("messengerOauthError",payload.error);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>RelayDesk · Facebook 授权</title></head><body><p>Facebook 授权已处理，正在返回 RelayDesk…</p><script>const payload=${message};if(window.opener&&!window.opener.closed){window.opener.postMessage(payload,${JSON.stringify(target)});window.close();}else{window.location.replace(${JSON.stringify(fallback.toString())});}</script></body></html>`;
}

async function oauthSettings():Promise<OAuthSettingsRow|null>{
  const result=await pool.query("SELECT * FROM messenger_oauth_settings WHERE singleton=true");
  return result.rows[0]??null;
}

function adminOnly(request:{principal?:{kind:string;role?:string}},reply:FastifyReply):boolean{
  if(request.principal?.kind==="user"&&request.principal.role==="admin")return true;
  reply.code(403).send({error:"admin_required"});
  return false;
}

async function exchangeAuthorizationCode(settings:OAuthSettingsRow,code:string):Promise<string>{
  const shortUrl=new URL(`${graphBase}/oauth/access_token`);
  shortUrl.searchParams.set("client_id",settings.app_id);
  shortUrl.searchParams.set("client_secret",decryptAtRest(settings.app_secret_encrypted,config.DATA_ENCRYPTION_KEY));
  shortUrl.searchParams.set("redirect_uri",callbackUrl());
  shortUrl.searchParams.set("code",code);
  const short=await metaRequest<{access_token?:string}>(shortUrl.toString());
  if(!short.access_token)throw new MetaOAuthError(400,"missing_access_token","Meta did not return a user access token");
  const longUrl=new URL(`${graphBase}/oauth/access_token`);
  longUrl.searchParams.set("grant_type","fb_exchange_token");
  longUrl.searchParams.set("client_id",settings.app_id);
  longUrl.searchParams.set("client_secret",decryptAtRest(settings.app_secret_encrypted,config.DATA_ENCRYPTION_KEY));
  longUrl.searchParams.set("fb_exchange_token",short.access_token);
  const long=await metaRequest<{access_token?:string}>(longUrl.toString());
  return long.access_token??short.access_token;
}

async function discoverPages(userToken:string):Promise<Array<{id:string;name:string;access_token:string;tasks:string[]}>>{
  const pages:Array<{id:string;name:string;access_token:string;tasks:string[]}>=[],seen=new Set<string>();
  let next:string|undefined=`${graphBase}/me/accounts?fields=id,name,access_token,tasks&limit=100`;
  for(let page=0;next&&page<10;page++){
    const response:MetaPageList=await metaRequest<MetaPageList>(next,userToken);
    for(const item of response.data??[]){
      if(!item.id||!item.access_token||seen.has(item.id))continue;
      seen.add(item.id);
      pages.push({id:item.id,name:item.name??`Facebook Page ${item.id}`,access_token:item.access_token,tasks:Array.isArray(item.tasks)?item.tasks:[]});
    }
    const candidate:string|undefined=response.paging?.next;
    next=candidate&&new URL(candidate).hostname==="graph.facebook.com"?candidate:undefined;
  }
  return pages;
}

async function verifyPage(pageId:string,pageToken:string):Promise<{id:string;name?:string}>{
  const page=await metaRequest<{id?:string;name?:string}>("me?fields=id,name",pageToken);
  if(page.id!==pageId)throw new MetaOAuthError(400,"page_mismatch","Page token does not belong to the selected Page");
  return{id:page.id,name:page.name};
}

async function subscribePage(pageId:string,pageToken:string):Promise<void>{
  const params=new URLSearchParams({subscribed_fields:subscriptionFields.join(",")});
  const result=await metaRequest<{success?:boolean}>(`${pageId}/subscribed_apps?${params}`,pageToken,{method:"POST"});
  if(result.success!==true)throw new MetaOAuthError(400,"subscription_failed","Meta did not confirm the Page webhook subscription");
}

async function upsertOAuthPage(input:{candidate:CandidateRow;settings:OAuthSettingsRow;actorId:string}):Promise<string>{
  const token=decryptAtRest(input.candidate.page_access_token_encrypted,config.DATA_ENCRYPTION_KEY);
  const profile=await verifyPage(input.candidate.page_id,token);
  return transaction(async client=>{
    const existing=await client.query("SELECT account_id FROM messenger_page_accounts WHERE page_id=$1",[input.candidate.page_id]);
    let accountId:string;
    if(existing.rowCount){
      accountId=String(existing.rows[0].account_id);
      await client.query("UPDATE channel_accounts SET display_name=$2,status='online',status_reason=NULL,last_connected_at=now() WHERE id=$1",[accountId,profile.name??input.candidate.page_name]);
      await client.query(`UPDATE messenger_page_accounts SET page_access_token_encrypted=$2,app_secret_encrypted=$3,verify_token_hash=$4,enabled=true,
        credentials_verified_at=now(),auth_source='oauth',token_refreshed_at=now(),subscription_status='pending',subscription_error=NULL,updated_at=now()
        WHERE account_id=$1`,[accountId,input.candidate.page_access_token_encrypted,input.settings.app_secret_encrypted,input.settings.verify_token_hash]);
    }else{
      const account=await client.query(`INSERT INTO channel_accounts(display_name,status,transport,platform,last_connected_at)
        VALUES($1,'online','cloud','messenger',now()) RETURNING id`,[profile.name??input.candidate.page_name]);
      accountId=String(account.rows[0].id);
      await client.query(`INSERT INTO messenger_page_accounts(account_id,page_id,page_access_token_encrypted,app_secret_encrypted,verify_token_hash,enabled,
        credentials_verified_at,auth_source,token_refreshed_at,subscription_status)
        VALUES($1,$2,$3,$4,$5,true,now(),'oauth',now(),'pending')`,[
        accountId,input.candidate.page_id,input.candidate.page_access_token_encrypted,input.settings.app_secret_encrypted,input.settings.verify_token_hash,
      ]);
    }
    await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'messenger_page.oauth_connect','channel_account',$2,$3)",[
      input.actorId,accountId,JSON.stringify({pageId:input.candidate.page_id,pageName:profile.name??input.candidate.page_name}),
    ]);
    return accountId;
  });
}

async function setSubscriptionResult(accountId:string,error?:unknown):Promise<void>{
  await pool.query(`UPDATE messenger_page_accounts SET subscription_status=$2,subscription_error=$3,updated_at=now() WHERE account_id=$1`,[
    accountId,error?"failed":"subscribed",error?(error instanceof Error?error.message:String(error)).slice(0,1000):null,
  ]);
}

export async function registerMessengerOAuthRoutes(app:FastifyInstance):Promise<void>{
  app.get("/api/v1/admin/messenger/oauth/settings",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const row=await oauthSettings();
    return{
      configured:Boolean(row),
      appId:row?.app_id??"",
      configurationId:row?.configuration_id??"",
      appSecretConfigured:Boolean(row?.app_secret_encrypted),
      verifyTokenConfigured:Boolean(row?.verify_token_hash),
      enabled:row?.enabled??false,
      redirectUri:callbackUrl(),
      webhookCallbackUrl:new URL("/api/v1/meta/messenger/webhook",config.PUBLIC_API_URL).toString(),
      updatedAt:row?.updated_at??null,
      subscriptionFields:[...subscriptionFields],
    };
  });

  app.put("/api/v1/admin/messenger/oauth/settings",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const parsed=settingsSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const current=await oauthSettings();
    if(!current&&!parsed.data.appSecret)return reply.code(400).send({error:"app_secret_required"});
    const verifyToken=current?undefined:`rdm_${randomBytes(32).toString("base64url")}`;
    const encryptedSecret=parsed.data.appSecret?encryptAtRest(parsed.data.appSecret,config.DATA_ENCRYPTION_KEY):current!.app_secret_encrypted;
    await transaction(async client=>{
      await client.query(`INSERT INTO messenger_oauth_settings(singleton,app_id,app_secret_encrypted,configuration_id,verify_token_hash,enabled,updated_by)
        VALUES(true,$1,$2,$3,$4,$5,$6)
        ON CONFLICT(singleton) DO UPDATE SET app_id=EXCLUDED.app_id,app_secret_encrypted=EXCLUDED.app_secret_encrypted,
        configuration_id=EXCLUDED.configuration_id,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=now()`,[
        parsed.data.appId,encryptedSecret,parsed.data.configurationId,current?.verify_token_hash??hashSecret(verifyToken!),parsed.data.enabled,request.principal!.id,
      ]);
      if(parsed.data.appSecret)await client.query("UPDATE messenger_page_accounts SET app_secret_encrypted=$1,updated_at=now() WHERE auth_source='oauth'",[encryptedSecret]);
    });
    return{ok:true,verifyToken};
  });

  app.post("/api/v1/admin/messenger/oauth/verify-token/reset",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const token=`rdm_${randomBytes(32).toString("base64url")}`,result=await pool.query(
      "UPDATE messenger_oauth_settings SET verify_token_hash=$1,updated_by=$2,updated_at=now() WHERE singleton=true RETURNING singleton",
      [hashSecret(token),request.principal!.id],
    );
    if(!result.rowCount)return reply.code(409).send({error:"oauth_not_configured"});
    await pool.query("UPDATE messenger_page_accounts SET verify_token_hash=$1,webhook_verified_at=NULL,updated_at=now() WHERE auth_source='oauth'",[hashSecret(token)]);
    return{verifyToken:token};
  });

  app.post("/api/v1/admin/messenger/oauth/start",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const settings=await oauthSettings();
    if(!settings||!settings.enabled)return reply.code(409).send({error:"oauth_not_configured"});
    await pool.query("DELETE FROM messenger_oauth_sessions WHERE expires_at<now()-interval '1 day'");
    const state=randomBytes(32).toString("base64url");
    const session=await pool.query(`INSERT INTO messenger_oauth_sessions(state_hash,user_id,expires_at)
      VALUES($1,$2,now()+interval '15 minutes') RETURNING id`,[hashSecret(state),request.principal!.id]);
    return{authorizationUrl:messengerOAuthAuthorizationUrl({appId:settings.app_id,configurationId:settings.configuration_id,state}),sessionId:session.rows[0].id};
  });

  app.get("/api/v1/meta/messenger/oauth/callback",{logLevel:"warn"},async(request,reply)=>{
    const query=request.query as {code?:string;state?:string;error?:string;error_description?:string};
    if(!query.state)return reply.type("text/html").send(messengerOAuthCallbackHtml({error:"missing_state"}));
    const claimed=await pool.query(`UPDATE messenger_oauth_sessions SET status='processing',updated_at=now()
      WHERE state_hash=$1 AND status='pending' AND expires_at>now() RETURNING *`,[hashSecret(query.state)]);
    if(!claimed.rowCount)return reply.type("text/html").send(messengerOAuthCallbackHtml({error:"oauth_session_expired"}));
    const session=claimed.rows[0] as {id:string};
    try{
      if(query.error)throw new MetaOAuthError(400,query.error,query.error_description??"Facebook authorization was cancelled");
      if(!query.code)throw new MetaOAuthError(400,"missing_code","Meta did not return an authorization code");
      const settings=await oauthSettings();
      if(!settings||!settings.enabled)throw new MetaOAuthError(409,"oauth_not_configured","Messenger OAuth is not configured");
      const userToken=await exchangeAuthorizationCode(settings,query.code);
      const pages=await discoverPages(userToken);
      await transaction(async client=>{
        await client.query("DELETE FROM messenger_oauth_page_candidates WHERE session_id=$1",[session.id]);
        for(const page of pages)await client.query(`INSERT INTO messenger_oauth_page_candidates(session_id,page_id,page_name,page_access_token_encrypted,tasks)
          VALUES($1,$2,$3,$4,$5)`,[session.id,page.id,page.name,encryptAtRest(page.access_token,config.DATA_ENCRYPTION_KEY),JSON.stringify(page.tasks)]);
        await client.query(`UPDATE messenger_oauth_sessions SET status='pages_ready',expires_at=now()+interval '30 minutes',last_error=NULL,updated_at=now() WHERE id=$1`,[session.id]);
      });
      return reply.type("text/html").send(messengerOAuthCallbackHtml({sessionId:session.id}));
    }catch(error){
      const message=(error instanceof Error?error.message:String(error)).slice(0,1000);
      await pool.query("UPDATE messenger_oauth_sessions SET status='failed',last_error=$2,updated_at=now() WHERE id=$1",[session.id,message]);
      return reply.type("text/html").send(messengerOAuthCallbackHtml({error:message}));
    }
  });

  app.get("/api/v1/admin/messenger/oauth/sessions/:id",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const {id}=request.params as {id:string};
    const session=await pool.query(`SELECT id,status,expires_at,last_error FROM messenger_oauth_sessions
      WHERE id=$1 AND user_id=$2`,[id,request.principal!.id]);
    if(!session.rowCount)return reply.code(404).send({error:"not_found"});
    if(new Date(session.rows[0].expires_at).getTime()<=Date.now())return reply.code(410).send({error:"oauth_session_expired"});
    const pages=await pool.query(`SELECT page_id,page_name,tasks FROM messenger_oauth_page_candidates WHERE session_id=$1 ORDER BY page_name`,[id]);
    return{session:{id,status:session.rows[0].status,expiresAt:session.rows[0].expires_at,lastError:session.rows[0].last_error},pages:pages.rows.map(row=>({pageId:row.page_id,pageName:row.page_name,tasks:row.tasks}))};
  });

  app.post("/api/v1/admin/messenger/oauth/sessions/:id/connect",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const parsed=connectSchema.safeParse(request.body);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request",details:parsed.error.flatten()});
    const {id}=request.params as {id:string};
    const session=await pool.query(`SELECT * FROM messenger_oauth_sessions WHERE id=$1 AND user_id=$2 AND status='pages_ready' AND expires_at>now()`,[id,request.principal!.id]);
    if(!session.rowCount)return reply.code(409).send({error:"oauth_session_not_ready"});
    const settings=await oauthSettings();
    if(!settings||!settings.enabled)return reply.code(409).send({error:"oauth_not_configured"});
    const candidates=await pool.query(`SELECT * FROM messenger_oauth_page_candidates WHERE session_id=$1 AND page_id=ANY($2::text[])`,[id,parsed.data.pageIds]);
    if(candidates.rowCount!==new Set(parsed.data.pageIds).size)return reply.code(400).send({error:"invalid_page_selection"});
    const results:Array<{pageId:string;accountId?:string;ok:boolean;error?:string}>=[];
    for(const candidate of candidates.rows as CandidateRow[]){
      let accountId:string|undefined;
      try{
        accountId=await upsertOAuthPage({candidate,settings,actorId:request.principal!.id});
        const token=decryptAtRest(candidate.page_access_token_encrypted,config.DATA_ENCRYPTION_KEY);
        try{await subscribePage(candidate.page_id,token);await setSubscriptionResult(accountId);}
        catch(error){await setSubscriptionResult(accountId,error);throw error;}
        results.push({pageId:candidate.page_id,accountId,ok:true});
      }catch(error){
        results.push({pageId:candidate.page_id,accountId,ok:false,error:error instanceof Error?error.message:String(error)});
      }
    }
    await transaction(async client=>{
      await client.query("UPDATE messenger_oauth_sessions SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1",[id]);
      await client.query("DELETE FROM messenger_oauth_page_candidates WHERE session_id=$1",[id]);
    });
    return reply.code(results.every(item=>item.ok)?200:207).send({results});
  });

  app.post("/api/v1/admin/messenger/pages/:id/subscription/retry",{preHandler:authenticate},async(request,reply)=>{
    if(!adminOnly(request,reply))return;
    const {id}=request.params as {id:string};
    const page=await pool.query("SELECT page_id,page_access_token_encrypted FROM messenger_page_accounts WHERE account_id=$1",[id]);
    if(!page.rowCount)return reply.code(404).send({error:"not_found"});
    try{
      await subscribePage(page.rows[0].page_id,decryptAtRest(page.rows[0].page_access_token_encrypted,config.DATA_ENCRYPTION_KEY));
      await setSubscriptionResult(id);
      return{ok:true};
    }catch(error){
      await setSubscriptionResult(id,error);
      return reply.code(400).send({error:"subscription_failed",message:error instanceof Error?error.message:String(error)});
    }
  });
}
