import sharp from "sharp";
import { wrapLine } from "./order-image.js";
import type { CollageLayer, CollageTemplate } from "./collage-template.js";

export type CollageProduct={id:string;name:string;sku:string;currency:string;defaultUnitAmount:number;priceTiers:Array<{minQuantity:number;unitAmount:number}>;tags:Array<{name:string}>;image:Buffer};

export async function renderCollagePage(template:CollageTemplate,products:CollageProduct[],assets:Map<string,Buffer>=new Map()):Promise<Buffer>{
  const {width,height,backgroundColor,backgroundMediaId}=template.canvas,base=sharp({create:{width,height,channels:4,background:backgroundColor??{r:0,g:0,b:0,alpha:0}}});
  const composites:Array<{input:Buffer;left:number;top:number}>=[];
  if(backgroundMediaId&&assets.has(backgroundMediaId))composites.push({input:await sharp(assets.get(backgroundMediaId)!).rotate().resize(width,height,{fit:"cover"}).png().toBuffer(),left:0,top:0});
  const slotIds=template.layers.filter(layer=>layer.type==="productImage").map(layer=>layer.slotId),bySlot=new Map(slotIds.map((slot,index)=>[slot,products[index]]));
  for(const layer of template.layers){
    const product="slotId" in layer?bySlot.get(layer.slotId):undefined;if("slotId" in layer&&!product)continue;
    const rendered=await renderLayer(layer,product,assets);if(!rendered)continue;
    const rotated=layer.rotation?await sharp(rendered).rotate(layer.rotation,{background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer():rendered,meta=await sharp(rotated).metadata();
    composites.push({input:rotated,left:Math.round(layer.x+layer.width/2-(meta.width??layer.width)/2),top:Math.round(layer.y+layer.height/2-(meta.height??layer.height)/2)});
  }
  return base.composite(composites).png({compressionLevel:9}).toBuffer();
}

async function renderLayer(layer:CollageLayer,product:CollageProduct|undefined,assets:Map<string,Buffer>):Promise<Buffer|null>{
  if(layer.type==="productImage"){if(!product)return null;const image=await sharp(product.image).rotate().resize(layer.width,layer.height,{fit:layer.fit,background:layer.backgroundColor}).png().toBuffer();return rounded(image,layer.width,layer.height,layer.radius,layer.opacity);}
  if(layer.type==="image"){const source=assets.get(layer.mediaId);if(!source)return null;const image=await sharp(source).rotate().resize(layer.width,layer.height,{fit:layer.fit,background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();return rounded(image,layer.width,layer.height,layer.radius,layer.opacity);}
  const text=layer.type==="text"?layer.text:product?`${layer.prefix}${boundText(layer.binding,product)}${layer.suffix}`:"";if(!text)return null;
  const approx=Math.max(1,Math.floor(layer.width/(layer.fontSize*.58))),lines=text.split("\n").flatMap(line=>wrapLine(line,approx)).slice(0,Math.max(1,Math.floor(layer.height/(layer.fontSize*1.25))));
  const anchor=layer.align==="center"?"middle":layer.align==="right"?"end":"start",x=layer.align==="center"?layer.width/2:layer.align==="right"?layer.width:0,lineHeight=Math.round(layer.fontSize*1.25);
  const svg=`<svg width="${layer.width}" height="${layer.height}" xmlns="http://www.w3.org/2000/svg"><g opacity="${layer.opacity}">${lines.map((line,index)=>`<text x="${x}" y="${Math.min(layer.height,layer.fontSize+index*lineHeight)}" text-anchor="${anchor}" font-family="Noto Sans,Noto Sans CJK SC,Arial,sans-serif" font-size="${layer.fontSize}" font-weight="${layer.fontWeight==='bold'?700:400}" fill="${escapeXml(layer.color)}">${escapeXml(line)}</text>`).join("")}</g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function rounded(image:Buffer,width:number,height:number,radius:number,opacity:number){if(!radius&&opacity===1)return image;const mask=Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="white" fill-opacity="${opacity}"/></svg>`);return sharp(image).composite([{input:mask,blend:"dest-in"}]).png().toBuffer();}
function boundText(binding:Extract<CollageLayer,{type:"productText"}>["binding"],product:CollageProduct){const prices=product.priceTiers.map(tier=>tier.unitAmount),min=Math.min(...prices),max=Math.max(...prices);return{ name:product.name,sku:product.sku,currency:product.currency,defaultPrice:`${product.currency} ${product.defaultUnitAmount.toFixed(2)}`,priceRange:min===max?`${product.currency} ${min.toFixed(2)}`:`${product.currency} ${min.toFixed(2)}–${max.toFixed(2)}`,tags:product.tags.map(tag=>tag.name).join(" · ")}[binding];}
function escapeXml(value:string){return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));}
