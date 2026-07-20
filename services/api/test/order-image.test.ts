import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { parseOrderImageSummary, renderOrderImage } from "../src/order-image.js";

test("full order images contain the complete summary and every supplied product image",async()=>{
  const red=await sharp({create:{width:12,height:12,channels:3,background:"#d22"}}).jpeg().toBuffer();
  const products=Array.from({length:7},(_,index)=>({name:`Product ${index+1}`,image:red}));
  const summary="Order #000042\n\nItems:\n1. Product 1 x 2 - USD 10.00 each\n2. Product 2 x 1 - USD 1.00 each\n3. Product 3 x 1 - USD 1.00 each\n4. Product 4 x 1 - USD 1.00 each\n5. Product 5 x 1 - USD 1.00 each\n6. Product 6 x 1 - USD 1.00 each\n7. Product 7 x 1 - USD 1.00 each\n\nAdditional fees:\nShipping - USD 4.00\n\nTotal: USD 30.00\n\nNotes: Handle with care";
  const sections=parseOrderImageSummary(summary,products.length,1);
  assert.equal(sections.items.length,7);
  assert.equal(sections.items[0].startsWith("1. Product 1"),true);
  assert.deepEqual(sections.fees,["Shipping - USD 4.00"]);
  assert.equal(sections.notes,"Notes: Handle with care");
  assert.equal(sections.total,"Total: USD 30.00");
  const rendered=await renderOrderImage(summary,products,1);
  const metadata=await sharp(rendered).metadata();
  assert.equal(metadata.format,"png");
  assert.equal(metadata.width,1080);
  assert.ok((metadata.height??0)>1400,"multiple image rows must not be clipped");
});
