import assert from "node:assert/strict";
import test from "node:test";
import { generateSpeech, ttsProviderDefaults } from "../src/tts-providers.js";

test("OpenAI-compatible provider requests Opus audio",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return new Response(new Uint8Array([1,2,3]),{status:200});};
  try{const result=await generateSpeech({provider:"openai",apiKey:"secret",...ttsProviderDefaults("openai")},{text:"您好",speed:1,instructions:"亲切"});assert.equal(result.extension,"ogg");assert.equal(request?.url,"https://api.openai.com/v1/audio/speech");assert.equal(request?.headers.get("authorization"),"Bearer secret");assert.match(await request!.text(),/"response_format":"opus"/);}finally{globalThis.fetch=original;}
});

test("custom OpenAI-compatible provider falls back to broadly supported fields",async()=>{
  const original=globalThis.fetch,requests:Request[]=[];
  globalThis.fetch=async(input,init)=>{
    const request=new Request(input,init);requests.push(request);
    if(requests.length<3)return Response.json({error:{message:requests.length===1?"instructions is not supported":"response_format is not supported"}},{status:400});
    return new Response(new Uint8Array([1,2,3]),{status:200,headers:{"content-type":"audio/mpeg"}});
  };
  try{
    const result=await generateSpeech({provider:"openai_compatible",apiKey:"secret",baseUrl:"https://speech.example/v1",model:"custom-tts",voice:"friendly"},{text:"Hello",speed:1,instructions:"Warm"});
    assert.equal(result.mimeType,"audio/mpeg");assert.equal(result.extension,"mp3");assert.equal(requests.length,3);
    const bodies=await Promise.all(requests.map(request=>request.json())) as Array<Record<string,unknown>>;
    assert.equal(bodies[0].instructions,"Warm");assert.equal(bodies[0].response_format,"mp3");
    assert.equal(bodies[1].instructions,undefined);assert.equal(bodies[1].response_format,"mp3");
    assert.equal(bodies[2].instructions,undefined);assert.equal(bodies[2].response_format,undefined);
  }finally{globalThis.fetch=original;}
});

test("custom OpenAI-compatible provider honors returned audio content type",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(new Uint8Array([1]),{status:200,headers:{"content-type":"audio/wav"}});
  try{
    const result=await generateSpeech({provider:"openai_compatible",apiKey:"secret",baseUrl:"https://speech.example/v1",model:"custom-tts",voice:"friendly"},{text:"Hello",speed:1});
    assert.equal(result.mimeType,"audio/wav");assert.equal(result.extension,"wav");
  }finally{globalThis.fetch=original;}
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
