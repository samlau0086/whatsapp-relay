import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { wrapLine } from "./order-image.js";
import type { ProductCardTemplate } from "./product-card-template.js";

export type ProductCardRenderProduct={name:string;sku:string;currency:string;priceTiers:Array<{minQuantity:number;unitAmount:number}>;variants?:Array<{attributes:Record<string,string>;sku:string;priceTiers:Array<{minQuantity:number;unitAmount:number}>;image?:Buffer}>;tags:Array<{name:string}>;image?:Buffer};
const WIDTH=1080,PADDING=64,CONTENT_WIDTH=WIDTH-PADDING*2;
const PDF_POINTS_PER_PIXEL=0.75;

export async function renderProductCards(template:ProductCardTemplate,products:ProductCardRenderProduct[],showPrice:boolean):Promise<Buffer>{
  const cards=await Promise.all(products.map(product=>renderCard(template,product,showPrice)));
  if(cards.length===1)return cards[0];
  const metadata=await Promise.all(cards.map(card=>sharp(card).metadata()));
  const gap=24,height=metadata.reduce((sum,item)=>sum+(item.height??0),0)+gap*(cards.length-1);
  let top=0;const composite=cards.map((input,index)=>{const entry={input,top,left:0};top+=(metadata[index].height??0)+gap;return entry;});
  return sharp({create:{width:WIDTH,height,channels:4,background:"#E9F0EC"}}).composite(composite).png({compressionLevel:9}).toBuffer();
}

export async function renderProductCardGrid(template:ProductCardTemplate,products:ProductCardRenderProduct[],showPrice:boolean,rows:number,columns:number):Promise<Buffer>{
  if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||columns<1||rows>10||columns>10||products.length>rows*columns)throw new Error("invalid product card grid");
  const cards=await Promise.all(products.map(product=>renderCard(template,product,showPrice))),metadata=await Promise.all(cards.map(card=>sharp(card).metadata()));
  const gap=24,canvasWidth=2160,cellWidth=Math.floor((canvasWidth-gap*(columns-1))/columns),resized=await Promise.all(cards.map(async(card,index)=>{const width=metadata[index].width??WIDTH,height=metadata[index].height??720,targetHeight=Math.max(1,Math.round(height*cellWidth/width));return{input:await sharp(card).resize({width:cellWidth}).png({compressionLevel:9}).toBuffer(),height:targetHeight};}));
  const usedRows=Math.max(1,Math.ceil(products.length/columns)),rowHeights=Array.from({length:usedRows},(_,row)=>Math.max(...resized.slice(row*columns,(row+1)*columns).map(card=>card.height),1)),rowTops:number[]=[];let top=0;
  for(const height of rowHeights){rowTops.push(top);top+=height+gap;}
  const height=Math.max(1,top-gap),composite=resized.map((card,index)=>({input:card.input,left:(index%columns)*(cellWidth+gap),top:rowTops[Math.floor(index/columns)]}));
  return sharp({create:{width:canvasWidth,height,channels:4,background:"#E9F0EC"}}).composite(composite).png({compressionLevel:9}).toBuffer();
}

export async function renderProductCardGridPages(template:ProductCardTemplate,products:ProductCardRenderProduct[],showPrice:boolean,rows:number,columns:number):Promise<Buffer[]>{
  if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||columns<1||rows>10||columns>10)throw new Error("invalid product card grid");
  const capacity=rows*columns,pages:Buffer[]=[];
  for(let start=0;start<products.length;start+=capacity)pages.push(await renderProductCardGrid(template,products.slice(start,start+capacity),showPrice,rows,columns));
  return pages;
}

export async function renderProductCardGridPdf(template:ProductCardTemplate,products:ProductCardRenderProduct[],showPrice:boolean,rows:number,columns:number):Promise<Buffer>{
  const images=await renderProductCardGridPages(template,products,showPrice,rows,columns),document=await PDFDocument.create();
  document.setTitle(`Product cards (${products.length})`);
  document.setCreator("RelayDesk");
  document.setProducer("RelayDesk");
  for(const png of images){
    const metadata=await sharp(png).metadata();
    if(!metadata.width||!metadata.height)throw new Error("product_card_pdf_image_dimensions_missing");
    const width=metadata.width*PDF_POINTS_PER_PIXEL,height=metadata.height*PDF_POINTS_PER_PIXEL,page=document.addPage([width,height]),image=await document.embedPng(png);
    page.drawImage(image,{x:0,y:0,width,height});
  }
  return Buffer.from(await document.save({useObjectStreams:true}));
}

