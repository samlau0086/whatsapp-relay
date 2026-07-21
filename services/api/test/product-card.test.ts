import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { DEFAULT_PRODUCT_CARD_TEMPLATE, productCardTemplateSchema } from "../src/product-card-template.js";
import { renderProductCards } from "../src/product-card-image.js";

test("product pricing and card migration is idempotent and enforces active SKU uniqueness",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/024_product_pricing_cards.sql",import.meta.url),"utf8");
  assert.match(migration,/ADD COLUMN IF NOT EXISTS sku/);
  assert.match(migration,/WHERE deleted_at IS NULL/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_price_tiers/);
  assert.match(migration,/ON CONFLICT\(product_id,min_quantity\) DO NOTHING/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_card_settings/);
});

test("product card templates protect required singleton blocks",()=>{
  assert.equal(productCardTemplateSchema.safeParse(DEFAULT_PRODUCT_CARD_TEMPLATE).success,true);
  assert.equal(productCardTemplateSchema.safeParse({...DEFAULT_PRODUCT_CARD_TEMPLATE,blocks:DEFAULT_PRODUCT_CARD_TEMPLATE.blocks.filter(block=>block.type!=="sku")}).success,false);
  assert.equal(productCardTemplateSchema.safeParse({...DEFAULT_PRODUCT_CARD_TEMPLATE,blocks:[...DEFAULT_PRODUCT_CARD_TEMPLATE.blocks,{...DEFAULT_PRODUCT_CARD_TEMPLATE.blocks[1],id:"name-2"}]}).success,false);
});

test("product cards render priced, unpriced, and combined PNG output",async()=>{
  const product={name:"高级香水 Premium perfume",sku:"PERFUME-001",currency:"USD",priceTiers:[{minQuantity:1,unitAmount:49.75},{minQuantity:10,unitAmount:42}],tags:[{name:"Featured"},{name:"Gift"}]};
  const priced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],true),unpriced=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,[product],false),combined=await renderProductCards(DEFAULT_PRODUCT_CARD_TEMPLATE,Array.from({length:10},(_,index)=>({...product,sku:`PERFUME-${index+1}`})),true);
  for(const image of [priced,unpriced,combined]){const metadata=await sharp(image).metadata();assert.equal(metadata.format,"png");assert.equal(metadata.width,1080);assert.ok((metadata.height??0)>=720);}
  assert.notEqual(priced.length,unpriced.length);
  assert.ok((await sharp(combined).metadata()).height!>(await sharp(priced).metadata()).height!);
});
