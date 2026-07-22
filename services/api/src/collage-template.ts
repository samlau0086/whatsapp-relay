import { z } from "zod";

const color=z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/);
const geometry={id:z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),x:z.number().int().min(0).max(4096),y:z.number().int().min(0).max(4096),width:z.number().int().min(16).max(4096),height:z.number().int().min(16).max(4096),rotation:z.number().min(-180).max(180).default(0),opacity:z.number().min(0).max(1).default(1)};
const productImageLayer=z.object({...geometry,type:z.literal("productImage"),slotId:z.string().min(1).max(40),fit:z.enum(["cover","contain"]).default("cover"),radius:z.number().int().min(0).max(1000).default(0),backgroundColor:color.default("#FFFFFF")}).strict();
const productTextLayer=z.object({...geometry,type:z.literal("productText"),slotId:z.string().min(1).max(40),binding:z.enum(["name","sku","currency","defaultPrice","priceRange","tags"]),prefix:z.string().max(120).default(""),suffix:z.string().max(120).default(""),fontSize:z.number().int().min(8).max(300).default(40),fontWeight:z.enum(["normal","bold"]).default("normal"),color:color.default("#111111"),align:z.enum(["left","center","right"]).default("left")}).strict();
const textLayer=z.object({...geometry,type:z.literal("text"),text:z.string().max(2000),fontSize:z.number().int().min(8).max(300).default(40),fontWeight:z.enum(["normal","bold"]).default("normal"),color:color.default("#111111"),align:z.enum(["left","center","right"]).default("left")}).strict();
const imageLayer=z.object({...geometry,type:z.literal("image"),mediaId:z.string().uuid(),fit:z.enum(["cover","contain"]).default("contain"),radius:z.number().int().min(0).max(1000).default(0)}).strict();
export const collageLayerSchema=z.discriminatedUnion("type",[productImageLayer,productTextLayer,textLayer,imageLayer]);
export const collageTemplateSchema=z.object({
  version:z.literal(1),
  canvas:z.object({width:z.number().int().min(320).max(4096),height:z.number().int().min(320).max(4096),padding:z.number().int().min(0).max(1000).default(48),backgroundColor:color.nullable().default("#FFFFFF"),backgroundMediaId:z.string().uuid().nullable().default(null)}).strict(),
  layers:z.array(collageLayerSchema).min(1).max(100),
}).strict().superRefine((value,ctx)=>{
  if(value.canvas.width*value.canvas.height>16_000_000)ctx.addIssue({code:"custom",path:["canvas"],message:"canvas exceeds 16 megapixels"});
  if(value.canvas.padding*2>=Math.min(value.canvas.width,value.canvas.height))ctx.addIssue({code:"custom",path:["canvas","padding"],message:"canvas padding leaves no usable content area"});
  const ids=new Set<string>(),slots=new Set<string>();
  for(const [index,layer] of value.layers.entries()){
    if(ids.has(layer.id))ctx.addIssue({code:"custom",path:["layers",index,"id"],message:"layer ids must be unique"});ids.add(layer.id);
    if(layer.x+layer.width>value.canvas.width||layer.y+layer.height>value.canvas.height)ctx.addIssue({code:"custom",path:["layers",index],message:"layer must stay inside canvas"});
    if(layer.type==="productImage"){if(slots.has(layer.slotId))ctx.addIssue({code:"custom",path:["layers",index,"slotId"],message:"product slot ids must be unique"});slots.add(layer.slotId);}
  }
  if(slots.size<1)ctx.addIssue({code:"custom",path:["layers"],message:"at least one product image slot is required"});
  if(slots.size>50)ctx.addIssue({code:"custom",path:["layers"],message:"at most 50 product slots are allowed"});
  for(const [index,layer] of value.layers.entries())if(layer.type==="productText"&&!slots.has(layer.slotId))ctx.addIssue({code:"custom",path:["layers",index,"slotId"],message:"bound product slot does not exist"});
});

export const collageTemplateCreateSchema=z.object({name:z.string().trim().min(1).max(120),template:collageTemplateSchema,isDefault:z.boolean().default(false)});
export const collageTemplateUpdateSchema=z.object({name:z.string().trim().min(1).max(120).optional(),template:collageTemplateSchema.optional(),isDefault:z.boolean().optional()}).refine(value=>Object.keys(value).length>0,"at least one field is required");
export const materialGenerateSchema=z.object({clientGenerationId:z.string().uuid(),name:z.string().trim().min(1).max(160),templateId:z.string().uuid(),productIds:z.array(z.string().uuid()).min(1).max(100)}).superRefine((value,ctx)=>{if(new Set(value.productIds).size!==value.productIds.length)ctx.addIssue({code:"custom",path:["productIds"],message:"product ids must be unique"});});

export type CollageTemplate=z.infer<typeof collageTemplateSchema>;
export type CollageLayer=z.infer<typeof collageLayerSchema>;

export const DEFAULT_COLLAGE_TEMPLATE:CollageTemplate={version:1,canvas:{width:1080,height:1080,padding:48,backgroundColor:"#F4F7F5",backgroundMediaId:null},layers:[
  {id:"title",type:"text",x:60,y:35,width:960,height:90,rotation:0,opacity:1,text:"FEATURED PRODUCTS",fontSize:48,fontWeight:"bold",color:"#153F2F",align:"center"},
  ...[0,1,2,3].flatMap(index=>{const col=index%2,row=Math.floor(index/2),slotId=`slot-${index+1}`,x=55+col*510,y=150+row*455;return [
    {id:`image-${index+1}`,type:"productImage" as const,slotId,x,y,width:460,height:330,rotation:0,opacity:1,fit:"cover" as const,radius:24,backgroundColor:"#FFFFFF"},
    {id:`name-${index+1}`,type:"productText" as const,slotId,binding:"name" as const,x,y:y+342,width:460,height:60,rotation:0,opacity:1,prefix:"",suffix:"",fontSize:30,fontWeight:"bold" as const,color:"#153F2F",align:"center" as const},
    {id:`price-${index+1}`,type:"productText" as const,slotId,binding:"defaultPrice" as const,x,y:y+398,width:460,height:42,rotation:0,opacity:1,prefix:"",suffix:"",fontSize:24,fontWeight:"normal" as const,color:"#397258",align:"center" as const},
  ];}),
]};

export function parseCollageTemplate(value:unknown):CollageTemplate{const parsed=collageTemplateSchema.safeParse(value);return parsed.success?parsed.data:DEFAULT_COLLAGE_TEMPLATE;}
export function productSlotIds(template:CollageTemplate):string[]{return template.layers.filter((layer):layer is Extract<CollageLayer,{type:"productImage"}>=>layer.type==="productImage").map(layer=>layer.slotId);}
