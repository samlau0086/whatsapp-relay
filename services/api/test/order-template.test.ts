import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderTemplateOrderImage } from "../src/order-image.js";
import { DEFAULT_IMAGE_ORDER_TEMPLATE, DEFAULT_TEXT_ORDER_TEMPLATE, orderTemplateSchema, parseTranslatedSemanticOrder, renderSemanticOrder, renderTextOrder, serializeSemanticOrder } from "../src/order-template.js";

const context={orderNumber:"20260720-001",currency:"USD",customerName:"Alex",customerPhone:"+8613800000000",description:"Handle *carefully*",items:[{name:"Perfume _limited_",quantity:2,unitAmount:49.75},{name:"Gift box",quantity:1,unitAmount:8}],fees:[{name:"Shipping",amount:6.5}],address:{recipientName:"Alex",phone:"+8613800000000",address:"88 Market Street"}};

test("template validation protects core blocks and variables",()=>{
  assert.equal(orderTemplateSchema.safeParse(DEFAULT_TEXT_ORDER_TEMPLATE).success,true);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"},{id:"total",type:"total"},{id:"again",type:"total"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"},{id:"total",type:"total"},{id:"custom",type:"customText",text:"{{unknown}}"}]}).success,false);
  assert.equal(orderTemplateSchema.safeParse({version:1,blocks:[{id:"items",type:"itemList"},{id:"total",type:"total"},{id:"custom",type:"customText",text:"{{orderNumber"}]}).success,false);
});

test("semantic and WhatsApp rendering follow order and hide empty optional blocks",()=>{
  const blocks=renderSemanticOrder(DEFAULT_TEXT_ORDER_TEMPLATE,{...context,fees:[],description:""});
  assert.deepEqual(blocks.map(block=>block.type),["orderHeader","itemList","total"]);
  const text=renderTextOrder(DEFAULT_TEXT_ORDER_TEMPLATE,blocks);
  assert.match(text,/^\*Order #20260720-001\*/);
  assert.match(text,/Perfume _\u200blimited_\u200b/);
  assert.match(text,/\*Total: USD 107\.50\*/);
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
