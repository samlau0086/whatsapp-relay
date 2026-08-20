import { z } from "zod";
import { WEIGHT_UNITS } from "./weight.js";
import { productCardTemplateSchema } from "./product-card-template.js";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().default(false),
});
export const apiKeyScopeSchema=z.enum(["products:read","products:write","messages:read","messages:send"]);
export const apiKeyCreateSchema=z.object({name:z.string().trim().min(1).max(120),scopes:z.array(apiKeyScopeSchema).min(1).max(4),expiresInDays:z.union([z.literal(30),z.literal(90),z.literal(365),z.null()]).default(90)}).superRefine((value,ctx)=>{if(new Set(value.scopes).size!==value.scopes.length)ctx.addIssue({code:"custom",path:["scopes"],message:"api key scopes must be unique"});});
const templateParameterSchema=z.union([
  z.object({type:z.literal("text"),text:z.string().trim().min(1).max(1024)}),
  z.object({type:z.enum(["image","video","document"]),mediaId:z.string().uuid()}),
]);
const messageTemplateSchema=z.object({
  name:z.string().trim().min(1).max(512),
  language:z.string().trim().min(2).max(35),
  components:z.array(z.object({
    type:z.enum(["header","body","button"]),
    sub_type:z.enum(["quick_reply","url"]).optional(),
    index:z.coerce.number().int().min(0).max(9).optional(),
    parameters:z.array(templateParameterSchema).max(20),
  })).max(20).default([]),
});
const languageCodeSchema=z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,"invalid BCP 47 language code");
export const messageSchema = z.object({
  accountId: z.string().uuid(),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().min(8).max(128),
  type: z.enum(["text","image","video","audio","document","location","contact","template"]),
  text: z.string().max(65536).optional(),
  translationSourceText: z.string().trim().min(1).max(65536).optional(),
  translationTargetLanguage: languageCodeSchema.optional(),
  mediaId: z.string().uuid().optional(),
  quotedMessageId: z.string().uuid().optional(),
  template: messageTemplateSchema.optional(),
}).superRefine((value, ctx) => {
  if(value.type==="template"&&!value.template)ctx.addIssue({code:"custom",path:["template"],message:"template message requires template data"});
  if (value.type === "text" && !value.text?.trim()) ctx.addIssue({ code:"custom", path:["text"], message:"文本消息不能为空" });
  if (value.translationSourceText && !["text","image","video","audio","document"].includes(value.type)) ctx.addIssue({ code:"custom", path:["translationSourceText"], message:"该消息类型不能保存翻译原文" });
  if (value.translationSourceText && !value.text?.trim()) ctx.addIssue({ code:"custom", path:["text"], message:"翻译后的消息必须包含发送文本" });
  if (Boolean(value.translationSourceText) !== Boolean(value.translationTargetLanguage)) ctx.addIssue({ code:"custom", path:["translationTargetLanguage"], message:"翻译原文和目标语言必须同时提供" });
  if (["image","video","audio","document"].includes(value.type) && !value.mediaId) ctx.addIssue({ code:"custom", path:["mediaId"], message:"媒体消息必须提供 mediaId" });
});

export const messageRetrySchema = z.object({
  clientMessageId: z.string().min(8).max(128),
});

export const messageCommentSchema=z.object({body:z.string().trim().min(1).max(4000)});
export const messageCommentVoteSchema=z.object({value:z.union([z.literal(1),z.literal(-1)])});

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
  conversationId:z.string().uuid().optional(),
});
export const productNameTranslationPreviewSchema=z.object({
  names:z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  targetLanguage:languageCodeSchema,
});

export const messageTranslationsSchema=z.object({
  messageIds:z.array(z.string().uuid()).min(1).max(50),
  targetLanguage:languageCodeSchema,
  sourceLanguage:languageCodeSchema.optional(),
  generateAudio:z.boolean().default(false),
});

export const newConversationSchema = z.object({
  accountId: z.string().uuid(),
  phone: z.string().transform(value=>value.trim().replace(/[\s()+.-]/g,"")).refine(value=>/^[1-9]\d{6,14}$/.test(value),"请输入包含国家代码的有效号码"),
  displayName: z.string().trim().min(1).max(80).optional(),
  firstMessage: z.string().trim().min(1).max(65536).optional(),
  message:z.discriminatedUnion("type",[
    z.object({type:z.literal("text"),text:z.string().trim().min(1).max(65536)}),
    z.object({type:z.literal("template"),template:messageTemplateSchema}),
  ]).optional(),
  clientMessageId: z.string().min(8).max(128),
});

