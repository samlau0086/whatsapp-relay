import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderTemplateOrderImage } from "../src/order-image.js";
import { renderTemplateOrderPdf } from "../src/order-pdf.js";
import { DEFAULT_IMAGE_ORDER_TEMPLATE, DEFAULT_INQ_ORDER_TEMPLATE, DEFAULT_SC_ORDER_TEMPLATE, DEFAULT_TEXT_ORDER_TEMPLATE, orderTemplateSchema, parseOrderTemplate, parseTranslatedSemanticOrder, renderSemanticOrder, renderTextOrder, serializeSemanticOrder } from "../src/order-template.js";

const context={orderNumber:"20260720-001",businessStatus:"pending_confirmation" as const,currency:"USD",customerName:"Alex",customerPhone:"+8613800000000",description:"Handle *carefully*",items:[{name:"Perfume _limited_",sku:"PERFUME-001",quantity:2,unitAmount:49.75},{name:"Gift box",sku:"GIFT-001",quantity:1,unitAmount:8}],fees:[{name:"Shipping",amount:6.5}],address:{recipientName:"Alex",phone:"+8613800000000",address:"88 Market Street"}};

test("template validation protects core blocks and variables",()=>{
  assert.equal(orderTemplateSchema.safeParse(DEFAULT_TEXT_ORDER_TEMPLATE).success,true);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"},{id:"total",type:"total"},{id:"again",type:"total"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"},{id:"total",type:"total"},{id:"custom",type:"customText",text:"{{unknown}}"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"},{id:"total",type:"total"},{id:"custom",type:"customText",text:"{{orderNumber"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList",itemTemplate:"{{unknown}}"},{id:"total",type:"total"},{id:"payment",type:"paymentSummary"}]}).success,false);
});

test("item templates render every supported product variable",()=>{
  const template=structuredClone(DEFAULT_TEXT_ORDER_TEMPLATE),items=template.blocks.find(block=>block.type==="itemList")!;
  items.itemTemplate="{{index}} | {{title}} | {{sku}} | {{brand}} | {{category}} | {{description}} | {{quantity}} | {{price}} | {{subtotal}}";
  const block=renderSemanticOrder(template,{...context,items:[{...context.items[0],brand:"Lumière",category:"Fragrance",description:"Eau de parfum"},{...context.items[1],brand:"Lumière",category:"Packaging",description:"Gift-ready box"}]}).find(item=>item.type==="itemList")!;
  assert.equal(block.lines[1],"1 | Perfume _limited_ | PERFUME-001 | Lumière | Fragrance | Eau de parfum | 2 | USD 49.75 | USD 99.50");
  assert.equal(block.lines[2],"2 | Gift box | GIFT-001 | Lumière | Packaging | Gift-ready box | 1 | USD 8.00 | USD 8.00");
});

test("order headers use the configured label for each business status",()=>{
  const template=structuredClone(DEFAULT_TEXT_ORDER_TEMPLATE),header=template.blocks.find(block=>block.type==="orderHeader")!;
  header.statusLabels={...header.statusLabels,quotation:"Quote",paid:"Receipt"};
  assert.equal(renderSemanticOrder(template,{...context,businessStatus:"quotation"})[0].lines[0],"Quote #20260720-001");
  assert.equal(renderSemanticOrder(template,{...context,businessStatus:"paid"})[0].lines[0],"Receipt #20260720-001");
});

