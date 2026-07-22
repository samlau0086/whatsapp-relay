import assert from "node:assert/strict";
import test from "node:test";
import { contactAliasSchema, contactUpdateSchema, conversationTagsSchema, currencySettingsSchema, customerStageSchema, messageSchema, messageTranslationsSchema, newConversationSchema, noteSchema, orderSchema, orderSendSchema, orderUpdateSchema, productBulkImportSchema, productCardSendSchema, productCreateSchema, productUpdateSchema, reminderSchema, tagCreateSchema, textToSpeechSchema, translationPreferenceSchema, translationPreviewSchema, translationProviderSettingsSchema, ttsProviderSettingsSchema } from "../src/schemas.js";

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
  assert.equal(contactAliasSchema.parse({alias:"  Alice Shanghai  "}).alias,"Alice Shanghai");
  assert.equal(contactAliasSchema.parse({alias:"   "}).alias,"");
  assert.equal(contactAliasSchema.safeParse({alias:"x".repeat(81)}).success,false);
  assert.equal(customerStageSchema.safeParse("qualified").success,true);
  assert.equal(customerStageSchema.safeParse("maybe").success,false);
  assert.equal(tagCreateSchema.safeParse({name:"  VIP  ",color:"#DFF5E8"}).data?.name,"VIP");
  assert.equal(tagCreateSchema.safeParse({name:"VIP",color:"green"}).success,false);
  assert.equal(conversationTagsSchema.safeParse({tagIds:Array.from({length:21},()=>accountId)}).success,false);
  assert.equal(noteSchema.safeParse({body:"x".repeat(5001)}).success,false);
  assert.equal(reminderSchema.safeParse({remindAt:new Date(Date.now()+60_000).toISOString()}).success,true);
  assert.equal(reminderSchema.safeParse({remindAt:new Date(Date.now()-60_000).toISOString()}).success,false);
});

test("contact profiles normalize email and select a single primary address",()=>{
  const profile=contactUpdateSchema.parse({alias:" Alice ",note:" Follow up ",emails:[{label:"Work",email:" ALICE@EXAMPLE.COM ",isPrimary:false}],methods:[{type:"telegram",label:"Sales",value:" @alice "}]});
  assert.equal(profile.alias,"Alice");
  assert.equal(profile.emails[0].email,"alice@example.com");
  assert.equal(profile.emails[0].isPrimary,true);
  assert.equal(profile.methods[0].value,"@alice");
  assert.equal(contactUpdateSchema.safeParse({...profile,emails:[profile.emails[0],{...profile.emails[0],isPrimary:false}]}).success,false);
  assert.equal(contactUpdateSchema.safeParse({...profile,emails:[profile.emails[0],{label:"Home",email:"other@example.com",isPrimary:true}]}).success,false);
  assert.equal(contactUpdateSchema.parse({...profile,emails:[]}).emails.length,0);
});

test("orders validate idempotency, products, fees, currency, and translation",()=>{
  const valid={clientOrderId:accountId,currency:"USD",items:[{name:"Leather bag",quantity:2,unitAmount:19.95,imageMediaId:accountId}],fees:[{name:"Shipping",amount:5}]};
  assert.equal(orderSchema.safeParse(valid).success,true);
  assert.equal(orderSchema.safeParse({...valid,items:[{...valid.items[0],productId:accountId,clientProductId:accountId}]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[{...valid.items[0],clientProductId:accountId,sku:"BAG-001"}]}).success,true);
  assert.equal(orderSchema.safeParse({...valid,clientOrderId:"order-1"}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[{name:"Bag",quantity:1,unitAmount:19.999}]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,currency:"BTC"}).success,true);
  assert.equal(orderSchema.safeParse({...valid,currency:"US"}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,items:[{name:"Free sample",quantity:1,unitAmount:0}],fees:[]}).success,false);
  assert.equal(orderSchema.safeParse({...valid,translateOnSend:true}).success,false);
  assert.equal(orderSchema.safeParse({...valid,translateOnSend:true,targetLanguage:"fr"}).success,true);
  assert.equal(orderSchema.safeParse({...valid,addressId:accountId}).success,true);
  assert.equal(orderSchema.safeParse({...valid,newAddress:{label:"公司",recipientName:"Alice",phone:"+86 13800000000",address:"上海市浦东新区测试路 1 号"}}).success,true);
  assert.equal(orderSchema.safeParse({...valid,addressId:accountId,newAddress:{label:"公司",address:"测试地址"}}).success,false);
  assert.equal(orderSchema.safeParse({...valid,newAddress:{label:"",address:""}}).success,false);
  const update={currency:valid.currency,items:valid.items,fees:valid.fees};
  assert.equal(orderUpdateSchema.safeParse(update).success,true);
  assert.equal(orderSendSchema.safeParse({format:"text"}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"image"}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"image",clientSendId:accountId}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"text",translate:false}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"text",translate:true,targetLanguage:"ar"}).success,true);
  assert.equal(orderSendSchema.safeParse({format:"text",translate:true}).success,false);
  assert.equal(orderSendSchema.safeParse({format:"image",clientSendId:"retry-1"}).success,false);
  assert.equal(orderSendSchema.safeParse({format:"pdf"}).success,false);
  assert.equal(orderSendSchema.parse(undefined).format,"text");
});

