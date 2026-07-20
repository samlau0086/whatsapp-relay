import sharp from "sharp";
import type { OrderTemplate, SemanticOrderBlock } from "./order-template.js";

export type OrderImageProduct={name:string;image?:Buffer};
export type OrderImageSections={title:string;itemsHeading:string;items:string[];feesHeading:string;fees:string[];notes:string;total:string};

const WIDTH=1080;
const PADDING=72;
const CONTENT_WIDTH=WIDTH-PADDING*2;

export function parseOrderImageSummary(summary:string,itemCount:number,feeCount:number):OrderImageSections{
  const lines=summary.split("\n").map(line=>line.trim()).filter(Boolean),title=lines.shift()??"Order",itemsHeading=lines.shift()??"Items:";
  const items=lines.splice(0,itemCount),feesHeading=feeCount?(lines.shift()??"Additional fees:"):"",fees=lines.splice(0,feeCount),total=lines.shift()??"Total",notes=lines.join(" ");
  return{title,itemsHeading,items,feesHeading,fees,notes,total};
}

export async function renderOrderImage(summary:string,products:OrderImageProduct[],feeCount=0):Promise<Buffer>{
  const sections=parseOrderImageSummary(summary,products.length,feeCount),photoSize=190;
  const prepared=await Promise.all(products.map(async product=>({
    name:product.name,
    data:product.image?(await sharp(product.image).rotate().resize(photoSize,photoSize,{fit:"cover"}).png().toBuffer()).toString("base64"):null,
  })));
  const itemLayouts=products.map((product,index)=>{const hasImage=Boolean(prepared[index]?.data),lines=wrapLine(sections.items[index]??product.name,hasImage?39:66);return{hasImage,lines,height:Math.max(hasImage?226:92,lines.length*38+42)};});
  const feeLayouts=sections.fees.map(text=>{const lines=wrapLine(text,68);return{lines,height:lines.length*36+30};});
  const noteLines=sections.notes?wrapLine(sections.notes,68):[];
  const totalLines=wrapLine(sections.total,55);
  let y=204;
  const itemHeading=`<text x="${PADDING}" y="${y}" class="section">${escapeXml(sections.itemsHeading)}</text>`;y+=28;
  const itemCards=itemLayouts.map((layout,index)=>{const cardY=y,product=prepared[index],textX=PADDING+24,textY=cardY+48;y+=layout.height+18;const text=layout.lines.map((line,lineIndex)=>`<text x="${textX}" y="${textY+lineIndex*38}" class="body">${escapeXml(line)}</text>`).join("");const image=layout.hasImage&&product?.data?`<image x="${WIDTH-PADDING-photoSize-18}" y="${cardY+18}" width="${photoSize}" height="${photoSize}" rx="12" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${product.data}"/>`:"";return`<rect x="${PADDING}" y="${cardY}" width="${CONTENT_WIDTH}" height="${layout.height}" rx="16" fill="#f6f9f7" stroke="#e0eae5"/>${text}${image}`;}).join("");

  let feeSection="";
  if(feeLayouts.length){y+=20;feeSection+=`<text x="${PADDING}" y="${y}" class="section">${escapeXml(sections.feesHeading)}</text>`;y+=26;feeSection+=feeLayouts.map(layout=>{const rowY=y,textY=rowY+35;y+=layout.height+10;const text=layout.lines.map((line,index)=>`<text x="${PADDING+22}" y="${textY+index*36}" class="body small">${escapeXml(line)}</text>`).join("");return`<rect x="${PADDING}" y="${rowY}" width="${CONTENT_WIDTH}" height="${layout.height}" rx="12" fill="#fafcfb" stroke="#e4ece8"/>${text}`;}).join("");}

  let notes="";
  if(noteLines.length){y+=20;const noteY=y,noteHeight=noteLines.length*36+22;notes+=`<rect x="${PADDING}" y="${noteY}" width="${CONTENT_WIDTH}" height="${noteHeight}" rx="12" fill="#fffaf0"/><text x="${PADDING+22}" y="${noteY+36}" class="body small">${escapeXml(noteLines[0])}</text>${noteLines.slice(1).map((line,index)=>`<text x="${PADDING+22}" y="${noteY+72+index*36}" class="body small">${escapeXml(line)}</text>`).join("")}`;y+=noteHeight;}

  y+=28;const totalY=y,totalHeight=totalLines.length*42+34,height=Math.max(720,totalY+totalHeight+PADDING);const total=`<rect x="${PADDING}" y="${totalY}" width="${CONTENT_WIDTH}" height="${totalHeight}" rx="15" fill="#153f2f"/>${totalLines.map((line,index)=>`<text x="${PADDING+24}" y="${totalY+48+index*42}" class="total">${escapeXml(line)}</text>`).join("")}`;
  const svg=`<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg"><style>.title{font:700 42px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#fff}.section{font:700 27px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#20372d}.body{font:500 25px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#20372d}.body.small{font-size:23px}.total{font:700 29px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#fff}</style><rect width="${WIDTH}" height="${height}" fill="#fff"/><rect width="${WIDTH}" height="150" fill="#153f2f"/><circle cx="${WIDTH-92}" cy="75" r="35" fill="#36ba7c"/><path d="M${WIDTH-108} 75l11 11 23-26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><text x="${PADDING}" y="94" class="title">${escapeXml(sections.title)}</text>${itemHeading}${itemCards}${feeSection}${notes}${total}<rect x="${PADDING}" y="${height-24}" width="${CONTENT_WIDTH}" height="3" fill="#dce9e2"/></svg>`;
  return sharp(Buffer.from(svg)).png({compressionLevel:9}).toBuffer();
}

