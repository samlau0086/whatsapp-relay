import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { COLLAGE_TEMPLATE_PRODUCT_LIMIT, collageTemplateSchema, DEFAULT_COLLAGE_TEMPLATE, materialGenerateSchema, productSlotIds } from "../src/collage-template.js";
import { renderCollagePage } from "../src/collage-image.js";

test("collage migration creates template, batch, and material asset records",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/033_collage_materials.sql",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE IF NOT EXISTS collage_templates/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS material_batches/);
  assert.match(migration,/client_generation_id uuid UNIQUE NOT NULL/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS material_assets/);
});

test("collage generation dialog loads selections larger than one 64-item product page in batches",async()=>{
  const dialog=await readFile(new URL("../../../app/collage-materials.tsx",import.meta.url),"utf8");
  assert.match(dialog,/PRODUCT_SELECTION_BATCH_SIZE=50/);
  assert.match(dialog,/MAX_TEMPLATE_PRODUCT_SLOTS=128/);
  assert.match(dialog,/rows\*columns>MAX_TEMPLATE_PRODUCT_SLOTS/);
  assert.match(dialog,/productIds\.slice\(start,start\+PRODUCT_SELECTION_BATCH_SIZE\)/);
  assert.match(dialog,/productBodies\.flatMap\(body=>body\.data\)/);
});

test("collage generation accepts up to 128 products",()=>{
  const productIds=Array.from({length:129},(_,index)=>`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`);
  const payload={clientGenerationId:"00000000-0000-4000-8000-000000000999",name:"128 products",templateId:"00000000-0000-4000-8000-000000000998"};
  assert.equal(materialGenerateSchema.safeParse({...payload,productIds:productIds.slice(0,128)}).success,true);
  assert.equal(materialGenerateSchema.safeParse({...payload,productIds}).success,false);
});

test("collage template validation protects canvas, slots, and bindings",()=>{
  assert.equal(collageTemplateSchema.safeParse(DEFAULT_COLLAGE_TEMPLATE).success,true);
  assert.equal(productSlotIds(DEFAULT_COLLAGE_TEMPLATE).length,4);
  const legacyTemplate=structuredClone(DEFAULT_COLLAGE_TEMPLATE) as typeof DEFAULT_COLLAGE_TEMPLATE&{canvas:{padding?:number}};delete legacyTemplate.canvas.padding;
  const legacyResult=collageTemplateSchema.safeParse(legacyTemplate);assert.equal(legacyResult.success,true);if(legacyResult.success)assert.equal(legacyResult.data.canvas.padding,48);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,canvas:{...DEFAULT_COLLAGE_TEMPLATE.canvas,padding:540}}).success,false);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,canvas:{...DEFAULT_COLLAGE_TEMPLATE.canvas,width:4096,height:4096}}).success,false);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,layers:DEFAULT_COLLAGE_TEMPLATE.layers.filter(layer=>layer.type!=="productImage")}).success,false);
  assert.equal(collageTemplateSchema.safeParse({...DEFAULT_COLLAGE_TEMPLATE,layers:[...DEFAULT_COLLAGE_TEMPLATE.layers,{...DEFAULT_COLLAGE_TEMPLATE.layers[0],id:DEFAULT_COLLAGE_TEMPLATE.layers[0].id}]}).success,false);
  const brokenBinding=structuredClone(DEFAULT_COLLAGE_TEMPLATE);const text=brokenBinding.layers.find(layer=>layer.type==="productText");if(text&&text.type==="productText")text.slotId="missing";
  assert.equal(collageTemplateSchema.safeParse(brokenBinding).success,false);
});

test("collage templates support up to 128 product slots",()=>{
  const makeLayers=(count:number)=>Array.from({length:count},(_,index)=>{
    const slotId=`slot-${index+1}`,x=(index%16)*20,y=Math.floor(index/16)*40;
    return [
      {id:`image-${index+1}`,type:"productImage" as const,slotId,x,y,width:16,height:16,rotation:0,opacity:1,fit:"cover" as const,radius:0,backgroundColor:"#FFFFFF"},
      {id:`name-${index+1}`,type:"productText" as const,slotId,binding:"name" as const,x,y:y+16,width:16,height:16,rotation:0,opacity:1,prefix:"",suffix:"",fontSize:8,fontWeight:"normal" as const,color:"#111111",align:"left" as const},
    ];
  }).flat();
  const template={version:1 as const,canvas:{width:320,height:320,padding:0,backgroundColor:"#FFFFFF",backgroundMediaId:null},layers:makeLayers(COLLAGE_TEMPLATE_PRODUCT_LIMIT)};
  assert.equal(collageTemplateSchema.safeParse(template).success,true);
  assert.equal(collageTemplateSchema.safeParse({...template,layers:makeLayers(COLLAGE_TEMPLATE_PRODUCT_LIMIT+1)}).success,false);
});

test("collage renderer produces fixed-size PNG and hides empty product slots",async()=>{
  const productImage=await sharp({create:{width:320,height:500,channels:4,background:"#d45555"}}).png().toBuffer(),product={id:"p1",name:"测试产品 Premium",sku:"SKU-1",currency:"USD",defaultUnitAmount:49.9,priceTiers:[{minQuantity:1,unitAmount:49.9},{minQuantity:10,unitAmount:39.9}],tags:[{name:"新品"}],image:productImage};
  const one=await renderCollagePage(DEFAULT_COLLAGE_TEMPLATE,[product]),four=await renderCollagePage(DEFAULT_COLLAGE_TEMPLATE,Array.from({length:4},(_,index)=>({...product,id:`p${index}`,sku:`SKU-${index}`})));
  for(const image of [one,four]){const metadata=await sharp(image).metadata();assert.equal(metadata.format,"png");assert.equal(metadata.width,1080);assert.equal(metadata.height,1080);}
  assert.notEqual(one.length,four.length);
});