async function renderCard(template:ProductCardTemplate,product:ProductCardRenderProduct,showPrice:boolean):Promise<Buffer>{
  const imageData=product.image?(await sharp(product.image).rotate().resize(900,620,{fit:"cover"}).png().toBuffer()).toString("base64"):null;
  const variantImageData=await Promise.all((product.variants??[]).map(async variant=>variant.image?(await sharp(variant.image).rotate().resize(180,180,{fit:"contain",background:"#FFFFFF"}).png().toBuffer()).toString("base64"):null));
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
    if(block.type==="variants"&&product.variants?.length){
      const fontSize=block.fontSize==="large"?32:block.fontSize==="small"?23:27,priceFontSize=Math.max(20,fontSize-3),lineHeight=fontSize+10,priceLineHeight=priceFontSize+9,label=block.label?.trim(),bg=block.backgroundColor??"#F8FBF9",color=block.textColor??"#20372D";
      const layouts=product.variants.map((variant,index)=>{
        const hasImage=Boolean(variantImageData[index]),attributes=Object.entries(variant.attributes).map(([key,value])=>`${key}: ${value}`).join(" / ")||variant.sku,attributeLines=wrapLine(attributes,hasImage?38:54),tiers=showPrice?variant.priceTiers:[];
        const textHeight=attributeLines.length*lineHeight+priceLineHeight+tiers.length*priceLineHeight,rowHeight=Math.max(hasImage?176:0,textHeight+30);
        return{variant,hasImage,attributeLines,tiers,rowHeight};
      });
      const sectionPadding=16,labelHeight=label?fontSize+20:0,rowGap=12,height=sectionPadding*2+labelHeight+layouts.reduce((sum,layout)=>sum+layout.rowHeight,0)+rowGap*Math.max(0,layouts.length-1);
      fragments.push(`<rect x="${PADDING}" y="${y}" width="${CONTENT_WIDTH}" height="${height}" rx="16" fill="${escapeXml(bg)}" stroke="#DCE7E1"/>`);
      if(label){const align=block.align??"left",labelX=align==="center"?WIDTH/2:align==="right"?WIDTH-PADDING-20:PADDING+20,anchor=align==="center"?"middle":align==="right"?"end":"start";fragments.push(`<text x="${labelX}" y="${y+fontSize+12}" text-anchor="${anchor}" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="${fontSize}" font-weight="700" fill="${escapeXml(color)}">${escapeXml(label)}</text>`);}
      let rowY=y+sectionPadding+labelHeight;
      layouts.forEach((layout,index)=>{
        const rowX=PADDING+16,rowWidth=CONTENT_WIDTH-32,imageSize=144,textX=layout.hasImage?rowX+imageSize+34:rowX+18;
        fragments.push(`<rect x="${rowX}" y="${rowY}" width="${rowWidth}" height="${layout.rowHeight}" rx="10" fill="#FFFFFF" stroke="#D9E5DF"/>`);
        if(layout.hasImage)fragments.push(`<image x="${rowX+16}" y="${rowY+(layout.rowHeight-imageSize)/2}" width="${imageSize}" height="${imageSize}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${variantImageData[index]}"/>`);
        let textY=rowY+fontSize+18;
        layout.attributeLines.forEach(line=>{fragments.push(`<text x="${textX}" y="${textY}" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="${fontSize}" font-weight="700" fill="${escapeXml(color)}">${escapeXml(line)}</text>`);textY+=lineHeight;});
        fragments.push(`<text x="${textX}" y="${textY}" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="${priceFontSize}" font-weight="500" fill="#607168">SKU: ${escapeXml(layout.variant.sku)}</text>`);textY+=priceLineHeight;
        layout.tiers.forEach(tier=>{fragments.push(`<text x="${textX}" y="${textY}" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="${priceFontSize}" font-weight="600" fill="${escapeXml(color)}">${escapeXml(`${tier.minQuantity}+ units  ${product.currency} ${tier.unitAmount.toFixed(2)} / unit`)}</text>`);textY+=priceLineHeight;});
        rowY+=layout.rowHeight+rowGap;
      });
      y+=height+14;continue;
    }
    let lines:string[]=[];const label=block.label?.trim();
    if(block.type==="productName")lines=[label?`${label}: ${product.name}`:product.name];
    if(block.type==="sku")lines=[label?`${label}: ${product.sku}`:product.sku];
    if(block.type==="priceTiers"&&!(product.variants?.length))lines=[...(label?[label]:[]),...product.priceTiers.map((tier,index)=>`${tier.minQuantity}+ ${index===0?"":"units / "}${product.currency} ${tier.unitAmount.toFixed(2)} / unit`)];
    if(block.type==="tags")lines=product.tags.length?[`${label?`${label}: `:""}${product.tags.map(tag=>tag.name).join(" / ")}`]:[];
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
