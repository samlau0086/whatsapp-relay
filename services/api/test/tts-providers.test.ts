import assert from "node:assert/strict";
import test from "node:test";
import { generateSpeech, ttsProviderDefaults } from "../src/tts-providers.js";

test("OpenAI-compatible provider requests Opus audio",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return new Response(new Uint8Array([1,2,3]),{status:200});};
  try{const result=await generateSpeech({provider:"openai",apiKey:"secret",...ttsProviderDefaults("openai")},{text:"您好",speed:1,instructions:"亲切"});assert.equal(result.extension,"ogg");assert.equal(request?.url,"https://api.openai.com/v1/audio/speech");assert.equal(request?.headers.get("authorization"),"Bearer secret");assert.match(await request!.text(),/"response_format":"opus"/);}finally{globalThis.fetch=original;}
});

test("ElevenLabs provider uses its voice endpoint and API-key header",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return new Response(new Uint8Array([1]),{status:200});};
  try{const result=await generateSpeech({provider:"elevenlabs",apiKey:"eleven-secret",...ttsProviderDefaults("elevenlabs")},{text:"Hello",speed:1});assert.equal(result.mimeType,"audio/mpeg");assert.match(request?.url??"",/text-to-speech\/JBFqnCBsd6RMkjVDRZzb/);assert.equal(request?.headers.get("xi-api-key"),"eleven-secret");}finally{globalThis.fetch=original;}
});

test("Azure provider sends escaped SSML and requests Ogg Opus",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return new Response(new Uint8Array([1]),{status:200});};
  try{await generateSpeech({provider:"azure",apiKey:"azure-secret",baseUrl:"https://relay.cognitiveservices.azure.com",model:"",voice:"zh-CN-XiaoxiaoNeural"},{text:"A < B & C",speed:1});assert.equal(request?.headers.get("x-microsoft-outputformat"),"ogg-24khz-16bit-mono-opus");assert.match(await request!.text(),/A &lt; B &amp; C/);}finally{globalThis.fetch=original;}
});
