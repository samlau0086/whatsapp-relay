import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_VIDEO_MIME, isBrowserCompatibleVideo, normalizeBrowserVideo } from "../src/video-normalizer.js";

test("phone videos are normalized to a browser-compatible MP4",async()=>{
  assert.equal(isBrowserCompatibleVideo("video/mp4"),false);
  assert.equal(isBrowserCompatibleVideo("video/quicktime"),false);
  let received:Buffer|undefined;
  const normalized=await normalizeBrowserVideo({bytes:Buffer.from("hevc"),fileName:"phone.mov",mimeType:"video/quicktime"},async bytes=>{received=bytes;return Buffer.from("h264");});
  assert.equal(received?.toString(),"hevc");
  assert.equal(normalized.fileName,"phone.mp4");
  assert.equal(normalized.mimeType,BROWSER_VIDEO_MIME);
  assert.equal(normalized.bytes.toString(),"h264");
});

test("videos already marked with browser codecs are preserved",async()=>{
  assert.equal(isBrowserCompatibleVideo(BROWSER_VIDEO_MIME),true);
  const original={bytes:Buffer.from("h264"),fileName:"video.mp4",mimeType:BROWSER_VIDEO_MIME};
  const normalized=await normalizeBrowserVideo(original,async()=>{throw new Error("converter should not run");});
  assert.deepEqual(normalized,original);
});
