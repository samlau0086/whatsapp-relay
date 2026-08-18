import assert from "node:assert/strict";
import test from "node:test";
import { transcribeAudio, translateProductNames, translateText, translateTextWithDetection, translationProviderDefaults } from "../src/translation-providers.js";

test("OpenAI translation provider sends a constrained chat-completions request",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({choices:[{message:{content:"Hello 👋\nhttps://example.com"}}]});};
  try{
    const translated=await translateText({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{text:"你好 👋\nhttps://example.com",targetLanguage:"en"});
    assert.equal(translated,"Hello 👋\nhttps://example.com");
    assert.equal(request?.url,"https://api.openai.com/v1/chat/completions");
    assert.equal(request?.headers.get("authorization"),"Bearer secret");
    const body=JSON.parse(await request!.text());assert.equal(body.model,"gpt-5.6-luna");assert.match(body.messages[0].content,/Preserve names, phone numbers, URLs, emoji, line breaks/);assert.match(body.messages[1].content,/Target language \(BCP 47\): en/);
  }finally{globalThis.fetch=original;}
});

test("custom provider uses its configured endpoint and model",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({choices:[{message:{content:"Bonjour"}}]});};
  try{await translateText({provider:"openai_compatible",apiKey:"custom",baseUrl:"https://llm.example/v1/",model:"translator-1",transcriptionModel:"speech-1"},{text:"Hello",targetLanguage:"fr"});const body=JSON.parse(await request!.text());assert.equal(request?.url,"https://llm.example/v1/chat/completions");assert.equal(body.model,"translator-1");}finally{globalThis.fetch=original;}
});

test("translation with detection returns a normalized BCP 47 source language",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({choices:[{message:{content:'{"translatedText":"你好！","sourceLanguage":"ES_mx"}'}}]});};
  try{
    const result=await translateTextWithDetection({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{text:"¡Hola!",targetLanguage:"zh-CN"});
    assert.deepEqual(result,{translatedText:"你好！",sourceLanguage:"es-MX"});
    const body=JSON.parse(await request!.text());
    assert.match(body.messages[0].content,/sourceLanguage/);
    assert.match(body.messages[0].content,/BCP 47/);
  }finally{globalThis.fetch=original;}
});

test("translation honors an explicitly supplied source language",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({choices:[{message:{content:'{"translatedText":"这是萨米尔","sourceLanguage":"en"}'}}]});};
  try{
    const result=await translateTextWithDetection({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{text:"هذا سمير",sourceLanguage:"ar",targetLanguage:"zh-CN"});
    assert.deepEqual(result,{translatedText:"这是萨米尔",sourceLanguage:"ar"});
    const body=JSON.parse(await request!.text());
    assert.match(body.messages[0].content,/do not auto-detect/);
    assert.match(body.messages[1].content,/Source language \(BCP 47\): ar/);
  }finally{globalThis.fetch=original;}
});

test("translation carries conversation context and mirrors Moroccan Darija script",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({choices:[{message:{content:"labas"}}]});};
  try{
    await translateText({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{text:"How can I help?",targetLanguage:"ary",context:{customerCountry:"MA",customerPreferredLanguage:"ary",conversation:[{direction:"in",text:"salam, kif dayr?"}]}});
    const body=JSON.parse(await request!.text());
    assert.match(body.messages[0].content,/regional language habits and script/);
    assert.match(body.messages[1].content,/Moroccan Darija/);
    assert.match(body.messages[1].content,/Customer: salam, kif dayr\?/);
  }finally{globalThis.fetch=original;}
});

test("product name translation preserves order and requires a structured response",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({choices:[{message:{content:'["AirPods Pro（第二代）","至尊典藏版"]'}}]});};
  try{
    const names=await translateProductNames({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{names:["AirPods Pro (2nd generation)","Supremacy Collector's Edition"],targetLanguage:"zh-CN"});
    assert.deepEqual(names,["AirPods Pro（第二代）","至尊典藏版"]);
    const body=JSON.parse(await request!.text());assert.match(body.messages[0].content,/ecommerce product titles/);assert.match(body.messages[1].content,/Product titles as JSON/);
    globalThis.fetch=async()=>Response.json({choices:[{message:{content:'["only one"]'}}]});
    await assert.rejects(()=>translateProductNames({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{names:["A","B"],targetLanguage:"zh-CN"}),/invalid_product_names_response/);
  }finally{globalThis.fetch=original;}
});

