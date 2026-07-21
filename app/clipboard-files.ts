export async function clipboardFiles(event:ClipboardEvent,{imagesOnly=false}:{imagesOnly?:boolean}={}){
  const direct=Array.from(event.clipboardData?.files??[]);
  const items=Array.from(event.clipboardData?.items??[]).filter(item=>item.kind==="file"&&(!imagesOnly||item.type.startsWith("image/"))).map(item=>item.getAsFile()).filter((file):file is File=>Boolean(file));
  const files=[...direct,...items].filter((file,index,all)=>(!imagesOnly||file.type.startsWith("image/"))&&all.findIndex(item=>item===file||(item.name===file.name&&item.size===file.size&&item.type===file.type))===index);
  if(!files.length&&navigator.clipboard?.read){try{const contents=await navigator.clipboard.read();for(const content of contents){const type=content.types.find(value=>value.startsWith("image/"));if(type)files.push(blobFile(await content.getType(type),type));}}catch{return[];}}
  return files.map(file=>file.type.startsWith("image/")?new File([file],clipboardImageName(file.type),{type:file.type,lastModified:Date.now()}):file);
}

function blobFile(blob:Blob,type:string){return new File([blob],clipboardImageName(type),{type,lastModified:Date.now()});}
function clipboardImageName(type:string){const date=new Date(),stamp=`${date.getFullYear()}${String(date.getMonth()+1).padStart(2,"0")}${String(date.getDate()).padStart(2,"0")}`,extension=type.split("/")[1]?.replace("jpeg","jpg").replace(/[^a-z0-9]/gi,"")||"png";return`${stamp}${randomText(7)}.${extension}`;}
function randomText(length:number){const alphabet="abcdefghijklmnopqrstuvwxyz0123456789",bytes=new Uint8Array(length);crypto.getRandomValues(bytes);return Array.from(bytes,value=>alphabet[value%alphabet.length]).join("");}
