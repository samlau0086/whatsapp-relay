import { z } from "zod";

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const messageSchema = z.object({
  accountId: z.string().uuid(),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().min(8).max(128),
  type: z.enum(["text","image","video","audio","document","location","contact"]),
  text: z.string().max(65536).optional(),
  translationSourceText: z.string().trim().min(1).max(65536).optional(),
  mediaId: z.string().uuid().optional(),
  quotedMessageId: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (value.type === "text" && !value.text?.trim()) ctx.addIssue({ code:"custom", path:["text"], message:"文本消息不能为空" });
  if (value.type !== "text" && value.translationSourceText) ctx.addIssue({ code:"custom", path:["translationSourceText"], message:"只有文本消息可以保存翻译原文" });
  if (["image","video","audio","document"].includes(value.type) && !value.mediaId) ctx.addIssue({ code:"custom", path:["mediaId"], message:"媒体消息必须提供 mediaId" });
});

export const textToSpeechSchema = z.object({
  accountId: z.string().uuid(),
  text: z.string().trim().min(1).max(4096),
  speed: z.number().min(0.25).max(4).default(1),
  instructions: z.string().trim().max(500).optional(),
});

export const ttsProviderSettingsSchema=z.object({
  enabled:z.boolean().default(false),
  apiKey:z.string().trim().min(1).max(4096).optional(),
  baseUrl:z.string().trim().url().max(2048),
  model:z.string().trim().max(200).default(""),
  voice:z.string().trim().min(1).max(200),
});

const languageCodeSchema=z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,"invalid BCP 47 language code");

export const translationPreferenceSchema=z.object({
  conversationId:z.string().uuid(),
  enabled:z.boolean(),
  agentLanguage:languageCodeSchema,
  customerLanguage:languageCodeSchema,
});

export const translationPreferenceQuerySchema=z.object({conversationId:z.string().uuid()});

export const translationProviderSettingsSchema=z.object({
  enabled:z.boolean().default(false),
  apiKey:z.string().trim().min(1).max(4096).optional(),
  baseUrl:z.string().trim().url().max(2048),
  model:z.string().trim().min(1).max(200),
  transcriptionModel:z.string().trim().min(1).max(200),
});

export const translationPreviewSchema=z.object({
  text:z.string().trim().min(1).max(65536),
  targetLanguage:languageCodeSchema,
});

export const messageTranslationsSchema=z.object({
  messageIds:z.array(z.string().uuid()).min(1).max(50),
  targetLanguage:languageCodeSchema,
  generateAudio:z.boolean().default(false),
});

export const newConversationSchema = z.object({
  accountId: z.string().uuid(),
  phone: z.string().transform(value=>value.trim().replace(/[\s()+.-]/g,"")).refine(value=>/^[1-9]\d{6,14}$/.test(value),"请输入包含国家代码的有效号码"),
  displayName: z.string().trim().min(1).max(80).optional(),
  firstMessage: z.string().trim().min(1).max(65536),
  clientMessageId: z.string().min(8).max(128),
});

