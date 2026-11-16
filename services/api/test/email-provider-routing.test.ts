import assert from "node:assert/strict";
import test from "node:test";
import type {Pool} from "pg";
import {mailboxEmailTransport,resolveEmailProvider,type SelectedEmailProvider} from "../src/email-provider-routing.js";

const selected:SelectedEmailProvider={id:"instance-a",provider:"resend",config:{fromName:"销售",fromEmail:"sales@example.com"},secret_encrypted:"encrypted-provider",explicit:true};
const mailbox={id:"mailbox-a",address:"support@example.com",display_name:"客服",auth_type:"microsoft",smtp_host:"smtp.example.com",smtp_port:587,smtp_tls:"starttls",smtp_username:"support",smtp_secret_encrypted:"encrypted-mailbox"};

test("显式绑定始终使用指定实例，Reply-To 保持邮箱关联",()=>{
  for(const provider of ["smtp","resend"] as const){
    const transport=mailboxEmailTransport(mailbox,{...selected,provider},true);
    assert.equal(transport.provider,provider);
    assert.equal(transport.secret,selected.secret_encrypted);
    assert.equal(transport.config.fromEmail,"sales@example.com");
    assert.equal(transport.config.replyTo,mailbox.address);
    assert.equal(transport.config.oauthMailboxId,undefined);
  }
  assert.equal(mailboxEmailTransport(mailbox,{...selected,config:{...selected.config,replyTo:"replies@example.com"}}).config.replyTo,"replies@example.com");
});

test("未绑定的主动邮件保留 OAuth 与发件地址回退",()=>{
  const fallback=mailboxEmailTransport(mailbox,{...selected,explicit:false},true);
  assert.equal(fallback.provider,"smtp");assert.equal(fallback.config.oauthMailboxId,mailbox.id);
  assert.equal(fallback.secret,mailbox.smtp_secret_encrypted);
  const passwordMailbox={...mailbox,auth_type:"password"};
  assert.equal(mailboxEmailTransport(passwordMailbox,{...selected,explicit:false},true).config.fromEmail,mailbox.address);
  assert.equal(mailboxEmailTransport(passwordMailbox,{...selected,explicit:false,config:{...selected.config,fromEmail:mailbox.address}},true).provider,"resend");
  assert.equal(mailboxEmailTransport(mailbox,null).config.oauthMailboxId,mailbox.id);
});

test("绑定不可用时明确拒绝，未绑定无默认时允许调用方回退",async()=>{
  const db=(bound:boolean)=>({query:async(sql:string,values:unknown[])=>{
    assert.deepEqual(values,["channel-a"]);
    const rows=sql.startsWith("SELECT provider_id")&&bound?[{provider_id:"disabled"}]:[];
    return {rows,rowCount:rows.length};
  }}) as unknown as Pick<Pool,"query">;
  assert.equal(await resolveEmailProvider(db(false),"channel-a"),null);
  await assert.rejects(resolveEmailProvider(db(true),"channel-a"),{message:"channel_email_provider_unavailable",statusCode:409});
});
