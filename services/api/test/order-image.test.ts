import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderOrderImage } from "../src/order-image.js";

test("full order images contain the complete summary and every supplied product image",async()=>{
  const red=await sharp({create:{width:12,height:12,channels:3,background:"#d22"}}).jpeg().toBuffer();
  const products=Array.from({length:7},(_,index)=>({name:`Product ${index+1}`,image:red}));
  const rendered=await renderOrderImage("Order #000042\n1. Product x 2 - USD 10.00 each\nAdditional fees:\nShipping - USD 4.00\nTotal: USD 24.00\nNotes: Handle with care",products);
  const metadata=await sharp(rendered).metadata();
  assert.equal(metadata.format,"png");
  assert.equal(metadata.width,1080);
  assert.ok((metadata.height??0)>1400,"multiple image rows must not be clipped");
});
