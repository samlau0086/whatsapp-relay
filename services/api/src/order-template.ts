import { z } from "zod";
import { calculateOrderTotal, type OrderSummaryFee, type OrderSummaryItem } from "./crm.js";

export const ORDER_BLOCK_TYPES=["orderHeader","itemList","feeList","total","shippingAddress","notes","divider","customText"] as const;
export type OrderBlockType=typeof ORDER_BLOCK_TYPES[number];
export type OrderTemplateFormat="text"|"image";
export type OrderTemplateBlock={
  id:string;type:OrderBlockType;label?:string;text?:string;
  bold?:boolean;italic?:boolean;strikethrough?:boolean;monospace?:boolean;blankAfter?:boolean;
  fontSize?:"small"|"medium"|"large";textColor?:string;backgroundColor?:string;align?:"left"|"center"|"right";
  showProductImages?:boolean;imageSize?:"small"|"medium"|"large";
};
export type OrderTemplate={version:1;blocks:OrderTemplateBlock[]};
export type OrderTemplateContext={
  orderNumber:string;currency:string;customerName:string;customerPhone:string;description:string;
  items:OrderSummaryItem[];fees:OrderSummaryFee[];
  address?:{label?:string;recipientName?:string;phone?:string;address?:string}|null;
};
export type SemanticOrderBlock={id:string;type:OrderBlockType;lines:string[]};

const color=z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const blockSchema=z.object({
  id:z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),type:z.enum(ORDER_BLOCK_TYPES),label:z.string().max(80).optional(),text:z.string().max(1000).optional(),
  bold:z.boolean().optional(),italic:z.boolean().optional(),strikethrough:z.boolean().optional(),monospace:z.boolean().optional(),blankAfter:z.boolean().optional(),
  fontSize:z.enum(["small","medium","large"]).optional(),textColor:color.optional(),backgroundColor:color.optional(),align:z.enum(["left","center","right"]).optional(),
  showProductImages:z.boolean().optional(),imageSize:z.enum(["small","medium","large"]).optional(),
}).strict().superRefine((block,ctx)=>{
  if(block.type==="customText"){
    if(!block.text?.trim())ctx.addIssue({code:"custom",path:["text"],message:"customText requires text"});
    const variables=block.text?.match(/{{\s*[^{}]+\s*}}/g)??[];
    const allowed=new Set(["{{orderNumber}}","{{customerName}}","{{customerPhone}}","{{currency}}","{{total}}","{{address}}","{{recipientName}}","{{recipientPhone}}","{{notes}}"]);
    for(const variable of variables)if(!allowed.has(variable.replace(/\s/g,"")))ctx.addIssue({code:"custom",path:["text"],message:`unsupported variable: ${variable}`});
    if(/{{|}}/.test((block.text??"").replace(/{{\s*[^{}]+\s*}}/g,"")))ctx.addIssue({code:"custom",path:["text"],message:"invalid variable syntax"});
  }
});

export const orderTemplateSchema=z.object({version:z.literal(1),blocks:z.array(blockSchema).min(2).max(30)}).strict().superRefine((template,ctx)=>{
  const singleton:OrderBlockType[]=["orderHeader","itemList","feeList","total","shippingAddress","notes"];
  for(const type of singleton){const count=template.blocks.filter(block=>block.type===type).length;if(count>1)ctx.addIssue({code:"custom",path:["blocks"],message:`${type} may only appear once`});}
  for(const type of ["itemList","total"] as const)if(!template.blocks.some(block=>block.type===type))ctx.addIssue({code:"custom",path:["blocks"],message:`${type} is required`});
  if(new Set(template.blocks.map(block=>block.id)).size!==template.blocks.length)ctx.addIssue({code:"custom",path:["blocks"],message:"block ids must be unique"});
});

export const orderTemplateUpdateSchema=orderTemplateSchema;

