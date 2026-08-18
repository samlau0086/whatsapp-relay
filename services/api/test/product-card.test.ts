import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { DEFAULT_PRODUCT_CARD_TEMPLATE, productCardTemplateSchema, renderProductCardCaption } from "../src/product-card-template.js";
import { renderProductCardGrid, renderProductCardGridPages, renderProductCardGridPdf, renderProductCards } from "../src/product-card-image.js";
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
  const translatedTemplate={...DEFAULT_PRODUCT_CARD_TEMPLATE,blocks:DEFAULT_PRODUCT_CARD_TEMPLATE.blocks.map(block=>block.id==="prices"?{...block,label:"价格"}:block)};
  assert.equal(productCardSendSchema.safeParse({...base,translationTargetLanguage:"zh-CN",translatedTemplate}).success,true);
  assert.equal(productCardSendSchema.safeParse({...base,translatedTemplate}).success,false);
});

test("product card sends accept automatic grid pagination",()=>{
  const productIds=Array.from({length:5},(_,index)=>`${index+1}1111111-1111-4111-8111-111111111111`),base={accountId:"33333333-3333-4333-8333-333333333333",clientBatchId:"batch_grid_123",productIds,mode:"grid" as const,showPrice:true};
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:2,columns:3}}).success,true);
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:2,columns:2}}).success,true);
  assert.equal(productCardSendSchema.safeParse(base).success,false);
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:11,columns:1}}).success,false);
  assert.equal(productCardSendSchema.safeParse({...base,grid:{rows:2,columns:2},gridOutputFormat:"pdf"}).success,true);
  assert.equal(productCardSendSchema.safeParse({...base,mode:"individual",grid:undefined,gridOutputFormat:"pdf"}).success,false);
});

test("product cards render priced, unpriced, and combined PNG output",async()=>{
  const product={name:"高级香水 Premium perfume",sku:"PERFUME-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:49.75},{minQuantity:10,unitAmount:42}],tags:[{name:"Featured"},{name:"Gift"}]};
  const priced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],true),unpriced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],false),combined=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:10},(_,index)=>({...product,sku:`PERFUME-${index+1}`})),true);
  for(const image of [priced,unpriced,combined]){const metadata=await sharp(image).metadata();assert.equal(metadata.format,"png");assert.equal(metadata.width,1080);assert.ok((metadata.height??0)>=720);}
  assert.notEqual(priced.length,unpriced.length);
  assert.ok((await sharp(combined).metadata()).height!>(await sharp(priced).metadata()).height!);
});

test("variant product cards render each image and every visible price tier",async()=>{
  const red=await sharp({create:{width:120,height:120,channels:4,background:"#D9363E"}}).png().toBuffer(),blue=await sharp({create:{width:120,height:120,channels:4,background:"#2764C7"}}).png().toBuffer();
  const product={name:"Variant perfume",sku:"PERFUME-V",currency:"USD",priceTiers:[],tags:[],variants:[
    {attributes:{Color:"Red",Size:"100 ml"},sku:"PERFUME-RED",image:red,priceTiers:[{minQuantity:1,unitAmount:160},{minQuantity:10,unitAmount:133.33},{minQuantity:50,unitAmount:120}]},
    {attributes:{Color:"Blue",Size:"100 ml"},sku:"PERFUME-BLUE",image:blue,priceTiers:[{minQuantity:1,unitAmount:165},{minQuantity:12,unitAmount:140}]},
  ]};
  const priced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],true),unpriced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],false),pricedMetadata=await sharp(priced).metadata(),unpricedMetadata=await sharp(unpriced).metadata();
  assert.equal(pricedMetadata.format,"png");assert.equal(pricedMetadata.width,1080);assert.ok((pricedMetadata.height??0)>(unpricedMetadata.height??0));assert.notEqual(priced.length,unpriced.length);
});

test("product cards render a bounded grid collage",async()=>{
  const product={name:"Grid perfume",sku:"GRID-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:25}],tags:[]},grid=await renderProductCardGrid(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:6},(_,index)=>({...product,sku:`GRID-${index+1}`})),true,2,3),metadata=await sharp(grid).metadata();
  assert.equal(metadata.format,"png");assert.equal(metadata.width,2160);assert.ok((metadata.height??0)>720);
  await assert.rejects(()=>renderProductCardGrid(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:5},()=>product),true,2,2),/invalid product card grid/);
});

test("product card grids automatically paginate beyond capacity",async()=>{
  const product={name:"Grid perfume",sku:"GRID-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:25}],tags:[]},pages=await renderProductCardGridPages(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:9},(_,index)=>({...product,sku:`GRID-${index+1}`})),true,2,2);
  assert.equal(pages.length,3);
  for(const page of pages){const metadata=await sharp(page).metadata();assert.equal(metadata.format,"png");assert.equal(metadata.width,2160);}
});

test("product card grid PDF contains every rendered grid page",async()=>{
  const product={name:"Grid perfume",sku:"GRID-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:25}],tags:[]},pdf=await renderProductCardGridPdf(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:9},(_,index)=>({...product,sku:`GRID-${index+1}`})),true,2,2),document=await PDFDocument.load(pdf);
  assert.equal(pdf.subarray(0,5).toString(),"%PDF-");
  assert.equal(document.getPageCount(),3);
});
