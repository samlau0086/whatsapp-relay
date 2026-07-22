import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { emailShell, escapeHtml } from "../src/email.js";
import { emailProviderSettingsSchema, emailSendSchema } from "../src/schemas.js";

test("email HTML escapes user-controlled content",()=>{
  assert.equal(escapeHtml(`<script>alert("x")</script>\nnext`),"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>next");
  const html=emailShell("Hello <customer>","<strong>trusted generated content</strong>");
  assert.match(html,/Hello &lt;customer&gt;/);
  assert.match(html,/<strong>trusted generated content<\/strong>/);
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