export const customerStageSchema=z.enum(["new","considering","qualified","won","lost"]);
export const conversationTransferSchema=z.object({accountId:z.string().uuid()});
export const conversationAgentModeSchema=z.enum(["cautious","full","human_paused"]);
export const contactAliasSchema=z.object({alias:z.string().trim().max(80)});
const whatsappPhoneSchema=z.string().transform(value=>value.trim().replace(/[\s()+.-]/g,"")).refine(value=>/^[1-9]\d{6,14}$/.test(value),"请输入包含国家代码的有效号码");
const contactNamePartSchema=z.string().trim().max(80);
const contactOrganizationFieldSchema=z.string().trim().max(160);
const contactLocationFieldSchema=z.string().trim().max(100);
export const contactCreateSchema=z.object({accountId:z.string().uuid(),name:z.string().trim().max(240).optional(),firstName:contactNamePartSchema.default(""),middleName:contactNamePartSchema.default(""),lastName:contactNamePartSchema.default(""),companyName:contactOrganizationFieldSchema.default(""),jobTitle:contactOrganizationFieldSchema.default(""),country:contactLocationFieldSchema.default(""),province:contactLocationFieldSchema.default(""),city:contactLocationFieldSchema.default(""),phone:whatsappPhoneSchema}).refine(value=>Boolean(value.name?.trim()||value.firstName||value.middleName||value.lastName),{path:["firstName"],message:"请输入联系人姓名"});
const contactEmailSchema=z.object({label:z.string().trim().max(40).default(""),email:z.string().trim().toLowerCase().email().max(254),isPrimary:z.boolean().default(false)});
const contactMethodSchema=z.object({type:z.enum(["phone","wechat","telegram","line","website","facebook","x","linkedin","instagram","other"]),label:z.string().trim().max(40).default(""),value:z.string().trim().min(1).max(500)});
const contactAddressSchema=z.object({id:z.string().uuid().optional(),label:z.string().trim().min(1).max(40),recipientName:z.string().trim().max(80).default(""),phone:z.string().trim().max(40).default(""),address:z.string().trim().min(1).max(1000),countryCode:z.string().trim().regex(/^[A-Za-z]{2}$/).or(z.literal("")).transform(value=>value?value.toUpperCase():undefined).optional(),province:z.string().trim().max(100).transform(value=>value||undefined).optional(),city:z.string().trim().max(100).transform(value=>value||undefined).optional(),street1:z.string().trim().max(500).transform(value=>value||undefined).optional(),street2:z.string().trim().max(500).transform(value=>value||undefined).optional(),postalCode:z.string().trim().max(40).transform(value=>value||undefined).optional(),isDefault:z.boolean().default(false)});
const calendarDateSchema=z.object({month:z.coerce.number().int().min(1).max(12),day:z.coerce.number().int().min(1).max(31),year:z.coerce.number().int().min(1900).max(2200).nullable().optional()}).superRefine((value,ctx)=>{const year=value.year??2024;if(new Date(Date.UTC(year,value.month-1,value.day)).getUTCMonth()!==value.month-1)ctx.addIssue({code:"custom",path:["day"],message:"invalid calendar date"});});
const contactSpecialDateSchema=calendarDateSchema.and(z.object({id:z.string().uuid().optional(),kind:z.enum(["anniversary","birthday","custom"]).default("anniversary"),label:z.string().trim().min(1).max(80),leadDays:z.coerce.number().int().min(0).max(365).nullable().optional()}));
export const contactUpdateSchema=z.object({alias:z.string().trim().max(80),firstName:contactNamePartSchema.optional(),middleName:contactNamePartSchema.optional(),lastName:contactNamePartSchema.optional(),companyName:contactOrganizationFieldSchema.optional(),jobTitle:contactOrganizationFieldSchema.optional(),country:contactLocationFieldSchema.optional(),province:contactLocationFieldSchema.optional(),city:contactLocationFieldSchema.optional(),phone:whatsappPhoneSchema.optional(),note:z.string().trim().max(5000),timezone:z.string().trim().max(100).nullable().optional(),preferredLanguage:z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35).nullable().optional(),birthday:calendarDateSchema.nullable().optional(),specialDates:z.array(contactSpecialDateSchema).max(30).optional(),emails:z.array(contactEmailSchema).max(20),methods:z.array(contactMethodSchema).max(30),addresses:z.array(contactAddressSchema).max(20).default([])}).superRefine((value,ctx)=>{
  const primaryCount=value.emails.filter(item=>item.isPrimary).length;
  if(primaryCount>1)ctx.addIssue({code:"custom",path:["emails"],message:"only one primary email is allowed"});
  const seen=new Set<string>();
  for(const [index,item] of value.emails.entries()){if(seen.has(item.email))ctx.addIssue({code:"custom",path:["emails",index,"email"],message:"duplicate email"});seen.add(item.email);}
  if(value.addresses.filter(item=>item.isDefault).length>1)ctx.addIssue({code:"custom",path:["addresses"],message:"only one default address is allowed"});
  value.addresses.forEach((item,index)=>{if(item.province&&!item.countryCode)ctx.addIssue({code:"custom",path:["addresses",index,"countryCode"],message:"country code is required when province is set"});});
}).transform(value=>({...value,emails:value.emails.map((item,index)=>({...item,isPrimary:value.emails.some(email=>email.isPrimary)?item.isPrimary:index===0})),addresses:value.addresses.map((item,index)=>({...item,isDefault:value.addresses.some(address=>address.isDefault)?item.isDefault:index===0}))}));