export async function renderTemplateOrderImage(template:OrderTemplate,blocks:SemanticOrderBlock[],products:OrderImageProduct[]):Promise<Buffer>{
  const definitions=new Map(template.blocks.map(block=>[block.id,block]));
  const prepared=await Promise.all(products.map(async product=>product.image?(await sharp(product.image).rotate().resize(240,240,{fit:"cover"}).png().toBuffer()).toString("base64"):null));
  let y=48;const fragments:string[]=[];
  for(const block of blocks){
    const definition=definitions.get(block.id);if(!definition)continue;
    const fontSize=definition.fontSize==="large"?34:definition.fontSize==="small"?22:27,lineHeight=fontSize+14;
    const color=definition.textColor??"#20372D",background=definition.backgroundColor??"#FFFFFF",align=definition.align??"left";
    const imageSize=definition.imageSize==="large"?160:definition.imageSize==="small"?88:124;
    const showImages=block.type==="itemList"&&definition.showProductImages!==false;
    const lineLayouts=block.lines.map((line,index)=>{
      const productIndex=block.type==="itemList"?index-(definition.label?1:0):-1,hasImage=showImages&&productIndex>=0&&Boolean(prepared[productIndex]);
      const wrapped=wrapLine(line,hasImage?38:64);return{wrapped,productIndex,hasImage,height:Math.max(wrapped.length*lineHeight+14,hasImage?imageSize+20:lineHeight+14)};
    });
    const blockHeight=Math.max(34,lineLayouts.reduce((sum,line)=>sum+line.height,0)+28),blockY=y;
    fragments.push(`<rect x="${PADDING}" y="${blockY}" width="${CONTENT_WIDTH}" height="${blockHeight}" rx="16" fill="${escapeXml(background)}" stroke="#E0EAE5"/>`);
    let lineY=blockY+24;
    for(const layout of lineLayouts){
      const x=align==="center"?WIDTH/2:align==="right"?WIDTH-PADDING-24:PADDING+24,textAnchor=align==="center"?"middle":align==="right"?"end":"start";
      layout.wrapped.forEach((line,index)=>fragments.push(`<text x="${x}" y="${lineY+fontSize+index*lineHeight}" text-anchor="${textAnchor}" font-family="Noto Sans,Noto Sans CJK SC,sans-serif" font-size="${fontSize}" font-weight="${block.type==="orderHeader"||block.type==="total"?700:500}" fill="${escapeXml(color)}">${escapeXml(line)}</text>`));
      if(layout.hasImage){const data=prepared[layout.productIndex];fragments.push(`<image x="${WIDTH-PADDING-imageSize-18}" y="${lineY+8}" width="${imageSize}" height="${imageSize}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${data}"/>`);}
      lineY+=layout.height;
    }
    y+=blockHeight+18;
  }
  const height=Math.max(720,y+30),svg=`<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${WIDTH}" height="${height}" fill="#FFFFFF"/>${fragments.join("")}<rect x="${PADDING}" y="${height-24}" width="${CONTENT_WIDTH}" height="3" fill="#DCE9E2"/></svg>`;
  return sharp(Buffer.from(svg)).png({compressionLevel:9}).toBuffer();
}

export function wrapLine(value:string,max:number):string[]{
  if(!value)return[""];
  const normalized=value.replace(/\b([A-Z]{3})\s+(\d+(?:\.\d+)?)\b/g,"$1\u00a0$2");
  const words=normalized.split(/ +/),lines:string[]=[];let current="";
  const pushLongWord=(word:string)=>{
    const chars=Array.from(word);
    while(chars.length>max)lines.push(chars.splice(0,max).join(""));
    current=chars.join("");
  };
  for(const word of words){
    const candidate=current?`${current} ${word}`:word;
    if(Array.from(candidate).length<=max){current=candidate;continue;}
    if(current){lines.push(current);current="";}
    if(Array.from(word).length>max)pushLongWord(word);else current=word;
  }
  if(current||!lines.length)lines.push(current);
  return lines;
}

function escapeXml(value:string):string{return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));}