test("product library schemas validate SKU, tiered prices, and editable labels",()=>{
  const valid={clientProductId:accountId,name:" Leather bag ",sku:" BAG-001 ",priceTiers:[{minQuantity:1,unitAmount:19.95},{minQuantity:10,unitAmount:17.5}],currency:"USD",imageMediaId:accountId,tags:[{name:" VIP ",color:"#E8EEF7"}]};
  const parsed=productCreateSchema.parse(valid);assert.equal(parsed.name,"Leather bag");assert.equal(parsed.tags[0].name,"VIP");
  assert.equal(parsed.description,"");
  assert.equal(productCreateSchema.parse({...valid,description:" Full-grain leather "}).description,"Full-grain leather");
  assert.equal(productCreateSchema.safeParse({...valid,description:"x".repeat(2001)}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,currency:"BTC"}).success,true);
  assert.equal(productCreateSchema.safeParse({...valid,currency:"US1"}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,priceTiers:[{minQuantity:1,unitAmount:19.999}]}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,priceTiers:[{minQuantity:1,unitAmount:9.2},{minQuantity:10,unitAmount:8.3},{minQuantity:100,unitAmount:7.5}]}).success,true);
  assert.equal(productCreateSchema.safeParse({...valid,priceTiers:[{minQuantity:2,unitAmount:19.95}]}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,priceTiers:[{minQuantity:1,unitAmount:19.95},{minQuantity:1,unitAmount:18}]}).success,false);
  assert.equal(productCreateSchema.safeParse({...valid,tags:[{name:"VIP",color:"green"}]}).success,false);
  assert.equal(productUpdateSchema.safeParse({tags:[]}).success,true);
  assert.equal(productUpdateSchema.safeParse({}).success,false);
  assert.equal(productBulkImportSchema.safeParse({products:[valid]}).success,true);
  assert.equal(productBulkImportSchema.safeParse({products:[valid,{...valid,clientProductId:"10000000-0000-4000-8000-000000000010",sku:"bag-001"}]}).success,false);
  assert.equal(productBulkImportSchema.safeParse({products:[]}).success,false);
  assert.equal(productCardSendSchema.safeParse({accountId,clientBatchId:"batch-001",productIds:[accountId],mode:"individual",showPrice:true}).success,true);
  assert.equal(productCardSendSchema.safeParse({accountId,clientBatchId:"batch-001",productIds:Array.from({length:11},(_,index)=>`10000000-0000-4000-8000-${String(index).padStart(12,"0")}`),mode:"combined",showPrice:false}).success,false);
});

test("currency settings require one included base currency with rate one",()=>{
  const valid={baseCurrency:"USD",currencies:[{code:"USD",name:"美元",rate:1},{code:"CNY",name:"人民币",rate:7.2}]};
  assert.equal(currencySettingsSchema.safeParse(valid).success,true);
  assert.equal(currencySettingsSchema.safeParse({...valid,baseCurrency:"EUR"}).success,false);
  assert.equal(currencySettingsSchema.safeParse({...valid,currencies:[{code:"USD",name:"美元",rate:2}]}).success,false);
  assert.equal(currencySettingsSchema.safeParse({...valid,currencies:[valid.currencies[0],valid.currencies[0]]}).success,false);
});
