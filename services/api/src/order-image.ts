import sharp from "sharp";

export type OrderImageProduct={name:string;image?:Buffer};

const WIDTH=1080;
const PADDING=72;

export async function renderOrderImage(summary:string,products:OrderImageProduct[]):Promise<Buffer>{
  const paragraphs=summary.split("\n").flatMap(line=>wrapLine(line,58));
  const textLineHeight=42;
  const textHeight=Math.max(100,paragraphs.length*textLineHeight);
  const pictured=products.filter(product=>product.image);
  const columns=3,photoSize=264,photoGap=24;
  const photoRows=Math.ceil(pictured.length/columns);
  const photoTop=PADDING+126+textHeight+(photoRows?42:0);
  const height=Math.max(720,photoRows?photoTop+photoRows*(photoSize+92+photoGap)+PADDING:PADDING+150+textHeight+PADDING);
  const prepared=await Promise.all(pictured.map(async product=>({
    name:product.name,
    data:(await sharp(product.image!).rotate().resize(photoSize,photoSize,{fit:"cover"}).png().toBuffer()).toString("base64"),
  })));
  const title=paragraphs.shift()??"Order";
  const body=paragraphs.map((line,index)=>`<text x="${PADDING}" y="${PADDING+144+index*textLineHeight}" class="body">${escapeXml(line||" ")}</text>`).join("");
  const photos=prepared.map((product,index)=>{
    const column=index%columns,row=Math.floor(index/columns),x=PADDING+column*(photoSize+photoGap),y=photoTop+row*(photoSize+92+photoGap);
    const label=truncate(product.name,30);
    return `<rect x="${x}" y="${y}" width="${photoSize}" height="${photoSize+58}" rx="18" fill="#f6f9f7"/><image x="${x}" y="${y}" width="${photoSize}" height="${photoSize}" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${product.data}"/><text x="${x+16}" y="${y+photoSize+38}" class="label">${escapeXml(label)}</text>`;
  }).join("");
  const svg=`<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg"><style>.title{font:700 42px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#fff}.body{font:400 28px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#20372d}.label{font:600 22px 'Noto Sans','Noto Sans CJK SC',sans-serif;fill:#20372d}</style><rect width="${WIDTH}" height="${height}" fill="#fff"/><rect width="${WIDTH}" height="150" fill="#153f2f"/><circle cx="${WIDTH-92}" cy="75" r="35" fill="#36ba7c"/><path d="M${WIDTH-108} 75l11 11 23-26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><text x="${PADDING}" y="94" class="title">${escapeXml(title)}</text>${body}${photos}<rect x="${PADDING}" y="${height-30}" width="${WIDTH-PADDING*2}" height="3" fill="#dce9e2"/></svg>`;
  return sharp(Buffer.from(svg)).png({compressionLevel:9}).toBuffer();
}

function wrapLine(value:string,max:number):string[]{
  if(!value)return[""];
  const chars=Array.from(value),lines:string[]=[];let current="";
  for(const char of chars){if(Array.from(current).length>=max){lines.push(current.trimEnd());current="";}current+=char;}
  if(current||!lines.length)lines.push(current.trimEnd());return lines;
}

function truncate(value:string,max:number):string{const chars=Array.from(value);return chars.length>max?`${chars.slice(0,max-1).join("")}…`:value;}
function escapeXml(value:string):string{return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));}
