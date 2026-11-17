import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {config} from "../src/config.js";
import {pool} from "../src/db.js";
import {googleMailboxToken,registerGoogleMailboxOAuth} from "../src/google-mailbox-oauth.js";
import {decryptAtRest,encryptAtRest,signToken} from "../src/security.js";

const accountId="123e4567-e89b-42d3-a456-426614174000";
const admin={authorization:`Bearer ${signToken({sub:accountId,role:"admin"},config.JWT_SECRET)}`};

test("Google authorization uses Gmail read-only, PKCE, and the configured callback",async t=>{
  const oldId=config.GOOGLE_MAIL_CLIENT_ID,oldSecret=config.GOOGLE_MAIL_CLIENT_SECRET;
  config.GOOGLE_MAIL_CLIENT_ID="google-client";config.GOOGLE_MAIL_CLIENT_SECRET="google-secret";
  t.mock.method(pool,"query",async(sql:string)=>sql.includes("FROM channel_accounts")?{rows:[{}],rowCount:1}:{rows:[],rowCount:1});
  const app=Fastify();registerGoogleMailboxOAuth(app);
  try{
    const response=await app.inject({method:"POST",url:"/api/v1/admin/mailboxes/google/authorize",headers:admin,payload:{accountId,address:"support@gmail.com"}});
    assert.equal(response.statusCode,200,response.body);
    const url=new URL(response.json().url);
    assert.equal(url.hostname,"accounts.google.com");
    assert.equal(url.searchParams.get("scope"),"https://www.googleapis.com/auth/gmail.readonly");
    assert.equal(url.searchParams.get("access_type"),"offline");
    assert.equal(url.searchParams.get("code_challenge_method"),"S256");
    assert.equal(url.searchParams.get("redirect_uri"),new URL("/api/v1/mailboxes/google/callback",config.PUBLIC_API_URL).toString());
    assert.equal(url.searchParams.has("client_secret"),false);
  }finally{config.GOOGLE_MAIL_CLIENT_ID=oldId;config.GOOGLE_MAIL_CLIENT_SECRET=oldSecret;await app.close();}
});

test("Google mailbox refresh token stays encrypted and is refreshed under a row lock",async t=>{
  const statements:string[]=[];
  const oldFetch=globalThis.fetch;
  t.mock.method(pool,"connect",async()=>({query:async(sql:string)=>{
    statements.push(sql);
    if(sql.startsWith("SELECT"))return {rows:[{oauth_refresh_encrypted:encryptAtRest("old-refresh",config.DATA_ENCRYPTION_KEY)}],rowCount:1};
    return {rows:[],rowCount:1};
  },release(){}}));
  globalThis.fetch=async(url)=>{
    assert.equal(String(url),"https://oauth2.googleapis.com/token");
    return Response.json({access_token:"new-access",refresh_token:"rotated-refresh"});
  };
  try{
    assert.equal(await googleMailboxToken("mailbox-id"),"new-access");
    assert.match(statements[1],/enabled AND auth_type='google' FOR UPDATE/);
    assert.equal(statements.at(-1),"COMMIT");
  }finally{globalThis.fetch=oldFetch;}
});

test("Google callback rejects missing or replayed OAuth state",async t=>{
  const oldQuery=pool.query;
  pool.query=(async(sql:string)=>{assert.match(sql,/DELETE FROM mailbox_oauth_states.*expires_at>now\(\).*RETURNING/);return {rows:[],rowCount:0};}) as unknown as typeof pool.query;
  const app=Fastify();registerGoogleMailboxOAuth(app);
  try{
    assert.equal((await app.inject({url:`/api/v1/mailboxes/google/callback?state=${"x".repeat(40)}&code=bad`})).statusCode,400);
    assert.equal((await app.inject({url:"/api/v1/mailboxes/google/callback?code=bad"})).statusCode,400);
  }finally{pool.query=oldQuery;await app.close();}
});

test("Gmail migration enables Google auth and persists label, history, and idempotency state",async()=>{
  const migration=await (await import("node:fs/promises")).readFile(new URL("../../../infra/postgres/migrations/107_google_mailbox_labels.sql",import.meta.url),"utf8");
  assert.match(migration,/CHECK\(auth_type IN \('password','microsoft','google'\)\)/);
  assert.match(migration,/gmail_label_id/);
  assert.match(migration,/gmail_history_id/);
  assert.match(migration,/PRIMARY KEY\(mailbox_id,gmail_message_id\)/);
});
