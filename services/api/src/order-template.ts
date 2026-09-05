import { z } from "zod";
import { calculateOrderTotal, type OrderSummaryFee, type OrderSummaryItem } from "./crm.js";
import { ORDER_BUSINESS_STATUSES } from "./schemas.js";

export const ORDER_BLOCK_TYPES=["orderHeader","itemList","feeList","total","paymentSummary","shippingAddress","contactInfo","notes","divider","customText","customImage","imageText"] as const;
export type OrderBlockType=typeof ORDER_BLOCK_TYPES[number];
export const CONTACT_INFO_FIELDS=["name","firstName","lastName","company","location","email","phone"] as const;
export type ContactInfoField=typeof CONTACT_INFO_FIELDS[number];
export type OrderTemplateFormat="text"|"image"|"pdf"|"qt"|"sc"|"pi"|"ci"|"inq";
export type OrderTemplateBlock={
  id:string;type:OrderBlockType;label?:string;text?:string;imageUrl?:string;imageLayout?:"left"|"right"|"top"|"bottom";
  statusLabels?:Partial<Record<OrderBusinessStatus,string>>;
  bold?:boolean;italic?:boolean;strikethrough?:boolean;monospace?:boolean;blankAfter?:boolean;
  fontSize?:"small"|"medium"|"large";textColor?:string;backgroundColor?:string;align?:"left"|"center"|"right";
  itemTemplate?:string;showProductImages?:boolean;imageSize?:"small"|"medium"|"large";groupBy?:"none"|"brand"|"category";
  contactFields?:ContactInfoField[];
};
export type OrderTemplate={version:1;blocks:OrderTemplateBlock[]};
export type OrderBusinessStatus=typeof ORDER_BUSINESS_STATUSES[number];
export type OrderTemplateContext={
  orderNumber:string;businessStatus:OrderBusinessStatus;currency:string;customerName:string;customerPhone:string;description:string;
  items:OrderSummaryItem[];fees:OrderSummaryFee[];
  address?:{label?:string;recipientName?:string;phone?:string;address?:string}|null;
  paymentProfile?:{summary?:string}|null;
  contact?:{firstName?:string|null;lastName?:string|null;companyName?:string|null;country?:string|null;province?:string|null;city?:string|null;email?:string|null}|null;
};
export type SemanticOrderBlock={id:string;type:OrderBlockType;lines:string[];itemIndexes?:number[];outOfStockLineIndexes?:number[]};