test("semantic and WhatsApp rendering follow order and hide empty optional blocks",()=>{
  const blocks=renderSemanticOrder(DEFAULT_TEXT_ORDER_TEMPLATE,{...context,fees:[],description:""});
  assert.deepEqual(blocks.map(block=>block.type),["orderHeader","itemList","total"]);
  const text=renderTextOrder(DEFAULT_TEXT_ORDER_TEMPLATE,blocks);
  assert.match(text,/^\*Order #20260720-001\*/);
  assert.match(text,/Perfume _\u200blimited_\u200b/);
  assert.match(text,/\*Total: USD 107\.50\*/);
});

test("contact information blocks render selected populated profile fields",()=>{
  const template={version:1 as const,blocks:[{id:"items",type:"itemList" as const},{id:"contact",type:"contactInfo" as const,label:"Buyer:",contactFields:["name","firstName","lastName","company","location","email","phone"]},{id:"total",type:"total" as const},{id:"payment",type:"paymentSummary" as const}]};
  assert.equal(orderTemplateSchema.safeParse(template).success,true);
  const contact=renderSemanticOrder(template,{...context,contact:{firstName:"Alex",lastName:"Chen",companyName:"Acme Trading",country:"China",city:"Shanghai",email:"alex@example.com"}}).find(block=>block.type==="contactInfo");
  assert.deepEqual(contact?.lines,["Buyer:","Name: Alex","First name: Alex","Last name: Chen","Company: Acme Trading","Location: China, Shanghai","Email: alex@example.com","Phone: +8613800000000"]);
});

test("SC templates include a contact information block by default",()=>{
  const contact=DEFAULT_SC_ORDER_TEMPLATE.blocks.find(block=>block.type==="contactInfo");
  assert.ok(contact);
  assert.deepEqual(contact.contactFields,["name","firstName","lastName","company","location","email","phone"]);
});

test("INQ templates default to a procurement list without pricing summaries",()=>{
  const types=DEFAULT_INQ_ORDER_TEMPLATE.blocks.map(block=>block.type);
  assert.equal(types.includes("feeList"),false);
  assert.equal(types.includes("total"),false);
  assert.equal(types.includes("paymentSummary"),false);
  const legacy=parseOrderTemplate({version:1,blocks:[{id:"items",type:"itemList"}]},"inq");
  assert.equal(legacy.blocks.some(block=>block.type==="paymentSummary"),false);
  assert.equal(legacy.blocks.some(block=>block.type==="total"),false);
});

test("translation markers round-trip and reject damaged output",()=>{
  const source=renderSemanticOrder(DEFAULT_TEXT_ORDER_TEMPLATE,context),serialized=serializeSemanticOrder(source);
  assert.deepEqual(parseTranslatedSemanticOrder(serialized,source),source);
  assert.throws(()=>parseTranslatedSemanticOrder(serialized.replace("[[/ORDER_BLOCK:items]]",""),source),/markers_invalid/);
});

test("structured image templates render dynamic-height PNG output",async()=>{
  const red=await sharp({create:{width:20,height:20,channels:3,background:"#d22"}}).png().toBuffer(),blocks=renderSemanticOrder(DEFAULT_IMAGE_ORDER_TEMPLATE,context);
  const png=await renderTemplateOrderImage(DEFAULT_IMAGE_ORDER_TEMPLATE,blocks,[{name:"Perfume",image:red},{name:"Gift box",image:red}]),metadata=await sharp(png).metadata();
  assert.equal(metadata.format,"png");assert.equal(metadata.width,1080);assert.ok((metadata.height??0)>=720);
});

test("INQ image renderer separates grouped items with rounded frames",async()=>{
  const template={...DEFAULT_INQ_ORDER_TEMPLATE,blocks:DEFAULT_INQ_ORDER_TEMPLATE.blocks.map(block=>block.type==="itemList"?{...block,groupBy:"brand" as const}:block)},blocks=renderSemanticOrder(template,{...context,items:[{...context.items[0],brand:"Lumière"},{...context.items[1],brand:"Maison"}]}),plain=await renderTemplateOrderImage(template,blocks,[]),grouped=await renderTemplateOrderImage(template,blocks,[],{groupItemsWithRoundedFrames:true});
  assert.notDeepEqual(grouped,plain);
  assert.ok((await sharp(grouped).metadata()).height);
});
test("PDF order templates produce a valid PDF containing the rendered order",async()=>{
  const red=await sharp({create:{width:20,height:20,channels:3,background:"#d22"}}).png().toBuffer(),blocks=renderSemanticOrder(DEFAULT_IMAGE_ORDER_TEMPLATE,context);
  const pdf=await renderTemplateOrderPdf(DEFAULT_IMAGE_ORDER_TEMPLATE,blocks,[{name:"Perfume",image:red},{name:"Gift box",image:red}]);
  assert.equal(pdf.subarray(0,5).toString(),"%PDF-");
  assert.ok(pdf.length>1000);
});