export const DEFAULT_TEXT_ORDER_TEMPLATE:OrderTemplate={version:1,blocks:[
  {id:"order-header",type:"orderHeader",label:"Order",bold:true,blankAfter:true},
  {id:"items",type:"itemList",label:"Items:",blankAfter:true},
  {id:"fees",type:"feeList",label:"Additional fees:",blankAfter:true},
  {id:"total",type:"total",label:"Total:",bold:true},
  {id:"notes",type:"notes",label:"Notes:",blankAfter:false},
]};

export const DEFAULT_IMAGE_ORDER_TEMPLATE:OrderTemplate={version:1,blocks:[
  {id:"order-header",type:"orderHeader",label:"Order",fontSize:"large",textColor:"#FFFFFF",backgroundColor:"#153F2F",align:"left"},
  {id:"items",type:"itemList",label:"Items:",fontSize:"medium",textColor:"#20372D",backgroundColor:"#F6F9F7",align:"left",showProductImages:true,imageSize:"medium"},
  {id:"fees",type:"feeList",label:"Additional fees:",fontSize:"small",textColor:"#20372D",backgroundColor:"#FAFCFB",align:"left"},
  {id:"total",type:"total",label:"Total:",fontSize:"large",textColor:"#FFFFFF",backgroundColor:"#153F2F",align:"left"},
  {id:"notes",type:"notes",label:"Notes:",fontSize:"small",textColor:"#20372D",backgroundColor:"#FFFAF0",align:"left"},
]};

export function parseOrderTemplate(value:unknown,format:OrderTemplateFormat):OrderTemplate{
  const parsed=orderTemplateSchema.safeParse(value);
  return parsed.success?parsed.data:(format==="text"?DEFAULT_TEXT_ORDER_TEMPLATE:DEFAULT_IMAGE_ORDER_TEMPLATE);
}

export function renderSemanticOrder(template:OrderTemplate,context:OrderTemplateContext):SemanticOrderBlock[]{
  const total=`${context.currency} ${calculateOrderTotal(context.items,context.fees).toFixed(2)}`;
  const address=[context.address?.recipientName,context.address?.phone,context.address?.address].filter(Boolean).join(" · ");
  const variables:Record<string,string>={orderNumber:context.orderNumber,customerName:context.customerName,customerPhone:context.customerPhone,currency:context.currency,total,address,recipientName:context.address?.recipientName??"",recipientPhone:context.address?.phone??"",notes:context.description};
  const replace=(text:string)=>text.replace(/{{\s*([A-Za-z]+)\s*}}/g,(_,name:string)=>variables[name]??"");
  return template.blocks.flatMap(block=>{
    let lines:string[]=[];const label=block.label??defaultLabel(block.type);
    if(block.type==="orderHeader")lines=[`${label}${label?" ":""}#${context.orderNumber}`];
    else if(block.type==="itemList")lines=[...(label?[label]:[]),...context.items.map((item,index)=>`${index+1}. ${item.name} x ${item.quantity} - ${context.currency} ${item.unitAmount.toFixed(2)} each - ${context.currency} ${(item.quantity*item.unitAmount).toFixed(2)}`)];
    else if(block.type==="feeList"){if(!context.fees.length)return[];lines=[...(label?[label]:[]),...context.fees.map(fee=>`${fee.name} - ${context.currency} ${fee.amount.toFixed(2)}`)];}
    else if(block.type==="total")lines=[`${label}${label?" ":""}${total}`];
    else if(block.type==="shippingAddress"){if(!address)return[];lines=[...(label?[label]:[]),address];}
    else if(block.type==="notes"){if(!context.description)return[];lines=[`${label}${label?" ":""}${context.description}`];}
    else if(block.type==="divider")lines=["────────────────"];
    else if(block.type==="customText")lines=replace(block.text??"").split("\n");
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
function defaultLabel(type:OrderBlockType):string{return({orderHeader:"Order",itemList:"Items:",feeList:"Additional fees:",total:"Total:",shippingAddress:"Shipping address:",notes:"Notes:",divider:"",customText:""})[type];}
