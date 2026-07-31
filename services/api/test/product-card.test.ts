import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { DEFAULT_PRODUCT_CARD_TEMPLATE, productCardTemplateSchema, renderProductCardCaption } from "../src/product-card-template.js";
import { renderProductCardGrid, renderProductCards } from "../src/product-card-image.js";
import { productCardSendSchema } from "../src/schemas.js";

test("product pricing and card migration is idempotent and enforces active SKU uniqueness",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/024_product_pricing_cards.sql",import.meta.url),"utf8");
  assert.match(migration,/ADD COLUMN IF NOT EXISTS sku/);
  assert.match(migration,/WHERE deleted_at IS NULL/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_price_tiers/);
  assert.match(migration,/ON CONFLICT\(product_id,min_quantity\) DO NOTHING/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_card_settings/);
});

test("product card templates allow optional names and prices but protect SKU and singleton blocks",()=>{
  assert.equal(productCardTemplateSchema.safeParse(DEFAULT_PRODUCT_CARD_TEMPLATE).success,true);
  assert.equal(productCardTemplateSchema.safeParse({...DEFAULT_PRODUCT_CARD_TEMPLATE,blocks:DEFAULT_PRODUCT_CARD_TEMPLATE.blocks.filter(block=>!["productName","priceTiers"].includes(block.type))}).success,true);
  assert.equal(productCardTemplateSchema.safeParse({...DEFAULT_PRODUCT_CARD_TEMPLATE,blocks:DEFAULT_PRODUCT_CARD_TEMPLATE.blocks.filter(block=>block.type!=="sku")}).success,false);
  assert.equal(productCardTemplateSchema.safeParse({...DEFAULT_PRODUCT_CARD_TEMPLATE,blocks:[...DEFAULT_PRODUCT_CARD_TEMPLATE.blocks,{...DEFAULT_PRODUCT_CARD_TEMPLATE.blocks[1],id:"name-2"}]}).success,false);
  assert.equal(renderProductCardCaption({...DEFAULT_PRODUCT_CARD_TEMPLATE,captionTemplate:"Selected {{productCount}}: {{productNames}}" },[{name:"A",sku:"A-1"},{name:"B",sku:"B-1"}]),"Selected 2: A、B");
});

test("product card sends accept complete translated product names and reject partial or foreign mappings",()=>{
  const productIds=["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],base={accountId:"33333333-3333-4333-8333-333333333333",clientBatchId:"batch_12345678",productIds,mode:"individual" as const,showPrice:true};
  assert.equal(productCardSendSchema.safeParse({...base,translationTargetLanguage:"zh-CN",translatedProductNames:productIds.map((productId,index)=>({productId,name:`译名 ${index+1}`}))}).success,true);
  assert.equal(productCardSendSchema.safeParse({...base,translationTargetLanguage:"zh-CN",translatedProductNames:[{productId:productIds[0],name:"译名"}]}).success,false);
  assert.equal(productCardSendSchema.safeParse({...base,translationTargetLanguage:"zh-CN",translatedProductNames:productIds.map(()=>({productId:productIds[0],name:"重复"}))}).success,false);
  assert.equal(productCardSendSchema.safeParse({...base,translationTargetLanguage:"zh-CN",translatedProductNames:[...productIds.map((productId,index)=>({productId,name:`译名 ${index+1}`})),{productId:"44444444-4444-4444-8444-444444444444",name:"越界"}]}).success,false);
});

test("product card sends validate preset and custom grid capacity",()=>{
  const productIds=Array.from({length:5},(_,index)=>`${index+1}1111111-1111-4111-8111-111111111111`),base={accountId:"33333333-3333-4333-8333-333333333333",clientBatchId:"batch_grid_123",productIds,mode:"grid" as const,showPrice:true};
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:2,columns:3}}).success,true);
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:2,columns:2}}).success,false);
  assert.equal(productCardSendSchema.safeParse(base).success,false);
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:11,columns:1}}).success,false);
});

test("product cards render priced, unpriced, and combined PNG output",async()=>{
  const product={name:"高级香水 Premium perfume",sku:"PERFUME-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:49.75},{minQuantity:10,unitAmount:42}],tags:[{name:"Featured"},{name:"Gift"}]};
  const priced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],true),unpriced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],false),combined=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:10},(_,index)=>({...product,sku:`PERFUME-${index+1}`})),true);
  for(const image of [priced,unpriced,combined]){const metadata=await sharp(image).metadata();assert.equal(metadata.format,"png");assert.equal(metadata.width,1080);assert.ok((metadata.height??0)>=720);}
  assert.notEqual(priced.length,unpriced.length);
  assert.ok((await sharp(combined).metadata()).height!>(await sharp(priced).metadata()).height!);
});

test("product cards render a bounded grid collage",async()=>{
  const product={name:"Grid perfume",sku:"GRID-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:25}],tags:[]},grid=await renderProductCardGrid(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:6},(_,index)=>({...product,sku:`GRID-${index+1}`})),true,2,3),metadata=await sharp(grid).metadata();
  assert.equal(metadata.format,"png");assert.equal(metadata.width,2160);assert.ok((metadata.height??0)>720);
  await assert.rejects(()=>renderProductCardGrid(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:5},()=>product),true,2,2),/invalid product card grid/);
});
