import assert from "node:assert/strict";
import test from "node:test";
import { newConversationSchema, textToSpeechSchema, ttsProviderSettingsSchema } from "../src/schemas.js";

const accountId="10000000-0000-4000-8000-000000000009";

test("new conversation normalizes a single international phone number",()=>{
  const parsed=newConversationSchema.parse({accountId,phone:"+86 138-0013-8000",displayName:" 客户 ",firstMessage:" 您好 ",clientMessageId:"new-chat-001"});
  assert.equal(parsed.phone,"8613800138000");
  assert.equal(parsed.displayName,"客户");
  assert.equal(parsed.firstMessage,"您好");
});

test("new conversation rejects local or empty destinations",()=>{
  assert.equal(newConversationSchema.safeParse({accountId,phone:"0138000",firstMessage:"您好",clientMessageId:"new-chat-002"}).success,false);
  assert.equal(newConversationSchema.safeParse({accountId,phone:"+8613800138000",firstMessage:" ",clientMessageId:"new-chat-003"}).success,false);
});

test("text-to-speech validates text and speed",()=>{
  const parsed=textToSpeechSchema.parse({accountId,text:"  您好，订单已经发出。  ",speed:1.1});
  assert.equal(parsed.text,"您好，订单已经发出。");
  assert.equal(textToSpeechSchema.safeParse({accountId,text:" "}).success,false);
  assert.equal(textToSpeechSchema.safeParse({accountId,text:"您好",speed:5}).success,false);
});

test("provider settings require a URL and voice while allowing encrypted-key retention",()=>{
  assert.equal(ttsProviderSettingsSchema.safeParse({enabled:true,baseUrl:"https://api.example.com/v1",model:"tts-model",voice:"voice-1"}).success,true);
  assert.equal(ttsProviderSettingsSchema.safeParse({enabled:true,baseUrl:"not-a-url",model:"tts-model",voice:"voice-1"}).success,false);
  assert.equal(ttsProviderSettingsSchema.safeParse({enabled:true,baseUrl:"https://api.example.com",model:"tts-model",voice:""}).success,false);
});