const color=z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const DEFAULT_ORDER_ITEM_TEMPLATE="{{index}}. {{title}} x {{quantity}} - {{price}} each - {{subtotal}}";
export const DEFAULT_ORDER_STATUS_LABELS:Record<OrderBusinessStatus,string>={quotation:"Quotation",pending_confirmation:"Order",pending_payment:"Payment Due",paid:"Paid Order",processing:"Order",shipped:"Shipped Order",completed:"Completed Order",cancelled:"Cancelled Order"};
const ORDER_ITEM_VARIABLES=new Set(["index","title","sku","quantity","price","subtotal","brand","category","description"]);
const blockSchema=z.object({
  id:z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),type:z.enum(ORDER_BLOCK_TYPES),label:z.string().max(80).optional(),text:z.string().max(1000).optional(),imageUrl:z.string().url().max(2000).optional(),imageLayout:z.enum(["left","right","top","bottom"]).optional(),
  statusLabels:z.object(Object.fromEntries(ORDER_BUSINESS_STATUSES.map(status=>[status,z.string().trim().min(1).max(80)])) as Record<OrderBusinessStatus,z.ZodString>).partial().optional(),
  bold:z.boolean().optional(),italic:z.boolean().optional(),strikethrough:z.boolean().optional(),monospace:z.boolean().optional(),blankAfter:z.boolean().optional(),
  fontSize:z.enum(["small","medium","large"]).optional(),textColor:color.optional(),backgroundColor:color.optional(),align:z.enum(["left","center","right"]).optional(),
  itemTemplate:z.string().min(1).max(500).optional(),showProductImages:z.boolean().optional(),imageSize:z.enum(["small","medium","large"]).optional(),groupBy:z.enum(["none","brand","category"]).optional(),
  contactFields:z.array(z.enum(CONTACT_INFO_FIELDS)).min(1).max(CONTACT_INFO_FIELDS.length).optional(),
}).strict().superRefine((block,ctx)=>{
  if(block.type==="customText"){
    if(!block.text?.trim())ctx.addIssue({code:"custom",path:["text"],message:"customText requires text"});
    const variables=block.text?.match(/{{\s*[^{}]+\s*}}/g)??[];
    const allowed=new Set(["{{orderNumber}}","{{customerName}}","{{customerPhone}}","{{currency}}","{{total}}","{{address}}","{{recipientName}}","{{recipientPhone}}","{{notes}}"]);
    for(const variable of variables)if(!allowed.has(variable.replace(/\s/g,"")))ctx.addIssue({code:"custom",path:["text"],message:`unsupported variable: ${variable}`});
    if(/{{|}}/.test((block.text??"").replace(/{{\s*[^{}]+\s*}}/g,"")))ctx.addIssue({code:"custom",path:["text"],message:"invalid variable syntax"});
  }
  if(block.type==="customImage"||block.type==="imageText"){
    if(!block.imageUrl)ctx.addIssue({code:"custom",path:["imageUrl"],message:"image block requires imageUrl"});
    if(block.type==="imageText"&&!block.text?.trim())ctx.addIssue({code:"custom",path:["text"],message:"imageText requires text"});
  }
  if(block.type==="itemList"&&block.itemTemplate!==undefined){
    const variables=block.itemTemplate.match(/{{\s*[^{}]+\s*}}/g)??[];
    for(const variable of variables){
      const name=variable.slice(2,-2).trim();
      if(!ORDER_ITEM_VARIABLES.has(name))ctx.addIssue({code:"custom",path:["itemTemplate"],message:`unsupported variable: ${variable}`});
    }
    if(/{{|}}/.test(block.itemTemplate.replace(/{{\s*[^{}]+\s*}}/g,"")))ctx.addIssue({code:"custom",path:["itemTemplate"],message:"invalid variable syntax"});
  }
});

export const orderTemplateSchema=z.object({version:z.literal(1),blocks:z.array(blockSchema).min(2).max(30)}).strict().superRefine((template,ctx)=>{
  const singleton:OrderBlockType[]=["orderHeader","itemList","feeList","total","paymentSummary","shippingAddress","contactInfo","notes"];
  for(const type of singleton){const count=template.blocks.filter(block=>block.type===type).length;if(count>1)ctx.addIssue({code:"custom",path:["blocks"],message:`${type} may only appear once`});}
  for(const type of ["itemList","total","paymentSummary"] as const)if(!template.blocks.some(block=>block.type===type))ctx.addIssue({code:"custom",path:["blocks"],message:`${type} is required`});
  if(new Set(template.blocks.map(block=>block.id)).size!==template.blocks.length)ctx.addIssue({code:"custom",path:["blocks"],message:"block ids must be unique"});
});

export const orderTemplateUpdateSchema=orderTemplateSchema;

export function validateOrderTemplate(value:unknown,format:OrderTemplateFormat){
  if(format!=="inq")return orderTemplateUpdateSchema.safeParse(value);
  if(!value||typeof value!=="object"||!Array.isArray((value as {blocks?:unknown}).blocks))return orderTemplateUpdateSchema.safeParse(value);
  const template=value as {blocks:Array<unknown>};
  const parsed=orderTemplateUpdateSchema.safeParse({...value,blocks:[...template.blocks,{id:"__inq-validation-total",type:"total"},{id:"__inq-validation-payment",type:"paymentSummary"}]});
  return parsed.success?{success:true as const,data:value as OrderTemplate}:{success:false as const,error:parsed.error};
}

export const DEFAULT_TEXT_ORDER_TEMPLATE:OrderTemplate={version:1,blocks:[
  {id:"order-header",type:"orderHeader",label:"Order",statusLabels:DEFAULT_ORDER_STATUS_LABELS,bold:true,blankAfter:true},
  {id:"items",type:"itemList",label:"Items:",itemTemplate:DEFAULT_ORDER_ITEM_TEMPLATE,blankAfter:true},
  {id:"fees",type:"feeList",label:"Additional fees:",blankAfter:true},
  {id:"total",type:"total",label:"Total:",bold:true},
  {id:"payment-summary",type:"paymentSummary",label:"Payment:",blankAfter:true},
  {id:"notes",type:"notes",label:"Notes:",blankAfter:false},
]};

