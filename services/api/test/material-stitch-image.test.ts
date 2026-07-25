import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { stitchMaterialImages } from "../src/material-stitch-image.js";

async function solid(width:number,height:number,background:string){return sharp({create:{width,height,channels:3,background}}).png().toBuffer();}

test("material images stitch vertically and horizontally in input order",async()=>{
  const red=await solid(20,10,"#ff0000"),blue=await solid(20,10,"#0000ff");
  const vertical=await stitchMaterialImages([red,blue],"vertical"),horizontal=await stitchMaterialImages([red,blue],"horizontal");
  assert.deepEqual({width:vertical.width,height:vertical.height,mime:vertical.mimeType},{width:20,height:20,mime:"image/png"});
  assert.deepEqual({width:horizontal.width,height:horizontal.height,mime:horizontal.mimeType},{width:40,height:10,mime:"image/png"});
  const verticalPixels=await sharp(vertical.bytes).raw().toBuffer(),horizontalPixels=await sharp(horizontal.bytes).raw().toBuffer();
  assert.deepEqual([...verticalPixels.subarray((2*20+2)*4,(2*20+2)*4+3)],[255,0,0]);
  assert.deepEqual([...verticalPixels.subarray((15*20+2)*4,(15*20+2)*4+3)],[0,0,255]);
  assert.deepEqual([...horizontalPixels.subarray((2*40+2)*4,(2*40+2)*4+3)],[255,0,0]);
  assert.deepEqual([...horizontalPixels.subarray((2*40+30)*4,(2*40+30)*4+3)],[0,0,255]);
});

test("oversized stitched PNG falls back to a send-safe JPEG",async()=>{
  const noisy=await sharp(randomBytes(700*700*3),{raw:{width:700,height:700,channels:3}}).png().toBuffer();
  const result=await stitchMaterialImages([noisy,noisy],"vertical",700_000);
  assert.equal(result.mimeType,"image/jpeg");
  assert.ok(result.bytes.length<=700_000);
  assert.ok(result.width>=420);
});

test("stitching reports an explicit error when even minimum output cannot fit",async()=>{
  const image=await solid(40,40,"#00aa66");
  await assert.rejects(()=>stitchMaterialImages([image,image],"vertical",10),/material_stitch_too_large/);
});

test("material send routes keep ordering, first-caption behavior, and idempotent batch status",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/\/api\/v1\/conversations\/:id\/materials\/send/);
  assert.match(server,/ORDER BY a\.page_index/);
  assert.match(server,/caption=index===0/);
  assert.match(server,/material_send_batch_conflict/);
  assert.match(server,/\/api\/v1\/conversations\/:id\/materials\/batches\/:batchId/);
  assert.match(server,/source:"material-stitch"/);
});
