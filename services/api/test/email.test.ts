import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emailShell, escapeHtml, sanitizeEmailHtml } from "../src/email.js";
import { emailSubjectKey, inboundEmailTimelineTime } from "../src/mailboxes.js";
import { emailProviderSettingsSchema, emailSendSchema } from "../src/schemas.js";

test("email HTML escapes user-controlled content",()=>{
  assert.equal(escapeHtml(`<script>alert("x")</script>\nnext`),"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>next");
  const html=emailShell("Hello <customer>","<strong>trusted generated content</strong>");
  assert.match(html,/Hello &lt;customer&gt;/);
  assert.match(html,/<strong>trusted generated content<\/strong>/);
});

test("email HTML only permits inline attachment CID images",()=>{
  assert.match(sanitizeEmailHtml('<p><img src="cid:attachment-0" alt="Order" style="width:999px"></p>'),/<img src="cid:attachment-0" alt="" style="display:block;max-width:100%;height:auto">/);
  assert.equal(sanitizeEmailHtml('<img src="https://example.com/tracker.png"><img src="javascript:alert(1)"><img data-src="cid:attachment-0">'),"");
});

test("email send input rejects header injection and cross-shape content",()=>{
  const base={clientSendId:"123e4567-e89b-42d3-a456-426614174000",recipientEmailIds:["123e4567-e89b-42d3-a456-426614174001"],messageBody:"Please review"};
  assert.equal(emailSendSchema.safeParse({...base,subject:"Order\nBcc: victim@example.com",content:{type:"order",orderId:"123e4567-e89b-42d3-a456-426614174002",format:"text"}}).success,false);
  assert.equal(emailSendSchema.safeParse({...base,subject:"Products",content:{type:"product_cards",productIds:["123e4567-e89b-42d3-a456-426614174003"],mode:"combined",showPrice:true}}).success,true);
  assert.equal(emailSendSchema.safeParse({...base,subject:"Order",content:{type:"order",orderId:"123e4567-e89b-42d3-a456-426614174002",format:"image",translate:true}}).success,false);
});

test("provider settings validate sender and SMTP transport fields",()=>{
  assert.equal(emailProviderSettingsSchema.safeParse({enabled:true,fromName:"RelayDesk",fromEmail:"sales@example.com",replyTo:"",host:"smtp.example.com",port:587,tls:"starttls",username:"sales@example.com",secret:"secret"}).success,true);
  assert.equal(emailProviderSettingsSchema.safeParse({enabled:true,fromName:"RelayDesk",fromEmail:"not-an-email",replyTo:""}).success,false);
});

test("email queue migration and worker include durability controls",async()=>{
  const [migration,worker,email,migrator]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/032_email_delivery.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/worker.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/email.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/client_send_id uuid UNIQUE NOT NULL/);
  assert.match(migration,/status IN \('queued','sending','retrying','accepted','failed'\)/);
  assert.match(migration,/email_attachments/);
  assert.match(worker,/processOneEmail/);
  assert.match(email,/FOR UPDATE SKIP LOCKED/);
  assert.match(email,/idempotency-key/);
  assert.match(email,/attempt<5/);
  assert.match(migrator,/032_email_delivery\.sql/);
});

test("conversation email tables are included in startup migrations",async()=>{
  const [migration,migrator]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/089_conversation_email.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migrator,/089_conversation_email\.sql/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS account_email_mailboxes/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS message_email_details/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS message_email_attachments/);
});

test("manual mailbox sync uses the same claimed worker path and is admin-only",async()=>{
  const [routes,mailboxes,inbox]=await Promise.all([
    readFile(new URL("../src/mailbox-routes.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/mailboxes.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(routes,/admin\/mailboxes\/:id\/sync/);
  assert.match(routes,/role!=="admin"/);
  assert.match(routes,/syncOneMailbox\(id\)/);
  assert.match(mailboxes,/syncOneMailbox\(mailboxId\?:string\)/);
  assert.match(mailboxes,/FOR UPDATE SKIP LOCKED/);
  assert.match(inbox,/立即同步/);
});

test("email quote details migration is included in startup migrations",async()=>{
  const [migration,migrator]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/090_email_collapsed_quotes.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migrator,/090_email_collapsed_quotes\.sql/);
  assert.match(migration,/ALTER TABLE message_email_details ADD COLUMN IF NOT EXISTS quoted_body text/);
});

test("inline email images appear before collapsed quotes while files remain attachments",async()=>{
  const [migration,migrator,routes,server,inbox]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/093_email_inline_attachments.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/mailbox-routes.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(migrator,/093_email_inline_attachments\.sql/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS is_inline boolean/);
  assert.match(migration,/queued_email\.html_body/);
  assert.match(routes,/content_id,is_inline\) VALUES/);
  assert.match(server,/'inline',a\.is_inline/);
  const inline=inbox.indexOf('aria-label="邮件内嵌图片"');
  const quote=inbox.indexOf("<CollapsedEmailQuote body={message.email.quotedBody}/>");
  const files=inbox.indexOf('aria-label="邮件附件"',quote);
  assert.ok(inline>0&&inline<quote&&quote<files);
  assert.match(inbox,/inline:Boolean\(v\.inline\)/);
});

test("inbound replies stay after their parent despite inaccurate Date headers",()=>{
  const received=new Date("2026-09-29T06:24:00.000Z");
  const parent=new Date("2026-09-29T06:23:00.000Z");
  const early=new Date("2026-09-29T06:22:00.000Z");
  const later=new Date("2026-09-29T06:23:30.000Z");
  assert.equal(inboundEmailTimelineTime(early,parent,received).toISOString(),received.toISOString());
  assert.equal(inboundEmailTimelineTime(later,parent,received).toISOString(),received.toISOString());
  assert.equal(inboundEmailTimelineTime(early,undefined,received).toISOString(),received.toISOString());
  assert.equal(inboundEmailTimelineTime(new Date("invalid"),parent,received).toISOString(),received.toISOString());
});

test("email reply subject matching accepts localized and numbered reply prefixes",()=>{
  assert.equal(emailSubjectKey("Re(3): Re: Test again"),"test again");
  assert.equal(emailSubjectKey("AW: Test again"),"test again");
  assert.equal(emailSubjectKey("Test again"),"test again");
});

test("archived email replies are corrected only for matching messages in the same conversation",async()=>{
  const [migration,migrator,mailboxes]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/092_email_reply_timeline.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/mailboxes.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migrator,/092_email_reply_timeline\.sql/);
  assert.match(migration,/parent\.conversation_id=reply\.conversation_id/);
  assert.match(migration,/detail\.in_reply_to=parent_detail\.rfc_message_id/);
  assert.match(migration,/position\(lower\(parent\.text_content\) IN lower\(COALESCE\(detail\.quoted_body,''\)\)\)>0/);
  assert.match(migration,/reply\.occurred_at<=all_reply_parents\.parent_time/);
  assert.match(mailboxes,/m\.conversation_id=\$1 AND d\.rfc_message_id=ANY/);
  assert.match(mailboxes,/position\(lower\(m\.text_content\) IN lower\(\$3\)\)>0/);
  assert.match(mailboxes,/internalDate:true/);
});