export const DEFAULT_IMAGE_ORDER_TEMPLATE:OrderTemplate={version:1,blocks:[
  {id:"order-header",type:"orderHeader",label:"Order",statusLabels:DEFAULT_ORDER_STATUS_LABELS,fontSize:"large",textColor:"#FFFFFF",backgroundColor:"#153F2F",align:"left"},
  {id:"items",type:"itemList",label:"Items:",itemTemplate:DEFAULT_ORDER_ITEM_TEMPLATE,fontSize:"medium",textColor:"#20372D",backgroundColor:"#F6F9F7",align:"left",showProductImages:true,imageSize:"medium"},
  {id:"fees",type:"feeList",label:"Additional fees:",fontSize:"small",textColor:"#20372D",backgroundColor:"#FAFCFB",align:"left"},
  {id:"total",type:"total",label:"Total:",fontSize:"large",textColor:"#FFFFFF",backgroundColor:"#153F2F",align:"left"},
  {id:"payment-summary",type:"paymentSummary",label:"Payment:",fontSize:"medium",textColor:"#20372D",backgroundColor:"#EEF6F2",align:"left"},
  {id:"notes",type:"notes",label:"Notes:",fontSize:"small",textColor:"#20372D",backgroundColor:"#FFFAF0",align:"left"},
]};
export const DEFAULT_PDF_ORDER_TEMPLATE:OrderTemplate=structuredClone(DEFAULT_IMAGE_ORDER_TEMPLATE);
function documentTemplate(label:string):OrderTemplate{const template=structuredClone(DEFAULT_PDF_ORDER_TEMPLATE);const header=template.blocks.find(block=>block.type==="orderHeader");if(header){header.label=label;header.statusLabels=Object.fromEntries(ORDER_BUSINESS_STATUSES.map(status=>[status,label]));}const totalIndex=template.blocks.findIndex(block=>block.type==="total");template.blocks.splice(totalIndex<0?template.blocks.length:totalIndex,0,{id:"contact-info",type:"contactInfo",label:"Customer:",fontSize:"small",textColor:"#20372D",backgroundColor:"#F6F9F7",align:"left",contactFields:["name","firstName","lastName","company","location","email","phone"]});return template;}
export const DEFAULT_SC_ORDER_TEMPLATE:OrderTemplate=documentTemplate("Sales Contract");
export const DEFAULT_PI_ORDER_TEMPLATE:OrderTemplate=documentTemplate("Proforma Invoice");
export const DEFAULT_CI_ORDER_TEMPLATE:OrderTemplate=documentTemplate("Commercial Invoice");
export const DEFAULT_QT_ORDER_TEMPLATE:OrderTemplate=documentTemplate("Quotation");
function inquiryTemplate():OrderTemplate{const template=documentTemplate("Inquiry");template.blocks=template.blocks.filter(block=>block.type!=="feeList"&&block.type!=="total"&&block.type!=="paymentSummary");return template;}
export const DEFAULT_INQ_ORDER_TEMPLATE:OrderTemplate=inquiryTemplate();

export function parseOrderTemplate(value:unknown,format:OrderTemplateFormat):OrderTemplate{
  const normalized=normalizeOrderTemplate(value,format),parsed=validateOrderTemplate(normalized,format);
  return parsed.success?parsed.data:(format==="text"?DEFAULT_TEXT_ORDER_TEMPLATE:format==="pdf"?DEFAULT_PDF_ORDER_TEMPLATE:format==="qt"?DEFAULT_QT_ORDER_TEMPLATE:format==="sc"?DEFAULT_SC_ORDER_TEMPLATE:format==="pi"?DEFAULT_PI_ORDER_TEMPLATE:format==="ci"?DEFAULT_CI_ORDER_TEMPLATE:format==="inq"?DEFAULT_INQ_ORDER_TEMPLATE:DEFAULT_IMAGE_ORDER_TEMPLATE);
}

