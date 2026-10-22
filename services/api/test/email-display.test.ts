import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {simpleParser} from "mailparser";
import type {ImapFlow} from "imapflow";
import {sanitizeEmailDisplayHtml,normalizeEmailCid} from "../src/email-display.js";
import {restoreArchivedEmailHtml} from "../src/mailboxes.js";
import {pool} from "../src/db.js";

const richEmail=`<html><head><style>@media(max-width:600px){.card{width:100%}} .cta{background:#ff6633;color:#fff}</style></head><body bgcolor="#f5f5f5"><table role="presentation" width="100%" cellspacing="0"><tr><td align="center"><table class="card" width="600" style="background:#fff;border-top:8px solid #f90"><tr><td style="padding:32px"><img src="https://example.com/logo.png" width="200"><p><strong>Update required</strong></p><a class="cta" href="https://example.com/download" style="display:inline-block;padding:12px 24px;border-radius:24px">Download client</a></td></tr></table></td></tr></table></body></html>`;

test("rich email preserves layout, inline CSS, responsive CSS and remote logos",()=>{
  const html=sanitizeEmailDisplayHtml(richEmail);
  assert.match(html,/<table[^>]+width="600"/);
  assert.match(html,/border-top:8px solid #f90/);
  assert.match(html,/@media\(max-width:600px\)/);
  assert.match(html,/<img src="https:\/\/example.com\/logo.png" width="200"/);
  assert.match(html,/class="cta"[^>]*padding:12px 24px/);
  assert.match(html,/target="_blank" rel="noopener noreferrer"/);
  assert.match(html,/<body bgcolor="#f5f5f5">/);
});

test("display sanitizer removes active content and whole nested quote subtrees",()=>{
  const html=sanitizeEmailDisplayHtml(`<script>alert(1)</script><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input name="password"></form><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><img src="javascript:alert(1)" onerror="alert(1)"><a href="java&#x73;cript:alert(1)">bad</a><div class="gmail_quote"><div><b>old reply</b></div>old footer</div><p>new reply</p>`);
  assert.doesNotMatch(html,/script|iframe|form|input|meta|<base|onerror|javascript|old reply|old footer/i);
  assert.match(html,/<p>new reply<\/p>/);
});

const mime=Buffer.from([
  "From: Cloud <news@example.com>","To: inbox@example.com","Message-ID: <original@example.com>",
  "Subject: Example","MIME-Version: 1.0",'Content-Type: multipart/related; boundary="boundary"',"",
  "--boundary","Content-Type: text/html; charset=utf-8","",'<table><tr><td><img src="cid:logo@example.com"><b>Hello</b></td></tr></table>',
  "--boundary","Content-Type: image/png",'Content-Disposition: inline; filename="logo.png"',"Content-ID: <logo@example.com>","Content-Transfer-Encoding: base64","","aW1hZ2U=","--boundary--","",
].join("\r\n"));

test("MIME parsing retains CID references instead of replacing them with stripped data URLs",async()=>{
  const parsed=await simpleParser(mime,{skipImageLinks:true});
  assert.match(sanitizeEmailDisplayHtml(String(parsed.html)),/src="cid:logo@example.com"/);
  assert.equal(normalizeEmailCid(parsed.attachments[0].contentId||""),"logo@example.com");
});

test("historical repair restores HTML and matches images by digest without reinserting messages or moving cursors",async t=>{
  const queries:Array<{sql:string;values:unknown[]}>=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    queries.push({sql,values});
    if(sql.startsWith("SELECT d.message_id"))return {rows:[{message_id:"message-1",uid:42,rfc_message_id:"<original@example.com>"}]};
    if(sql.startsWith("SELECT a.media_id"))return {rows:[{media_id:"media-1",sha256:createHash("sha256").update("image").digest("hex")}]};
    return {rows:[]};
  };
  t.mock.method(pool,"query",query);
  t.mock.method(pool,"connect",async()=>({query,release(){}}));
  const imap={async fetchOne(uid:string,_options:unknown,flags:{uid:boolean}){assert.equal(uid,"42");assert.equal(flags.uid,true);return {source:mime};}} as unknown as ImapFlow;
  await restoreArchivedEmailHtml(imap,{id:"mailbox-1"},"validity-1");
  assert.deepEqual(queries[0].values,["mailbox-1","validity-1"]);
  assert.match(queries[0].sql,/r.uid_validity=\$2/);
  const htmlUpdate=queries.find(value=>value.sql.startsWith("UPDATE message_email_details SET html_body"));
  assert.match(String(htmlUpdate?.values[1]),/<table>/);
  assert.deepEqual(queries.find(value=>value.sql.startsWith("UPDATE message_email_attachments"))?.values,["message-1","media-1","logo@example.com",true]);
  assert.equal(queries.at(-1)?.sql,"COMMIT");
  assert.ok(queries.every(value=>!/^INSERT|last_uid|UPDATE conversations/.test(value.sql)));
});

test("historical repair keeps text when the original is no longer in the mailbox",async t=>{
  const queries:string[]=[];
  t.mock.method(pool,"query",async(sql:string)=>{queries.push(sql);return {rows:sql.startsWith("SELECT")?[{message_id:"missing",uid:43}]:[]};});
  await restoreArchivedEmailHtml({async fetchOne(){return false;}} as unknown as ImapFlow,{id:"mailbox-1"},"validity-1");
  assert.match(queries[1],/SET html_render_version=-1/);
  assert.ok(queries.every(value=>!value.includes("SET html_body")));
});
