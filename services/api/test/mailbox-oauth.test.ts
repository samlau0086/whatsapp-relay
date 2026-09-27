import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import Fastify from "fastify";
import {config} from "../src/config.js";
import {pool} from "../src/db.js";
import {microsoftAuthorizationUrl,microsoftMailboxToken,registerMailboxOAuth} from "../src/mailbox-oauth.js";
import {decryptAtRest,encryptAtRest,signToken} from "../src/security.js";

test("Microsoft authorization uses personal accounts, state, PKCE and delegated mail scopes",()=>{
  const url=new URL(microsoftAuthorizationUrl("one-time-state","pkce-verifier","user@hotmail.com"));
  assert.equal(url.origin,"https://login.microsoftonline.com");
  assert.equal(url.pathname,"/consumers/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("state"),"one-time-state");
  assert.equal(url.searchParams.get("code_challenge_method"),"S256");
  assert.equal(url.searchParams.get("code_challenge"),createHash("sha256").update("pkce-verifier").digest("base64url"));
  assert.equal(url.searchParams.get("login_hint"),"user@hotmail.com");
  assert.match(url.searchParams.get("scope")!,/offline_access/);
  assert.match(url.searchParams.get("scope")!,/IMAP.AccessAsUser.All/);
  assert.match(url.searchParams.get("scope")!,/SMTP.Send/);
  assert.equal(url.searchParams.get("redirect_uri"),new URL("/api/v1/mailboxes/microsoft/callback",config.PUBLIC_API_URL).toString());
  assert.equal(url.searchParams.has("client_secret"),false);
});

test("Microsoft refresh tokens rotate encrypted under a row lock",async()=>{
  const statements:Array<{sql:string;values?:unknown[]}>=[];
  let released=false;
  const client={query:async(sql:string,values?:unknown[])=>{
    statements.push({sql,values});
    if(sql.startsWith("SELECT"))return {rows:[{oauth_refresh_encrypted:encryptAtRest("old-refresh",config.DATA_ENCRYPTION_KEY)}],rowCount:1};
    return {rows:[],rowCount:1};
  },release:()=>{released=true;}};
  const oldConnect=pool.connect,oldFetch=globalThis.fetch;
  try{
    pool.connect=(async()=>client) as unknown as typeof pool.connect;
    globalThis.fetch=async(url,init)=>{
      assert.equal(String(url),"https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
      const body=init!.body as URLSearchParams;
      assert.equal(body.get("grant_type"),"refresh_token");
      assert.equal(body.get("refresh_token"),"old-refresh");
      return Response.json({access_token:"new-access",refresh_token:"new-refresh"});
    };
    assert.equal(await microsoftMailboxToken("mailbox-id"),"new-access");
    assert.match(statements[1].sql,/enabled AND auth_type='microsoft' FOR UPDATE/);
    const update=statements.find(item=>item.sql.startsWith("UPDATE"))!;
    assert.equal(decryptAtRest(String(update.values![1]),config.DATA_ENCRYPTION_KEY),"new-refresh");
    assert.equal(statements.at(-1)!.sql,"COMMIT");
    assert.equal(released,true);
  }finally{pool.connect=oldConnect;globalThis.fetch=oldFetch;}
});

test("revoked Microsoft consent rolls back without exposing provider token errors",async()=>{
  const statements:string[]=[];
  const oldConnect=pool.connect,oldFetch=globalThis.fetch;
  try{
    pool.connect=(async()=>({query:async(sql:string)=>{statements.push(sql);return {rows:[{oauth_refresh_encrypted:encryptAtRest("revoked-token",config.DATA_ENCRYPTION_KEY)}],rowCount:1};},release:()=>{}})) as unknown as typeof pool.connect;
    globalThis.fetch=async()=>Response.json({error_description:"sensitive-provider-detail"},{status:400});
    await assert.rejects(microsoftMailboxToken("mailbox-id"),/microsoft_authorization_failed/);
    assert.equal(statements.at(-1),"ROLLBACK");
    assert.equal(statements.some(sql=>sql.startsWith("UPDATE")),false);
  }finally{pool.connect=oldConnect;globalThis.fetch=oldFetch;}
});

test("OAuth endpoints require admin and reject missing, expired or replayed state",async()=>{
  const app=Fastify();registerMailboxOAuth(app);
  const oldQuery=pool.query;
  try{
    assert.equal((await app.inject({method:"POST",url:"/api/v1/admin/mailboxes/microsoft/authorize",payload:{}})).statusCode,401);
    const token=signToken({sub:"123e4567-e89b-42d3-a456-426614174000",role:"agent"},config.JWT_SECRET);
    assert.equal((await app.inject({method:"POST",url:"/api/v1/admin/mailboxes/microsoft/authorize",headers:{authorization:`Bearer ${token}`},payload:{}})).statusCode,403);
    assert.equal((await app.inject({url:"/api/v1/mailboxes/microsoft/callback?code=bad"})).statusCode,400);
    pool.query=(async(sql:string)=>{assert.match(sql,/DELETE FROM mailbox_oauth_states.*expires_at>now\(\).*RETURNING/);return {rows:[],rowCount:0};}) as unknown as typeof pool.query;
    const response=await app.inject({url:`/api/v1/mailboxes/microsoft/callback?state=${"x".repeat(40)}&code=bad`});
    assert.equal(response.statusCode,400);assert.equal(response.headers["cache-control"],"no-store");
  }finally{pool.query=oldQuery;await app.close();}
});

test("Microsoft mailbox migration and queue keep OAuth secrets outside queued messages",async()=>{
  const root=new URL("../../../",import.meta.url);
  const migration=await readFile(new URL("infra/postgres/migrations/090_mailbox_oauth.sql",root),"utf8");
  const email=await readFile(new URL("../src/email.ts",import.meta.url),"utf8");
  const routes=await readFile(new URL("../src/mailbox-routes.ts",import.meta.url),"utf8");
  assert.match(migration,/oauth_refresh_encrypted/);
  assert.match(migration,/verifier_encrypted/);
  assert.match(email,/await microsoftMailboxToken\(cfg.oauthMailboxId\)/);
  assert.match(email,/type:"OAuth2"/);
  assert.match(routes,/providerConfig.oauthMailboxId=String\(row.id\)/);
  assert.match(routes,/\$9,\$10,\$10,\$11,'text'/);
});