function normalizeOrderTemplate(value:unknown,format:OrderTemplateFormat):unknown{
  if(!value||typeof value!=="object"||!Array.isArray((value as {blocks?:unknown}).blocks))return value;
  const template=value as {version?:unknown;blocks:Array<Record<string,unknown>>};
  const blocks=template.blocks.map(block=>block.type==="itemList"&&block.itemTemplate===undefined?{...block,itemTemplate:DEFAULT_ORDER_ITEM_TEMPLATE}:block.type==="orderHeader"?{...block,statusLabels:{...DEFAULT_ORDER_STATUS_LABELS,...(block.statusLabels&&typeof block.statusLabels==="object"?block.statusLabels:{})}}:block);
  if(format!=="inq"&&!blocks.some(block=>block.type==="paymentSummary")){
    const block=format==="text"
      ?{id:"payment-summary",type:"paymentSummary",label:"Payment:",blankAfter:true}
      :{id:"payment-summary",type:"paymentSummary",label:"Payment:",fontSize:"medium",textColor:"#20372D",backgroundColor:"#EEF6F2",align:"left"};
    const totalIndex=blocks.findIndex(item=>item.type==="total");blocks.splice(totalIndex<0?blocks.length:totalIndex+1,0,block);
  }
  return{...template,blocks};
}

export function renderSemanticOrder(template:OrderTemplate,context:OrderTemplateContext):SemanticOrderBlock[]{
  const total=`${context.currency} ${calculateOrderTotal(context.items,context.fees).toFixed(2)}`;
  const address=[context.address?.recipientName,context.address?.phone,context.address?.address].filter(Boolean).join(" · ");
  const variables:Record<string,string>={orderNumber:context.orderNumber,customerName:context.customerName,customerPhone:context.customerPhone,currency:context.currency,total,address,recipientName:context.address?.recipientName??"",recipientPhone:context.address?.phone??"",notes:context.description};
  const replace=(text:string)=>text.replace(/{{\s*([A-Za-z]+)\s*}}/g,(_,name:string)=>variables[name]??"");
  return template.blocks.flatMap<SemanticOrderBlock>(block=>{
    let lines:string[]=[];const label=block.label??defaultLabel(block.type);
    if(block.type==="orderHeader"){const statusLabel=block.statusLabels?.[context.businessStatus]?.trim()||label;lines=[`${statusLabel}${statusLabel?" ":""}#${context.orderNumber}`];}
    else if(block.type==="itemList"){
      const itemIndexes:number[]=[],outOfStockLineIndexes:number[]=[];if(label){lines.push(label);itemIndexes.push(-1);}
      const groups=block.groupBy&&block.groupBy!=="none"?new Map<string,Array<{item:OrderSummaryItem;index:number}>>():null;
      if(groups)for(const [index,item] of context.items.entries()){const key=(block.groupBy==="brand"?item.brand:item.category)?.trim()||"未分类";const group=groups.get(key)??[];group.push({item,index});groups.set(key,group);}
      if(groups)for(const [key,group] of groups){lines.push(`[${block.groupBy==="brand"?"Brand":"Category"}] ${key}`);itemIndexes.push(-1);for(const {item,index} of group){lines.push(renderOrderItem(block.itemTemplate,item,index,context.currency));itemIndexes.push(index);if(item.isOutOfStock)outOfStockLineIndexes.push(lines.length-1);}}
      else for(const [index,item] of context.items.entries()){lines.push(renderOrderItem(block.itemTemplate,item,index,context.currency));itemIndexes.push(index);if(item.isOutOfStock)outOfStockLineIndexes.push(lines.length-1);}
      return[{id:block.id,type:block.type,lines,itemIndexes,outOfStockLineIndexes}];
    }
    else if(block.type==="feeList"){if(!context.fees.length)return[];lines=[...(label?[label]:[]),...context.fees.map(fee=>`${fee.name} - ${context.currency} ${fee.amount.toFixed(2)}`)];}
    else if(block.type==="total")lines=[`${label}${label?" ":""}${total}`];
    else if(block.type==="paymentSummary"){if(!context.paymentProfile?.summary)return[];lines=[`${label}${label?" ":""}${context.paymentProfile.summary}`];}
    else if(block.type==="shippingAddress"){if(!address)return[];lines=[...(label?[label]:[]),address];}
    else if(block.type==="contactInfo"){
      const contact=context.contact??{},location=[contact.country,contact.province,contact.city].filter(Boolean).join(", ");
      const fields:Record<ContactInfoField,[string,string]>={name:["Name",context.customerName],firstName:["First name",contact.firstName??""],lastName:["Last name",contact.lastName??""],company:["Company",contact.companyName??""],location:["Location",location],email:["Email",contact.email??""],phone:["Phone",context.customerPhone]};
      const values=(block.contactFields?.length?block.contactFields:CONTACT_INFO_FIELDS).map(field=>fields[field]).filter(([,value])=>Boolean(value));
      if(!values.length)return[];lines=[...(label?[label]:[]),...values.map(([field,value])=>`${field}: ${value}`)];
    }
    else if(block.type==="notes"){if(!context.description)return[];lines=[`${label}${label?" ":""}${context.description}`];}
    else if(block.type==="divider")lines=["────────────────"];
    else if(block.type==="customText")lines=replace(block.text??"").split("\n");
    else if(block.type==="imageText")lines=replace(block.text??"").split("\n");
    return[{id:block.id,type:block.type,lines}];
  });
}

