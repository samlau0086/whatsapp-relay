import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {ImapFlow} from "imapflow";
import nodemailer from "nodemailer";
import {config} from "../src/config.js";
import {pool} from "../src/db.js";
import {registerMailboxRoutes} from "../src/mailbox-routes.js";
import {encryptAtRest,signToken} from "../src/security.js";

const accountId="123e4567-e89b-42d3-a456-426614174000",mailboxId="123e4567-e89b-42d3-a456-426614174001";
const headers={authorization:`Bearer ${signToken({sub:accountId,role:"admin"},config.JWT_SECRET)}`};
const payload={accountId,address:"support@example.com",imapHost:"imap.example.com",imapPort:993,imapUsername:"support",imapPassword:"imap-secret",smtpHost:"smtp.example.com",smtpPort:465,smtpTls:"tls",smtpUsername:"support",smtpPassword:"smtp-secret",isPrimary:true};

test("会话邮箱新增、编辑及 Microsoft 授权支持 WhatsApp 和 Live Chat，拒绝其他渠道",async t=>{
  let platform="livechat";
  const statements:Array<{sql:string;values:unknown[]}>=[];
  const result=(rows:Record<string,unknown>[]=[])=>( {rows,rowCount:rows.length} );
  const query=async(sql:string,values:unknown[]=[])=>{
    statements.push({sql,values});
    if(sql.includes("FROM channel_accounts")){
      assert.equal(values[0],accountId);
      assert.match(sql,/platform IN \('whatsapp','livechat'\)/);
      return result(["whatsapp","livechat"].includes(platform)?[{}]:[]);
    }
    if(sql.startsWith("SELECT auth_type"))return result([{auth_type:"password"}]);
    if(sql.startsWith("SELECT imap_secret"))return result([{imap_secret_encrypted:encryptAtRest("old-imap",config.DATA_ENCRYPTION_KEY),smtp_secret_encrypted:encryptAtRest("old-smtp",config.DATA_ENCRYPTION_KEY)}]);
    if(sql.startsWith("INSERT INTO account_email_mailboxes"))return result([{id:mailboxId}]);
    return result();
  };
  t.mock.method(pool,"query",query);
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  t.mock.method(ImapFlow.prototype,"connect",async()=>{});
  t.mock.method(ImapFlow.prototype,"mailboxOpen",async()=>({uidValidity:1n,uidNext:1}));
  t.mock.method(ImapFlow.prototype,"logout",async()=>{});
  t.mock.method(nodemailer,"createTransport",()=>({verify:async()=>true}));
  const oldId=config.MICROSOFT_MAIL_CLIENT_ID,oldSecret=config.MICROSOFT_MAIL_CLIENT_SECRET;
  config.MICROSOFT_MAIL_CLIENT_ID="test-client";config.MICROSOFT_MAIL_CLIENT_SECRET="test-secret";
  const app=Fastify();registerMailboxRoutes(app);
  try{
    for(platform of ["livechat","whatsapp","messenger","missing"]){
      const supported=["livechat","whatsapp"].includes(platform);
      statements.length=0;
      const created=await app.inject({method:"POST",url:"/api/v1/admin/mailboxes",headers,payload});
      assert.equal(created.statusCode,supported?201:404,created.body);
      if(supported)assert.equal(statements.find(item=>item.sql.startsWith("INSERT INTO account_email_mailboxes"))?.values[0],accountId);
      const updated=await app.inject({method:"PUT",url:`/api/v1/admin/mailboxes/${mailboxId}`,headers,payload:{...payload,imapPassword:"",smtpPassword:""}});
      assert.equal(updated.statusCode,supported?200:404,updated.body);
      if(supported)assert.equal(statements.find(item=>item.sql.startsWith("UPDATE account_email_mailboxes SET account_id"))?.values[1],accountId);
      const authorized=await app.inject({method:"POST",url:"/api/v1/admin/mailboxes/microsoft/authorize",headers,payload:{accountId,address:payload.address}});
      assert.equal(authorized.statusCode,supported?200:404,authorized.body);
      if(supported){
        assert.equal(new URL(authorized.json().url).hostname,"login.microsoftonline.com");
        assert.equal(statements.find(item=>item.sql.startsWith("INSERT INTO mailbox_oauth_states"))?.values[2],accountId);
      }else assert.ok(!statements.some(item=>item.sql.startsWith("INSERT")||item.sql.startsWith("UPDATE")));
    }
    for(const role of ["agent","supervisor"]){
      const denied={authorization:`Bearer ${signToken({sub:accountId,role},config.JWT_SECRET)}`};
      for(const [method,url] of [["POST","/api/v1/admin/mailboxes"],["PUT",`/api/v1/admin/mailboxes/${mailboxId}`],["POST","/api/v1/admin/mailboxes/microsoft/authorize"]] as const){
        assert.equal((await app.inject({method,url,headers:denied,payload})).statusCode,403);
      }
    }
  }finally{config.MICROSOFT_MAIL_CLIENT_ID=oldId;config.MICROSOFT_MAIL_CLIENT_SECRET=oldSecret;await app.close();}
});
