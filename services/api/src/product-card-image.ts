import sharp from "sharp";
import { wrapLine } from "./order-image.js";
import type { ProductCardTemplate } from "./product-card-template.js";

export type ProductCardRenderProduct={name:string;sku:string;currency:string;priceTiers:Array<{minQuantity:number;unitAmount:number}>;tags:Array<{name:string}>;image?:Buffer};
const WIDTH=1080,PADDING=64,CONTENT_WIDTH=WIDTH-PADDING*2;

export async function renderProductCards(template:ProductCardTemplate,products:ProductCardRenderProduct[],showPrice:boolean):Promise<Buffer>{
  const cards=await Promise.all(products.map(product=>renderCard(template,product,showPrice)));
  if(cards.length===1)return cards[0];
  const metadata=await Promise.all(cards.map(card=>sharp(card).metadata()));
  const gap=24,height=metadata.reduce((sum,item)=>sum+(item.height??0),0)+gap*(cards.length-1);
  let top=0;const composite=cards.map((input,index)=>{const entry={input,top,left:0};top+=(metadata[index].height??0)+gap;return entry;});
  return sharp({create:{width:WIDTH,height,channels:4,background:"#E9F0EC"}}).composite(composite).png({compressionLevel:9}).toBuffer();
}

async function renderCard(template:ProductCardTemplate,product:ProductCardRenderProduct,showPrice:boolean):Promise<Buffer>{
  const imageData=product.image?(await sharp(product.image).rotate().resize(900,620,{fit:"cover"}).png().toBuffer()).toString("base64"):null;
  const fragments:string[]=[];let y=36;
  for(const block of template.blocks){
    if(block.type==="priceTiers"&&!showPrice)continue;
    if(block.type==="productImage"){
      if(!imageData&&block.showPlaceholder===false)continue;
      const height=block.imageSize==="small"?240:block.imageSize==="medium"?360:520,bg=block.backgroundColor??"#F2F6F4";
      fragments.push(`<rect x="${PADDING}" y="${y}" width="${CONTENT_WIDTH}" height="${height}" rx="22" fill="${escapeXml(bg)}"/>`);
      if(imageData){const fit=block.imageFit==="contain"?"xMidYMid meet":"xMidYMid slice";fragments.push(`<image x="${PADDING}" y="${y}" width="${CONTENT_WIDTH}" height="${height}" preserveAspectRatio="${fit}" href="data:image/png;base64,${imageData}"/>`);}else fragments.push(`<text x="540" y="${y+height/2+12}" text-anchor="middle" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="30" fill="#829087">PRODUCT</text>`);
      y+=height+18;continue;
    }
    if(block.type==="divider"){fragments.push(`<line x1="${PADDING}" y1="${y+10}" x2="${WIDTH-PADDING}" y2="${y+10}" stroke="#DCE7E1" stroke-width="3"/>`);y+=34;continue;}
    let lines:string[]=[];const label=block.label?.trim();
    if(block.type==="productName")lines=[label?`${label}: ${product.name}`:product.name];
    if(block.type==="sku")lines=[label?`${label}: ${product.sku}`:product.sku];
    if(block.type==="priceTiers")lines=[...(label?[label]:[]),...product.priceTiers.map((tier,index)=>`${tier.minQuantity}+ ${index===0?"":"units · "}${product.currency} ${tier.unitAmount.toFixed(2)} / unit`)];
    if(block.type==="tags")lines=product.tags.length?[`${label?`${label}: `:""}${product.tags.map(tag=>tag.name).join(" · ")}`]:[];
    if(block.type==="customText")lines=replaceVariables(block.text??"",product).split("\n");
    if(!lines.length)continue;
    const fontSize=block.fontSize==="large"?38:block.fontSize==="small"?24:30,lineHeight=fontSize+14,wrapped=lines.flatMap(line=>wrapLine(line,58));
    const height=wrapped.length*lineHeight+34,bg=block.backgroundColor??"#FFFFFF",color=block.textColor??"#20372D",align=block.align??"left";
    fragments.push(`<rect x="${PADDING}" y="${y}" width="${CONTENT_WIDTH}" height="${height}" rx="16" fill="${escapeXml(bg)}" stroke="#E0EAE5"/>`);
    const x=align==="center"?WIDTH/2:align==="right"?WIDTH-PADDING-22:PADDING+22,anchor=align==="center"?"middle":align==="right"?"end":"start";
    wrapped.forEach((line,index)=>fragments.push(`<text x="${x}" y="${y+fontSize+15+index*lineHeight}" text-anchor="${anchor}" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="${fontSize}" font-weight="${block.type==="productName"?700:500}" fill="${escapeXml(color)}">${escapeXml(line)}</text>`));
    y+=height+14;
  }
  const height=Math.max(720,y+30),svg=`<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${WIDTH}" height="${height}" fill="#FFFFFF"/>${fragments.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png({compressionLevel:9}).toBuffer();
}

function replaceVariables(text:string,product:ProductCardRenderProduct):string{return text.replace(/{{\s*(name|sku|currency)\s*}}/g,(_,key:string)=>({name:product.name,sku:product.sku,currency:product.currency})[key]??"");}
function escapeXml(value:string):string{return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));}
