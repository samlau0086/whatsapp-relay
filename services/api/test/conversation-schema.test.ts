import assert from "node:assert/strict";
import test from "node:test";
import { conversationTagsSchema, customerStageSchema, messageSchema, messageTranslationsSchema, newConversationSchema, noteSchema, orderSchema, orderSendSchema, orderUpdateSchema, productCreateSchema, productUpdateSchema, reminderSchema, tagCreateSchema, textToSpeechSchema, translationPreferenceSchema, translationPreviewSchema, translationProviderSettingsSchema, ttsProviderSettingsSchema } from "../src/schemas.js";

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

test("translation preferences require BCP 47 language codes",()=>{
  assert.equal(translationPreferenceSchema.safeParse({conversationId:accountId,enabled:true,agentLanguage:"zh-CN",customerLanguage:"en-US"}).success,true);
  assert.equal(translationPreferenceSchema.safeParse({conversationId:accountId,enabled:true,agentLanguage:"中文",customerLanguage:"English"}).success,false);
  assert.equal(translationPreferenceSchema.safeParse({conversationId:"not-a-conversation",enabled:false,agentLanguage:"zh-CN",customerLanguage:"en"}).success,false);
});

test("translation inputs enforce text and batch limits",()=>{
  assert.equal(translationPreviewSchema.safeParse({text:"  Hello  ",targetLanguage:"fr"}).data?.text,"Hello");
  assert.equal(messageTranslationsSchema.safeParse({messageIds:Array.from({length:51},()=>accountId),targetLanguage:"zh-CN"}).success,false);
  assert.equal(messageTranslationsSchema.parse({messageIds:[accountId],targetLanguage:"zh-CN"}).generateAudio,false);
  assert.equal(messageTranslationsSchema.parse({messageIds:[accountId],targetLanguage:"zh-CN",generateAudio:true}).generateAudio,true);
  assert.equal(translationProviderSettingsSchema.safeParse({enabled:true,baseUrl:"https://api.example.com/v1",model:"translator-1",transcriptionModel:"speech-1"}).success,true);
  assert.equal(translationProviderSettingsSchema.safeParse({enabled:true,baseUrl:"https://api.example.com/v1",model:"translator-1",transcriptionModel:""}).success,false);
  assert.equal(translationProviderSettingsSchema.safeParse({enabled:true,baseUrl:"invalid",model:""}).success,false);
});

test("translated outgoing text can retain an agent-only source",()=>{
  const translated=messageSchema.parse({accountId,conversationId:accountId,clientMessageId:"translated-message-001",type:"text",text:"Hello",translationSourceText:"你好"});
  assert.equal(translated.translationSourceText,"你好");
  assert.equal(messageSchema.safeParse({accountId,conversationId:accountId,clientMessageId:"translated-audio-001",type:"audio",mediaId:accountId,translationSourceText:"你好"}).success,false);
});

test("CRM schemas enforce stages, tags, notes, and reminder dates",()=>{
  assert.equal(customerStageSchema.safeParse("qualified").success,true);
  assert.equal(customerStageSchema.safeParse("maybe").success,false);
  assert.equal(tagCreateSchema.safeParse({name:"  VIP  ",color:"#DFF5E8"}).data?.name,"VIP");
  assert.equal(tagCreateSchema.safeParse({name:"VIP",color:"green"}).success,false);
  assert.equal(conversationTagsSchema.safeParse({tagIds:Array.from({length:21},()=>accountId)}).success,false);
  assert.equal(noteSchema.safeParse({body:"x".repeat(5001)}).success,false);
  assert.equal(reminderSchema.safeParse({remindAt:new Date(Date.now()+60_000).toISOString()}).success,true);
  assert.equal(reminderSchema.safeParse({remindAt:new Date(Date.now()-60_000).toISOString()}).success,false);
});

test("orders validate idempotency, products, fees, currency, and translation",()=>{
  const valid={clientOrderId:accountId,currency:"USD",items:[{name:"Leather bag",quantity:2,unitAmount:19.95,imageMediaId:accountId}],fees:[{name:"Shipping",amount:5}]};
  assert.equal(orderSchema.safeParse(valid).success,true);
  assert.equal(orderSchema.safeParse({...valid,items:[{...valid.items[0],productId:accountId,clientProductId:accountId}]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[{...valid.items[0],clientProductId:accountId}]}).success,true);
  assert.equal(orderSchema.safeParse({...valid,clientOrderId:"order-1"}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[{name:"Bag",quantity:1,unitAmount:19.999}]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,currency:"BTC"}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[{name:"Free sample",quantity:1,unitAmount:0}],fees:[]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,translateOnSend:true}).success,false);
  assert.equal(orderSchema.safeParse({...valid,translateOnSend:true,targetLanguage:"fr"}).success,true);
  const update={currency:valid.currency,items:valid.items,fees:valid.fees};
  assert.equal(orderUpdateSchema.safeParse(update).success,true);
  assert.equal(orderSendSchema.safeParse({format:"text"}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"image"}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"image",clientSendId:accountId}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"image",clientSendId:"retry-1"}).success,false);
  assert.equal(orderSendSchema.safeParse({format:"pdf"}).success,false);
  assert.equal(orderSendSchema.parse(undefined).format,"text");
});

test("product library schemas validate shared products and editable labels",()=>{
  const valid={clientProductId:accountId,name:" Leather bag ",defaultUnitAmount:19.95,currency:"USD",imageMediaId:accountId,tags:[{name:" VIP ",color:"#E8EEF7"}]};
  const parsed=productCreateSchema.parse(valid);assert.equal(parsed.name,"Leather bag");assert.equal(parsed.tags[0].name,"VIP");
  assert.equal(productCreateSchema.safeParse({...valid,currency:"BTC"}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,defaultUnitAmount:19.999}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,tags:[{name:"VIP",color:"green"}]}).success,false);
  assert.equal(productUpdateSchema.safeParse({tags:[]}).success,true);
  assert.equal(productUpdateSchema.safeParse({}).success,false);
});
