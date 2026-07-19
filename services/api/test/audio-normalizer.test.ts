import assert from "node:assert/strict";
import test from "node:test";
import { needsTranscriptionConversion, normalizeTranscriptionAudio } from "../src/audio-normalizer.js";

test("WhatsApp OGG voice notes are converted to a supported MP3 upload",async()=>{
  assert.equal(needsTranscriptionConversion("voice.ogg","audio/ogg; codecs=opus"),true);
  let received:Buffer|undefined;
  const normalized=await normalizeTranscriptionAudio({bytes:Buffer.from("ogg-opus"),fileName:"voice.ogg",mimeType:"audio/ogg; codecs=opus"},async bytes=>{received=bytes;return Buffer.from("mp3");});
  assert.equal(received?.toString(),"ogg-opus");assert.equal(normalized.fileName,"voice.mp3");assert.equal(normalized.mimeType,"audio/mpeg");assert.equal(normalized.bytes.toString(),"mp3");
});

test("already supported transcription formats are preserved",async()=>{
  assert.equal(needsTranscriptionConversion("voice.webm","audio/webm"),false);
  const original={bytes:Buffer.from("webm"),fileName:"voice.webm",mimeType:"audio/webm"};
  const normalized=await normalizeTranscriptionAudio(original,async()=>{throw new Error("converter should not run");});
  assert.deepEqual(normalized,original);
});