export const customerStageSchema=z.enum(["new","considering","qualified","won","lost"]);
export const contactAliasSchema=z.object({alias:z.string().trim().max(80)});
const contactEmailSchema=z.object({label:z.string().trim().max(40).default(""),email:z.string().trim().toLowerCase().email().max(254),isPrimary:z.boolean().default(false)});
const contactMethodSchema=z.object({type:z.enum(["phone","wechat","telegram","line","website","other"]),label:z.string().trim().max(40).default(""),value:z.string().trim().min(1).max(500)});
const contactAddressSchema=z.object({id:z.string().uuid().optional(),label:z.string().trim().min(1).max(40),recipientName:z.string().trim().max(80).default(""),phone:z.string().trim().max(40).default(""),address:z.string().trim().min(1).max(1000)});
export const contactUpdateSchema=z.object({alias:z.string().trim().max(80),note:z.string().trim().max(5000),emails:z.array(contactEmailSchema).max(20),methods:z.array(contactMethodSchema).max(30),addresses:z.array(contactAddressSchema).max(20).default([])}).superRefine((value,ctx)=>{
  const primaryCount=value.emails.filter(item=>item.isPrimary).length;
  if(primaryCount>1)ctx.addIssue({code:"custom",path:["emails"],message:"only one primary email is allowed"});
  const seen=new Set<string>();
  for(const [index,item] of value.emails.entries()){if(seen.has(item.email))ctx.addIssue({code:"custom",path:["emails",index,"email"],message:"duplicate email"});seen.add(item.email);}
}).transform(value=>({...value,emails:value.emails.map((item,index)=>({...item,isPrimary:value.emails.some(email=>email.isPrimary)?item.isPrimary:index===0}))}));
export const tagCreateSchema=z.object({name:z.string().trim().min(1).max(40),color:z.string().regex(/^#[0-9A-Fa-f]{6}$/)});
export const tagUpdateSchema=tagCreateSchema.partial().refine(value=>Object.keys(value).length>0,"at least one field is required");
export const conversationTagsSchema=z.object({tagIds:z.array(z.string().uuid()).max(20)});
export const noteSchema=z.object({body:z.string().trim().min(1).max(5000)});
export const reminderSchema=z.object({remindAt:z.string().datetime({offset:true}).transform(value=>new Date(value)).refine(value=>value.getTime()>Date.now(),"reminder must be in the future")});
const moneySchema=z.coerce.number().nonnegative().max(99_999_999.99).refine(value=>Math.abs(value*100-Math.round(value*100))<1e-7,"amount supports at most two decimals");
export const currencySchema=z.string().trim().transform(value=>value.toUpperCase()).pipe(z.string().regex(/^[A-Z]{3}$/,"currency must be a three-letter code"));
export const currencySettingsSchema=z.object({
  baseCurrency:currencySchema,
  currencies:z.array(z.object({
    code:currencySchema,
    name:z.string().trim().min(1).max(80),
    rate:z.coerce.number().positive().max(1_000_000),
  })).min(1).max(100),
}).superRefine((value,ctx)=>{
  const codes=value.currencies.map(item=>item.code);
  if(new Set(codes).size!==codes.length)ctx.addIssue({code:"custom",path:["currencies"],message:"currency codes must be unique"});
  const base=value.currencies.find(item=>item.code===value.baseCurrency);
  if(!base)ctx.addIssue({code:"custom",path:["baseCurrency"],message:"base currency must be included"});
  else if(base.rate!==1)ctx.addIssue({code:"custom",path:["currencies",codes.indexOf(value.baseCurrency),"rate"],message:"base currency rate must equal 1"});
});
export const productLabelSchema=z.object({name:z.string().trim().min(1).max(40),color:z.string().regex(/^#[0-9A-Fa-f]{6}$/)});
export const productPriceTierSchema=z.object({minQuantity:z.coerce.number().int().min(1).max(999999),unitAmount:moneySchema});
const productPriceTiersSchema=z.array(productPriceTierSchema).min(1).max(50).superRefine((tiers,ctx)=>{if(tiers[0]?.minQuantity!==1)ctx.addIssue({code:"custom",path:[0,"minQuantity"],message:"first tier must start at quantity 1"});for(let index=1;index<tiers.length;index++)if(tiers[index].minQuantity<=tiers[index-1].minQuantity)ctx.addIssue({code:"custom",path:[index,"minQuantity"],message:"tier quantities must be strictly increasing"});});
const productContentSchema=z.object({name:z.string().trim().min(1).max(120),sku:z.string().trim().min(1).max(80),description:z.string().trim().max(2000).default(""),priceTiers:productPriceTiersSchema,currency:currencySchema,imageMediaId:z.string().uuid().nullable().optional(),tags:z.array(productLabelSchema).max(30).default([])});
export const productCreateSchema=z.object({clientProductId:z.string().uuid()}).and(productContentSchema);
export const productBulkImportSchema=z.object({products:z.array(productCreateSchema).min(1).max(500)}).superRefine((value,ctx)=>{const seen=new Set<string>();for(const [index,product] of value.products.entries()){const key=product.sku.trim().toLocaleLowerCase();if(seen.has(key))ctx.addIssue({code:"custom",path:["products",index,"sku"],message:"duplicate sku in import"});seen.add(key);}});
export const productUpdateSchema=productContentSchema.partial().refine(value=>Object.keys(value).length>0,"at least one field is required");
const bulkPriceOperation=z.object({field:z.literal("price"),mode:z.enum(["set","increase","decrease","percentIncrease","percentDecrease"]),value:z.coerce.number().nonnegative().max(99_999_999.99)});
const bulkTagOperation=z.object({field:z.literal("tags"),mode:z.enum(["add","remove","set"]),tags:z.array(productLabelSchema).min(1).max(30)});
const bulkTitleOperation=z.discriminatedUnion("mode",[
  z.object({field:z.literal("title"),mode:z.literal("set"),value:z.string().trim().min(1).max(120)}),
  z.object({field:z.literal("title"),mode:z.enum(["prefix","suffix"]),value:z.string().min(1).max(120)}),
  z.object({field:z.literal("title"),mode:z.literal("replace"),search:z.string().min(1).max(120),value:z.string().max(120)}),
]);
export const productBulkEditSchema=z.object({productIds:z.array(z.string().uuid()).min(1).max(100),operation:z.union([bulkPriceOperation,bulkTagOperation,bulkTitleOperation])}).superRefine((value,ctx)=>{if(new Set(value.productIds).size!==value.productIds.length)ctx.addIssue({code:"custom",path:["productIds"],message:"product ids must be unique"});if(value.operation.field==="price"&&value.operation.mode==="percentDecrease"&&value.operation.value>100)ctx.addIssue({code:"custom",path:["operation","value"],message:"percentage decrease cannot exceed 100"});});
export const productCardSendSchema=z.object({accountId:z.string().uuid(),clientBatchId:z.string().min(8).max(96),productIds:z.array(z.string().uuid()).min(1).max(50),mode:z.enum(["individual","combined"]),showPrice:z.boolean()}).superRefine((value,ctx)=>{if(new Set(value.productIds).size!==value.productIds.length)ctx.addIssue({code:"custom",path:["productIds"],message:"product ids must be unique"});if(value.mode==="combined"&&value.productIds.length>10)ctx.addIssue({code:"custom",path:["productIds"],message:"combined cards support at most 10 products"});});
const orderItemSchema=z.object({name:z.string().trim().min(1).max(120),sku:z.string().trim().min(1).max(80).optional(),quantity:z.coerce.number().int().min(1).max(9999),unitAmount:moneySchema,imageMediaId:z.string().uuid().optional(),productId:z.string().uuid().optional(),clientProductId:z.string().uuid().optional()}).superRefine((value,ctx)=>{if(value.productId&&value.clientProductId)ctx.addIssue({code:"custom",path:["productId"],message:"productId and clientProductId are mutually exclusive"});if(value.clientProductId&&!value.sku)ctx.addIssue({code:"custom",path:["sku"],message:"new products require a sku"});});
const orderFeeSchema=z.object({name:z.string().trim().min(1).max(80),amount:moneySchema.refine(value=>value>0,"fee must be positive")});
export const customerAddressSchema=z.object({
  label:z.string().trim().min(1).max(40),
  recipientName:z.string().trim().max(80).optional().transform(value=>value||undefined),
  phone:z.string().trim().max(40).optional().transform(value=>value||undefined),
  address:z.string().trim().min(1).max(1000),
});
const orderContentSchema=z.object({
  currency:currencySchema,
  description:z.string().trim().max(2000).optional().transform(value=>value||undefined),
  translateOnSend:z.boolean().default(false),
  targetLanguage:languageCodeSchema.optional(),
  items:z.array(orderItemSchema).min(1).max(50),
  fees:z.array(orderFeeSchema).max(20).default([]),
  addressId:z.string().uuid().nullable().optional(),
  newAddress:customerAddressSchema.optional(),
}).superRefine((value,ctx)=>{const total=value.items.reduce((sum,item)=>sum+item.quantity*item.unitAmount,0)+value.fees.reduce((sum,fee)=>sum+fee.amount,0);if(total<=0)ctx.addIssue({code:"custom",path:["items"],message:"order total must be positive"});if(value.translateOnSend&&!value.targetLanguage)ctx.addIssue({code:"custom",path:["targetLanguage"],message:"target language is required"});if(value.addressId&&value.newAddress)ctx.addIssue({code:"custom",path:["addressId"],message:"addressId and newAddress are mutually exclusive"});});
export const orderSchema=z.object({clientOrderId:z.string().uuid()}).and(orderContentSchema);
export const orderUpdateSchema=orderContentSchema;
export const orderAddressSchema=z.object({addressId:z.string().uuid().nullable().optional(),newAddress:customerAddressSchema.optional()}).superRefine((value,ctx)=>{if(value.addressId&&value.newAddress)ctx.addIssue({code:"custom",path:["addressId"],message:"addressId and newAddress are mutually exclusive"});});
export const orderSendSchema=z.object({format:z.enum(["text","image"]).default("text"),clientSendId:z.string().uuid().optional(),translate:z.boolean().optional(),targetLanguage:languageCodeSchema.optional()}).default({format:"text"}).superRefine((value,ctx)=>{if(value.translate===true&&!value.targetLanguage)ctx.addIssue({code:"custom",path:["targetLanguage"],message:"target language is required when translation is requested"});});
const emailSubjectSchema=z.string().trim().min(1).max(200).refine(value=>!/[\r\n]/.test(value),"subject must not contain line breaks");
export const emailProviderSettingsSchema=z.object({
  enabled:z.boolean(),fromName:z.string().trim().min(1).max(120),fromEmail:z.string().trim().email().max(254),replyTo:z.string().trim().email().max(254).or(z.literal("")).default(""),
  host:z.string().trim().max(255).optional(),port:z.coerce.number().int().min(1).max(65535).optional(),tls:z.enum(["tls","starttls"]).optional(),username:z.string().trim().max(255).optional(),secret:z.string().max(4096).optional(),
});
export const emailProviderTestSchema=z.object({recipientEmail:z.string().trim().email().max(254)});
const emailCommon=z.object({clientSendId:z.string().uuid(),recipientEmailIds:z.array(z.string().uuid()).min(1).max(20),subject:emailSubjectSchema,messageBody:z.string().max(5000)});
const emailOrderContent=z.object({type:z.literal("order"),orderId:z.string().uuid(),format:z.enum(["text","image"]),translate:z.boolean().optional(),targetLanguage:languageCodeSchema.optional()});
const emailProductContent=z.object({type:z.literal("product_cards"),productIds:z.array(z.string().uuid()).min(1).max(50),mode:z.enum(["individual","combined"]),showPrice:z.boolean()});
export const emailSendSchema=emailCommon.and(z.object({content:z.discriminatedUnion("type",[emailOrderContent,emailProductContent])})).superRefine((value,ctx)=>{if(value.content.type==="order"&&value.content.translate&&!value.content.targetLanguage)ctx.addIssue({code:"custom",path:["content","targetLanguage"],message:"target language is required"});if(value.content.type==="product_cards"){if(new Set(value.content.productIds).size!==value.content.productIds.length)ctx.addIssue({code:"custom",path:["content","productIds"],message:"product ids must be unique"});if(value.content.mode==="combined"&&value.content.productIds.length>10)ctx.addIssue({code:"custom",path:["content","productIds"],message:"combined cards support at most 10 products"});}});
export const orderSettingsSchema=z.object({numberTemplate:z.string().min(1).max(80),timezone:z.string().min(1).max(100)});
export const paypalSettingsSchema=z.object({
  enabled:z.boolean(),
  environment:z.enum(["sandbox","live"]),
  clientId:z.string().trim().min(1).max(500).optional(),
  clientSecret:z.string().trim().min(1).max(2000).optional(),
  sandboxClientId:z.string().trim().min(1).max(500).optional(),
  sandboxClientSecret:z.string().trim().min(1).max(2000).optional(),
  liveClientId:z.string().trim().min(1).max(500).optional(),
  liveClientSecret:z.string().trim().min(1).max(2000).optional(),
  referenceTemplate:z.string().trim().min(1).max(500).default("Order #{{orderNumber}}"),
  noteTemplate:z.string().trim().max(4000).default("{{orderNotes}}"),
  itemNameTemplate:z.string().trim().min(1).max(500).default("{{productName}}"),
});

export const enrollmentSchema = z.object({ code: z.string().min(16), name: z.string().min(2).max(80), version: z.string(), platform: z.string() });
