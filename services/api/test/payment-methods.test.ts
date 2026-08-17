import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { orderSchema, paymentMethodCreateSchema, paymentProfileCreateSchema, paymentProfileUpdateSchema, paymentSendSchema } from "../src/schemas.js";
import { parseOrderTemplate, renderSemanticOrder } from "../src/order-template.js";

test("accepts the built-in payment method catalog and custom methods",()=>{
  for(const type of ["paypal","bank_transfer","western_union","wise","moneygram","stripe_payment_link","custom"]){
    assert.equal(paymentMethodCreateSchema.safeParse({type,name:type,enabled:true,sortOrder:0}).success,true);
  }
  assert.equal(paymentMethodCreateSchema.safeParse({type:"unknown",name:"Unknown"}).success,false);
});

test("validates order profile selection and idempotent payment sends",()=>{
  const order=orderSchema.safeParse({clientOrderId:"6fd86e89-343c-4c30-9a91-174f94415ab8",currency:"USD",paymentProfileId:"6317c536-8bc0-4b12-8d73-26d10b79ecaf",items:[{name:"Item",quantity:1,unitAmount:10}],fees:[]});
  assert.equal(order.success,true);
  assert.equal(paymentSendSchema.safeParse({clientSendId:"1dd88bbf-94dd-4470-8914-89ae9434e183"}).success,true);
  assert.equal(paymentProfileCreateSchema.safeParse({name:"HSBC USD",publicFields:[{label:"SWIFT",value:"HSBCHKHH"}],instructions:"Use {{orderNumber}}"}).success,true);
});

test("accepts explicit PayPal profile environment switches",()=>{
  assert.equal(paymentProfileUpdateSchema.safeParse({environment:"sandbox"}).success,true);
  assert.equal(paymentProfileUpdateSchema.safeParse({environment:"live"}).success,true);
  assert.equal(paymentProfileUpdateSchema.safeParse({environment:"production"}).success,false);
});

test("normalizes legacy order templates and conditionally renders payment summaries",()=>{
  const legacy={version:1 as const,blocks:[{id:"items",type:"itemList" as const,label:"Items:"},{id:"total",type:"total" as const,label:"Total:"}]};
  const template=parseOrderTemplate(legacy,"text");
  assert.equal(template.blocks.some(block=>block.type==="paymentSummary"),true);
  const base={orderNumber:"001",currency:"USD",customerName:"Sam",customerPhone:"",description:"",items:[{name:"Item",quantity:1,unitAmount:10}],fees:[]};
  assert.equal(renderSemanticOrder(template,{...base,paymentProfile:null}).some(block=>block.type==="paymentSummary"),false);
  const rendered=renderSemanticOrder(template,{...base,paymentProfile:{summary:"Bank Transfer · HSBC USD"}});
  assert.deepEqual(rendered.find(block=>block.type==="paymentSummary")?.lines,["Payment: Bank Transfer · HSBC USD"]);
});

test("migration and routes preserve snapshots and isolate PayPal profiles",async()=>{
  const [migration,server,module]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/042_payment_methods_profiles.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/payment-methods.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS payment_methods/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS payment_profiles/);
  assert.match(migration,/payment_profile_snapshot jsonb/);
  assert.match(migration,/legacy_paypal_default/);
  assert.match(server,/\/api\/v1\/orders\/:orderId\/payment-send/);
  assert.match(server,/\/api\/v1\/orders\/:orderId\/payment-request\/send[\s\S]*paymentSendSchema\.safeParse\(request\.body\)/);
  assert.match(server,/paypal:\$\{row\.payment_request_id\}:\$\{parsed\.data\.clientSendId\}/);
  assert.match(server,/resolvePaymentProfile\(client,parsed\.data\.paymentProfileId\)/);
  assert.match(module,/sandbox_client_id_encrypted/);
  assert.match(module,/live_client_id_encrypted/);
  assert.match(module,/requiredEnvironment\?\?row\.environment/);
  assert.match(module,/environment==="sandbox"\?row\.sandbox_client_id_encrypted:row\.live_client_id_encrypted/);
  assert.doesNotMatch(module,/clientSecret:String/);
});
