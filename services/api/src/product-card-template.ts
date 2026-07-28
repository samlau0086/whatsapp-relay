import { z } from "zod";

const color=z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const blockType=z.enum(["productImage","productName","sku","priceTiers","tags","divider","customText"]);
export const DEFAULT_PRODUCT_CARD_CAPTION="{{productCount}} products";
export const productCardBlockSchema=z.object({
  id:z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),type:blockType,label:z.string().max(80).optional(),text:z.string().max(1000).optional(),
  fontSize:z.enum(["small","medium","large"]).optional(),textColor:color.optional(),backgroundColor:color.optional(),align:z.enum(["left","center","right"]).optional(),
  imageSize:z.enum(["small","medium","large"]).optional(),imageFit:z.enum(["cover","contain"]).optional(),showPlaceholder:z.boolean().optional(),
}).strict();

export const productCardTemplateSchema=z.object({version:z.literal(1),captionTemplate:z.string().max(2000).default(DEFAULT_PRODUCT_CARD_CAPTION),blocks:z.array(productCardBlockSchema).min(1).max(30)}).strict().superRefine((value,ctx)=>{
  if(new Set(value.blocks.map(block=>block.id)).size!==value.blocks.length)ctx.addIssue({code:"custom",path:["blocks"],message:"block ids must be unique"});
  if(value.blocks.filter(block=>block.type==="sku").length!==1)ctx.addIssue({code:"custom",path:["blocks"],message:"sku is required exactly once"});
  for(const type of ["productImage","productName","priceTiers","tags"] as const)if(value.blocks.filter(block=>block.type===type).length>1)ctx.addIssue({code:"custom",path:["blocks"],message:`${type} may only appear once`});
});

export type ProductCardTemplate=z.infer<typeof productCardTemplateSchema>;
export type ProductCardBlock=z.infer<typeof productCardBlockSchema>;

export const DEFAULT_PRODUCT_CARD_TEMPLATE:ProductCardTemplate={version:1,captionTemplate:DEFAULT_PRODUCT_CARD_CAPTION,blocks:[
  {id:"image",type:"productImage",imageSize:"large",imageFit:"cover",showPlaceholder:true,backgroundColor:"#F2F6F4"},
  {id:"name",type:"productName",label:"Product",fontSize:"large",textColor:"#153F2F",backgroundColor:"#FFFFFF",align:"left"},
  {id:"sku",type:"sku",label:"SKU",fontSize:"small",textColor:"#607168",backgroundColor:"#FFFFFF",align:"left"},
  {id:"prices",type:"priceTiers",label:"Pricing",fontSize:"medium",textColor:"#20372D",backgroundColor:"#F2F8F5",align:"left"},
  {id:"tags",type:"tags",label:"",fontSize:"small",textColor:"#31644D",backgroundColor:"#EAF7F0",align:"left"},
]};

export function parseProductCardTemplate(value:unknown):ProductCardTemplate{const parsed=productCardTemplateSchema.safeParse(value);return parsed.success?parsed.data:DEFAULT_PRODUCT_CARD_TEMPLATE;}
export function renderProductCardCaption(template:ProductCardTemplate,products:Array<{name:string;sku:string}>):string{
  const first=products[0],values:Record<string,string>={productCount:String(products.length),productNames:products.map(product=>product.name).join("、"),productName:first?.name??"",sku:first?.sku??""};
  return template.captionTemplate.replace(/{{\s*(productCount|productNames|productName|sku)\s*}}/g,(_,key:string)=>values[key]??"").trim();
}