test("audio transcription uses the configured OpenAI-compatible endpoint and model",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({text:"Hello from the voice note"});};
  try{
    const transcript=await transcribeAudio({provider:"openai",apiKey:"secret",...translationProviderDefaults("openai")},{bytes:Buffer.from("voice"),fileName:"voice.ogg",mimeType:"audio/ogg",sourceLanguage:"ar-SA"});
    assert.equal(transcript,"Hello from the voice note");assert.equal(request?.url,"https://api.openai.com/v1/audio/transcriptions");assert.equal(request?.headers.get("authorization"),"Bearer secret");
    const form=await request!.formData();assert.equal(form.get("model"),"gpt-4o-mini-transcribe");assert.equal(form.get("response_format"),"json");assert.equal(form.get("language"),"ar");assert.equal((form.get("file") as File).name,"voice.ogg");
  }finally{globalThis.fetch=original;}
});

test("diarization transcription requests diarized JSON and joins speaker segments",async()=>{
  const original=globalThis.fetch;let request:Request|undefined;
  globalThis.fetch=async(input,init)=>{request=new Request(input,init);return Response.json({segments:[{speaker:"A",text:"Hello"},{speaker:"B",text:"there"}]});};
  try{
    const transcript=await transcribeAudio({provider:"openai_compatible",apiKey:"secret",baseUrl:"https://llm.example/v1",model:"translator-1",transcriptionModel:"gpt-4o-transcribe-diarize"},{bytes:Buffer.from("voice"),fileName:"voice.ogg",mimeType:"audio/ogg"});
    assert.equal(transcript,"Hello there");
    const form=await request!.formData();assert.equal(form.get("response_format"),"diarized_json");assert.equal(form.get("chunking_strategy"),"auto");
  }finally{globalThis.fetch=original;}
});

test("transcription accepts common compatible-provider response wrappers",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>Response.json({data:{text:"Wrapped transcript"}});
    const wrapped=await transcribeAudio({provider:"openai_compatible",apiKey:"secret",baseUrl:"https://llm.example/v1",model:"translator-1",transcriptionModel:"speech-1"},{bytes:Buffer.from("voice"),fileName:"voice.ogg",mimeType:"audio/ogg"});
    assert.equal(wrapped,"Wrapped transcript");
    globalThis.fetch=async()=>new Response("Plain transcript",{headers:{"content-type":"text/plain"}});
    const plain=await transcribeAudio({provider:"openai_compatible",apiKey:"secret",baseUrl:"https://llm.example/v1",model:"translator-1",transcriptionModel:"speech-1"},{bytes:Buffer.from("voice"),fileName:"voice.ogg",mimeType:"audio/ogg"});
    assert.equal(plain,"Plain transcript");
  }finally{globalThis.fetch=original;}
});

test("provider failures and empty responses are rejected",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response("bad gateway",{status:502});await assert.rejects(()=>translateText({provider:"openai",apiKey:"x",...translationProviderDefaults("openai")},{text:"Hello",targetLanguage:"zh-CN"}),/translation_provider_http_502/);
    globalThis.fetch=async()=>Response.json({choices:[{message:{content:"  "}}]});await assert.rejects(()=>translateText({provider:"openai",apiKey:"x",...translationProviderDefaults("openai")},{text:"Hello",targetLanguage:"zh-CN"}),/empty_response/);
    globalThis.fetch=async()=>Response.json({text:"  "});await assert.rejects(()=>transcribeAudio({provider:"openai",apiKey:"x",...translationProviderDefaults("openai")},{bytes:Buffer.from("voice"),fileName:"voice.ogg",mimeType:"audio/ogg"}),/empty_response/);
  }finally{globalThis.fetch=original;}
});