export const taskStatusSchema=z.enum(["planned","in_progress","waiting_approval","scheduled","completed","overdue","failed","cancelled"]);
export const taskToolSchema=z.enum(["knowledge_search","contact_profile_read","conversation_memory_read","recent_messages_read","order_summary_read","create_task","generate_draft","queue_message"]);
const recurrenceSchema=z.object({kind:z.enum(["daily","weekly","monthly","yearly"]),interval:z.coerce.number().int().min(1).max(365).default(1),daysOfWeek:z.array(z.coerce.number().int().min(0).max(6)).max(7).optional(),until:z.string().datetime({offset:true}).nullable().optional()}).superRefine((value,ctx)=>{if(value.kind==="weekly"&&!value.daysOfWeek?.length)ctx.addIssue({code:"custom",path:["daysOfWeek"],message:"weekly recurrence requires daysOfWeek"});});
const taskContentBase=z.object({
  accountId:z.string().uuid(),contactId:z.string().uuid().nullable().optional(),conversationId:z.string().uuid().nullable().optional(),assignedUserId:z.string().uuid().nullable().optional(),
  kind:z.enum(["general","message"]).default("general"),title:z.string().trim().min(1).max(200),description:z.string().trim().max(10000).default(""),status:taskStatusSchema.default("planned"),progress:z.coerce.number().int().min(0).max(100).default(0),
  startAt:z.string().datetime({offset:true}),dueAt:z.string().datetime({offset:true}),sendAt:z.string().datetime({offset:true}).nullable().optional(),sendMode:z.enum(["approval","auto"]).default("approval"),recurrence:recurrenceSchema.nullable().optional(),personaOverride:z.string().trim().max(5000).nullable().optional(),toolOverrides:z.array(taskToolSchema).max(8).nullable().optional(),dependencyIds:z.array(z.string().uuid()).max(50).default([]),
});
const validateTaskTimes=(value:Record<string,unknown>,ctx:z.RefinementCtx)=>{if(value.startAt&&value.dueAt&&new Date(String(value.dueAt))<new Date(String(value.startAt)))ctx.addIssue({code:"custom",path:["dueAt"],message:"dueAt must not precede startAt"});if(value.kind==="message"&&!value.contactId)ctx.addIssue({code:"custom",path:["contactId"],message:"message tasks require a contact"});if(value.kind==="general"&&value.sendAt)ctx.addIssue({code:"custom",path:["sendAt"],message:"general tasks cannot have sendAt"});if(value.kind==="message"&&!value.sendAt)ctx.addIssue({code:"custom",path:["sendAt"],message:"message tasks require sendAt"});};
export const taskCreateSchema=taskContentBase.superRefine(validateTaskTimes);
export const taskUpdateSchema=taskContentBase.partial().refine(value=>Object.keys(value).length>0,"at least one field is required").superRefine(validateTaskTimes);
export const taskDraftResolveSchema=z.object({text:z.string().trim().min(1).max(65536).optional()});
export const taskRescheduleSchema=z.object({startAt:z.string().datetime({offset:true}),dueAt:z.string().datetime({offset:true}),sendAt:z.string().datetime({offset:true}).nullable().optional()}).superRefine((value,ctx)=>{if(new Date(value.dueAt)<new Date(value.startAt))ctx.addIssue({code:"custom",path:["dueAt"],message:"dueAt must not precede startAt"});});
const holidayDefinitionSchema=z.object({id:z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),name:z.string().trim().min(1).max(80),month:z.coerce.number().int().min(1).max(12),day:z.coerce.number().int().min(1).max(31)}).superRefine((value,ctx)=>{if(new Date(Date.UTC(2024,value.month-1,value.day)).getUTCMonth()!==value.month-1)ctx.addIssue({code:"custom",path:["day"],message:"invalid calendar date"});});
export const accountTaskSettingsSchema=z.object({timezone:z.string().trim().min(1).max(100),holidays:z.array(holidayDefinitionSchema).max(50).superRefine((items,ctx)=>{const ids=new Set<string>();for(const [index,item] of items.entries()){if(ids.has(item.id))ctx.addIssue({code:"custom",path:[index,"id"],message:"duplicate holiday id"});ids.add(item.id);}}),holidayRegions:z.array(z.string().trim().min(1).max(40)).min(1).max(20).default(["global"]),defaultLeadDays:z.coerce.number().int().min(0).max(365),draftLeadHours:z.coerce.number().int().min(0).max(8760),defaultSendMode:z.enum(["approval","auto"]),leapDayPolicy:z.enum(["feb28","mar1","leap_year_only"]),defaultTools:z.array(taskToolSchema).max(8)});
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
export const productLabelCatalogUpdateSchema=z.object({currentName:z.string().trim().min(1).max(40),name:z.string().trim().min(1).max(40),color:z.string().regex(/^#[0-9A-Fa-f]{6}$/)});
export const productLabelCatalogDeleteSchema=z.object({name:z.string().trim().min(1).max(40)});
export const productPriceTierSchema=z.object({minQuantity:z.coerce.number().int().min(1).max(999999),unitAmount:moneySchema,costAmount:moneySchema.optional(),profitMargin:z.coerce.number().min(0).lt(100).refine(value=>Math.abs(value*10000-Math.round(value*10000))<1e-7,"profit margin supports at most four decimals").optional()}).superRefine((value,ctx)=>{if((value.costAmount===undefined)!==(value.profitMargin===undefined))ctx.addIssue({code:"custom",path:[value.costAmount===undefined?"costAmount":"profitMargin"],message:"cost amount and profit margin must be provided together"});if(value.costAmount!==undefined&&value.profitMargin!==undefined&&Math.round(value.costAmount/(1-value.profitMargin/100)*100)/100!==value.unitAmount)ctx.addIssue({code:"custom",path:["unitAmount"],message:"unit amount must match cost amount and profit margin"});});
export const productVariantSchema=z.object({
  id:z.string().uuid().optional(),
  attributes:z.record(z.string().trim().min(1).max(40),z.string().trim().min(1).max(80)).refine(value=>Object.keys(value).length>0,"variant attributes are required"),
  sku:z.string().trim().min(1).max(80),
  priceTiers:z.array(productPriceTierSchema).min(1).max(50).superRefine((tiers,ctx)=>{if(tiers[0]?.minQuantity!==1)ctx.addIssue({code:"custom",path:[0,"minQuantity"],message:"first tier must start at quantity 1"});for(let index=1;index<tiers.length;index++)if(tiers[index].minQuantity<=tiers[index-1].minQuantity)ctx.addIssue({code:"custom",path:[index,"minQuantity"],message:"tier quantities must be strictly increasing"});}),
  imageMediaId:z.string().uuid().nullable().optional(),
}).superRefine((value,ctx)=>{if(Object.keys(value.attributes).length>3)ctx.addIssue({code:"custom",path:["attributes"],message:"at most three variant dimensions are supported"});});
const productVariantsSchema=z.array(productVariantSchema).max(500).superRefine((variants,ctx)=>{const combos=new Set<string>(),skus=new Set<string>();for(const [index,variant] of variants.entries()){const combo=Object.entries(variant.attributes).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join("|");if(combos.has(combo))ctx.addIssue({code:"custom",path:[index,"attributes"],message:"duplicate variant combination"});combos.add(combo);const sku=variant.sku.toLocaleLowerCase();if(skus.has(sku))ctx.addIssue({code:"custom",path:[index,"sku"],message:"duplicate variant sku"});skus.add(sku);}});
const weightAmountSchema=z.coerce.number().positive().max(99_999_999);
const optionalWeightFields={weightAmount:weightAmountSchema.nullable().optional(),weightUnit:z.enum(WEIGHT_UNITS).nullable().optional()};
function validateWeightPair(value:{weightAmount?:number|null;weightUnit?:typeof WEIGHT_UNITS[number]|null},ctx:z.RefinementCtx){
  const hasAmount=value.weightAmount!==undefined&&value.weightAmount!==null,hasUnit=value.weightUnit!==undefined&&value.weightUnit!==null;
  if(hasAmount!==hasUnit)ctx.addIssue({code:"custom",path:[hasAmount?"weightUnit":"weightAmount"],message:"weight amount and unit must be provided together"});
}
const productPriceTiersSchema=z.array(productPriceTierSchema).min(1).max(50).superRefine((tiers,ctx)=>{if(tiers[0]?.minQuantity!==1)ctx.addIssue({code:"custom",path:[0,"minQuantity"],message:"first tier must start at quantity 1"});for(let index=1;index<tiers.length;index++)if(tiers[index].minQuantity<=tiers[index-1].minQuantity)ctx.addIssue({code:"custom",path:[index,"minQuantity"],message:"tier quantities must be strictly increasing"});});
const supplierLinkSchema=z.object({label:z.string().trim().max(120).default(""),url:z.string().trim().url().max(2000),supplyPrice:moneySchema.optional()});
const productContentFields={name:z.string().trim().min(1).max(120),sku:z.string().trim().min(1).max(80),description:z.string().trim().max(2000).default(""),category:z.string().trim().max(80).default(""),brand:z.string().trim().max(80).default(""),priceTiers:productPriceTiersSchema,currency:currencySchema,imageMediaId:z.string().uuid().nullable().optional(),galleryMediaIds:z.array(z.string().uuid()).max(12).refine(value=>new Set(value).size===value.length,"gallery images must be unique").optional(),shippingClassId:z.string().uuid().nullable().optional(),tags:z.array(productLabelSchema).max(30).default([]),supplierLinks:z.array(supplierLinkSchema).max(30).default([]),internalNote:z.string().trim().max(4000).default(""),variants:productVariantsSchema.optional(),...optionalWeightFields};
const productContentSchema=z.object(productContentFields).superRefine(validateWeightPair);
export const productCreateSchema=z.object({clientProductId:z.string().uuid()}).and(productContentSchema);
const productBulkImportItemSchema=z.object({clientProductId:z.string().uuid(),sku:z.string().trim().min(1).max(80),name:z.string().trim().min(1).max(120),description:z.string().trim().max(2000).optional(),category:z.string().trim().max(80).optional(),brand:z.string().trim().max(80).optional(),priceTiers:productPriceTiersSchema.optional(),currency:currencySchema.optional(),imageMediaId:z.string().uuid().nullable().optional(),galleryMediaIds:z.array(z.string().uuid()).max(12).refine(value=>new Set(value).size===value.length,"gallery images must be unique").optional(),shippingClassId:z.string().uuid().nullable().optional(),tags:z.array(productLabelSchema).max(30).optional(),supplierLinks:z.array(supplierLinkSchema).max(30).optional(),internalNote:z.string().trim().max(4000).optional(),variants:productVariantsSchema.optional(),...optionalWeightFields}).superRefine(validateWeightPair);
export const productBulkImportSchema=z.object({products:z.array(productBulkImportItemSchema).min(1).max(500)}).superRefine((value,ctx)=>{const seen=new Set<string>();for(const [index,product] of value.products.entries()){const key=product.sku.trim().toLocaleLowerCase();if(seen.has(key))ctx.addIssue({code:"custom",path:["products",index,"sku"],message:"duplicate sku in import"});seen.add(key);}});
export const productUpdateSchema=z.object(productContentFields).partial().superRefine((value,ctx)=>{if(!Object.keys(value).length)ctx.addIssue({code:"custom",message:"at least one field is required"});validateWeightPair(value,ctx);});
export const productSkuQuerySchema=z.object({skus:z.array(z.string().trim().min(1).max(80)).min(1).max(500)}).superRefine((value,ctx)=>{const seen=new Set<string>();for(const [index,sku] of value.skus.entries()){const key=sku.toLocaleLowerCase();if(seen.has(key))ctx.addIssue({code:"custom",path:["skus",index],message:"product skus must be unique"});seen.add(key);}});
const productBulkUpdateItemSchema=z.object({sku:z.string().trim().min(1).max(80),name:z.string().trim().min(1).max(120).optional(),description:z.string().trim().max(2000).optional(),category:z.string().trim().max(80).optional(),brand:z.string().trim().max(80).optional(),tags:z.array(productLabelSchema).max(30).optional()}).refine(value=>value.name!==undefined||value.description!==undefined||value.category!==undefined||value.brand!==undefined||value.tags!==undefined,"at least one update field is required");
export const productBulkUpdateSchema=z.object({products:z.array(productBulkUpdateItemSchema).min(1).max(100)}).superRefine((value,ctx)=>{const seen=new Set<string>();for(const [index,product] of value.products.entries()){const key=product.sku.toLocaleLowerCase();if(seen.has(key))ctx.addIssue({code:"custom",path:["products",index,"sku"],message:"product skus must be unique"});seen.add(key);}});
const bulkPriceOperation=z.object({field:z.literal("price"),mode:z.enum(["set","increase","decrease","percentIncrease","percentDecrease"]),value:z.coerce.number().nonnegative().max(99_999_999.99)});
const bulkTagOperation=z.object({field:z.literal("tags"),mode:z.enum(["add","remove","set"]),tags:z.array(productLabelSchema).min(1).max(30)});
const bulkCategoryOperation=z.object({field:z.literal("category"),mode:z.literal("set"),value:z.string().trim().max(80)});
const bulkShippingClassOperation=z.object({field:z.literal("shippingClass"),mode:z.literal("set"),shippingClassId:z.string().uuid().nullable()});
const bulkTitleOperation=z.discriminatedUnion("mode",[
  z.object({field:z.literal("title"),mode:z.literal("set"),value:z.string().trim().min(1).max(120)}),
  z.object({field:z.literal("title"),mode:z.enum(["prefix","suffix"]),value:z.string().min(1).max(120)}),
  z.object({field:z.literal("title"),mode:z.literal("replace"),search:z.string().min(1).max(120),value:z.string().max(120)}),
]);
const bulkSkuOperation=z.discriminatedUnion("mode",[
  z.object({field:z.literal("sku"),mode:z.literal("set"),value:z.string().trim().min(1).max(80)}),
  z.object({field:z.literal("sku"),mode:z.enum(["prefix","suffix"]),value:z.string().min(1).max(80)}),
  z.object({field:z.literal("sku"),mode:z.literal("replace"),search:z.string().min(1).max(80),value:z.string().max(80)}),
]);
export const productBulkEditSchema=z.object({productIds:z.array(z.string().uuid()).min(1).max(100),operation:z.union([bulkPriceOperation,bulkTagOperation,bulkCategoryOperation,bulkShippingClassOperation,bulkTitleOperation,bulkSkuOperation])}).superRefine((value,ctx)=>{if(new Set(value.productIds).size!==value.productIds.length)ctx.addIssue({code:"custom",path:["productIds"],message:"product ids must be unique"});if(value.operation.field==="price"&&value.operation.mode==="percentDecrease"&&value.operation.value>100)ctx.addIssue({code:"custom",path:["operation","value"],message:"percentage decrease cannot exceed 100"});});
export const productCardBatchIdSchema=z.string().min(8).max(96).regex(/^[A-Za-z0-9_-]+$/,"invalid product card batch id");
export const productCardBatchStatusSchema=z.object({accountId:z.string().uuid(),batchId:productCardBatchIdSchema});
const productCardGridSchema=z.object({rows:z.number().int().min(1).max(10),columns:z.number().int().min(1).max(10)});
export const productCardSendSchema=z.object({accountId:z.string().uuid(),clientBatchId:productCardBatchIdSchema,productIds:z.array(z.string().uuid()).min(1).max(50),mode:z.enum(["individual","combined","grid"]),grid:z.optional(productCardGridSchema),gridOutputFormat:z.enum(["image","pdf"]).optional(),showPrice:z.boolean(),caption:z.string().max(65536).optional(),translationSourceText:z.string().max(65536).optional(),translationTargetLanguage:languageCodeSchema.optional(),translatedProductNames:z.array(z.object({productId:z.string().uuid(),name:z.string().trim().min(1).max(120)})).max(50).optional(),translatedTemplate:productCardTemplateSchema.optional()}).superRefine((value,ctx)=>{if(new Set(value.productIds).size!==value.productIds.length)ctx.addIssue({code:"custom",path:["productIds"],message:"product ids must be unique"});if(value.mode==="combined"&&value.productIds.length>10)ctx.addIssue({code:"custom",path:["productIds"],message:"combined cards support at most 10 products"});if(value.mode==="grid"&&!value.grid)ctx.addIssue({code:"custom",path:["grid"],message:"grid layout is required"});if(value.mode!=="grid"&&value.grid)ctx.addIssue({code:"custom",path:["grid"],message:"grid layout is only valid for grid mode"});if(value.mode!=="grid"&&value.gridOutputFormat)ctx.addIssue({code:"custom",path:["gridOutputFormat"],message:"grid layout is only valid for grid mode"});if(value.translationSourceText&&!value.caption?.trim())ctx.addIssue({code:"custom",path:["translationSourceText"],message:"translated product card captions require a caption"});const translatedIds=value.translatedProductNames?.map(item=>item.productId)??[],hasTranslation=Boolean(value.translationSourceText||translatedIds.length||value.translatedTemplate);if(hasTranslation!==Boolean(value.translationTargetLanguage))ctx.addIssue({code:"custom",path:["translationTargetLanguage"],message:"translated content and target language must be provided together"});if(new Set(translatedIds).size!==translatedIds.length)ctx.addIssue({code:"custom",path:["translatedProductNames"],message:"translated product ids must be unique"});if(translatedIds.some(id=>!value.productIds.includes(id)))ctx.addIssue({code:"custom",path:["translatedProductNames"],message:"translated product ids must be selected products"});if(translatedIds.length&&translatedIds.length!==value.productIds.length)ctx.addIssue({code:"custom",path:["translatedProductNames"],message:"all selected product names must be translated"});});
export const materialSendBatchIdSchema=z.string().min(8).max(96).regex(/^[A-Za-z0-9_-]+$/,"invalid material send batch id");
export const materialSendBatchStatusSchema=z.object({accountId:z.string().uuid(),batchId:materialSendBatchIdSchema});
export const materialSendSchema=z.object({
  accountId:z.string().uuid(),
  clientBatchId:materialSendBatchIdSchema,
  materialBatchIds:z.array(z.string().uuid()).min(1).max(10),
  mediaIds:z.array(z.string().uuid()).min(1).max(10),
  mode:z.enum(["stitched","individual"]),
  orientation:z.enum(["vertical","horizontal"]).default("vertical"),
  caption:z.string().max(65536).optional(),
  translationSourceText:z.string().trim().min(1).max(65536).optional(),
  translationTargetLanguage:languageCodeSchema.optional(),
}).superRefine((value,ctx)=>{if(new Set(value.materialBatchIds).size!==value.materialBatchIds.length)ctx.addIssue({code:"custom",path:["materialBatchIds"],message:"material batch ids must be unique"});if(new Set(value.mediaIds).size!==value.mediaIds.length)ctx.addIssue({code:"custom",path:["mediaIds"],message:"media ids must be unique"});if(value.translationSourceText&&!value.caption?.trim())ctx.addIssue({code:"custom",path:["translationSourceText"],message:"translated material captions require a caption"});if(Boolean(value.translationSourceText)!==Boolean(value.translationTargetLanguage))ctx.addIssue({code:"custom",path:["translationTargetLanguage"],message:"translation source and target language must be provided together"});});
const orderItemSchema=z.object({name:z.string().trim().min(1).max(120),sku:z.string().trim().min(1).max(80).optional(),quantity:z.coerce.number().int().min(1).max(9999),unitAmount:moneySchema,imageMediaId:z.string().uuid().optional(),productId:z.string().uuid().optional(),variantId:z.string().uuid().optional(),clientProductId:z.string().uuid().optional(),shippingClassId:z.string().uuid().nullable().optional(),...optionalWeightFields}).superRefine((value,ctx)=>{validateWeightPair(value,ctx);if(value.productId&&value.clientProductId)ctx.addIssue({code:"custom",path:["productId"],message:"productId and clientProductId are mutually exclusive"});if(value.variantId&&!value.productId)ctx.addIssue({code:"custom",path:["variantId"],message:"variantId requires productId"});if(value.clientProductId&&!value.sku)ctx.addIssue({code:"custom",path:["sku"],message:"new products require a sku"});});
const orderFeeSchema=z.object({name:z.string().trim().min(1).max(80),amount:moneySchema.refine(value=>value>0,"fee must be positive")});
export const ORDER_BUSINESS_STATUSES=["quotation","pending_confirmation","pending_payment","paid","processing","shipped","completed","cancelled"] as const;
export const orderBusinessStatusSchema=z.enum(ORDER_BUSINESS_STATUSES);
const destinationCountryCodeSchema=z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).transform(value=>value.toUpperCase());
export const customerAddressSchema=z.object({
  label:z.string().trim().min(1).max(40),
  recipientName:z.string().trim().max(80).optional().transform(value=>value||undefined),
  phone:z.string().trim().max(40).optional().transform(value=>value||undefined),
  address:z.string().trim().min(1).max(1000),
  countryCode:destinationCountryCodeSchema.nullable().optional().transform(value=>value||undefined),
  province:z.string().trim().max(100).nullable().optional().transform(value=>value||undefined),
  city:z.string().trim().max(100).nullable().optional().transform(value=>value||undefined),
  street1:z.string().trim().max(500).nullable().optional().transform(value=>value||undefined),
  street2:z.string().trim().max(500).nullable().optional().transform(value=>value||undefined),
  postalCode:z.string().trim().max(40).nullable().optional().transform(value=>value||undefined),
}).superRefine((value,ctx)=>{if(value.province&&!value.countryCode)ctx.addIssue({code:"custom",path:["countryCode"],message:"country code is required when province is set"});});
const orderContentSchema=z.object({
  currency:currencySchema,
  businessStatus:orderBusinessStatusSchema.default("quotation"),
  weightUnit:z.enum(WEIGHT_UNITS).default("kg"),
  paymentProfileId:z.string().uuid().nullable().optional(),
  description:z.string().trim().max(2000).optional().transform(value=>value||undefined),
  internalComment:z.string().trim().max(2000).optional().transform(value=>value||undefined),
  translateOnSend:z.boolean().default(false),
  targetLanguage:languageCodeSchema.optional(),
  items:z.array(orderItemSchema).min(1).max(50),
  fees:z.array(orderFeeSchema).max(20).default([]),
  shippingAmount:moneySchema.nullable().optional(),
  shippingTemplateId:z.string().uuid().nullable().optional(),
  acceptCalculatedShipping:z.boolean().default(false),
  addressId:z.string().uuid().nullable().optional(),
  newAddress:customerAddressSchema.optional(),
}).superRefine((value,ctx)=>{const total=value.items.reduce((sum,item)=>sum+item.quantity*item.unitAmount,0)+value.fees.reduce((sum,fee)=>sum+fee.amount,0)+(value.shippingAmount??0);if(total<=0)ctx.addIssue({code:"custom",path:["items"],message:"order total must be positive"});if(value.acceptCalculatedShipping&&!value.shippingTemplateId)ctx.addIssue({code:"custom",path:["shippingTemplateId"],message:"shipping template is required when accepting a quote"});if(value.translateOnSend&&!value.targetLanguage)ctx.addIssue({code:"custom",path:["targetLanguage"],message:"target language is required"});if(value.addressId&&value.newAddress)ctx.addIssue({code:"custom",path:["addressId"],message:"addressId and newAddress are mutually exclusive"});});
export const orderSchema=z.object({clientOrderId:z.string().uuid()}).and(orderContentSchema);
export const orderUpdateSchema=orderContentSchema;
export const orderBusinessStatusUpdateSchema=z.object({businessStatus:orderBusinessStatusSchema});
export const orderTrackingSchema=z.object({
  carrier:z.string().trim().min(1).max(80),
  trackingNumber:z.string().trim().min(1).max(160),
  trackingUrl:z.string().trim().max(2000).optional().transform(value=>value||undefined).refine(value=>!value||/^https?:\/\//i.test(value),"tracking URL must be http(s)"),
});
export const orderAddressSchema=z.object({addressId:z.string().uuid().nullable().optional(),newAddress:customerAddressSchema.optional()}).superRefine((value,ctx)=>{if(value.addressId&&value.newAddress)ctx.addIssue({code:"custom",path:["addressId"],message:"addressId and newAddress are mutually exclusive"});});
export const orderSendSchema=z.object({format:z.enum(["text","image","pdf"]).default("text"),clientSendId:z.string().uuid().optional(),translate:z.boolean().optional(),targetLanguage:languageCodeSchema.optional()}).default({format:"text"}).superRefine((value,ctx)=>{if(value.translate===true&&!value.targetLanguage)ctx.addIssue({code:"custom",path:["targetLanguage"],message:"target language is required when translation is requested"});});
const emailSubjectSchema=z.string().trim().min(1).max(200).refine(value=>!/[\r\n]/.test(value),"subject must not contain line breaks");
export const emailProviderSettingsSchema=z.object({
  enabled:z.boolean(),fromName:z.string().trim().min(1).max(120),fromEmail:z.string().trim().email().max(254),replyTo:z.string().trim().email().max(254).or(z.literal("")).default(""),
  host:z.string().trim().max(255).optional(),port:z.coerce.number().int().min(1).max(65535).optional(),tls:z.enum(["tls","starttls"]).optional(),username:z.string().trim().max(255).optional(),secret:z.string().max(4096).optional(),
});
export const emailProviderTestSchema=z.object({recipientEmail:z.string().trim().email().max(254)});
const emailCommon=z.object({clientSendId:z.string().uuid(),recipientEmailIds:z.array(z.string().uuid()).min(1).max(20),subject:emailSubjectSchema,messageBody:z.string().max(5000)});
const emailOrderContent=z.object({type:z.literal("order"),orderId:z.string().uuid(),format:z.enum(["text","image","pdf"]),translate:z.boolean().optional(),targetLanguage:languageCodeSchema.optional()});
const emailProductContent=z.object({type:z.literal("product_cards"),productIds:z.array(z.string().uuid()).min(1).max(50),mode:z.enum(["individual","combined","grid"]),grid:z.optional(productCardGridSchema),gridOutputFormat:z.enum(["image","pdf"]).optional(),showPrice:z.boolean()});
export const emailSendSchema=emailCommon.and(z.object({content:z.discriminatedUnion("type",[emailOrderContent,emailProductContent])})).superRefine((value,ctx)=>{if(value.content.type==="order"&&value.content.translate&&!value.content.targetLanguage)ctx.addIssue({code:"custom",path:["content","targetLanguage"],message:"target language is required"});if(value.content.type==="product_cards"){if(new Set(value.content.productIds).size!==value.content.productIds.length)ctx.addIssue({code:"custom",path:["content","productIds"],message:"product ids must be unique"});if(value.content.mode==="combined"&&value.content.productIds.length>10)ctx.addIssue({code:"custom",path:["content","productIds"],message:"combined cards support at most 10 products"});if(value.content.mode==="grid"&&!value.content.grid)ctx.addIssue({code:"custom",path:["content","grid"],message:"grid layout is required"});if(value.content.mode!=="grid"&&value.content.grid)ctx.addIssue({code:"custom",path:["content","grid"],message:"grid layout is only valid for grid mode"});if(value.content.mode!=="grid"&&value.content.gridOutputFormat)ctx.addIssue({code:"custom",path:["content","gridOutputFormat"],message:"grid output format is only valid for grid mode"});}});
export const orderSettingsSchema=z.object({numberTemplate:z.string().min(1).max(80),timezone:z.string().min(1).max(100)});

export const shippingClassCreateSchema=z.object({name:z.string().trim().min(1).max(80),enabled:z.boolean().default(true)});
export const shippingClassUpdateSchema=shippingClassCreateSchema.partial().refine(value=>Object.keys(value).length>0,"at least one field is required");
const shippingDestinationFields={destinationCountryCode:destinationCountryCodeSchema.nullable().default(null),destinationProvince:z.string().trim().max(100).nullable().default(null)};
const quantityShippingRuleSchema=z.object({shippingClassId:z.string().uuid().nullable().default(null),...shippingDestinationFields,mode:z.literal("quantity"),firstItemPrice:moneySchema,additionalItemPrice:moneySchema});
const weightShippingRuleSchema=z.object({shippingClassId:z.string().uuid().nullable().default(null),...shippingDestinationFields,mode:z.literal("weight"),firstWeight:weightAmountSchema,additionalWeight:weightAmountSchema,weightUnit:z.enum(WEIGHT_UNITS),firstWeightPrice:moneySchema,additionalWeightPrice:moneySchema});
export const shippingRuleSchema=z.discriminatedUnion("mode",[quantityShippingRuleSchema,weightShippingRuleSchema]);
const shippingTemplateContentSchema=z.object({name:z.string().trim().min(1).max(120),currency:currencySchema,enabled:z.boolean().default(true),isDefault:z.boolean().default(false),rules:z.array(shippingRuleSchema).min(1).max(101)}).superRefine((value,ctx)=>{
  const defaults=value.rules.filter(rule=>rule.shippingClassId===null&&rule.destinationCountryCode===null&&rule.destinationProvince===null);
  if(defaults.length!==1)ctx.addIssue({code:"custom",path:["rules"],message:"exactly one default rule is required"});
  const keys=value.rules.map(rule=>`${rule.shippingClassId??""}|${rule.destinationCountryCode??""}|${rule.destinationProvince?.toLocaleLowerCase()??""}`);
  if(new Set(keys).size!==keys.length)ctx.addIssue({code:"custom",path:["rules"],message:"shipping rules must be unique for each destination and class"});
  value.rules.forEach((rule,index)=>{if(rule.destinationProvince&&!rule.destinationCountryCode)ctx.addIssue({code:"custom",path:["rules",index,"destinationCountryCode"],message:"country code is required when province is set"});});
  if(value.isDefault&&!value.enabled)ctx.addIssue({code:"custom",path:["enabled"],message:"default template must be enabled"});
});
export const shippingTemplateCreateSchema=shippingTemplateContentSchema;
export const shippingTemplateUpdateSchema=shippingTemplateContentSchema;
export const shippingQuoteSchema=z.object({
  templateId:z.string().uuid(),
  currency:currencySchema,
  destination:z.object({countryCode:destinationCountryCodeSchema.nullable().optional(),province:z.string().trim().max(100).nullable().optional()}).superRefine((value,ctx)=>{if(value.province&&!value.countryCode)ctx.addIssue({code:"custom",path:["countryCode"],message:"country code is required when province is set"});}).optional(),
  items:z.array(z.object({name:z.string().trim().min(1).max(120),quantity:z.coerce.number().int().min(1).max(9999),shippingClassId:z.string().uuid().nullable().optional(),shippingClassName:z.string().trim().max(80).nullable().optional(),...optionalWeightFields}).superRefine(validateWeightPair)).min(1).max(50),
});
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

export const paymentMethodTypeSchema=z.enum(["paypal","bank_transfer","western_union","wise","moneygram","stripe_payment_link","custom"]);
const paymentPublicFieldSchema=z.object({label:z.string().trim().min(1).max(80),value:z.string().trim().min(1).max(500)});
export const paymentMethodCreateSchema=z.object({
  type:paymentMethodTypeSchema,
  name:z.string().trim().min(1).max(80),
  enabled:z.boolean().default(true),
  sortOrder:z.coerce.number().int().min(-10000).max(10000).default(0),
});
export const paymentMethodUpdateSchema=paymentMethodCreateSchema.partial().refine(value=>Object.keys(value).length>0,"at least one field is required");
export const paymentProfileCreateSchema=z.object({
  name:z.string().trim().min(1).max(80),
  enabled:z.boolean().default(true),
  publicFields:z.array(paymentPublicFieldSchema).max(30).default([]),
  instructions:z.string().trim().max(8000).default(""),
  environment:z.enum(["sandbox","live"]).optional(),
  sandboxClientId:z.string().trim().min(1).max(500).optional(),
  sandboxClientSecret:z.string().trim().min(1).max(2000).optional(),
  liveClientId:z.string().trim().min(1).max(500).optional(),
  liveClientSecret:z.string().trim().min(1).max(2000).optional(),
  referenceTemplate:z.string().trim().min(1).max(500).default("Order #{{orderNumber}}"),
  noteTemplate:z.string().trim().max(4000).default("{{orderNotes}}"),
  itemNameTemplate:z.string().trim().min(1).max(500).default("{{productName}}"),
  paypalFeeRatePercent:z.coerce.number().min(0).max(99.9999).default(0),
  paypalFixedFee:moneySchema.default(0),
  paypalFeeLabel:z.string().trim().min(1).max(80).default("PayPal 手续费"),
});
export const paymentProfileUpdateSchema=paymentProfileCreateSchema.partial().refine(value=>Object.keys(value).length>0,"at least one field is required");
export const paymentSendSchema=z.object({clientSendId:z.string().uuid()});

export const enrollmentSchema = z.object({ code: z.string().min(16), name: z.string().min(2).max(80), version: z.string(), platform: z.string() });
