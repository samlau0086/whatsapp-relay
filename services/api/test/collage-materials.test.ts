import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { collageTemplateSchema, DEFAULT_COLLAGE_TEMPLATE, productSlotIds } from "../src/collage-template.js";
import { renderCollagePage } from "../src/collage-image.js";

test("collage migration creates template, batch, and material asset records",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/033_collage_materials.sql",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE IF NOT EXISTS collage_templates/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS material_batches/);
  assert.match(migration,/client_generation_id uuid UNIQUE NOT NULL/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS material_assets/);
});

test("collage template validation protects canvas, slots, and bindings",()=>{
  assert.equal(collageTemplateSchema.safeParse(DEFAULT_COLLAGE_TEMPLATE).success,true);
  assert.equal(productSlotIds(DEFAULT_COLLAGE_TEMPLATE).length,4);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,canvas:{...DEFAULT_COLLAGE_TEMPLATE.canvas,width:4096,height:4096}}).success,false);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,layers:DEFAULT_COLLAGE_TEMPLATE.layers.filter(layer=>layer.type!=="productImage")}).success,false);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,layers:[...DEFAULT_COLLAGE_TEMPLATE.layers,{...DEFAULT_COLLAGE_TEMPLATE.layers[0],id:DEFAULT_COLLAGE_TEMPLATE.layers[0].id}]}).success,false);
  const brokenBinding=structuredClone(DEFAULT_COLLAGE_TEMPLATE);const text=brokenBinding.layers.find(layer=>layer.type==="productText");if(text&&text.type==="productText")text.slotId="missing";
  assert.equal(collageTemplateSchema.safeParse(brokenBinding).success,false);
});

test("collage renderer produces fixed-size PNG and hides empty product slots",async()=>{
  const productImage=await sharp({create:{width:320,height:500,channels:4,background:"#d45555"}}).png().toBuffer(),product={id:"p1",name:"测试产品 Premium",sku:"SKU-1",currency:"USD",defaultUnitAmount:49.9,priceTiers:[{minQuantity:1,unitAmount:49.9},{minQuantity:10,unitAmount:39.9}],tags:[{name:"新品"}],image:productImage};
  const one=await renderCollagePage(DEFAULT_COLLAGE_TEMPLATE,[product]),four=await renderCollagePage(DEFAULT_COLLAGE_TEMPLATE,Array.from({length:4},(_,index)=>({...product,id:`p${index}`,sku:`SKU-${index}`})));
  for(const image of [one,four]){const metadata=await sharp(image).metadata();assert.equal(metadata.format,"png");assert.equal(metadata.width,1080);assert.equal(metadata.height,1080);}
  assert.notEqual(one.length,four.length);
});