export function serializeSemanticOrder(blocks:SemanticOrderBlock[]):string{return blocks.map(block=>`[[ORDER_BLOCK:${block.id}]]\n${block.lines.join("\n")}\n[[/ORDER_BLOCK:${block.id}]]`).join("\n");}

export function parseTranslatedSemanticOrder(value:string,source:SemanticOrderBlock[]):SemanticOrderBlock[]{
  const found=new Map<string,string[]>();
  const pattern=/\[\[ORDER_BLOCK:([A-Za-z0-9_-]+)]]\s*([\s\S]*?)\s*\[\[\/ORDER_BLOCK:\1]]/g;let match:RegExpExecArray|null;
  while((match=pattern.exec(value)))found.set(match[1],match[2].trim().split("\n"));
  if(found.size!==source.length||source.some(block=>!found.has(block.id)))throw new Error("translated_order_template_markers_invalid");
  return source.map(block=>({...block,lines:found.get(block.id)!}));
}

export function renderTextOrder(template:OrderTemplate,blocks:SemanticOrderBlock[]):string{
  const byId=new Map(blocks.map(block=>[block.id,block]));const output:string[]=[];
  for(const definition of template.blocks){const block=byId.get(definition.id);if(!block)continue;let text=block.lines.map(escapeWhatsApp).join("\n");if(!text)continue;
    if(definition.monospace)text=`\`\`\`${text}\`\`\``;if(definition.bold)text=`*${text}*`;if(definition.italic)text=`_${text}_`;if(definition.strikethrough)text=`~${text}~`;
    output.push(text);if(definition.blankAfter)output.push("");
  }
  return output.join("\n").replace(/\n{3,}/g,"\n\n").trim();
}

function escapeWhatsApp(value:string):string{return value.replace(/([*_~`])/g,"$1\u200b");}
function renderOrderItem(template:string|undefined,item:OrderSummaryItem,index:number,currency:string):string{
  if(item.isOutOfStock&&(!template?.trim()||template.trim()===DEFAULT_ORDER_ITEM_TEMPLATE))return `${index+1}. ${item.name} x ${item.quantity} - Out of stock`;
  const variables:Record<string,string>={
    index:String(index+1),
    title:item.name,
    sku:item.sku??"",
    brand:item.brand??"",
    category:item.category??"",
    description:item.description??"",
    quantity:String(item.quantity),
    price:item.isOutOfStock?"Out of stock":`${currency} ${item.unitAmount.toFixed(2)}`,
    subtotal:item.isOutOfStock?"Out of stock":`${currency} ${(item.quantity*item.unitAmount).toFixed(2)}`,
  };
  return(template?.trim()||DEFAULT_ORDER_ITEM_TEMPLATE).replace(/{{\s*([A-Za-z]+)\s*}}/g,(_,name:string)=>variables[name]??"");
}
function defaultLabel(type:OrderBlockType):string{return({orderHeader:"Order",itemList:"Items:",feeList:"Additional fees:",total:"Total:",paymentSummary:"Payment:",shippingAddress:"Shipping address:",contactInfo:"Customer:",notes:"Notes:",divider:"",customText:"",customImage:"",imageText:""})[type];}
