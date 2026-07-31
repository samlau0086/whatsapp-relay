import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { orderSchema, productCreateSchema, shippingQuoteSchema, shippingTemplateCreateSchema } from "../src/schemas.js";
import { calculateShipping, convertShippingCurrency } from "../src/shipping.js";

test("quantity shipping groups classes and applies default fallbacks",()=>{
  const result=calculateShipping([
    {name:"A",quantity:2,shippingClassId:"heavy",shippingClassName:"Heavy"},
    {name:"B",quantity:1,shippingClassId:"heavy",shippingClassName:"Heavy"},
    {name:"C",quantity:2,shippingClassId:"standard",shippingClassName:"Standard"},
    {name:"D",quantity:1},
  ],{mode:"quantity",firstItemPrice:5,additionalItemPrice:2},[
    {shippingClassId:"heavy",shippingClassName:"Heavy",rule:{mode:"quantity",firstItemPrice:10,additionalItemPrice:3}},
  ]);
  assert.equal(result.ok,true);
  if(result.ok){
    assert.equal(result.amount,28);
    assert.deepEqual(result.breakdown.map(item=>item.amount),[16,7,5]);
  }
});

test("weight shipping converts units and rounds additional bands upward",()=>{
  const result=calculateShipping([
    {name:"A",quantity:2,weightAmount:400,weightUnit:"g"},
    {name:"B",quantity:1,weightAmount:0.3,weightUnit:"kg"},
  ],{mode:"weight",firstWeight:1,additionalWeight:.5,weightUnit:"kg",firstWeightPrice:8,additionalWeightPrice:3},[]);
  assert.equal(result.ok,true);
  if(result.ok){
    assert.equal(result.breakdown[0].weightAmount,1.1);
    assert.equal(result.amount,11);
  }
});

test("weight shipping reports every missing product and returns no partial quote",()=>{
  const result=calculateShipping([
    {name:"Missing A",quantity:1},
    {name:"Ready",quantity:1,weightAmount:1,weightUnit:"kg"},
    {name:"Missing B",quantity:2,weightAmount:null,weightUnit:null},
  ],{mode:"weight",firstWeight:1,additionalWeight:1,weightUnit:"kg",firstWeightPrice:5,additionalWeightPrice:2},[]);
  assert.deepEqual(result,{ok:false,missingWeightItems:[{index:0,name:"Missing A"},{index:2,name:"Missing B"}]});
});

test("shipping currency conversion rounds the final order amount",()=>{
  assert.equal(convertShippingCurrency(10,7.2,1),1.39);
  assert.throws(()=>convertShippingCurrency(10,0,1),/invalid_currency_rate/);
});

test("shipping schemas enforce one default rule and extend products and orders",()=>{
  const classId="10000000-0000-4000-8000-000000000001",templateId="20000000-0000-4000-8000-000000000002";
  assert.equal(shippingTemplateCreateSchema.safeParse({name:"Default",currency:"USD",enabled:true,isDefault:true,rules:[{shippingClassId:null,mode:"quantity",firstItemPrice:5,additionalItemPrice:2},{shippingClassId:classId,mode:"weight",firstWeight:1,additionalWeight:.5,weightUnit:"kg",firstWeightPrice:10,additionalWeightPrice:3}]}).success,true);
  assert.equal(shippingTemplateCreateSchema.safeParse({name:"Broken",currency:"USD",enabled:true,isDefault:false,rules:[{shippingClassId:classId,mode:"quantity",firstItemPrice:5,additionalItemPrice:2}]}).success,false);
  assert.equal(shippingQuoteSchema.safeParse({templateId,currency:"USD",items:[{name:"Bag",quantity:2,weightAmount:1,weightUnit:"kg",shippingClassId:classId}]}).success,true);
  assert.equal(productCreateSchema.safeParse({clientProductId:templateId,name:"Bag",sku:"B-1",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:10}],shippingClassId:classId}).success,true);
  assert.equal(orderSchema.safeParse({clientOrderId:templateId,currency:"USD",items:[{name:"Bag",quantity:1,unitAmount:10,shippingClassId:classId}],shippingAmount:3,shippingTemplateId:templateId,acceptCalculatedShipping:true}).success,true);
});

test("shipping migration, routes, snapshots, and startup migration are wired",async()=>{
  const [migration,routes,server,startup]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/058_shipping_templates.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/shipping-routes.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS shipping_classes/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS shipping_templates/);
  assert.match(migration,/shipping_quote_snapshot jsonb/);
  assert.match(routes,/\/api\/v1\/shipping\/quotes/);
  assert.match(routes,/calculateShippingQuote/);
  assert.match(server,/acceptCalculatedShipping/);
  assert.match(server,/shipping_class_name/);
  assert.match(startup,/058_shipping_templates\.sql/);
});
