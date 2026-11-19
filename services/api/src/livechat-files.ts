export const livechatAttachmentExtensions=["pdf","step","stp","iges","igs","x_t","dwg","dxf","zip"];
export const livechatAttachmentAccept=livechatAttachmentExtensions.map(extension=>`.${extension}`).join(",");
export const livechatImageTypes=["image/png","image/jpeg","image/webp"];

export function livechatFileExtension(name:string):string{
  return name.slice(name.lastIndexOf(".")+1).toLowerCase();
}

export function livechatFileMime(name:string,mime:string):string{
  const extension=livechatFileExtension(name);
  if(extension==="pdf")return "application/pdf";
  if(extension==="zip")return "application/zip";
  if(livechatAttachmentExtensions.includes(extension))return "application/octet-stream";
  return mime;
}
