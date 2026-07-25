import sharp from "sharp";

export type MaterialStitchOrientation="vertical"|"horizontal";
export type MaterialStitchResult={bytes:Buffer;mimeType:"image/png"|"image/jpeg";extension:"png"|"jpg";width:number;height:number};

const MAX_OUTPUT_BYTES=5*1024*1024;
const MIN_SCALE=.6;
const JPEG_QUALITIES=[90,84,78,72] as const;

export async function stitchMaterialImages(images:Buffer[],orientation:MaterialStitchOrientation,maxBytes=MAX_OUTPUT_BYTES):Promise<MaterialStitchResult>{
  if(!images.length)throw new Error("material_images_required");
  const normalized=await Promise.all(images.map(image=>sharp(image).rotate().png().toBuffer()));
  const metadata=await Promise.all(normalized.map(image=>sharp(image).metadata()));
  const dimensions=metadata.map(item=>({width:item.width??0,height:item.height??0}));
  if(dimensions.some(item=>!item.width||!item.height))throw new Error("invalid_material_image");
  const width=orientation==="vertical"?Math.max(...dimensions.map(item=>item.width)):dimensions.reduce((sum,item)=>sum+item.width,0);
  const height=orientation==="vertical"?dimensions.reduce((sum,item)=>sum+item.height,0):Math.max(...dimensions.map(item=>item.height));
  const offsets:number[]=[];let position=0;
  for(const item of dimensions){offsets.push(position);position+=orientation==="vertical"?item.height:item.width;}
  const png=await sharp({create:{width,height,channels:4,background:"#FFFFFF"}})
    .composite(normalized.map((input,index)=>({input,left:orientation==="vertical"?0:offsets[index],top:orientation==="vertical"?offsets[index]:0})))
    .png({compressionLevel:9,adaptiveFiltering:true})
    .toBuffer();
  if(png.length<=maxBytes)return{bytes:png,mimeType:"image/png",extension:"png",width,height};

  for(const scale of [1,.9,.8,.7,MIN_SCALE]){
    const scaledWidth=Math.max(1,Math.round(width*scale)),scaledHeight=Math.max(1,Math.round(height*scale));
    for(const quality of JPEG_QUALITIES){
      const bytes=await sharp(png).flatten({background:"#FFFFFF"}).resize(scaledWidth,scaledHeight,{fit:"fill"}).jpeg({quality,progressive:true,chromaSubsampling:"4:4:4"}).toBuffer();
      if(bytes.length<=maxBytes)return{bytes,mimeType:"image/jpeg",extension:"jpg",width:scaledWidth,height:scaledHeight};
    }
  }
  throw Object.assign(new Error("material_stitch_too_large"),{statusCode:413});
}

export const MATERIAL_STITCH_MAX_BYTES=MAX_OUTPUT_BYTES;
