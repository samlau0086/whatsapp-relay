import assert from "node:assert/strict";
import test from "node:test";
import { translateText, translationProviderDefaults } from "../src/translation-providers.js";

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
  try{await translateText({provider:"openai_compatible",apiKey:"custom",baseUrl:"https://llm.example/v1/",model:"translator-1"},{text:"Hello",targetLanguage:"fr"});const body=JSON.parse(await request!.text());assert.equal(request?.url,"https://llm.example/v1/chat/completions");assert.equal(body.model,"translator-1");}finally{globalThis.fetch=original;}
});

test("provider failures and empty responses are rejected",async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response("bad gateway",{status:502});await assert.rejects(()=>translateText({provider:"openai",apiKey:"x",...translationProviderDefaults("openai")},{text:"Hello",targetLanguage:"zh-CN"}),/translation_provider_http_502/);
    globalThis.fetch=async()=>Response.json({choices:[{message:{content:"  "}}]});await assert.rejects(()=>translateText({provider:"openai",apiKey:"x",...translationProviderDefaults("openai")},{text:"Hello",targetLanguage:"zh-CN"}),/empty_response/);
  }finally{globalThis.fetch=original;}
});
